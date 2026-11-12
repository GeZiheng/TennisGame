/**
 * 脚本回球机：对打模式里的对手。
 *
 * ## 它其实是一个「假手机」
 *
 * 回球机不参与任何特殊判定。它每帧产出一个 `RacketPose`，塞进和玩家同一套
 * `RacketTrack` / `sweepFace` 里；球必须真的碰到它的拍面才算回球，它够不着
 * 一样会漏。所以 `Duel` 里没有 `if (side === 'machine')` 的判定分支，
 * 以后把这层换成 RL 策略或另一个真人，状态机一行都不用改。
 *
 * ## 三层
 *
 *  1. 预测：把球复制一份往前推，算出「还有多久到我这个击球面、到那一刻
 *     x/y 在哪」。弹一次地重算一次——落地会明显改变速度方向，整条弹道外推
 *     会把那一拐算错（墙打那边的 sim 踩过同样的坑）。
 *  2. 走位：朝预测点移动，限速、有反应延迟、有站位误差。**这三样不是打磨，
 *     是核心设计**：一个每次都精确到位的对手，比一个打不过的对手更出戏。
 *  3. 回球：选一个目标落点，用 `aimIntoCourt` 反解出球速度。
 *
 * ## 为什么出球直接给速度、不走 `Stroke`
 *
 * 玩家的链路是「挥拍 → `shotFromStroke` → 出球」：方向 = 拍面法线×0.72 +
 * 拍头速度×0.30。想从「我要球落在那儿」反解出拍面法线和拍头速度，是 2 个
 * 未知数 1 个方程——欠定。脚本对手不需要模拟挥拍手感，所以这里直接给速度，
 * 绕过 `Stroke`；但**碰撞判定不绕过**，球仍然得碰到拍面。
 */

import { advance, aimIntoCourt, makeBall, type Ball } from './physics';
import {
  BALL_R,
  BASELINE_Z,
  FACE_CY,
  HALF_WIDTH,
  HIT_Z,
  NET_Z,
  OPP_BASELINE_Z,
  OPP_HIT_Z,
  PHYS_DT,
  RACKET_POS,
} from './court';
import type { RacketPose } from './racket';
import { vrot, type Quat4, type V3 } from './vec';

/** 到面预测。t 是从预测那一刻算起的秒数。 */
export interface Intercept {
  t: number;
  x: number;
  y: number;
  /** 迎击点的 z。可以比站位靠前——真实球员会上去迎短球。 */
  z: number;
}

export interface MachineConfig {
  /** 反应延迟（毫秒）。球离开对手拍面之后，它要等这么久才开始动。 */
  reactMs: number;
  /** 横移速度（m/s）。真实球员 4–5，陪练取低一档。 */
  moveSpeed: number;
  /** 横向可及范围（米，相对站位中心） */
  reachX: number;
  /** 站位横向误差（米）。决定「擦框」还是「打实」。 */
  aimErrorX: number;
  /** 站位竖直误差（米）。 */
  aimErrorY: number;
  /** 提前多久决定这一拍（毫秒）。太晚来不及，太早会站着等。 */
  swingLeadMs: number;
  /** 接触时刻与决定时刻允许的偏差（毫秒），超了就算挥空。 */
  swingWindowMs: number;
  /** 打两角的概率。0 = 全回中场。 */
  cornerProb: number;
  /** 浅球落点 z（离网近，数值更负） */
  depthShallow: number;
  /** 深球落点 z（靠近玩家底线） */
  depthDeep: number;
  /** 上旋转速（rad/s） */
  spinRate: number;
  /** 过网高度上限（米），防月亮球 */
  clearMax: number;
  seed: number;
}

/**
 * 三档难度。手感和失败率全靠这几个数，不要用「随机失误」当难度——
 * 那会让失败原因不可归因，玩家学不到东西。
 *
 * `depthShallow`/`depthDeep` 是落点 z 的两端：**越负 = 离玩家越远 = 越好接**
 * （球落地之后还有更长的路要爬到你手上）。所以 L1 打得更「软」、更靠前场。
 * 注意这两个数只是「想打的」，能打出多深还受站位限制，见 `candidateTargets`。
 */
export const MACHINE_L1: MachineConfig = {
  reactMs: 380,
  moveSpeed: 2.6,
  reachX: 2.6,
  aimErrorX: 0.34,
  aimErrorY: 0.26,
  swingLeadMs: 150,
  swingWindowMs: 240,
  cornerProb: 0.15,
  depthShallow: -6.0,
  depthDeep: -4.4,
  spinRate: 40,
  clearMax: 1.5,
  seed: 1001,
};

export const MACHINE_L2: MachineConfig = {
  reactMs: 300,
  moveSpeed: 3.6,
  reachX: 3.0,
  aimErrorX: 0.22,
  aimErrorY: 0.18,
  swingLeadMs: 130,
  swingWindowMs: 220,
  cornerProb: 0.4,
  depthShallow: -5.6,
  depthDeep: -3.0,
  spinRate: 90,
  clearMax: 1.4,
  seed: 2002,
};

export const MACHINE_L3: MachineConfig = {
  reactMs: 240,
  moveSpeed: 4.6,
  reachX: 3.2,
  aimErrorX: 0.14,
  aimErrorY: 0.12,
  swingLeadMs: 110,
  swingWindowMs: 200,
  cornerProb: 0.65,
  depthShallow: -5.0,
  depthDeep: -2.0,
  spinRate: 140,
  clearMax: 1.3,
  seed: 3003,
};

/**
 * 握点高度范围。
 *
 * 和玩家**故意不一样**：玩家握点恒等于 `RACKET_POS[1]`=1.3，所以拍面中心被锁在
 * 1.3–1.9m 那段球壳上（拍柄是刚性的，人只有这一副身子）。回球机是一台机器，
 * 拍臂能升能降，这一段给到 0.15–2.0。
 *
 * 这不是为了让它更难打，是**对称性的必需**：玩家打出来的球弹起顶点只有 1.0m
 * 上下（`GROUND_REST` 0.76，落地时竖直速度本来就不大），拍面最低只能到握点高度
 * 的话它每一个球都够不着——实测「够不着」全是这个原因，不是走位没跑到位。
 */
const GRIP_MIN_Y = 0.15;
const GRIP_MAX_Y = 2.0;

/**
 * 可及纵深。回球机**不再钉在底线**。
 *
 * 一度它的 z 恒等于 `OPP_HIT_Z`，结果整场比赛只有一种球：从底线到玩家拍面
 * 有 21.6 米，想让球「落在界内、并且到面时还有 1.15–1.7 米高」的弹道
 * 只剩 9–11 m/s、28–48° 的月亮球一族（`.tmp-bench/aim-band.cjs` 实测）。
 * 那不是求解器不行，是几何：玩家的拍面中心锁在握点上方 0.6m 的球壳上，
 * 来球必须是「弹起来爬到你手上」的球。
 *
 * 真实球员遇到短球会往前迎——迎上去之后到玩家的距离变短，快球也有解。
 * 所以纵深必须放开，这不只是为了少失分，是为了让球路有变化。
 */
const Z_NEAR = NET_Z - 1.6;
const Z_FAR = OPP_BASELINE_Z - 0.8;

/** 舒服的击球高度。拍面中心 = 握点 + 0.6m，握点 0.15–2.0 → 拍心 0.75–2.6。 */
const IDEAL_HIT_Y = 1.15;
/** 低于这个高度就得把拍臂压到地上，高于就得举过头顶，都算「勉强够到」。 */
const HIT_Y_MIN = 0.78;
const HIT_Y_MAX = 2.2;

/**
 * 拍心离迎击点超过这个距离就放弃这一拍（米）。
 *
 * 判定椭圆半轴只有 0.203 / 0.243，留到 0.75 是因为「看着能碰到」和
 * 「判定盘够到」之间还差着挥拍的跟随误差。放弃比硬打干净：硬打出来的
 * 是一条穿过网带或直接出界的怪球，玩家会以为是穿模。
 */
const GIVE_UP_GAP = 0.75;

/**
 * 回球到玩家拍面时的高度带：握点高度 +0…+0.3。
 *
 * 玩家握点 y 恒等于 `RACKET_POS[1]`=1.3（三路走位只搬 x/z，`setRacketBase` 传进去的
 * 一直是这个高度），拍面中心只能在半径 `FACE_CY`=0.6 的球壳上转，能到 1.3–1.9m。
 * 但**不能把整段球壳都当目标**：到面高度越高，从对手底线（21.6m 外）落界内还要
 * 爬那么高的弹道越少，回球机只能打月亮球。实测（`npm run duel-sim`，握点 1.3）：
 *
 *   ARRIVE_Y     1.3–1.6    1.45–1.75    1.6–1.9
 *   回球 L1/L2/L3  27/52/81   22/33/75     26/40/69
 *
 * 低段（= 拍面从水平到前倾 60°）明显最好，也正好是「手机横着握」时拍面所在的高度：
 * 玩家不用为了够球把拍子举过头顶。握点从 1.0 抬到 1.3 时这一段跟着上移，
 * 但区间宽度保持 0.3m，别跟着放大。
 */
export const ARRIVE_Y_MIN = RACKET_POS[1];
export const ARRIVE_Y_MAX = RACKET_POS[1] + 0.3;

/**
 * 回球落点最靠玩家底线能到哪。
 *
 * 不是手感偏好，是几何：球落得越靠近玩家，弹起来到击球面时就越低
 * （落到脚边的球本来就是低球）。要让它同时还有 `ARRIVE_Y_MIN` 那么高，
 * 落点就被夹在 `z ≈ -6 … -1.5` 这一段，再往右整段都没有解。
 */
const ARRIVE_TARGET_Z_MAX = -1.5;

/** 拍面朝向。略微前倾，看起来像在「压着打」，同时不影响盘形判定。 */
const MACHINE_Q: Quat4 = [-0.0998, 0, 0, 0.995]; // 绕 x 轴约 -11.4°

/**
 * 到面预测已经提到 `physics.ts`（玩家自动走位也要用同一份）。
 * 这里只做名字转发，`scripts/duel-sim.cjs` 与旧调用方不用改。
 */
export { predictAtPlane } from './physics';

export class BallMachine {
  readonly cfg: MachineConfig;
  /** 握点（世界系）。拍面中心在它沿拍柄 FACE_CY 处，见 `faceCenter`。 */
  pos: V3;
  readonly q: Quat4 = [...MACHINE_Q] as Quat4;

  /** 站位中心。回中、以及横向可及范围的基准。 */
  homeX = 0;
  private homeY = 1.0;

  private rngState: number;
  private pred: Intercept | null = null;
  private predAt = 0;
  private predBounces = -1;
  private seenAt = 0;
  private active = false;

  /** 已决定这一拍的时刻。null = 还没决定。 */
  private swingAt: number | null = null;
  private plannedTarget: V3 | null = null;

  private errX = 0;
  private errY = 0;

  /** 诊断：最近一次回球的目标与速度，HUD 用 */
  lastTarget: V3 | null = null;
  lastSpeed = 0;
  lastMiss: 'timing' | 'solve' | 'reach' | null = null;

  constructor(cfg: MachineConfig = MACHINE_L2, homeX = 0) {
    this.cfg = { ...cfg };
    this.rngState = cfg.seed >>> 0;
    this.homeX = homeX;
    this.pos = [homeX, this.homeY, OPP_HIT_Z];
  }

  reset(now = 0) {
    this.rngState = this.cfg.seed >>> 0;
    this.pos = [this.homeX, this.homeY, OPP_HIT_Z];
    this.pred = null;
    this.predBounces = -1;
    this.seenAt = now;
    this.active = false;
    this.swingAt = null;
    this.plannedTarget = null;
    this.lastTarget = null;
    this.lastSpeed = 0;
    this.lastMiss = null;
  }

  /** 球开始朝它飞了。反应延迟从这里起算。 */
  beginPlay(now: number) {
    this.active = true;
    this.seenAt = now;
    this.pred = null;
    this.predBounces = -1;
    this.swingAt = null;
    this.plannedTarget = null;
    this.lastMiss = null;
    // 这一球的站位误差，抽一次用到底；每帧重抽等于给它加了 ESP
    this.errX = (this.rand() - 0.5) * 2 * this.cfg.aimErrorX;
    this.errY = (this.rand() - 0.5) * 2 * this.cfg.aimErrorY;
  }

  /**
   * 一分结束：收回站位、清掉这一球的计划，但**不重置随机数**。
   *
   * `reset()` 会把 rngState 拨回种子，那是「换一局」用的；如果每分都调它，
   * 每一分的目标落点会一模一样，对手会变成一台复读机。
   */
  park() {
    this.pos = [this.homeX, this.homeY, OPP_HIT_Z];
    this.active = false;
    this.pred = null;
    this.predBounces = -1;
    this.swingAt = null;
    this.plannedTarget = null;
    this.lastMiss = null;
  }

  /** 球不再朝它来了（出界、被接住、这一分结束）。 */
  endPlay() {
    this.active = false;
    this.swingAt = null;
  }

  /**
   * 每帧推进。
   *
   * @param ball 当前球状态（只读，内部会复制一份去预测）
   */
  update(dt: number, now: number, ball: Ball) {
    const { cfg } = this;

    // 球不是朝我来的：回中站好。回中速度比横移快一点，避免它停在角落发呆。
    if (!this.active || ball.v[2] > -0.3) {
      this.moveToward([this.homeX, this.homeY, OPP_HIT_Z], cfg.moveSpeed * 1.3 * dt);
      this.swingAt = null;
      return;
    }

    // 反应延迟：球迷都飞了一段了才动。这一条是「像人」的关键，
    // 去掉它对手会变成一台完美跟随的机器。
    if (now - this.seenAt < cfg.reactMs) {
      this.moveToward([this.pos[0], this.pos[1], OPP_HIT_Z], 0);
      return;
    }

    // 弹地一次重算一次：落地会削掉水平速度、改变竖直方向，
    // 用落地前的弹道外推「还有多久到」会差几百毫秒。
    if (ball.bounces !== this.predBounces) {
      this.pred = this.pickIntercept(now, ball);
      this.predAt = now;
      this.predBounces = ball.bounces;
    }

    const p = this.pred;
    if (!p) {
      this.moveToward([this.homeX, this.homeY, OPP_HIT_Z], cfg.moveSpeed * dt);
      return;
    }

    // 到面点 + 这一球的站位误差 → 理想拍心位置
    const fx = clamp(p.x + this.errX, -cfg.reachX, cfg.reachX);
    const fy = clamp(p.y + this.errY, GRIP_MIN_Y + FACE_CY, GRIP_MAX_Y + FACE_CY);

    // 反解握点：拍心要落在 (fx, fy, p.z) 上。
    // 不能直接把 pos 设成拍心——拍心在球拍局部系里沿拍柄偏移 FACE_CY，
    // 拍面一倾斜，这点偏移在横向和纵向上都会露出来（墙打那边
    // 「球在拍子前方 30cm 被打中」就是这个错）。
    const off = vrot(this.q, [0, FACE_CY, 0]);
    const target: V3 = [fx - off[0], fy - off[1], p.z - off[2]];
    this.moveToward(target, cfg.moveSpeed * dt);

    // 到位了没有？没到位就是够不着——这是它唯一「努力但失败」的方式。
    const gap = Math.hypot(
      this.pos[0] - target[0],
      this.pos[1] - target[1],
      this.pos[2] - target[2]
    );

    const remain = p.t - (now - this.predAt) / 1000;
    if (this.swingAt === null && remain <= cfg.swingLeadMs / 1000) {
      this.swingAt = now;
      // 落不进球场就别指望能打回来：站位差太多时直接放弃这一拍，
      // 让球飞过去判失分，比打出一条穿网/出界的怪球干净。
      this.plannedTarget = gap > GIVE_UP_GAP ? null : this.chooseTarget();
      if (gap > GIVE_UP_GAP) this.lastMiss = 'reach';
    }
  }

  /**
   * 在全场范围内挑一个「最舒服的迎击点」。
   *
   * 逐帧扫「按当前速度往前飞」的弹道，只保留我方半场、够得到、时间上来得及的
   * 采样点，按「离理想击球高度多远 + 要跑多远」打代价取最小。
   *
   * 为什么不用「球穿过某个固定平面」那种预测：那是把站位钉死了。球可能落在
   * 前场、也可能压底线，钉死一个平面意味着大部分球根本等不到它穿过。
   *
   * 时间可行性用**当前站位**算。它每帧重算（弹地时重算），所以站位在动、
   * 判据也在跟着动，不会出现「一开始就判定够不着然后放弃」。
   */
  private pickIntercept(now: number, ball: Ball): Intercept | null {
    if (ball.v[2] > -0.3) return null;
    const { cfg } = this;
    const b = makeBall(ball.p, ball.v, ball.spin);
    b.bounces = ball.bounces;

    // 还没反应完的那段时间不能用来跑位
    const reactLeft = Math.max(0, cfg.reactMs - (now - this.seenAt)) / 1000;

    let best: Intercept | null = null;
    let bestCost = Infinity;
    /** 一个都去不了的兜底：至少朝最像的那个点跑，看起来像在努力。 */
    let fallback: Intercept | null = null;
    let fallbackCost = Infinity;

    let t = 0;
    for (let i = 0; i < 240 * 5; i++) {
      advance(b, PHYS_DT, () => {});
      t += PHYS_DT;
      if (!b.live) break;

      const x = b.p[0];
      const y = b.p[1];
      const z = b.p[2];
      // 只在我方半场、不贴网、不退出挡板
      if (z > Z_NEAR || z < Z_FAR) continue;

      const travel = Math.hypot(x - this.pos[0], z - this.pos[2]);
      const cost =
        Math.abs(y - IDEAL_HIT_Y) + 0.1 * travel + (y < HIT_Y_MIN || y > HIT_Y_MAX ? 3 : 0);

      if (cost < fallbackCost) {
        fallbackCost = cost;
        fallback = { t, x, y, z };
      }

      // 横向超出可及范围：这一站怎么跑都够不到
      if (Math.abs(x) > cfg.reachX + 0.6) continue;
      // 时间够不够跑过去
      if (travel > cfg.moveSpeed * Math.max(0, t - reactLeft)) continue;

      if (cost < bestCost) {
        bestCost = cost;
        best = { t, x, y, z };
      }
    }

    return best ?? fallback;
  }

  /**
   * 球真的碰到拍面了，让它出球。返回 null = 这一拍没打成。
   *
   * @param at 命中点（球心世界坐标，由 sweepFace 给出）
   */
  attemptReturn(now: number, at: V3): V3 | null {
    if (this.swingAt === null) {
      this.lastMiss = 'timing';
      return null;
    }
    if (Math.abs(now - this.swingAt) > this.cfg.swingWindowMs) {
      this.lastMiss = 'timing';
      return null;
    }
    if (!this.plannedTarget) {
      this.lastMiss = 'reach';
      return null;
    }

    // 上旋：向 +z 飞行时旋转轴取 -x。符号由 `v × ω` 定，
    // 写反会变成下旋，球会「飘」过去而不是压下来（墙打那边专门钉过一条测试）。
    const spin: V3 = [-this.cfg.spinRate, 0, 0];

    // 到面高度是硬约束，而且比想象中更窄：玩家握点 y 恒等于 RACKET_POS[1]=1.3，
    // 拍面中心只能在半径 FACE_CY=0.6 的球壳上（`faceCenter`），能到 1.3–1.9m。
    // 但可及的整段不等于该送的高度段——太高打不出界内，太低要把拍面压平、
    // 判定盘跟着转成水平面。真正的目标段是 `ARRIVE_Y_MIN/MAX`（握点 +0…+0.3），
    // 三个候选段的实测对比写在那两个常量上方。
    //
    // 速度区间和弧线上限都是被这条逼出来的：从对手底线到玩家拍面有 21.6 米，
    // 能让球「落在界内、并且到面时还有 1.3–1.6 米高」的弹道不多。
    // 实测（`.tmp-bench/aim-solve.cjs`）从各深度出发的可打落点带：
    //   z=-21.3 → -6.0..-2.0   z=-18 → -4.5..-2.0   z=-14 → -3.5..-1.0
    // 迎得越靠前，能打的目标越靠前——所以下面的候选阶梯要跟着站位算。
    const aimOpts = {
      maxClear: 2.8,
      speed: [8, 26] as [number, number],
      arriveZ: HIT_Z,
      arriveY: [ARRIVE_Y_MIN, ARRIVE_Y_MAX] as [number, number],
      arriveTol: 0.12,
    };

    // 候选落点阶梯。第一档是它「想打的」，后面几档是退让：
    // 站位靠前时深球解不出来，硬要给一条就会出界或撞网，不如换个近一点的落点。
    // 全都不行才判 `solve`——那说明几何上真的没得打。
    for (const target of this.candidateTargets()) {
      const v = aimIntoCourt(at, target, spin, aimOpts);
      if (!v) continue;
      this.lastTarget = [...target];
      this.lastSpeed = Math.hypot(v[0], v[1], v[2]);
      this.swingAt = null;
      return v;
    }

    this.lastMiss = 'solve';
    return null;
  }

  /**
   * 候选落点，从「最想要」到「保底」。
   *
   * 上界 `-1.5` 不是随便取的：球落在越靠玩家底线的地方，到面高度就越低
   * （落到脚边的球本来就是低球），能同时满足 `ARRIVE_Y_MIN` 的落点区域被夹在
   * `z ≈ -6 … -1.5` 这一段。站位越靠前，这段的远端还会继续收紧。
   */
  private candidateTargets(): V3[] {
    const d = HIT_Z - this.pos[2];
    const lo = this.pos[2] + Math.max(0.45 * d, 2.0);
    const hi = ARRIVE_TARGET_Z_MAX;
    const pref = this.chooseTarget();
    const zMid = clamp((lo + hi) / 2, Math.min(lo, hi), hi);
    const safeX = pref[0] * 0.5;

    return [
      [pref[0], BALL_R, clamp(pref[2], lo, hi)],
      [pref[0], BALL_R, zMid],
      [safeX, BALL_R, zMid],
      [0, BALL_R, zMid],
      [safeX, BALL_R, clamp(-3, lo, hi)],
      [0, BALL_R, clamp(midCourtZ(), lo, hi)],
    ];
  }

  /** 当前位姿。和玩家一样，每帧都要喂给判定层。 */
  pose(now: number): RacketPose {
    return { t: now, pos: [...this.pos], q: [...this.q] as Quat4 };
  }

  /* ---------------- 内部 ---------------- */

  private chooseTarget(): V3 {
    const { cfg } = this;
    let x: number;
    if (this.rand() < cfg.cornerProb) {
      const side = this.rand() < 0.5 ? -1 : 1;
      x = side * HALF_WIDTH * (0.55 + this.rand() * 0.3);
    } else {
      x = (this.rand() - 0.5) * HALF_WIDTH * 0.9;
    }
    const z = cfg.depthShallow + this.rand() * (cfg.depthDeep - cfg.depthShallow);
    return [x, BALL_R, clamp(z, NET_Z + 1.2, BASELINE_Z - 0.6)];
  }

  /** 朝目标点移动，最多走 budget 米。横向受 reachX 约束，纵深受场地约束。 */
  private moveToward(target: V3, budget: number) {
    if (budget <= 0) return;
    let dx = target[0] - this.pos[0];
    let dy = target[1] - this.pos[1];
    let dz = target[2] - this.pos[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    const k = Math.min(1, budget / d);
    dx *= k;
    dy *= k;
    dz *= k;
    this.pos[0] = clamp(this.pos[0] + dx, -this.cfg.reachX, this.cfg.reachX);
    this.pos[1] = clamp(this.pos[1] + dy, GRIP_MIN_Y, GRIP_MAX_Y);
    this.pos[2] = clamp(this.pos[2] + dz, Z_FAR, Z_NEAR);
  }

  private rand(): number {
    this.rngState = (this.rngState * 1103515245 + 12345) % 2147483648;
    return this.rngState / 2147483648;
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 退回用的安全落点：玩家半场中路。 */
function midCourtZ(): number {
  return NET_Z + (BASELINE_Z - NET_Z) * 0.45;
}
