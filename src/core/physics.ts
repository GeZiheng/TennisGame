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
  WALL_REST,
  WALL_Z,
  WALL_H,
  HIT_Z,
  NET_Z,
  NET_H,
  SPIN_TAU,
  PHYS_DT,
  RETURN_OFF_TOL,
  HALF_WIDTH,
  BASELINE_Z,
} from './court';

/**
 * 练习墙是否参与碰撞。
 *
 * 墙打模式需要它（球必须自己飞回来），对打模式必须关掉它——对手站在
 * 网后 10.8 米，球从那里往玩家这边飞，会先经过 `WALL_Z`(-11.9) 被弹回去，
 * 一球都过不了网。
 *
 * 用模块级开关而不是给 `advance` 加参数，是因为墙碰撞埋在 `substep` 最里层，
 * 每帧要过 4 次；加参数会改到每一个调用点（含测试和 probe），
 * 而这个开关只在模式切换时写一次。默认 true，墙打模式与既有单测行为完全不变。
 */
let wallActive = true;
export function setWallActive(on: boolean) {
  wallActive = on;
}
import { sweepFace, type RacketPose } from './racket';

export interface Ball {
  p: V3;
  v: V3;
  /** 角速度向量（rad/s），模长是转速，方向是旋转轴 */
  spin: V3;
  /** 落地次数 */
  bounces: number;
  /** 撞墙次数 */
  wallHits: number;
  /** 是否还在规则内（出界后由 rally 判死） */
  live: boolean;
}

export type Collision =
  | { kind: 'ground'; at: V3; speed: number; topSpin: number }
  | { kind: 'wall'; at: V3; speed: number }
  | { kind: 'net'; at: V3 };

export function makeBall(p: V3, v: V3, spin: V3 = [0, 0, 0]): Ball {
  return { p: [...p], v: [...v], spin: [...spin], bounces: 0, wallHits: 0, live: true };
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

  /* ---- 练习墙 ---- */
  if (wallActive && p[2] < WALL_Z + BALL_R) {
    p[2] = WALL_Z + BALL_R;
    if (v[2] < 0) {
      const impact = -v[2];
      v[2] = impact * WALL_REST;
      // 软垫墙会把斜着打上去的球「吸」一下，方向更垂直地弹回来
      v[0] *= 0.9;
      v[1] *= 0.9;
      b.wallHits++;
      emit({ kind: 'wall', at: [...p], speed: impact });
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

/**
 * 球落地弹起之后，把这一球重新瞄准到「拍面现在所在的点」。
 *
 * 为什么必须在落地那一刻重瞄，而不是发球时一次算准：
 *
 *   发球那一刻拍面在哪，两秒后球到的时候拍面**已经不在那了**。玩家会走位、
 *   会转手机、会抬拍准备击球，拍面中心挂在一根 0.6 米长的杆子末端，
 *   手机转 30° 它就平移 30 厘米——比整个拍面还宽。于是「看着球到身边了、
 *   也挥了，就是不弹」变成常态，而玩家完全无法理解：他看到的拍子确实在那里。
 *
 *   落地是整条弹道上**唯一一个不会被察觉的修正点**：球在这一刻本来就要
 *   剧烈改变方向，横向挪几厘米、纵向调几厘米，眼睛读不出来。发球时瞄一次、
 *   落地时按「此刻的拍面」再瞄一次，球就真的冲着玩家手里那把拍子去了。
 *
 * 求解只有两个未知量（vx, vy），两个约束（到 targetZ 时 x、y 命中目标），
 * vz 保持不变（不改变落点距离，也就不改变节奏）。无阻力解析解打底，
 * 再用真实物理试算两次修正阻力与马格努斯造成的偏差。
 *
 * @param maxTurn 允许的相对原速度的最大横向修正（m/s）。太大就成了追踪导弹，
 *   球会在空中明显拐弯。默认 1.6，正常走位和转手机都在这个范围内。
 */
export function aimAfterBounce(
  ball: Ball,
  target: V3,
  maxTurn = 1.6
): { ok: boolean; t: number } {
  const [tx, ty, tz] = target;
  const vz = ball.v[2];
  if (vz <= 0.4) return { ok: false, t: 0 };

  const t = (tz - ball.p[2]) / vz;
  // 太近：已经来不及改（改出来的速度会大到荒谬）；太远：这不是「快到了」，是出界了
  if (t < 0.12 || t > 1.8) return { ok: false, t };

  // 无阻力解析解：x 线性，y 抛物线
  let vx = (tx - ball.p[0]) / t;
  let vy = (ty - ball.p[1] + 0.5 * GRAVITY * t * t) / t;

  // 阻力让球飞不到目标，按 t 折算回去；两次足够（网球阻力在 2 米内只差几厘米）
  for (let i = 0; i < 2; i++) {
    const probe = makeBall([...ball.p], [vx, vy, vz], [...ball.spin]);
    let end: V3 | null = null;
    let zPrev = probe.p[2];
    for (let k = 0; k < 600; k++) {
      advance(probe, PHYS_DT, () => {});
      if (zPrev < tz && probe.p[2] >= tz) {
        end = [probe.p[0], probe.p[1], probe.p[2]];
        break;
      }
      if (!probe.live) break;
      zPrev = probe.p[2];
    }
    if (!end) break;
    const ex = tx - end[0];
    const ey = ty - end[1];
    if (Math.abs(ex) < 0.005 && Math.abs(ey) < 0.005) break;
    vx += ex / t;
    vy += ey / t;
  }

  // 修正量限幅：横向 1.6 m/s（2 米飞行约 20cm 位移），纵向放宽到 4.5——
  // 高度差一两档握法就是二三十厘米，纵向修正必须够用，而纵向改的是「弹多高」，
  // 在落地瞬间本来就看不出来。
  const dvx = clampNum(vx - ball.v[0], -maxTurn, maxTurn);
  const dvy = clampNum(vy - ball.v[1], -4.5, 4.5);
  ball.v[0] += dvx;
  ball.v[1] += dvy;
  return { ok: true, t };
}

/** 球是否已经彻底飞出场外（由 rally 用来判失误）。 */
export function isOutOfPlay(b: Ball): boolean {
  return (
    Math.abs(b.p[0]) > 9 || b.p[2] > 6 || b.p[2] < WALL_Z - 2 || b.p[1] > 12 || b.p[1] < -1
  );
}

/**
 * 保证这一拍打过去以后，球能自己飞回来、而且回来时在够得着的高度。
 *
 * 手机测出来的挥拍速度比真球拍低不少，轻挥可能只有 13 m/s，按这个速度直线打出去必然下网。
 * 真实球员遇到这种球不会硬打平击，而是抬高一点、把球「兜」过去——这里替玩家做同样的补偿，
 * 只抬高垂直分量，水平方向原样保留，所以「往左打还是往右打」仍然由拍面决定。
 *
 * 为什么要一路模拟到「球回到手边」，而不是只检查过网或撞墙高度：
 * 这三件事是连锁的，只满足前一件没用。轻打时球撞墙位置低（y≈1.3），
 * 而球在撞墙那一刻就已经在往下掉了，反弹后 1.4 米就掉到网下——
 * 表现就是「我明明把球打过去了，它却没回来」。所以目标只能是回球高度本身。
 *
 * 为什么用扫描而不是二分：回球高度对仰角不单调（太陡会飞过头、太缓会撞网），
 * 二分在这里会收敛到错误的解。
 *
 * ## 「回来时够得着」到底怎么判定
 *
 * 最早写的是「球穿过击球竖平面 z=targetZ 时，高度在拍面中心 ±12cm」。这个模型
 * 在拍面水平时近似成立，拍面一倾斜就全错，而且错得很隐蔽：倾斜的拍面是一张
 * **斜的盘**，上升中的球穿过盘平面的点比穿过竖平面的点低十几厘米
 * （18° 倾斜实测差 15cm）。于是补偿器选出「过竖平面时 1.6m」的弧线，
 * 实际从拍面下沿下面两厘米掠过去——模拟里表现为偶发的 reach 漏接，
 * 每一次都伴随 7.5m 以上的撞墙（窗口太窄，扫描一路跳到高吊才命中）。
 *
 * 现在传了 pose 就用**和游戏内判定完全同一套数学**（sweepFace）验证回球：
 * 逐个物理子步检查「回球这一段有没有穿过拍面椭圆盘」。判据从此和「球回来
 * 到底打不打得到」是同一件事，不再有模型偏差。没传 pose 时（单元测试、
 * 调参工具）退回旧的竖平面窗口模型。
 *
 * ## 可行解里挑哪一个
 *
 * 扫全程、不取第一个，也不挑**最居中**的（那是旧行为，见 RETURN_OFF_TOL 的说明）：
 * 所有落点偏离在 55% 半径以内的弧线都是合格解，**随机挑一条**。
 *
 * 为什么要留这个随机：补偿器用的位姿是击球那一刻的快照，球飞回来要两秒多，
 * 玩家早就走开了——所以每一条合格弧线都能打到。而总挑最居中的那条，
 * 会让每一拍都回到拍面正中央，玩家两拍之后就只看时间、不看球了。
 *
 * 撞墙高度超过可见墙面（WALL_H）的弧线不进池子：墙只有 5.2m 高，更高的「撞墙」
 * 是物理在一面不存在的墙上弹了一下，回球会从天上砸下来、在脚前大力弹起，
 * 正是要避免的那类球。全都超过墙高时才退而求其次。
 */
export function liftOverNet(
  p: V3,
  v: V3,
  spin: V3 = [0, 0, 0],
  /**
   * 球拍所在的位置——球要回到这里，不是回到某个固定平面。
   *
   * 原来是写死的 HIT_Z。严格碰撞上线后这个假设不成立了：拍面中心在握点
   * 上方 FACE_CY，拍子一倾斜，中心就前移十几到四十厘米。照着 z=0.3 去算，
   * 球回来时会从拍面上方 30cm 掠过——补偿算得再准也白搭，它瞄的位置本来就不对。
   */
  targetZ = HIT_Z,
  targetY = 1.45,
  /**
   * 击球那一刻的拍面位姿。给了它，回球判定就从「竖平面上的高度窗口」
   * 升级成「是否真的穿过拍面椭圆盘」，见上面的说明。
   */
  pose?: RacketPose
): V3 {
  if (p[2] - WALL_Z <= 0.2) return v;

  // 回球高度围绕拍面中心 ±12cm。
  //
  // 拍面半长 19cm + 球半径，理论可击高度是 ±22cm；收窄到 ±12cm 是为了让球
  // 稳定落在**甜区**而不是拍框内沿——擦框也算命中，但出球方向会歪，
  // 而且玩家会觉得「每一拍都很勉强」。
  const LO = targetY - 0.12;
  const HI = targetY + 0.12;
  const MAX_LIFT = 13;

  // 玩家自己打出的仰角如果能用，就一点都别改。
  // 补偿的职责是「兜底」，不是「替你选球路」——球已经能好好回来时改它，
  // 玩家会觉得「我明明打的是平击，怎么变成挑高球了」。
  const own = probe(p, v, spin, targetZ, pose);
  if (pose ? own.ok : own.ok && own.backY !== null && own.backY >= LO && own.backY <= HI) {
    return v;
  }

  /** 撞墙没超过可见墙面、且落点离拍面中心够近的候选——合格回球的池子 */
  const pool: { vy: number; off: number }[] = [];
  /** 撞墙没超过墙面但偏离过大的，兜底用（池子空了才用） */
  let pick: { vy: number; off: number } | null = null;
  /** 超过可见墙面的也留一个，防止墙高线以上什么都没有 */
  let pickAny: { vy: number; off: number } | null = null;
  /** 旧判据（竖平面窗口）的兜底：最接近可用区间的那一个 */
  let best: { vy: number; miss: number } | null = null;

  // 扫描起点是 0，不是 max(v[1], 0)。
  //
  // 原来「只许抬高、不许压低」的前提是「压低一定下网」。但球撞的是练习墙，
  // 压平之后球撞墙的位置更低、反弹回来也更低，照样能过网——probe 会验证，
  // 撞网的那几个 vy 直接 ok=false 跳过。
  //
  // 这个下限卡死过一整档手感：全力挥的出射仰角本身就有 6 m/s，所有 vy 都从 6 起，
  // 球飞过去撞墙时已经两米七，回来三米高，从头顶飞过。补偿试了 33 个角度全部失败，
  // 最后原样返回——看起来像补偿没生效，其实是根本没得选。
  for (let vy = 0; vy <= MAX_LIFT + 1e-6; vy += 0.4) {
    const r = probe(p, [v[0], vy, v[2]], spin, targetZ, pose);

    if (pose && r.ok && r.hit) {
      const cand = { vy, off: r.hit.offCenter };
      const inside = r.wallY !== null && r.wallY <= WALL_H + 0.05;
      if (inside) {
        // 落点还在「拍面附近」就算合格，不要求最居中（见 RETURN_OFF_TOL）
        if (cand.off <= RETURN_OFF_TOL) pool.push(cand);
        if (!pick || cand.off < pick.off) pick = cand;
      }
      if (!pickAny || cand.off < pickAny.off) pickAny = cand;
      continue;
    }

    if (!r.ok || r.backY === null) continue;

    // 没传 pose 时保持旧语义：第一个落进窗口的就直接用（弧线最低、飞得最快）
    if (!pose && r.backY >= LO && r.backY <= HI) return [v[0], vy, v[2]];

    // 没有完美的，记下最接近可用区间的那个兜底
    const miss = Math.min(Math.abs(r.backY - LO), Math.abs(r.backY - HI));
    if (!best || miss < best.miss) best = { vy, miss };
  }

  // 粗网格步长 0.4 可能正好跳过合适的那一档——实测同一拍，vy 差 0.2，
  // 回球偏离从 0.75（拍沿）跳到 0.09（甜区）。池子空的时候在最优候选附近
  // 按 0.1 补一圈，把「够得着」的解捞回来。9 次探测，一拍一次，可以忽略。
  if (pool.length === 0) {
    const base = pick ?? pickAny;
    if (base) {
      const wallCap = pick ? WALL_H + 0.05 : Infinity;
      for (let d = -0.4; d <= 0.4001; d += 0.1) {
        const vy = base.vy + d;
        if (vy < 0 || Math.abs(vy - base.vy) < 1e-9) continue;
        const r = probe(p, [v[0], vy, v[2]], spin, targetZ, pose);
        if (!(pose && r.ok && r.hit)) continue;
        const inside = r.wallY !== null && r.wallY <= wallCap;
        const cand = { vy, off: r.hit.offCenter };
        if (inside && cand.off <= RETURN_OFF_TOL) pool.push(cand);
        if (inside && (!pick || cand.off < pick.off)) pick = cand;
        if (!pickAny || cand.off < pickAny.off) pickAny = cand;
      }
    }
  }

  // 合格解里**随机**挑一个，不再挑最居中的。
  //
  // 这是「回球不要每次都吸到拍面中心」的落地点。以前这里挑 offCenter 最小、
  // 还按 0.1 步长细化一圈，于是每一拍都回到甜区正中央——玩家两球之后就
  // 不用再看球在左边还是右边了，接球退化成打地鼠。
  //
  // 随机挑的代价是回球弧线会变（撞墙高度、回到手边的高度都会浮动），
  // 但每一条都经过 probe 验证、都在 RETURN_OFF_TOL 以内，也就是
  // 「一定够得着，只是不在正中」。
  const chosen = pool.length > 0
    ? pool[Math.floor(Math.random() * pool.length)]
    : (pick ?? pickAny);
  if (chosen) return [v[0], chosen.vy, v[2]];
  if (best) return [v[0], best.vy, v[2]];
  return [v[0], Math.min(Math.max(v[1], 0), MAX_LIFT), v[2]];
}

interface ProbeResult {
  ok: boolean;
  wallY: number | null;
  backY: number | null;
  /** 回球穿过拍面的信息（只有传了 pose 且真的穿过才有） */
  hit: { offCenter: number; at: V3 } | null;
}

/**
 * 试算一条完整往返：打出去 → 过网 →（网前可落地）→ 撞墙 → 弹回来 → 越过来球线。
 *
 * 撞墙/撞网必须用碰撞事件判断，不能用「位置是否越过某个 z」——
 * 碰撞后球的位置会被修正回墙外一点点（防止卡进去），
 * 所以 p[2] <= WALL_Z 这种判断永远不成立。
 * 这个坑一开始就踩了：所有轻球都被当成「飞不到墙」，于是被兜成六米高的高吊球。
 *
 * 墙前允许落地是这一版的关键：否则每一拍都被迫打墙上空，慢球只能兜成
 * 从墙顶飞过的月亮球，「落点离球网近一些」永远做不到。两道闸：
 * 第一跳必须过网（落在我方半场 = 这一拍根本没打过去），墙前最多跳两次
 * （地滚球回来一定撞网，让后面撞网的判定去否掉它）。
 *
 * 传了 pose 时多一条终局判定：回球逐个物理子步和拍面椭圆盘求交
 * （sweepFace，和游戏内击球判定同一套数学）。穿过即 ok，backY 是穿过点高度；
 * 从玩家身后 80cm 飞过去都算没够着。出球腿不检查——球一开始就贴在拍面上，
 * 前几个子步必然「命中」，那是假象。
 */
function probe(p: V3, v: V3, spin: V3, targetZ: number = HIT_Z, pose?: RacketPose): ProbeResult {
  const b = makeBall(p, v, spin);
  let wallY: number | null = null;
  let reachedWall = false;
  /** 撞墙之前的落地次数 */
  let bounces = 0;
  /** 撞墙之后的落地次数。撞墙后重新计数——之前可能已经在网前跳过了 */
  let bouncesAfter = 0;
  /** 回球穿过拍面的位置（面内归一化偏离 + 世界坐标） */
  let hit: { offCenter: number; at: V3 } | null = null;
  // 赋值发生在 advance 的回调里，TS 的控制流分析看不见，直接读会被误判成
  // 永远是 null（true 分支 narrowing 成 never）。包一层函数按声明类型读。
  const hitInfo = (): { offCenter: number; at: V3 } | null => hit;

  for (let i = 0; i < 1600; i++) {
    let hitWall = false;
    let bad = false;
    advance(
      b,
      PHYS_DT,
      (c) => {
        if (c.kind === 'net') bad = true;
        if (c.kind === 'wall') {
          hitWall = true;
          wallY = c.at[1];
        }
        if (c.kind === 'ground') {
          if (reachedWall) {
            bouncesAfter++;
          } else {
            bounces++;
            if (bounces === 1 && c.at[2] > NET_Z) bad = true;
          }
        }
      },
      pose
        ? (p0, p1) => {
            // 只在下山回来的路上检查：出球腿球就贴在拍面上，必然假命中；
            // 还没过网的球也不可能够到拍面（网在 -10.5，拍面在 0.3 附近）。
            if (!hit && reachedWall && !bad && b.p[2] > NET_Z) {
              const h = sweepFace(pose, p0, p1);
              if (h) hit = { offCenter: h.offCenter, at: h.at };
            }
          }
        : undefined
    );

    if (bad) return { ok: false, wallY: null, backY: null, hit: null };
    if (hitWall) reachedWall = true;

    if (reachedWall) {
      const h = hitInfo();
      if (h) return { ok: true, wallY, backY: h.at[1], hit: h };
      if (pose) {
        // 盘形判定下「到平面」不算数——球可能从盘子旁边过去。
        // 越过玩家身后 80cm 还没碰上拍面 = 这一拍够不着。
        if (b.p[2] > targetZ + 0.8) return { ok: false, wallY: null, backY: null, hit: null };
      } else if (b.p[2] >= targetZ) {
        return { ok: true, wallY, backY: b.p[1], hit: null };
      }
      if (bouncesAfter >= 2) return { ok: false, wallY: null, backY: null, hit: null };
    } else if (bounces > 2) {
      return { ok: false, wallY: null, backY: null, hit: null };
    }
  }
  return { ok: false, wallY, backY: null, hit: null };
}

/**
 * 喂球出射仰角：让球从 (0, y0, fromZ) 出发、以 vz 平速飞来，
 * 越过击球面 targetZ 时高度正好是 targetY。
 *
 * 为什么要求解而不是写死：喂球高度现在是**自适应**的——瞄玩家当前拍面中心
 * （见 Rally.serve）。拍面高度随握法在 1.0–1.6m 之间变化，写死的仰角只能
 * 照顾一种握法，另一种就是「球总从头顶或者脚边过去」。竖直运动受阻力影响
 * 没有闭式解，但「vy 越大、到达越高」严格单调，二分 28 次足够精确。
 * 每次喂球算一次（约 7000 个物理步），可以忽略。
 *
 * targetZ 也必须传：玩家能前后走位（HIT_Z−0.55 到 +1.35），击球面不再固定在
 * HIT_Z。照着固定平面解出来的仰角，后退一米就会让球早到 0.1 秒、低十几厘米。
 *
 * ⚠️ 这个函数有个**结构性缺陷**，所以只在 feedBounce 解不出时兜底：
 * 它要求球一口气飞到击球面，中途不许落地。玩家退到后场时飞行距离 12m 以上、
 * vz 只有 10.5，球必然中途落地——而 heightAt 提前落地时返回 -1，
 * 二分于是认为「仰角还不够」，一路加到上限 12，把球变成从墙顶飞过的月亮球。
 * 玩家看到的是「发球又高又飘，退到后场也够不到」。弹地喂球不存在这个问题：
 * 落地是**设计的一部分**，不是失败。
 */
export function feedVy(
  y0: number,
  targetY: number,
  vz: number,
  fromZ = -11,
  targetZ = HIT_Z
): number {
  const heightAt = (vy: number): number => {
    const b = makeBall([0, y0, fromZ], [0, vy, vz]);
    for (let i = 0; i < 240 * 4; i++) {
      const z0 = b.p[2];
      advance(b, PHYS_DT, () => {});
      if (z0 < targetZ && b.p[2] >= targetZ) return b.p[1];
      if (!b.live) break;
    }
    return -1; // 到不了来球线（提前落地或飞出），当作极低
  };

  // 区间要盖得住最远的站位：玩家退到 z=1.65 时飞行 12.65m，初速 10.5 m/s
  // 要飞 1.4 秒以上，仰角给到 12 才够（原来 10 在极端站位上会顶到边界）。
  let lo = -8;
  let hi = 12;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (heightAt(mid) < targetY) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 一次弹地喂球的解 */
export interface FeedShot {
  /** 初速度（含 vx） */
  v: V3;
  /** 第一次落地的 z */
  dropZ: number;
  /** 弹起后穿过拍面平面时的高度 */
  hitY: number;
  /** 弹起后穿过拍面平面时的竖直速度。负 = 球正在下落，接起来最自然 */
  hitVy: number;
  /**
   * 弹起后真正的最高点（顶点）位置。
   *
   * 判定「喂球好不好」用的是这个，不是 hitY：玩家看到的是球在哪儿最高，
   * 而系统只承诺「最高点落在拍面附近」。有了它，测试就能直接断言
   * 「顶点在拍面 ±范围」，而不是绕着 hitY 猜。
   */
  apex: V3;
  /** 从发球到第一次落地的飞行时间（秒） */
  fallT: number;
}

/**
 * 弹地喂球：让球在玩家**前方** dropDist 米处落地，弹起来再送到拍面。
 *
 * 为什么要这么喂，而不是像 feedVy 那样直接送过来：
 *
 *   1) 真实网球绝大多数来球是弹地之后的。球在空中飞 10 米直扑脸前，本身就是
 *      一件现实里不会发生的事，看起来假、判断起来也没有参照——玩家不知道该在
 *      哪儿等球，只能靠"看球什么时候到脸上"来挥拍。
 *   2) 有了落点就有了**视觉节拍器**：球第一次落地 = 计时开始，此后球的高度
 *      单调可预测，挥拍时机可以靠看落点学出来。这是体育游戏里最重要的教学信号。
 *   3) 落地把球速和来球高度**解耦**了。直接送过来的球，想让球慢就得压平
 *      （然后撞网），想让它高就得吊起来（然后够不到）。落地之后，弹起的
 *      竖直速度由入射角决定，水平速度由落点距离决定，两者可以分开调。
 *
 * ## 求解方法：单参数（飞行时间）
 *
 * 未知两个（vy, vz），约束两个（落点 = dropZ、弹起后过拍面高度 = targetY）。
 * 但不用二维搜索——参数化成一个东西：**发球到落地的飞行时间 `t`**。
 * t 一旦给定，落点又固定，vz ≈ dist/t、vy 由抛体方程反解，剩下只做几次
 * 落点修正（阻力会缩短射程）。而「弹起后到拍面的高度」对 t **严格单调**：
 * t 越大 → 入射角越陡 → 弹起越高。所以直接二分 t。
 *
 * 一次求解约 60 次模拟（每次 200–1400 步），几毫秒，发球时算一次可以忽略。
 * 比二维网格便宜两个数量级，也不会收敛到错误的解。
 *
 * ## 落点为什么在 1.55–1.85 米
 *
 * 这里控制的实际是**弹起后的顶点落在拍面之后多远**（见返回值 `apex`）。
 * 实测把「落点距离」和「到面竖直速度」摊开看（scripts/probe-feed-scan2.cjs）：
 *
 *   落点距拍面 1.0m → 到面 vy ≈ +3.8 m/s，顶点在拍面后 0.6m，球是蹿上来的
 *   落点距拍面 1.6m → 到面 vy ≈ +1.9 m/s，顶点在拍面后 0.3m，缓升送上手
 *   落点距拍面 2.2m → 到面 vy ≈ +0.4 m/s，顶点几乎就在拍面上，球「悬停」
 *   落点距拍面 2.8m → 到面 vy ≈ −1.0 m/s，顶点在拍面前 0.3m，开始下落
 *   落点距拍面 3.4m → 弹起高度已经掉到拍面以下，够不着
 *
 * 所以由 `FEED_APEX_LEAD − back` 反推：back 0.55–0.85m 对应落点 1.55–1.85m：
 * 球还在缓升，接起来最自然，落点也不会离人太远。
 *
 * 注意这里的约束写的是「穿过拍面时的高度 = targetY」，而不是直接约束顶点。
 * 两者在目标落点区间里只差几厘米（顶点附近竖直速度很小），而「过面高度」
 * 有个额外好处：它顺带保证了击球那一瞬球的高度就是玩家拍面所在的高度——
 * 顶点偏移再多，击球点也不会偏出判定盘。
 */
export function feedBounce(
  start: V3,
  targetZ: number,
  targetY: number,
  dropDist: number,
  vx = 0
): FeedShot | null {
  const dropZ = targetZ - dropDist;
  const dist = dropZ - start[2];
  if (dist < 2) return null; // 落点比发球点还近，没得谈

  /**
   * 模拟一次发球：返回落点 + 弹起后穿过 targetZ 的高度。
   *
   * 用对象装状态而不是裸变量：闭包里的赋值会被 TS 的流分析 narrow 成
   * 初始值类型（null），后面读出来就是 never，编译不过。
   */
  const sim = (
    v: V3
  ): { dropZ: number | null; hitY: number | null; hitVy: number; apex: V3 | null } => {
    const b = makeBall(start, v);
    const st = {
      grounds: 0,
      dropZ: null as number | null,
      hitY: null as number | null,
      hitVy: 0,
      apex: null as V3 | null,
      passed: false,
    };
    const trackApex = () => {
      if (st.grounds < 1) return;
      if (st.apex === null || b.p[1] > st.apex[1]) st.apex = [b.p[0], b.p[1], b.p[2]];
    };

    for (let i = 0; i < 240 * 6; i++) {
      const zPrev = b.p[2];
      const g = { z: null as number | null };
      advance(b, PHYS_DT, (c) => {
        if (c.kind === 'ground') g.z = c.at[2];
      });

      if (g.z !== null) {
        st.grounds++;
        if (st.grounds === 1) st.dropZ = g.z;
        // 弹起之后又落地、而且还没穿过拍面：球没送到，这一组参数作废
        else if (!st.passed) return { dropZ: st.dropZ, hitY: null, hitVy: 0, apex: st.apex };
      }

      if (!b.live) break;
      trackApex();

      if (st.passed) {
        // 过拍面之后继续跑，只为找到真正的顶点：顶点通常落在拍面**之后**
        // 十几到五十厘米（球还在缓升），不继续跑就会把「到面那一刻」误当成顶点。
        if (b.v[1] < 0) break;
        continue;
      }

      if (st.dropZ === null) {
        // 还没落地就到拍面了：这不是弹地球，但仍然报告高度（二分靠它判方向）
        if (b.p[2] >= targetZ) return { dropZ: null, hitY: b.p[1], hitVy: b.v[1], apex: st.apex };
        continue;
      }
      if (zPrev < targetZ && b.p[2] >= targetZ) {
        st.passed = true;
        st.hitY = b.p[1];
        st.hitVy = b.v[1];
        if (b.v[1] < 0) break;
      }
    }
    return { dropZ: st.dropZ, hitY: st.hitY, hitVy: st.hitVy, apex: st.apex };
  };

  /**
   * 给定飞行时间，解出初速度。
   *
   * 先用无阻力抛体估一个起点，再按实际落点修正 vz——阻力会把射程缩短 10–15%，
   * 不修正的话 10 米外的落点会偏近一米多。修正只动 vz 不动 vy：vy 决定弹起
   * 高度，是二分要控制的东西，不能在这里被动过。
   */
  const shoot = (t: number): V3 => {
    const vy = (BALL_R - start[1] + 0.5 * GRAVITY * t * t) / t;
    let vz = dist / t;
    for (let k = 0; k < 5; k++) {
      const r = sim([vx, vy, vz]);
      if (r.dropZ === null) break;
      const err = dropZ - r.dropZ;
      if (Math.abs(err) < 0.02) break;
      vz += err / t;
    }
    return [vx, vy, vz];
  };

  const heightAt = (t: number): number | null => sim(shoot(t)).hitY;

  // t 的区间：0.4s 是 21m/s 左右的平送，1.9s 是很慢的高吊。
  // 两端都要能算出来，否则说明这个落点+高度组合无解，交给调用方兜底。
  const lo0 = 0.4;
  const hi0 = 1.9;
  const hLo = heightAt(lo0);
  const hHi = heightAt(hi0);
  if (hLo === null || hHi === null) return null;
  // 高度随 t 单调增：最平的也弹太高、或最陡的也弹不够 → 这个落点不行
  if (hLo > targetY + 0.02 || hHi < targetY - 0.02) return null;

  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const h = heightAt(mid);
    if (h === null || h < targetY) lo = mid;
    else hi = mid;
  }
  const fallT = (lo + hi) / 2;
  const v = shoot(fallT);
  const r = sim(v);
  if (r.hitY === null || r.dropZ === null) return null;
  return {
    v,
    dropZ: r.dropZ,
    hitY: r.hitY,
    hitVy: r.hitVy,
    // 极端参数下可能连顶点都没走到（球贴地飞过去），退回「到面点」当顶点
    apex: r.apex ?? [start[0], r.hitY, targetZ],
    fallT,
  };
}

/* ---------------- 对打：目标落点 → 出球速度 ---------------- */

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

  // 求解期间必须屏蔽练习墙：对打的出球点可能在墙后面（z=-21.3 < WALL_Z），
  // 墙一开，球还没过网就被弹回来了。这里是临时开关，出了函数就还原，
  // 调用方不需要知道这个细节。
  const prevWall = wallActive;
  wallActive = false;
  try {
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
  } finally {
    wallActive = prevWall;
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
 * 对打模式里这是回球机唯一需要的「算法」：它把「我想把球打到哪里」翻译成
 * 「我要以什么速度击球」。墙打模式不用它——那边是 `liftOverNet`，
 * 目标是把球送回玩家拍面，比这个难（要反解到一张 0.6m 的椭圆盘上）。
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

  for (let i = 0; i < 240 * 3; i++) {
    const p0: V3 = [b.p[0], b.p[1], b.p[2]];
    const t0 = t;
    advance(b, PHYS_DT, () => {});
    t += PHYS_DT;
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
