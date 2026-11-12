/**
 * 自动走位：把「球会从哪儿来」变成「握点该往哪儿挪」。
 *
 * ## 它解决的是什么
 *
 * 严格碰撞上线后，可击球面积就是真实的 30×38cm 拍面；来球的散布是米级。拍子不能
 * 平移的话命中率只有两成——玩家会觉得「判定有问题」，实际上是「你站着没动」。
 * 这个模块只做一件事：把玩家搬到球会经过的位置，**挥拍仍然留给玩家**。
 *
 * ## 走的是拍面中心，不是握点（11-13 修正）
 *
 * 拍面中心挂在握点沿拍柄 0.6m 的杆子末端（`pos + R(q)·(0, FACE_CY, 0)`）。握法一横，
 * 这根杆子就横过去，中心落在握点侧方 0.6m —— 而判定半轴只有 0.24m。所以「把握点 x
 * 对准球的 x」只在拍子竖直时成立；横握时人站对了、拍面却在半米外，看起来就是
 * 「明明够得到却打空」。这里改成让**拍面中心**落到弹道上：握点目标 = 穿面点 − 中心偏移。
 *
 * 偏移由 `app.ts` 用「没在挥拍的那几帧」估计后传进来（`AutoMoveState.center`）。
 * 不能直接用实时拍面中心：挥拍本身会把中心甩出 0.3–1.1m（`docs/history.md` 4.5），
 * 拿它当目标，玩家一挥拍人就被拽走。自动走位只补偿**握法**造成的静态偏移。
 *
 * ## 为什么现在两个轴都动（11-13）
 *
 * 前后（z）决定「球到面时的高度」：同样的球，站前 0.5m 就高 0.4m。只调 x 的话，
 * 球高了低了都只能干看着——竖直判定半轴只有 0.23m，而来球到面高度从 1.0m 到 1.7m
 * 都有（发球散布 + 落地重瞄 + 握法偏移各贡献一点），这个缺口不是横向能补的。
 * 所以沿弹道采样我方半场的可站区间，挑一个「球的高度最接近拍面中心、又来得及走过去」
 * 的平面，x 与 z 一起挪。
 *
 * ## 与其它输入通道的关系
 *
 * 视觉走位（`?vision=1`）和键盘都在 `app.ts` 里排在它前面：手动输入一存在，
 * 这一路就整帧不动，避免两路同时写 `PLAYER` 打架。
 */

import { HIT_Z, RACKET_POS } from './court';
import { sampleCrossings, type Ball, type PlaneHit } from './physics';
import type { V3 } from './vec';

export interface AutoMoveConfig {
  /** 追球时的横移速度上限（m/s）。真实球员 4–5，取 4.8 让「来得及」但仍有极限。 */
  speed: number;
  /** 追球时的前后速度上限（m/s）。真人倒退比横移慢，而且退太多就没法发力。 */
  speedZ: number;
  /** 没有来球时回中线的速度（m/s）。比追球慢，免得球刚离拍人就窜回去。 */
  homeSpeed: number;
  /** 目标死区（米）。差得比这还少就不动，否则会贴着球抖。 */
  deadband: number;
  /**
   * 认定「这球是朝我来的」的最小 z 速度（m/s）。
   * 球飞向墙 / 飞向对手时 z 分量为负，低于这个门槛就当作不是来找我的，直接回中。
   */
  incomingVz: number;
  /**
   * 到面高度偏离拍面中心多少以内算「接得到」（米）。
   * 取竖直判定半轴 `FACE_RY + BALL_R`≈0.23 再留一点余量，只用来标记
   * `reachable`（给 HUD 提示「该举拍/该退」），不参与选点——选点永远挑最接近的。
   */
  yTol: number;
  /** 站位的横向极限（米）。球更靠外时只能尽量靠近。 */
  maxX: number;
  /** 站位的纵深范围（米，握点 z）。 */
  minZ: number;
  maxZ: number;
  /** 没有来球时的回位点。 */
  homeX: number;
  homeZ: number;
}

export const AUTO_MOVE_DEFAULTS: AutoMoveConfig = {
  speed: 4.8,
  speedZ: 3.6,
  homeSpeed: 3.2,
  deadband: 0.05,
  incomingVz: 0.6,
  yTol: 0.2,
  maxX: 3.0,
  // 纵深：往前 0.55m 到离网 6.8m，往后 2.0m 到底线外 0.8m。
  // 后端比「击球面 +1.35」更深：握点 1.0m 时横握中心只有 1.0m，要靠后退等球掉下来，
  // 1.35 退到头球还有 1.15m。握点抬到 1.3 之后这段余量用不满，但低球/高球两端
  // 都还要留空间，别再收回 +1.35。
  minZ: HIT_Z - 0.55,
  maxZ: HIT_Z + 2.0,
  homeX: 0,
  homeZ: HIT_Z,
};

/** 一帧的输入里属于「玩家状态」的部分。 */
export interface AutoMoveState {
  /** 当前握点 x */
  x: number;
  /** 当前握点 z */
  z: number;
  /**
   * 拍面中心相对握点的偏移（世界系，长度恒为 0.6）。
   * 由 `app.ts` 在慢速帧里低通估计，挥拍时不更新。
   */
  center: V3;
}

export interface AutoMovePlan {
  /** 这一帧想去的握点 x（米）。 */
  target: number;
  /** 这一帧想去的握点 z（米）。 */
  targetZ: number;
  /** true = 正在追这一球；false = 没有来球，正在回中线。 */
  chasing: boolean;
  /** 球到目标平面还有多久（秒）。不追球时为 null。 */
  eta: number | null;
  /** 球在目标平面上的高度。够不着时也有值，用来提示玩家举拍或屈膝。 */
  hitY: number | null;
  /** 「站到这个位置，球是否落在拍面竖直判定半轴内」。 */
  reachable: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 一帧的走位决策。纯函数：不读时间、不读全局，给定球、站位、握法偏移就一定给同一个答案。
 *
 * 选点顺序是「先筛来得及、再挑高度最接近」：
 *
 * 1. 沿弹道在我方可站区间里每 10cm 采一个穿面点（`sampleCrossings`）；
 * 2. 每个点换算成握点 `(p.x - center.x, p.z - center.z)`，横向超界就钳位并加惩罚
 *    ——球飘到边线外时还是要尽量靠近，不能干脆不追；
 * 3. 分轴估走到那儿要多久（横移 4.8 / 后退 3.6），超过球到面时间就淘汰；
 * 4. 剩下的按 `|球高 - 拍面中心高|` 排序，加 0.06·耗时 的微弱惩罚让目标在两帧
 *    之间连续（不然会在两个几乎等高的平面之间来回跳，人就原地抖）。
 *
 * 一个都来不及的时候**不回到中线**，而是挑「最赶得上」的那个继续追：球已经发出去了，
 * 站在原地看着它落地是更差的选择。
 */
export function planAutoMove(
  ball: Ball,
  state: AutoMoveState,
  cfg: AutoMoveConfig = AUTO_MOVE_DEFAULTS,
): AutoMovePlan {
  const home: AutoMovePlan = {
    target: cfg.homeX,
    targetZ: cfg.homeZ,
    chasing: false,
    eta: null,
    hitY: null,
    reachable: true,
  };
  if (!ball.live) return home;
  // 不朝我飞（飞向墙 / 飞向对面）
  if (ball.v[2] <= cfg.incomingVz) return home;

  const c = state.center;
  // 握点能站的范围 + 中心偏移 = 拍面中心能覆盖的 z 区间
  const zLo = cfg.minZ + c[2];
  const zHi = cfg.maxZ + c[2];
  // 已经从身边过去了
  if (ball.p[2] >= zHi) return home;

  const wantY = RACKET_POS[1] + c[1];
  const pts = sampleCrossings(ball, Math.max(ball.p[2], zLo), zHi);
  if (!pts.length) return home;

  let best: PlaneHit | null = null;
  let bestX = cfg.homeX;
  let bestZ = cfg.homeZ;
  let bestCost = Infinity;
  // 来不及时的兜底：挑「需要时间 / 剩余时间」比值最小的
  let late: PlaneHit | null = null;
  let lateX = cfg.homeX;
  let lateZ = cfg.homeZ;
  let lateCost = Infinity;

  for (const p of pts) {
    const rawX = p.x - c[0];
    const wx = clamp(rawX, -cfg.maxX, cfg.maxX);
    const wz = clamp(p.z - c[2], cfg.minZ, cfg.maxZ);
    // 横向超出站位的部分按半价计：够不到也要尽量贴着边线站
    const over = Math.abs(rawX - wx) * 0.5;

    const need = Math.max(Math.abs(wx - state.x) / cfg.speed, Math.abs(wz - state.z) / cfg.speedZ);
    const dy = Math.abs(p.y - wantY) + over;

    if (need <= p.t) {
      const cost = dy + 0.06 * need;
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
        bestX = wx;
        bestZ = wz;
      }
    }
    const lateScore = need / Math.max(p.t, 0.05) + over;
    if (lateScore < lateCost) {
      lateCost = lateScore;
      late = p;
      lateX = wx;
      lateZ = wz;
    }
  }

  const pick = best ?? late;
  if (!pick) return home;

  return {
    target: best ? bestX : lateX,
    targetZ: best ? bestZ : lateZ,
    chasing: true,
    eta: pick.t,
    hitY: pick.y,
    reachable: Math.abs(pick.y - wantY) <= cfg.yTol,
  };
}

/**
 * 朝目标挪一步，最多 `maxStep`，进了死区就停。
 *
 * 故意做成「有多少走多少、到点就停」而不是指数收敛：走位要的是**站到位置**，
 * 指数收敛永远差最后一点点，球到面时还差 10cm 就擦框。
 */
export function stepAxis(current: number, target: number, maxStep: number, deadband: number): number {
  const d = target - current;
  if (Math.abs(d) <= deadband) return current;
  const step = Math.min(Math.abs(d), Math.max(0, maxStep));
  return current + Math.sign(d) * step;
}

/**
 * 用一帧的姿态更新「拍面中心相对握点」的偏移估计，返回这一帧是否采信了。
 *
 * 只在**几乎没在转**的帧采信（角速度 < `maxSpin`）：挥拍中段拍面中心会被甩出
 * 0.3–1.1m，采进来就等于「一挥拍人就被拽着跑」。静止时用 τ=0.4s 的一阶低通，
 * 换手 / 换握法后约半秒收敛，期间走位偏差不超过一个新握法的偏移量。
 *
 * 判据用四元数夹角而不是「拍子是否在动」：手机只给角度，没有其他位置信息，
 * 角速度是唯一可靠的「这一帧能不能信」的信号。门槛取 0.6 rad/s（34°/s）：
 * 静止持拍的传感器抖动是个位数 °/s，慢速调整握持在 10–30°/s，而慢挥也有 100°/s 以上
 * ——留一档余量，宁可少采几帧（τ=0.4s 会补回来），也别把挥拍的甩动算进「握法」。
 *
 * `want` 是这一帧量到的偏移，`offset` 是被原地更新的估计值。
 */
export function blendCenterOffset(
  prevQ: readonly number[],
  q: readonly number[],
  dt: number,
  want: readonly number[],
  offset: V3,
  maxSpin = 0.6,
  tau = 0.4,
): boolean {
  const dot = Math.abs(prevQ[0] * q[0] + prevQ[1] * q[1] + prevQ[2] * q[2] + prevQ[3] * q[3]);
  const ang = 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
  if (ang / Math.max(dt, 1e-3) > maxSpin) return false;
  const k = 1 - Math.exp(-Math.max(dt, 0) / tau);
  for (let i = 0; i < 3; i++) offset[i] += (want[i] - offset[i]) * k;
  return true;
}
