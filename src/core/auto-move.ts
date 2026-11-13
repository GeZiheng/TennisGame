/**
 * 自动走位：把「球会从哪儿来」变成「握点该往哪儿挪」。
 *
 * ## 它解决的是什么
 *
 * 严格碰撞上线后，可击球面积就是真实的 30×38cm 拍面；来球的散布是米级。拍子不能
 * 平移的话命中率只有两成——玩家会觉得「判定有问题」，实际上是「你站着没动」。
 * 这个模块把玩家搬到球会经过的位置，**挥拍仍然留给玩家**。
 *
 * ## 三个自由度：x / z / y（11-13 第二次修正）
 *
 * - **x 补偿握法**：拍面中心挂在握点沿拍柄 0.6m 的杆子末端（`faceCenter`）。握法一横，
 *   这根杆子横过去，中心落在握点侧方 0.6m，而判定半轴只有 0.24m。所以「把握点 x 对准
 *   球的 x」只在拍子竖直时成立；横握时人站对了、拍面却在半米外。
 * - **z 决定「球到面时多高」**：同样的球，站前 0.5m 就高 0.4m。
 * - **y 决定「拍面够不够得到那个高度」**：这是 11-13 补上的那一维，也是最关键的一维。
 *   握点原来被锁死在 `RACKET_POS[1]`，拍面中心只能在半径 0.6m 的球壳上转 ⇒ 竖握时
 *   拍面恒在 1.9m、横握恒在 1.3m。而回球机把球送到 1.3–1.6m，于是**竖握/斜握的玩家
 *   每一球都是从拍面下方 20cm 掠过**：屏幕上看着擦到了，判定说没进椭圆。
 *   真人对付高球会举拍、对付低球会屈膝，这一维就是那个动作。
 *
 * ## 选点：先筛「够得着 + 来得及」，再挑「最省力」
 *
 * 1. 沿弹道在我方可站区间里每 10cm 采一个穿面点（`sampleCrossings`）；
 * 2. 每个点反解出握点 `(p.x - c.x, p.y - c.y, p.z - c.z)`——三个轴各自夹到身体范围内，
 *    夹出去的差值就是「够不着」的量；
 * 3. 只要球高出了握点的可调范围（`minGripY`–`maxGripY`），这个平面就**不合格**：
 *    站在那儿也打不到，再近也没用。这是「离球太近却打不到」的直接解药；
 * 4. 合格解里按「姿态偏离 + 站位偏离 + 横向出界 + 耗时」挑最省力的那个。
 *    站位的权重高于姿态：宁可屈膝 20cm，也不愿意为了舒服退到底线外一米。
 * 5. 一个都不合格时**不回到中线**，挑「总代价最小」的那个继续追：球已经发出去了，
 *    站着看它落地是更差的选择。
 *
 * ## 球已经到身边就别追了
 *
 * 旧版会用 `maxZ`（底线上 2m）当上界，于是球一旦飞过身侧，规划器还在往后找一个
 * 「更高/更低」的平面，人就跟着球一路后退——玩家看到的是「球贴着我飞、拍子却够不到」。
 * 现在球一旦越过拍面所在平面就**原地不动**：这一拍已经没救了，站住等下一球。
 *
 * ## 与其它输入通道的关系
 *
 * 键盘（`WASD`）在 `app.ts` 里排在它前面：这一帧只要有方向键按下，这一路就整帧
 * 不动，避免两路同时写 `PLAYER` 打架。手动永远优先，松手才接回来。
 *
 * 11-13 之前还有一条「摄像头追胸口色块」的视觉通道排在更前面，同日撤掉了
 * （`docs/history.md` 4.21）：走位现在只有「脚本自动」和「键盘手动」两路。
 */

import { HIT_Z, RACKET_POS } from './court';
import { sampleCrossings, type Ball, type PlaneHit } from './physics';
import type { V3 } from './vec';

export interface AutoMoveConfig {
  /** 追球时的横移速度上限（m/s）。真实球员 4–5，取 4.8 让「来得及」但仍有极限。 */
  speed: number;
  /** 追球时的前后速度上限（m/s）。真人倒退比横移慢，而且退太多就没法发力。 */
  speedZ: number;
  /**
   * 握点升降速度（m/s）。屈膝、举拍是手臂和腿的动作，比跑动快得多——
   * 这一维要「立刻到位」，否则球到面时拍面还在半路上，等于没这一维。
   */
  speedY: number;
  /**
   * 球还远时的握点升降速度（m/s）。这一档只用来做「预位」：把拍子朝来球的高度
   * 提前抬/压 `heightBand`，慢到看得见。老行为是全程 `speedY`=9 m/s，一帧 15cm，
   * 抬起来是一瞬间、球一过又弹回中立位，玩家只看到「永远同一个高度」。
   */
  speedYSlow: number;
  /** 预位幅度（米）：球还远时握点最多偏离中立高度这么多。 */
  heightBand: number;
  /**
   * 「球还远」的判据（秒）：`plan.eta` 大于它就只做预位，小于它才放开整个
   * `minGripY–maxGripY` 行程做精确对位。
   */
  heightLead: number;
  /** 没有来球时回中线的速度（m/s）。比追球慢，免得球刚离拍人就窜回去。 */
  homeSpeed: number;
  /** 目标死区（米）。差得比这还少就不动，否则会贴着球抖。 */
  deadband: number;
  /**
   * 高度的死区（米），比 `deadband` 小。
   *
   * 竖直判定半轴只有 0.24m，5cm 的死区等于先送掉四分之一余量；而高度这一维
   * 不像横移那样要「贴着球」，走小步不会抖（`stepAxis` 到点就停）。
   */
  deadbandY: number;
  /**
   * 认定「这球是朝我来的」的最小 z 速度（m/s）。
   * 球飞向墙 / 飞向对手时 z 分量为负，低于这个门槛就当作不是来找我的，直接回中。
   */
  incomingVz: number;
  /**
   * 到面高度偏离拍面中心多少以内算「接得到」（米）。只用于标记 `reachable`
   * （给 HUD 提示「该举拍/该退」），不参与选点。
   */
  yTol: number;
  /**
   * 站位的横向极限（米），默认 `HALF_WIDTH - 0.2`。
   *
   * 原来给 3.0，而单打边线在 4.115 —— 边线附近的球**永远**够不到：实测有一整类
   * 漏接是这样，球在 x=-3.9 落地，人卡在 -2.96 看着。走位既然是为了「站到球会
   * 经过的位置」，就该覆盖整块场地；留 0.2m 是给「站在线上不算出界」的余量。
   */
  maxX: number;
  /** 站位的纵深范围（米，**握点** z）。 */
  minZ: number;
  maxZ: number;
  /** 握点高度的可调范围（米）。下界 = 屈膝，上界 = 举拍。 */
  minGripY: number;
  maxGripY: number;
  /** 没有来球时的回位点。 */
  homeX: number;
  homeZ: number;
}

export const AUTO_MOVE_DEFAULTS: AutoMoveConfig = {
  speed: 4.8,
  speedZ: 3.6,
  speedY: 6,
  /**
   * 预位阶段（球还远）的升降速度。
   *
   * 1.8 m/s 的依据：20cm 的预位行程走完约 110ms，比一帧 15cm 的「瞬移」慢一个
   * 数量级，肉眼能读出「拍子在跟着球抬起来」；又不至于慢到球到了还在半路——
   * `heightLead`=0.45s 之后还有 9 m/s 的精确档兜底。
   */
  speedYSlow: 1.8,
  /** 预位幅度 20cm：真机反馈要的「上下 20cm 左右」，不是 60cm 的深蹲。 */
  heightBand: 0.2,
  /** 球还有 0.45s 以上到面时只预位；更近就放开全行程。 */
  heightLead: 0.45,
  homeSpeed: 3.2,
  deadband: 0.05,
  deadbandY: 0.02,
  incomingVz: 0.6,
  yTol: 0.2,
  maxX: 3.9,
  /**
   * 纵深：往前 3.0m、往后 1.0m（握点 z）。
   *
   * 往前这一侧原来是 0.55m —— 等于「只能离击球面半步」，网前的短球只能看着。
   * 判死的球里有一整类是这样：机器一记软球落在 z≈-8，弹起后最高不到 1m，在
   * z≈-1.4 就二次落地 —— 它根本没到击球面。要接只能往前 2–3m 迎击，0.55m
   * 连一半都不到。3.0m 大约是中场（离网 7.5m），再往前就不是「接球」而是
   * 「冲网」了。往后收到 1.0m：退到底线（`BASELINE_Z`=1.5）就停。
   *
   * 实测一对（`.tmp-bench/bounce-probe`，从 -22.05 起手扫 vy/vz）：vz=13 / vy=5.5
   * 第一落点 -8.01、第二落点 -1.40，正好是这一类。
   */
  minZ: HIT_Z - 3.0,
  maxZ: HIT_Z + 1.0,
  /**
   * 握点高度：`RACKET_POS[1]` 上下各让一档。
   *
   * 向下 0.6m 是深屈膝（1.3 → 0.70），向上 0.35m 是举拍（→ 1.65）。
   * 横握时拍面中心跟着握点走，这两个数直接决定「能接 0.70–1.65m 的球」；
   * 竖握/斜握时再加 0.6 的竖直投影（14° 握法 +0.53）。回球机的到面带是 1.3–1.6，
   * 两种握法都盖得住；而**落地后再掉到 1m 以下的球**只有把拍子沉下去才够得着，
   * 0.45 那一档（面 1.38）差一点点，实测漏接全落在这一档上。
   */
  minGripY: RACKET_POS[1] - 0.6,
  maxGripY: RACKET_POS[1] + 0.35,
  homeX: 0,
  homeZ: HIT_Z,
};

/** 一帧的输入里属于「玩家状态」的部分。 */
export interface AutoMoveState {
  /** 当前握点 x */
  x: number;
  /** 当前握点 z */
  z: number;
  /** 当前握点 y（缺省 = `RACKET_POS[1]`，老调用方的兼容路径）。 */
  y?: number;
  /**
   * 拍面中心相对握点的偏移（世界系，长度约 0.6）。
   *
   * 由 `app.ts` 估两份再加起来：站着不动的握法偏移（低角速度帧低通）+ 挥拍把中心
   * 多扫出去的那一段（每命中一球学一次）。**喂球必须用同一份**（`Rally.setFaceAimOffset`），
   * 否则球会被瞄到另一个点上，而且每球累积（`docs/history.md` 4.23）。
   */
  center: V3;
}

export interface AutoMovePlan {
  /** 这一帧想去的握点 x（米）。 */
  target: number;
  /** 这一帧想去的握点 z（米）。 */
  targetZ: number;
  /** 这一帧想去的握点 y（米）。 */
  targetY: number;
  /** true = 正在追这一球；false = 没有来球 / 球已过身，正在回中或原地不动。 */
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
 * 球越过拍面平面多远之后就不再追。
 *
 * 留 0.15m 是给「刚好压线」的球一点余量：球心越过拍面中心的 z 那一刻，球体还有
 * 半径在后，判定仍然可能命中；超过这个量就真的过去了，再追只能往后跑。
 */
const PAST_MARGIN = 0.15;

/**
 * 一帧的走位决策。纯函数：不读时间、不读全局，给定球、站位、握法偏移就一定给同一个答案。
 *
 * 代价权重（米为单位的等效不适感）：
 *   - 姿态偏离 `|gripY - RACKET_POS[1]|` × 0.9：屈膝/举拍是有代价的，但不大。
 *   - 站位偏离 `|gripZ - homeZ|`       × 0.7：走一步比蹲一下更费劲。
 *   - 横向出界 `|gripX - clamp|`       × 1.2：够不到边线球时也尽量贴着边站。
 *   - 耗时 `need`                      × 0.06：让两帧之间的目标连续，不来回跳。
 *   - 高度不够 `|gripY - clamp|`       × 3.0：只在没有合格解时兜底用——它是「打不到」。
 */
export function planAutoMove(
  ball: Ball,
  state: AutoMoveState,
  cfg: AutoMoveConfig = AUTO_MOVE_DEFAULTS,
): AutoMovePlan {
  const curY = state.y ?? RACKET_POS[1];
  const home: AutoMovePlan = {
    target: cfg.homeX,
    targetZ: cfg.homeZ,
    targetY: RACKET_POS[1],
    chasing: false,
    eta: null,
    hitY: null,
    reachable: true,
  };
  if (!ball.live) return home;
  // 不朝我飞（飞向墙 / 飞向对面）
  if (ball.v[2] <= cfg.incomingVz) return home;

  const c = state.center;
  const faceZ = state.z + c[2];
  // 已经从身边过去了：站住，不再跟着球往后跑
  if (ball.p[2] >= faceZ + PAST_MARGIN) {
    return {
      target: state.x,
      targetZ: state.z,
      targetY: curY,
      chasing: false,
      eta: null,
      hitY: ball.p[1],
      reachable: true,
    };
  }

  // 握点能站的范围 + 中心偏移 = 拍面中心能覆盖的 z 区间
  const zLo = cfg.minZ + c[2];
  const zHi = cfg.maxZ + c[2];

  // 起点用 `max(球现在的位置, 下界)`：采样网格锚在区间下界上，所以网格会跟着球
  // 一起往前滑——这不是 bug，是**响应性**的来源（球当前所在的平面永远是候选），
  // 曾经改成固定下界试过，最后一刻的横向偏差从 0.16m 掉到 0.29m（单测
  // 「中途跑开 2.2m」直接红）。滑动的代价是相邻候选的排序每帧都会翻，规划器于是
  // 在相邻两格之间来回改主意——那一层由 `TargetHold` 吸收。
  const pts = sampleCrossings(ball, Math.max(ball.p[2], zLo), zHi);
  if (!pts.length) return home;

  const neutralY = RACKET_POS[1];
  let best: PlaneHit | null = null;
  let bestX = cfg.homeX;
  let bestZ = cfg.homeZ;
  let bestY = neutralY;
  let bestCost = Infinity;

  // 不合格的兜底：挑「高度差最小、又最赶得上」的，仍然往那儿走
  let late: PlaneHit | null = null;
  let lateX = cfg.homeX;
  let lateZ = cfg.homeZ;
  let lateY = neutralY;
  let lateCost = Infinity;

  for (const p of pts) {
    const gripX = p.x - c[0];
    const gripZ = p.z - c[2];
    const gripY = p.y - c[1];
    const wx = clamp(gripX, -cfg.maxX, cfg.maxX);
    const wz = clamp(gripZ, cfg.minZ, cfg.maxZ);
    const wy = clamp(gripY, cfg.minGripY, cfg.maxGripY);

    const overX = Math.abs(gripX - wx);
    const overY = Math.abs(gripY - wy);
    const need = Math.max(
      Math.abs(wx - state.x) / cfg.speed,
      Math.abs(wz - state.z) / cfg.speedZ,
      Math.abs(wy - curY) / cfg.speedY,
    );

    // 够得着的判据只有一条：球高必须落在握点可调范围之内（±1cm 浮点余量）
    const ok = overY <= 0.01 && need <= p.t;

    if (ok) {
      const cost =
        0.9 * Math.abs(wy - neutralY) +
        0.7 * Math.abs(wz - cfg.homeZ) +
        1.2 * overX +
        0.06 * need;
      if (cost < bestCost) {
        bestCost = cost;
        best = p;
        bestX = wx;
        bestZ = wz;
        bestY = wy;
      }
    }

    const fallback =
      3.0 * overY + 1.2 * overX + 0.7 * Math.abs(wz - cfg.homeZ) + need / Math.max(p.t, 0.05);
    if (fallback < lateCost) {
      lateCost = fallback;
      late = p;
      lateX = wx;
      lateZ = wz;
      lateY = wy;
    }
  }

  const pick = best ?? late;
  if (!pick) return home;

  return {
    target: best ? bestX : lateX,
    targetZ: best ? bestZ : lateZ,
    targetY: best ? bestY : lateY,
    chasing: true,
    eta: pick.t,
    hitY: pick.y,
    reachable: Math.abs(pick.y - (RACKET_POS[1] + c[1])) <= cfg.yTol,
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

/** 一帧的最终站位目标（米）。 */
export interface MoveTarget {
  x: number;
  y: number;
  z: number;
}

/**
 * 把「规划 + 保持器」变成下一帧的站位。**主循环和探针都走这一个函数**。
 *
 * 抽出来的原因：这段逻辑（限速步进 + 边界夹取 + 高度两段）原来在 `app.ts` 里，
 * 而 `scripts/probe-jitter.cjs` / `probe-contact.cjs` 各抄了一份。抄的那份一旦
 * 和主循环漂了，探针量到的就不是玩家身上的行为——这个项目吃过「单测全绿、真机
 * 全漏」的亏，探针和主循环必须是同一份代码。
 *
 * ## 高度为什么分两段
 *
 * `eta > heightLead`（球还远）时只做 `±heightBand`（20cm）的预位、慢速挪过去；
 * 球到跟前才放开 `minGripY–maxGripY` 的全行程和 `speedY`。
 *
 * 老行为是全程 `speedY`=9 m/s：一帧 15cm，抬起来是一瞬间、球一过又弹回中立位，
 * 玩家看到的一直是回位后的 1.3m，读成「高度永远不变」。慢速预位让「跟着来球
 * 抬/压」这件事变得可见，同时不牺牲最后那几厘米的精确对位（竖直半轴只有 0.24m）。
 */
export function stepAutoMove(
  cur: { x: number; y: number; z: number },
  plan: AutoMovePlan,
  tg: MoveTarget,
  dt: number,
  cfg: AutoMoveConfig = AUTO_MOVE_DEFAULTS,
): MoveTarget {
  const speedX = plan.chasing ? cfg.speed : cfg.homeSpeed;
  const speedZ = plan.chasing ? cfg.speedZ : cfg.homeSpeed;
  const early = plan.chasing && plan.eta !== null && plan.eta > cfg.heightLead;
  // 预位 → 精确对位之间**连续**打开，不是到点硬切。
  //
  // 硬切会在 `eta === heightLead` 那一帧把目标从「中立位 ±20cm」直接换成「0.75
  // 或 1.65」，目标跳一次、人跟着反向一次（探针里 y 反向 0.04 次/球就是这么来的）。
  // 现在用一个随 eta 线性开闸的权重：球还远时权重 0，越近越大，到面那一刻是 1。
  const w = plan.eta === null ? 1 : clamp((cfg.heightLead - plan.eta) / Math.max(cfg.heightLead, 1e-6), 0, 1);
  const banded = RACKET_POS[1] + clamp(tg.y - RACKET_POS[1], -cfg.heightBand, cfg.heightBand);
  const yTarget = plan.chasing ? banded + (tg.y - banded) * w : tg.y;
  // 回位那一段不能按举拍的 9 m/s：球刚过去、挥拍还没收完，那是单帧 15cm 的竖直
  // 弹跳（「击球时拍子抖一下」的第二个来源）。
  const speedY = plan.chasing ? (early ? cfg.speedYSlow : cfg.speedY) : cfg.homeSpeed;

  return {
    x: clamp(stepAxis(cur.x, tg.x, speedX * dt, cfg.deadband), -cfg.maxX, cfg.maxX),
    y: clamp(stepAxis(cur.y, yTarget, speedY * dt, cfg.deadbandY), cfg.minGripY, cfg.maxGripY),
    z: clamp(stepAxis(cur.z, tg.z, speedZ * dt, cfg.deadband), cfg.minZ, cfg.maxZ),
  };
}

/**
 * 目标保持器：把「每帧重新选点」变成「选一次点，除非必须改就不改」。
 *
 * ## 它治的是什么
 *
 * 真机反馈「移动到位之后、击球前球拍会剧烈抖一下」。这不是渲染问题，是规划器
 * 每帧都在**重新选平面**：候选点在弹道上按 10cm 分格，相邻两个点的代价往往只差
 * 千分之几，球再飞 6cm（一帧）排序就翻一次。于是 `targetZ` 在 0.30 / 0.36 之间
 * 来回跳，而 `stepAxis` 把它当成「真的要挪」，每帧按 `speedZ` 满速走 6cm 再走回来
 * ——60Hz 的 ±6cm 方波。实测（`scripts/probe-jitter.cjs`）到面前 300ms 里
 * 前后方向反向 2–7 次，相机也跟着一起晃（`setRacketBase` 平移相机）。
 *
 * ## 判据：新目标离旧目标不到 `holdR` 就不动
 *
 * 不用低通也不用加速度限幅：那两种都只是把抖动压小，规划器照样每帧改主意。
 * 这里问的是「换到新目标，能多打到球吗」——`holdR` 取 0.10m，比判定盘的等效
 * 半轴（横 0.20 / 竖 0.24）小一半，落在里面本来就是「打得到，只是没那么甜」。
 * 超过 10cm 才说明站位真的不对（球换了落点、换了高度），这时一次跳过去，
 * 由 `stepAxis` 的速度上限拉成几帧，不会再抖。
 *
 * ## 球已经过去：先挥完这一拍，再回中线
 *
 * `chasing` 在球越过拍面那一刻翻成 false，目标立刻变成回中点——握点高度这时候
 * 会从「蹲着接低球」一跳回到 1.3m。按 `speedY`=9 m/s 算，那是**单帧 15cm** 的
 * 竖直弹跳，正好落在挥拍最后那两帧上，读起来就是「击球时拍子猛地一抖」。
 * 所以球过去之后先保持原地 `settleMs`（250ms，够一次随挥收完），再回位；
 * 回位那一段在 `app.ts` 里用 `homeSpeed` 走 y，不再用「举拍」的 9 m/s。
 */
export class TargetHold {
  private cur: MoveTarget | null = null;
  private lastChaseAt = 0;

  constructor(
    private readonly holdR = 0.1,
    private readonly settleMs = 250,
  ) {}

  resolve(plan: AutoMovePlan, now: number): MoveTarget {
    if (plan.chasing) this.lastChaseAt = now;
    const want: MoveTarget = { x: plan.target, y: plan.targetY, z: plan.targetZ };
    if (!this.cur) {
      this.cur = want;
      return want;
    }
    if (!plan.chasing) {
      if (now - this.lastChaseAt < this.settleMs) return this.cur;
      this.cur = want;
      return want;
    }
    const d = Math.hypot(want.x - this.cur.x, want.y - this.cur.y, want.z - this.cur.z);
    if (d > this.holdR) this.cur = want;
    return this.cur;
  }

  reset() {
    this.cur = null;
    this.lastChaseAt = 0;
  }
}

/**
 * 用一帧的姿态更新「拍面中心相对握点」的偏移估计，返回这一帧是否采信了。
 *
 * 只在**几乎没在转**的帧采信（角速度 < `maxSpin`）：挥拍中段拍面中心会被甩出
 * 0.3–1.1m，采进来就等于「一挥拍人就被拽着跑」。静止时用 τ=0.4s 的一阶低通，
 * 换手 / 换握法后约半秒收敛，期间走位偏差不超过一个新握法的偏移量。
 *
 * 判据用四元数夹角而不是「拍子是否在动」：手机只给角度，没有其他位置信息，
 * 角速度是唯一可靠的「这一帧能不能信」的信号。
 *
 * 门槛默认 0.6 rad/s（34°/s），**大屏端传的是 1.2**：0.6 连正常的手部微动都会挡掉，
 * 估出来的握法会卡在开局那一次，于是「站多远」一直按老姿势算——真机反馈的
 * 「发球时按拍面角度估一次，之后拍子角度变了也不跟着改」就是这么来的（`docs/history.md` 4.23）。
 * 真实挥拍是 100–1700°/s，1.2 rad/s（69°/s）仍然离得很远，该挡的还挡得住。
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
