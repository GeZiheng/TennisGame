/**
 * 诊断脚本玩家：给探针用的一只手。
 *
 * ## 它和 `duel-sim.cjs` 的脚本玩家不是一回事
 *
 * `duel-sim` 的玩家是**近乎完美的求解器**（按预测点摆拍、到点就挥、出球走
 * `aimIntoCourt`），因为那边测的是回球机，玩家越完美，失败越只可能归到机器头上。
 *
 * 这里的玩家正好相反：**走位交给调用方**（探针要测的就是 `planAutoMove` /
 * `TargetHold` / `stepAutoMove` 那三层），本模块只负责两件杂活：
 *
 *   1. 到点挥拍（不挥的话球飞过去、这一分就结束，拿不到连续的来球）；
 *   2. 发球局里把球发出去（否则每一分都卡在 `setup`，等到超时才抛球）。
 *
 * ## 为什么发球可以不做
 *
 * 探针只关心「来球 + 走位」，所以这里把握球方固定成机器：调用方每帧把
 * `duel.match.server` 写成 `'machine'`，玩家就永远是接发球方。少一套发球几何，
 * 就少一处会和 `duel-sim` 漂移的拷贝。`duel-sim` 那边必须真发球（它要数双误），
 * 所以两份实现是有意的分工，不是漏了合并。
 *
 * 依赖 `.tmp-duel`（先跑 `npm run core`）。
 */
const { predictAtPlane, aimIntoCourt } = require('../../.tmp-duel/core/physics.js');
const { BALL_R, BALL_M, HIT_Z, NET_Z, OPP_BASELINE_Z, RACKET_POS } = require('../../.tmp-duel/core/court.js');

/** 提前多久决定这一拍（秒）。和 `duel-sim` 同一个数。 */
const SWING_LEAD = 0.075;
/** 两次挥拍之间的最小间隔（毫秒），防止同一个球被连挥两下。 */
const SUBMIT_GAP_MS = 260;
/** 出球速度区间。下限要高于 `SPEED_MIN`=18，否则 `shotFromStroke` 会把它抬回 18。 */
const AIM_SPEED = [18.5, 30];

/**
 * 把「求解器的出球速度」反解成一次挥拍。
 *
 * `shotFromStroke` 里 `dir = unit(face*0.72 + unit(head)*0.3 + [0,0.06,0])`、
 * `speed = dot(head,dir)*0.85 + 3`。直接拿求解结果当 head 会同时偏方向和偏快，
 * 所以这里反解：取 head ∥ d，face = d − [0, 0.06/0.72, 0]，两项一减正好抵消。
 */
function strokeToward(now, aim) {
  const S = Math.hypot(aim[0], aim[1], aim[2]);
  const d = [aim[0] / S, aim[1] / S, aim[2] / S];
  const face = [d[0], d[1] - 0.06 / 0.72, d[2]];
  const h = (S - 3) / 0.85;
  return {
    t: now,
    peakW: 15,
    head: [d[0] * h, d[1] * h, d[2] * h],
    speed: h,
    face,
    grip: [0, 1, 0],
    charge: 0.6,
    used: false,
  };
}

class ProbePlayer {
  /**
   * @param {() => number} rng 0..1 的随机数（由探针按种子提供，保证可复现）
   */
  constructor(rng) {
    this.rng = rng;
    this.lastSubmit = -1e9;
    this.swings = 0;
    this.aimNull = 0;
  }

  /**
   * 到点就挥。**只负责决定挥不挥**，握点由调用方给。
   *
   * @param {object} duel  `Duel` 实例
   * @param {number} now
   * @param {{x:number,y:number,z:number}} grip 这一帧的握点（走位算完之后）
   * @returns {object|null} 要提交的 stroke，没挥就是 null
   */
  maybeSwing(duel, now, grip) {
    // 永远接发球：把发球方钉在机器那边，省掉一整套发球几何
    duel.match.server = 'machine';
    if (duel.phase !== 'live' || duel.receiver !== 'player') return null;
    if (duel.ball.v[2] <= 0.5) return null;
    if (now - this.lastSubmit < SUBMIT_GAP_MS) return null;

    const pred = predictAtPlane(duel.ball, HIT_Z);
    if (!pred || pred.t <= 0 || pred.t > SWING_LEAD) return null;

    // 打回对方场内就行：探针要的是「球能回来」，不是「打得刁」
    const tx = (this.rng() - 0.5) * 5.2;
    const tz = NET_Z - 1.4 - this.rng() * 7.4;
    const at = [pred.x, pred.y, HIT_Z];
    const pOpts = { zMin: OPP_BASELINE_Z + 0.3, zMax: NET_Z - 0.3, speed: AIM_SPEED };
    const aim =
      aimIntoCourt(at, [tx, BALL_R, tz], [0, 0, 0], { ...pOpts, maxClear: 1.8 }) ??
      aimIntoCourt(at, [tx * 0.6, BALL_R, tz - 1.2], [0, 0, 0], { ...pOpts, maxClear: 2.2 }) ??
      aimIntoCourt(at, [0, BALL_R, NET_Z - 4], [0, 0, 0], { ...pOpts, maxClear: 2.6 });

    this.lastSubmit = now;
    if (!aim) {
      this.aimNull++;
      return null;
    }
    this.swings++;
    void grip;
    return strokeToward(now, aim);
  }
}

/** 组装一个 `RacketPose`。**握点**高度就是 `grip.y`，和真机 `setRacketBase` 一致。 */
function poseAt(now, grip, q) {
  return { t: now, pos: [grip.x, grip.y, grip.z], q: [...q] };
}

module.exports = { ProbePlayer, poseAt, strokeToward, SWING_LEAD, RACKET_POS, BALL_M };
