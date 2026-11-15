/**
 * 网球弹道积分。
 *
 * 为什么自己写而不是用 cannon / rapier：
 *   1. 通用引擎不做马格努斯力（旋转产生的弧线），而旋转就是网球玩法的全部纵深
 *   2. 通用引擎的 CCD 在 200km/h 面前要么开得很贵，要么干脆隧穿
 *   3. 这里只有一颗球，不需要空间划分、约束求解、休眠，几千行的东西二十行就够
 *
 * 积分用半隐式欧拉 + 240Hz 定步长。网球最快 40 m/s，每步走 16.7cm，
 * 远小于球的直径和场地特征尺寸，不会穿模；再往上加步长收益很小。
 *
 * 力的量级（30 m/s 平击球）：
 *   重力   0.56 N
 *   阻力   1.05 N   ← 比重力还大！这就是网球速度衰减极快的原因
 *   马格努斯 0.2 N  ← 够让上旋球提前两米落地
 */

import { vcross, vdot, vlen, vnorm, type V3 } from './vec';
import {
  BALL_R,
  BALL_AREA,
  BALL_M,
  RHO,
  DRAG_CD,
  MAGNUS_CL,
  GRAVITY,
  GROUND_REST,
  GROUND_FRIC,
  NET_Z,
  NET_H,
  SPIN_TAU,
  PHYS_DT,
  HALF_WIDTH,
  BASELINE_Z,
} from './court';


export interface Ball {
  p: V3;
  v: V3;
  /** 角速度向量（rad/s），模长是转速，方向是旋转轴 */
  spin: V3;
  /** 落地次数 */
  bounces: number;
  /** 撞墙次数 */
  /** 是否还在规则内（出界由 `Duel` 判） */
  live: boolean;
}

export type Collision =
  | { kind: 'ground'; at: V3; speed: number; topSpin: number }
  | { kind: 'net'; at: V3 };

export function makeBall(p: V3, v: V3, spin: V3 = [0, 0, 0]): Ball {
  return { p: [...p], v: [...v], spin: [...spin], bounces: 0, live: true };
}

/**
 * 每一步的位置轨迹回调。
 *
 * 球拍碰撞必需：一帧里球最多走 70cm，而拍面是一张零厚度的平面，
 * 用「帧结束位置」判定必然隧穿。这里把每个 4.17ms 子步的起止位置和对应时刻
 * 报出去，调用方才能做「线段 vs 椭圆盘」的精确求交。
 */
export type StepFn = (p0: V3, p1: V3, t0: number, t1: number) => boolean | void;

/**
 * 推进一步。
 *
 * dt 是渲染帧间隔，内部会拆成若干个 PHYS_DT 的子步。
 * 之所以不用累加器：累加器会让球的位置慢 1–3 步（4–12ms），
 * 而击球判定正好依赖球的位置，这点滞后会直接变成「手感黏」。
 * 拆成不等长子步（最后一步可能只有半拍）在数值上完全够用。
 *
 * @param onStep 每个子步的轨迹回调，不给就不产生任何开销
 * @param tStart 这一帧的起始本地时刻（毫秒）。只有给了 onStep 才有意义。
 */
export function advance(
  ball: Ball,
  dt: number,
  emit: (c: Collision) => void,
  onStep?: StepFn,
  tStart = 0
): void {
  // 切到后台再切回来时 dt 会是几秒，限幅防止球瞬移穿墙
  let remain = Math.min(Math.max(dt, 0), 0.05);
  let t = tStart;
  while (remain > 1e-6) {
    const h = Math.min(PHYS_DT, remain);
    const p0: V3 = [ball.p[0], ball.p[1], ball.p[2]];
    substep(ball, h, emit);
    if (onStep) {
      const t1 = t + h * 1000;
      const go = onStep(p0, [ball.p[0], ball.p[1], ball.p[2]], t, t1);
      t = t1;
      // 回调返回 false = 事件已处理完（比如球被拍面接住冻结了），
      // 剩下的子步不能再走：球此刻速度是 0，继续推进只会让它往下掉一点点。
      if (go === false) break;
    }
    remain -= h;
    if (!ball.live) break;
  }
}

function substep(b: Ball, h: number, emit: (c: Collision) => void): void {
  const v = b.v;
  const p = b.p;

  // 已经彻底停在地上：不再施加重力，也不再发碰撞事件。
  // 少了这一条，球停住之后每一步都会「再落一次地」，一粒静止的球每秒能刷出 240 个事件，
  // 音效和粒效会被引爆，而且 v[1] 的反号会累积出莫名其妙的抖动。
  if (p[1] <= BALL_R + 1e-3 && Math.abs(v[1]) < 0.08 && Math.hypot(v[0], v[2]) < 0.1) {
    v[0] = 0;
    v[1] = 0;
    v[2] = 0;
    return;
  }

  const speed = vlen(v);

  const a: V3 = [0, -GRAVITY, 0];

  if (speed > 0.05) {
    // 阻力：F = -½ρCdA|v|v，除以质量变成加速度
    const kd = (0.5 * RHO * DRAG_CD * BALL_AREA * speed) / BALL_M;
    a[0] -= kd * v[0];
    a[1] -= kd * v[1];
    a[2] -= kd * v[2];

    // 马格努斯：F = ½ρArC(v × ω)。
    //
    // 注意叉乘顺序是 v × ω，不是 ω × v。搞反的话上旋球会往上飘——
    // 这个错误看起来「也挺像那么回事」，但整个旋转玩法就全废了，
    // 所以 tests 里专门钉了一条「上旋必须下坠」。
    const mag = vcross(v, b.spin);
    const km = (0.5 * RHO * BALL_AREA * BALL_R * MAGNUS_CL) / BALL_M;
    a[0] += km * mag[0];
    a[1] += km * mag[1];
    a[2] += km * mag[2];
  }

  // 半隐式欧拉：先更新速度，再用新速度走位置。比显式欧拉稳定得多，成本一样。
  v[0] += a[0] * h;
  v[1] += a[1] * h;
  v[2] += a[2] * h;

  const z0 = p[2];
  p[0] += v[0] * h;
  p[1] += v[1] * h;
  p[2] += v[2] * h;

  // 旋转衰减。真实网球的旋转大约 4 秒衰减到 37%，比速度慢得多，
  // 所以一个上旋球会「一路带着弧线」飞过去。
  const decay = Math.exp(-h / SPIN_TAU);
  b.spin[0] *= decay;
  b.spin[1] *= decay;
  b.spin[2] *= decay;

  /* ---- 地面 ---- */
  if (p[1] < BALL_R) {
    p[1] = BALL_R;
    if (v[1] < -0.6) {
      const impact = -v[1];
      const ts = topSpinness(b);

      // 上旋落地后「蹿」：水平速度保留更多、弹得更高；下旋则被地面吃掉。
      // 这是网球最直观的物理特征，少了它旋转就只是数字。
      const fricH = clampNum(GROUND_FRIC + ts * 0.18, 0.45, 0.95);
      v[0] *= fricH;
      v[2] *= fricH;
      v[1] = impact * (GROUND_REST + ts * 0.05);

      // 落地会把旋转磨掉一大截
      b.spin[0] *= 0.55;
      b.spin[1] *= 0.55;
      b.spin[2] *= 0.55;

      b.bounces++;
      emit({ kind: 'ground', at: [...p], speed: impact, topSpin: ts });
    } else {
      // 贴地滚动：只做阻尼，不算一次落地
      v[1] = 0;
      const roll = Math.exp(-h / 1.1);
      v[0] *= roll;
      v[2] *= roll;
    }
  }

  /* ---- 球网 ---- */
  // 用「这一步是否跨越了网平面」来判断，而不是比较距离。
  // 40 m/s 的球一步走 16.7cm，靠距离判断必然漏掉；跨越判断不会。
  if ((z0 - NET_Z) * (p[2] - NET_Z) < 0) {
    const tt = (NET_Z - z0) / (p[2] - z0 || 1e-9);
    const yCross = p[1] - v[1] * h * (1 - tt);
    if (yCross < NET_H + BALL_R) {
      emit({ kind: 'net', at: [p[0], yCross, NET_Z] });
      // 撞网：动能基本被吃掉，球直接往下掉
      v[0] *= 0.12;
      v[2] *= -0.16;
      v[1] *= 0.2;
      p[2] = NET_Z + (z0 < NET_Z ? -(BALL_R + 0.02) : BALL_R + 0.02);
      b.spin[0] = b.spin[1] = b.spin[2] = 0;
    }
  }
}

/**
 * 「上旋程度」，-1 到 1。
 *
 * 做法是把旋转向量投影到「上旋对应的旋转轴」上。上旋轴 = 前进方向 × 上，
 * 所以这一项为正就是上旋，为负是下旋。除以 300 是拿 300 rad/s 当「满转」，
 * 因为实测业余挥拍也就 100–250 rad/s。
 */
function topSpinness(b: Ball): number {
  const rate = vlen(b.spin);
  if (rate < 5) return 0;

  const horiz = Math.hypot(b.v[0], b.v[2]);
  if (horiz < 0.5) return 0;

  const dir: V3 = [b.v[0] / horiz, 0, b.v[2] / horiz];
  const topAxis = vcross(dir, [0, 1, 0]);
  const proj = vdot(vnorm(b.spin), topAxis);
  return clampNum(proj * Math.min(1, rate / 300), -1, 1);
}

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const DEG = Math.PI / 180;

interface AimShot {
  /** 过网那一刻的高度。null = 没穿过网平面（不可能，除非被打回来了） */
  netY: number | null;
  /** 第一次落地位置 */
  land: V3 | null;
  hitNet: boolean;
  /** 穿过「到面平面」时的高度。对打要靠它保证来球是能接的高度 */
  planeY: number | null;
}

/**
 * 从 from 以初速 v 打出去，测「过网多高、落在哪」。
 *
 * 和 `probe` 的区别：`probe` 要的是「撞墙之后回到拍面」，这里只要一次落地。
 * 对打模式没有墙，球落地之后还有没有戏由 `Duel` 判，求解器不关心。
 */
function shootToLand(from: V3, v: V3, spin: V3, planeZ: number | null = null): AimShot {
  const b = makeBall(from, v, spin);
  let netY: number | null = null;
  let land: V3 | null = null;
  let hitNet = false;
  let planeY: number | null = null;

  for (let i = 0; i < 240 * 5; i++) {
    let zPrev = b.p[2];
    let yPrev = b.p[1];
    advance(
      b,
      PHYS_DT,
      (c) => {
        if (c.kind === 'net') hitNet = true;
        if (c.kind === 'ground' && !land) land = [c.at[0], c.at[1], c.at[2]];
      },
      (_p0, p1) => {
        // 过网高度只能在子步里插值：40 m/s 的球一步走 17cm，
        // 用两端点判会漏掉「正好在网平面上下」的那一步。
        if ((zPrev - NET_Z) * (p1[2] - NET_Z) <= 0 && p1[2] !== zPrev) {
          const k = (NET_Z - zPrev) / (p1[2] - zPrev);
          netY = yPrev + (p1[1] - yPrev) * k;
        }
        if (planeZ !== null && (zPrev - planeZ) * (p1[2] - planeZ) <= 0 && p1[2] !== zPrev) {
          const k = (planeZ - zPrev) / (p1[2] - zPrev);
          planeY = yPrev + (p1[1] - yPrev) * k;
        }
        zPrev = p1[2];
        yPrev = p1[1];
      }
    );
    // 缓落的球可能触发不了 ground 事件（竖直速度小于阈值时按贴地滚动处理），
    // 所以位置这一层要兜一次。
    if (!land && b.p[1] <= BALL_R + 1e-3) land = [b.p[0], BALL_R, b.p[2]];
    if (hitNet) break;
    // 要测到面高度时，两个量都得拿到才停：球可能在**还没落地**的时候就穿过了
    // 到面平面（玩家要凌空打），之后才落在界内。只拿到一个就 break 的话，
    // 前者会丢 land、后者会丢 planeY，两种合法球都被判成无解。
    if (planeZ === null) {
      if (land) break;
    } else if (land && planeY !== null) {
      break;
    }
    if (b.bounces > 3) break;
  }
  return { netY, land, hitNet, planeY };
}

export interface AimOptions {
  /** 过网最低余量（米）。太贴着网会被判撞网 */
  minClear?: number;
  /**
   * 过网最高余量（米）。
   *
   * 这个上限不是为了真实感，是**必需的**：目标落点是 2 个约束、初速是 3 个未知量，
   * 有 1 个自由度。不加上限时求解器会挑最省力的那条——实测「打深球」解出
   * 过网 3.39 米的月亮球。真实球员不会这么打，回球机也不该。
   */
  maxClear?: number;
  /** 有效落点区间 */
  zMin?: number;
  zMax?: number;
  xMax?: number;
  /** 初速扫描区间（m/s） */
  speed?: [number, number];
  /**
   * 到面高度约束：球穿过 `arriveZ` 时的高度必须落在 `arriveY` 区间内。
   *
   * 这是对打模式的**硬需求**，不是打磨。拍面中心永远在握点沿拍柄 0.6 米的
   * 球壳上（`faceCenter`），握点高度又被人的身高锁死：来球到面高度低于 1.1 米
   * 或高过 2.0 米，玩家就物理上够不着。第一版只约束落点，实测发球到面高度
   * 只有 0.17 米，玩家一帧都接不到。
   */
  arriveZ?: number;
  arriveY?: [number, number];
  /**
   * 到面高度允许的偏差（米）。默认 0.2。
   *
   * 收紧它会让求解器更愿意换一个落点，而不是给一条「高度差了 20cm」的球。
   * 回球机用 0.12：玩家的拍面只能在 1.22–1.6m 那一段，差 20cm 就得靠压手腕
   * 去补，而压手腕会连带把拍面朝向转歪，出球方向跟着歪。
   */
  arriveTol?: number;
}

/**
 * 给定期望落点，求出球速度。
 *
 * 这是整条链路上**唯一**的「我要球落在哪儿 → 该用什么速度打」的求解器：
 * 回球机回球、发球、探针喂球全都调它（`docs/history.md` 4.27 合并掉墙打之后，
 * 原来还有一份 `liftOverNet`，它已经把球送回去、不需要反解落点）。
 *
 * ## 为什么是扫描而不是解析解
 *
 * 有阻力和马格努斯，弹道没有闭式解。而这里最多 3 个待定量（速度、仰角、方位），
 * 落点误差的单调性足够好，粗扫 + 局部细化就能到厘米级。
 *
 * 方位角不扫，直接用几何算初值：横向偏转主要由「朝目标的水平方向」决定，
 * 马格努斯带来的偏移只有几十厘米，交给后面的细化去修。
 *
 * 成本：粗扫 11×11 ≈ 121 次试射，每次 1.1 秒弹道（264 个子步），合计约 0.4ms。
 * 回球机每拍才调一次，不进 60Hz 主循环。
 */
export function aimIntoCourt(
  from: V3,
  target: V3,
  spin: V3 = [0, 0, 0],
  opts: AimOptions = {}
): V3 | null {
  const minClear = opts.minClear ?? 0.25;
  const maxClear = opts.maxClear ?? 1.4;
  const zMin = opts.zMin ?? NET_Z + 0.2;
  const zMax = opts.zMax ?? BASELINE_Z - 0.2;
  const xMax = opts.xMax ?? HALF_WIDTH - 0.2;
  const [sLo, sHi] = opts.speed ?? [14, 34];
  const arriveZ = opts.arriveZ ?? null;
  const [aYLo, aYHi] = opts.arriveY ?? [0, 0];
  const arriveTol = opts.arriveTol ?? 0.2;

  const dz = target[2] - from[2];
  const dx = target[0] - from[0];
  if (Math.abs(dz) < 1) return null;
  const theta0 = Math.atan2(dx, dz) / DEG;

  let best: { v: V3; cost: number; landErr: number; miss: number } | null = null;
  let bs = 20;
  let ba = 10;
  let bt = theta0;

  /**
   * 到面高度不满足的代价。权重 8 的意思是「差 10cm 比落点偏 80cm 还严重」——
   * 落点偏一点只是球路不理想，高度不对是玩家根本打不到。
   */
  const ARRIVE_WEIGHT = 8;

  const trial = (s: number, alphaDeg: number, thetaDeg: number): number => {
    const a = alphaDeg * DEG;
    const th = thetaDeg * DEG;
    const v: V3 = [
      s * Math.cos(a) * Math.sin(th),
      s * Math.sin(a),
      s * Math.cos(a) * Math.cos(th),
    ];
    const r = shootToLand(from, v, spin, arriveZ);
    if (r.hitNet || !r.land || r.netY === null) return Infinity;
    if (r.netY < NET_H + minClear || r.netY > NET_H + maxClear) return Infinity;
    if (Math.abs(r.land[0]) > xMax) return Infinity;
    if (r.land[2] < zMin || r.land[2] > zMax) return Infinity;

    const landErr = Math.hypot(r.land[0] - target[0], r.land[2] - target[2]);
    // 到面高度：拿不到（球在到面之前就滚停了）按差得最远算
    const py = r.planeY;
    const miss = py === null ? 9 : Math.max(0, aYLo - py, py - aYHi);
    const cost = landErr + ARRIVE_WEIGHT * miss;

    if (!best || cost < best.cost) {
      best = { v, cost, landErr, miss };
      bs = s;
      ba = alphaDeg;
      bt = thetaDeg;
    }
    return cost;
  };

  // 粗扫：速度 × 仰角。方位角先用几何初值，细化阶段再修。
  //
  // 仰角上限给到 46°，不是保守估计——对打里要让球「落在界内、并且到面时
  // 还有 1.2–1.7 米高」，唯一可行的族是慢而高的抛物线（实测 10 m/s / 40°）。
  // 上限只到 22° 的话，整个可行域都扫不到，求解器会对任何目标都返回 null。
  for (let s = sLo; s <= sHi + 1e-6; s += 2) {
    for (let al = -8; al <= 46 + 1e-6; al += 3) trial(s, al, theta0);
  }
  if (!best) return null;

  // 局部细化：三个维度一起收，步长每轮减半。3 轮够到厘米级。
  let step = { s: 1, a: 1.5, t: 2 };
  for (let iter = 0; iter < 3; iter++) {
    const c = { s: bs, a: ba, t: bt };
    for (const ds of [-step.s, 0, step.s]) {
      for (const da of [-step.a, 0, step.a]) {
        for (const dt of [-step.t, 0, step.t]) trial(c.s + ds, c.a + da, c.t + dt);
      }
    }
    step = { s: step.s / 2, a: step.a / 2, t: step.t / 2 };
  }

  const out = best as { v: V3; cost: number; landErr: number; miss: number };
  // 落点必须在半米内，到面高度必须在 20cm 内。超出说明这个目标在这套初始条件下
  // 打不到——与其硬给一条会出界或接不到的弧线，不如让调用方换目标或判失误。
  if (out.landErr > 0.5) return null;
  if (arriveZ !== null && out.miss > arriveTol) return null;
  return out.v;
}

/* ---------------- 到面预测 ---------------- */

/** 球以什么状态穿过某个 z 平面。`t` 是从调用那一刻算起的秒数。 */
export interface PlaneHit {
  t: number;
  x: number;
  y: number;
  z: number;
}

/**
 * 球会以什么 x/y 穿过 `planeZ`，以及还有多久。
 *
 * 把球复制一份往前推，而不是线性外推——来球中途还要落地弹一次，落地会削掉
 * 26% 的横向速度并改变竖直方向，整条弹道外推会把那一拐算错（墙打的 sim 踩过）。
 * 复制时把已落地次数带过去，反弹次数的语义才连续。
 *
 * 回球机（`machine.ts`）和玩家自动走位（`auto-move.ts`）共用这一份：两边看的是
 * 同一个球，预测算法不一致的话，会出现「机器算出来的点对得上、玩家算出来的差半米」。
 */
export function predictAtPlane(ball: Ball, planeZ: number): PlaneHit | null {
  const b = makeBall(ball.p, ball.v, ball.spin);
  b.bounces = ball.bounces;
  let zPrev = b.p[2];
  let t = 0;
  for (let i = 0; i < 240 * 3; i++) {
    advance(b, PHYS_DT, () => {});
    t += PHYS_DT;
    if ((zPrev - planeZ) * (b.p[2] - planeZ) <= 0 && b.p[2] !== zPrev) {
      return { t, x: b.p[0], y: b.p[1], z: planeZ };
    }
    if (!b.live) return null;
    zPrev = b.p[2];
  }
  return null;
}

/**
 * 球在 z ∈ [zA, zB] 区间内的穿越采样点，按时间（也就是 z 增大）排序。
 *
 * 为什么不是「再调一次 `predictAtPlane` 拿某个平面」：自动走位要的不是某一个平面
 * 的穿面点，而是**整段可站范围里球的高度怎么变**。玩家往后退 0.5m，球就晚 0.1 秒
 * 到、低 0.4m —— 挑哪个 z 站，等于挑「球在什么高度进拍面」。这条曲线只能靠采样
 * 弹道拿到，解析式在带阻力 + 马格努斯 + 落地反弹的积分器里没有。
 *
 * 网格刻意固定（默认 10cm），不跟着球速走：目标点的 z 一帧一变会让玩家往前跑。
 * 落地反弹那一段 z 仍然单调，所以按 z 插值不会出现一格两个解。
 */
export function sampleCrossings(ball: Ball, zA: number, zB: number, step = 0.1): PlaneHit[] {
  const lo = Math.min(zA, zB);
  const hi = Math.max(zA, zB);
  const out: PlaneHit[] = [];
  if (!ball.live || step <= 0 || hi <= lo) return out;

  const b = makeBall(ball.p, ball.v, ball.spin);
  b.bounces = ball.bounces;
  let t = 0;
  // 落地次数。**第二次在我方半场落地时这一球就死了**（`rally` / `duel` 的
  // 「两次落地」规则），再往后推出来的是不存在的弹道。
  //
  // 这不是优化，是正确性。不截断时规划器会看到「球二次弹起后还会飘到 z=0.3」，
  // 于是让人站在击球面等着，而球在 1.7 米外就判死了——实测这正是「网前的球
  // 走不过去」里最大的一类：球落在 z≈-8，弹一下在 z≈-1.4 就二次落地
  //（实测 vz=13 / vy=5.5 那一条：-8.01 → -1.40）。
  // 判据要跟判决处完全一致（`bounces >= 2` 且落点在我方半场），不能只数「从现在
  // 起还要弹几次」——来球往往已经弹过一次了。
  let bounces = ball.bounces;
  let dead = false;

  for (let i = 0; i < 240 * 3; i++) {
    const p0: V3 = [b.p[0], b.p[1], b.p[2]];
    const t0 = t;
    advance(b, PHYS_DT, (c) => {
      if (c.kind !== 'ground') return;
      bounces++;
      if (bounces >= 2 && c.at[2] > NET_Z) dead = true;
    });
    t += PHYS_DT;
    if (dead) break;
    const p1 = b.p;
    const dz = p1[2] - p0[2];

    if (dz !== 0) {
      const segLo = Math.min(p0[2], p1[2]);
      const segHi = Math.max(p0[2], p1[2]);
      // 只在 [lo, hi] 内找第一条还没越过的网格线，避免 O(网格总数) 的空转
      const first = Math.ceil((Math.max(segLo, lo) - lo) / step - 1e-9) * step + lo;
      for (let g = first; g <= segHi + 1e-9; g += step) {
        if (g > hi + 1e-9) break;
        if (g < lo - 1e-9) continue;
        const u = (g - p0[2]) / dz;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        out.push({
          t: t0 + u * PHYS_DT,
          x: p0[0] + (p1[0] - p0[0]) * u,
          y: p0[1] + (p1[1] - p0[1]) * u,
          z: g,
        });
      }
    }
    if (!b.live) break;
    // 球朝我飞时 z 单调增大，越过区间上界就没必要再推了（多数调用省掉一半以上步进）
    if (b.p[2] > hi) break;
  }
  return out;
}
