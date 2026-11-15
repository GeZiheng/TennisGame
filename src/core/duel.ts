/**
 * 对打：玩家 vs 脚本回球机，按真实网球规则计分（分 → 局 → 盘，一盘定胜负）。
 *
 * ## 它是唯一的玩法
 *
 * 11-15 之前还有一个对墙打的 `Rally` 并存。两者**没有**合并成一个带模式开关的类：
 * `Rally` 的阶段语义是「这一球会不会自己回来」，`Duel` 的是「这一分归谁」，
 * 捏在一起只会让两边都难读。删掉墙打时正是靠这层切分——把 `Rally` 剥掉，
 * `Duel` 一行没动（`docs/history.md` 4.27）。
 *
 * 复用的部分：`advance` 的物理、`sweepFace` 的拍面判定、`shotFromStroke`
 * 的挥拍→出球、`RacketTrack` 的位姿插值、`SwingDetector`（在外面）。
 *
 * ## 一分里有两个「发球」
 *
 * 真实网球每一分有两次发球机会：一发失误还有二发，二发再失误就是双误，
 * 这一分归接发方。而且发球**必须落在斜对角的发球区里**——不是「界内就行」。
 * 这条规则和判断落点用的是同一个 `onCollision`，区别只是落点区间从整块半场
 * 收窄成 `serveBox()`。
 *
 * 玩家发球时球是**自动抛起来的**（竖直上抛），但必须自己挥拍去打；没挥到
 * 就是一次失误。抛球不是「发球机」——球只是被抛起来，怎么打、打到哪儿
 * 全看玩家这一拍。
 *
 * ## 判分只看落点
 *
 * 一度想按「球穿过击球面」判漏接，那样能立刻给玩家反馈，但会误判：
 * 玩家打出一条飞向底线的长球，球会先穿过对手的击球面、再落在界外——
 * 按击球面判就是「对手漏接，玩家得分」，而实际上这球出界了，该玩家失分。
 *
 * 所以胜负只在三个时刻判定：**落地、撞网、飞出范围**。代价是反馈晚半秒左右，
 * 但这半秒换来的是判罚正确。中间过程仍然给提示（球从身边过去了），
 * 只是不立刻定输赢。
 *
 * ## 一球的生命周期
 *
 *   wait → (玩家) setup → toss → 挥拍 → live
 *        → (机器) 直接发球 → live
 *   live → 落地界内 → 接球方击球 → …… → point → wait → 下一分
 *   serve 落点不在发球区 → fault → 二发 / 双误
 */

import {
  advance,
  aimIntoCourt,
  makeBall,
  type Ball,
  type Collision,
} from './physics';
import { shotFromStroke, type Stroke } from './swing';
import { faceCenter, RacketTrack, sweepFace, type FaceHit, type RacketPose } from './racket';
import {
  BALL_R,
  BASELINE_Z,
  DUEL_PAD,
  HALF_WIDTH,
  HIT_WINDOW_MS,
  HIT_Z,
  NET_Z,
  OPP_BASELINE_Z,
  OPP_HIT_Z,
  RACKET_POS,
} from './court';
import { BallMachine, type MachineConfig } from './machine';
import { TennisMatch, pointLabel, type ServeCourt } from './match';
import {
  serveAim,
  serveBox,
  serveStandX,
  tossContact,
  TOSS_FWD,
  TOSS_VY,
  TOSS_Y0,
  SERVE_TOSS_Z,
  SERVE_STAND_Z,
  type ServeBox,
} from './serve';
import type { V3 } from './vec';

export type DuelSide = 'player' | 'machine';
export type DuelPhase = 'wait' | 'setup' | 'toss' | 'live' | 'contact' | 'over';

export interface DuelScore {
  player: number;
  machine: number;
}

export interface DuelDiag {
  /** 累计挥拍次数 */
  swings: number;
  /** 球穿过我方击球面的次数 */
  reaches: number;
  /** 最近一次命中偏离甜区（0 = 正中，1 = 拍框内沿，null = 没碰到） */
  lastOffCenter: number | null;
  /** 最近一次挥拍的时差（ms，正 = 晚） */
  lastLag: number | null;
  /** 球到面之后停了多久才被打出去（ms）。抢跑生效时是个位数。 */
  lastLatency: number | null;
}

/** 发球失误的原因。`short` = 弹在了发球方自己半场（没过网）。 */
export type FaultReason = 'out' | 'net' | 'short' | 'nohit' | 'stop';

export type DuelEvent =
  | { kind: 'hit'; by: DuelSide; at: V3; speed: number; clean: boolean; serve?: boolean }
  | { kind: 'ground'; at: V3; half: DuelSide }
  | { kind: 'net'; by: DuelSide }
  | { kind: 'out'; by: DuelSide; at: V3 }
  | { kind: 'miss'; by: DuelSide; reason: 'late' | 'double' | 'stop' }
  | { kind: 'point'; winner: DuelSide; reason: string; rally: number }
  | { kind: 'game'; winner: DuelSide; games: [number, number] }
  | { kind: 'tiebreak' }
  | { kind: 'matchOver'; winner: DuelSide; games: [number, number] }
  | { kind: 'fault'; by: DuelSide; attempt: 1 | 2; reason: FaultReason; at: V3 }
  | { kind: 'serve'; by: DuelSide; attempt: 1 | 2; court: ServeCourt };

/** 一分结束后多久重新发球 */
const RESERVE_MS = 1700;
/** 一发失误到二发之间的间隔。比换分短：同一个站位、同一个人，只是再抛一次。 */
const FAULT_RESERVE_MS = 1100;
/** 玩家碰到球之后等挥拍事件的上限。和墙打同一个理由：网络在路上要走 20–60ms。 */
const CONTACT_HOLD_MS = 100;
/** 一球的最长存活时间，防止球卡在角落永远不结束 */
const MAX_RALLY_MS = 14000;
/** 击球面之后多远算「球已经过去了」，只用来给提示，不定输赢 */
const BEHIND_PAD = 0.4;
/** 发球准备的最长等待（等玩家走到发球位）。超过就直接抛球，别让人干等。 */
const SETUP_MAX_MS = 1600;
/** 抛球之后多久还没打出去就算这次发球没了。 */
const TOSS_TIMEOUT_MS = 3200;

/**
 * 发球第一次弹起后、飞到接发方击球面时该有多高（米）。
 *
 * 下限 1.35：玩家的握点最低 0.70（`AUTO_MOVE_DEFAULTS.minGripY`），拍面中心挂在
 * 握点外 0.6m 的杆子上，所以够得到的下限就是 1.30 左右。
 * 上限 2.10：握点最高 1.65 → 拍面能到 2.25，留一点余量。
 *
 * 它同时是**机器发球**的筛选条件，见 `solveServe`。
 */
const SERVE_ARRIVE_MIN = 1.35;
const SERVE_ARRIVE_MAX = 2.1;
const SERVE_ARRIVE_WANT = 1.65;

const other = (s: DuelSide): DuelSide => (s === 'player' ? 'machine' : 'player');
const halfOf = (z: number): DuelSide => (z > NET_Z ? 'player' : 'machine');
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class Duel {
  ball: Ball = makeBall([0, BALL_R, OPP_BASELINE_Z + 0.45], [0, 0, 0]);
  phase: DuelPhase = 'wait';
  /** 分 / 局 / 盘。判定与显示都以它为准，`score` 只是它的一个视图。 */
  match = new TennisMatch('player');
  /** 本次回合双方各击球一次算一拍 */
  rally = 0;
  bestRally = 0;
  status = '准备中';

  /** 必须接下一拍的一方 */
  receiver: DuelSide = 'player';
  /** 上一个击球方 */
  hitter: DuelSide = 'machine';

  /** 这一分已经发了几次（1 = 一发，2 = 二发）。每次得分后回到 1。 */
  serveAttempt: 1 | 2 = 1;
  /** 球从发球出手到第一次落地之间 = true。落地判定按发球区来。 */
  servePending = false;

  readonly machine: BallMachine;
  diag: DuelDiag = { swings: 0, reaches: 0, lastOffCenter: null, lastLag: null, lastLatency: null };

  /** 这一分的发球方 / 发球区。发球过程中固定，抢七里每一分都可能变。 */
  private serveServer: DuelSide = 'player';
  private serveCourt: ServeCourt = 'deuce';

  private playerTrack = new RacketTrack();
  private machineTrack = new RacketTrack();
  private pending: Stroke[] = [];

  private started = false;
  private phaseAt = 0;
  private deadAt = 0;
  /** `wait` 阶段等多久再开下一分（换分和「一发失误」不一样长） */
  private waitMs = RESERVE_MS;

  /** 接球方半场上的落地次数。0/1 合法，2 失分。 */
  private bouncesOnReceiver = 0;
  private contactSide: DuelSide | null = null;
  /** 这一拍真正打出去的时刻，用来算「球在拍面上停了多久」 */
  private contactLaunchedAt = 0;
  private contactAt = 0;
  private contactPoint: V3 | null = null;

  /**
   * @param liveStroke 抢跑取拍：球已经贴在拍面上时，直接从检测器里取
   *   「正在进行中」的那一挥，别让球悬着等结算。
   */
  constructor(
    private liveStroke?: (near: number) => Stroke | null,
    cfg?: MachineConfig
  ) {
    this.machine = new BallMachine(cfg);
    this.serveServer = this.match.serveInfo().server;
    this.serveCourt = this.match.serveInfo().court;
  }

  /* ---------------- 比分视图 ---------------- */

  /** 本局（抢七时是本抢七）的原始分数。老调用方还在用它。 */
  get score(): DuelScore {
    return { player: this.match.points[0], machine: this.match.points[1] };
  }

  /** 本盘的局数。 */
  get games(): DuelScore {
    return { player: this.match.games[0], machine: this.match.games[1] };
  }

  get over(): boolean {
    return this.match.over;
  }

  /** 记分牌上的字（0 / 15 / 30 / 40 / AD；抢七是数字）。 */
  pointText(side: DuelSide): string {
    return pointLabel(this.match.points, side === 'player' ? 0 : 1, this.match.tiebreak);
  }

  /** 当前这一分（或即将开始的这一分）的发球方、发球区、第几发。 */
  get serveInfo(): { server: DuelSide; court: ServeCourt; attempt: 1 | 2 } {
    const info = this.match.serveInfo();
    return { server: info.server, court: info.court, attempt: this.serveAttempt };
  }

  /**
   * 玩家此刻该站到发球位的那一侧（x），null = 正常走位。
   *
   * `app.ts` 的走位用：只要不是 null，就把玩家搬到发球位、把握点举高，
   * 不再跑自动走位。发球是**站位固定**的动作，一边跑一边发不是网球。
   */
  get playerServeStanceX(): number | null {
    if (this.match.over) return null;
    if (this.phase === 'live' || this.phase === 'contact') return null;
    const info = this.match.serveInfo();
    return info.server === 'player' ? serveStandX('player', info.court) : null;
  }

  /**
   * 每帧喂玩家位姿。判定与渲染必须用同一份（AGENTS.md 硬约束 3）。
   *
   * 上层只有一个主循环，动词只该有一套。
   */
  pushRacket(pose: RacketPose) {
    this.playerTrack.push(pose);
  }

  /** 球拍端传来的挥拍事件，任意时刻到达都正常。 */
  submit(stroke: Stroke) {
    this.diag.swings++;
    this.pending.push(stroke);
    const cutoff = stroke.t - HIT_WINDOW_MS * 4;
    this.pending = this.pending.filter((s) => s.t > cutoff);
    if (this.pending.length > 10) this.pending.shift();
  }

  reset(now = 0) {
    this.phase = 'wait';
    this.match.reset('player');
    this.rally = 0;
    this.bestRally = 0;
    this.pending = [];
    this.playerTrack.reset();
    this.machineTrack.reset();
    this.machine.reset(now);
    this.machine.setHome(0);
    this.ball = makeBall([0, BALL_R, OPP_BASELINE_Z + 0.45], [0, 0, 0]);
    this.started = false;
    this.status = '准备中';
    this.serveAttempt = 1;
    this.servePending = false;
    const info = this.match.serveInfo();
    this.serveServer = info.server;
    this.serveCourt = info.court;
    this.waitMs = RESERVE_MS;
    this.diag = { swings: 0, reaches: 0, lastOffCenter: null, lastLag: null, lastLatency: null };
  }

  /** 回球机当前位姿，渲染用。 */
  machinePose(now: number): RacketPose {
    return this.machine.pose(now);
  }

  update(dt: number, now: number): DuelEvent[] {
    const ev: DuelEvent[] = [];
    if (!this.started) {
      this.started = true;
      this.deadAt = now - this.waitMs; // 立刻开第一球
    }

    if (this.phase === 'over') return ev;
    if (this.phase === 'contact') return this.tickContact(now, ev);

    if (this.phase === 'wait') {
      // 让球自己滚完再重发，静止画面比瞬间重置容易接受
      advance(this.ball, dt, () => {});
      if (now - this.deadAt > this.waitMs) this.beginPoint(now, ev);
      return ev;
    }

    // 玩家发球：等走到站位（或等到超时）再抛球。
    if (this.phase === 'setup') {
      if (this.playerAtStance() || now - this.phaseAt > SETUP_MAX_MS) this.startToss(now);
      return ev;
    }

    if (this.phase === 'toss') return this.tickToss(dt, now, ev);

    if (now - this.phaseAt > MAX_RALLY_MS) {
      if (this.servePending) this.fault('stop', now, ev);
      else this.finish(other(this.hitter), '超时', now, ev);
      return ev;
    }

    // 回球机要在物理推进**之前**更新：这一帧的拍面位姿必须先确定，
    // 才能参与本帧子步的求交（渲染与判定必须用同一份 pose）。
    if (this.receiver === 'machine') this.machine.update(dt, now, this.ball);
    this.machineTrack.push(this.machine.pose(now));

    const prevP: V3 = [this.ball.p[0], this.ball.p[1], this.ball.p[2]];
    const t0 = now - dt * 1000;
    advance(
      this.ball,
      dt,
      (c) => this.onCollision(c, now, ev),
      (p0, p1, s0, s1) => this.checkReceiverFace(p0, p1, s0, s1, now, ev),
      t0
    );

    // 「球从身边过去了」只是提示，不判输赢——它可能是个出界球。
    if (this.phase === 'live') {
      const plane =
        this.receiver === 'player'
          ? (this.playerTrack.last ? faceCenter(this.playerTrack.last)[2] : HIT_Z) + BEHIND_PAD
          : OPP_HIT_Z - BEHIND_PAD;
      const crossed =
        this.receiver === 'player'
          ? prevP[2] < plane && this.ball.p[2] >= plane
          : prevP[2] > plane && this.ball.p[2] <= plane;
      if (crossed) this.status = this.receiver === 'player' ? '球从身边过去了' : '对手没接到';
    }

    // 球在场上滚停了（接球方没挥）：判接球方失分。
    // 少了这一条，缓速滚动的球永远等不到「第二次落地」，一分会卡死。
    if (this.phase === 'live' && this.bouncesOnReceiver >= 1) {
      const b = this.ball;
      if (Math.hypot(b.v[0], b.v[1], b.v[2]) < 1.2 && b.p[1] < 0.3) {
        if (this.servePending) this.fault('stop', now, ev);
        else this.finish(other(this.receiver), '球停住了', now, ev);
      }
    }

    // 兜底：飞出正常范围（不是落地判的，是彻底迷路）。
    // 已经合法弹过一次的话，球滚出边线不代表击球方出界——那是接球方没接到。
    const b = this.ball;
    if (
      this.phase === 'live' &&
      (Math.abs(b.p[0]) > HALF_WIDTH + DUEL_PAD * 2 ||
        b.p[2] > BASELINE_Z + DUEL_PAD * 2 ||
        b.p[2] < OPP_BASELINE_Z - DUEL_PAD * 2 ||
        b.p[1] > 12)
    ) {
      if (this.servePending) this.fault('out', now, ev);
      else if (this.bouncesOnReceiver >= 1) this.finish(this.hitter, '对手没接到', now, ev);
      else this.finish(other(this.hitter), '出界', now, ev);
    }

    return ev;
  }

  /* ---------------- 一分开始 ---------------- */

  private beginPoint(now: number, ev: DuelEvent[]) {
    if (this.match.over) return;
    // 发球方 / 发球区完全由 `match` 决定：普通局每局换人、每分换边，
    // 抢七里还要按 1-2-2 轮转。这里只抄一份给判定层用。
    const info = this.match.serveInfo();
    this.serveServer = info.server;
    this.serveCourt = info.court;

    this.rally = 0;
    this.pending = [];
    this.bouncesOnReceiver = 0;
    this.servePending = false;

    if (info.server === 'machine') this.machineServe(now, ev);
    else this.playerServeSetup(now, ev);
  }

  /** 玩家发球：先走到站位，再抛球。 */
  private playerServeSetup(now: number, ev: DuelEvent[]) {
    // 接发球站位：站到「球要被发去的那半边」的中间，而不是钉在中线。
    const box = serveBox(this.serveServer, this.serveCourt);
    this.machine.setHome(clamp((box.x0 + box.x1) / 2, -2.8, 2.8));
    this.machine.park();

    // 球先「托在手里」：停在抛球出手点，不是躺在地上。`startToss` 从这儿接过去，
    // 所以球在画面里是连续的——先举着、再往上走。躺在地上会在抛球那一帧突然弹到 2 米。
    // 抛球点是**身体前上方**（站位靠网 `TOSS_FWD`），不是拍面所在的某个位置：
    // 见 `core/serve.ts` 的说明，位置跟着手机朝向跑就是「抛球位置不合理」的来源。
    this.ball = makeBall(
      [serveStandX('player', this.serveCourt), TOSS_Y0, SERVE_TOSS_Z],
      [0, 0, 0]
    );
    this.ball.live = false;
    this.hitter = 'player';
    this.receiver = 'machine';
    this.phase = 'setup';
    this.phaseAt = now;
    this.status = this.serveAttempt === 1 ? '你发球' : '你二发';
    ev.push({ kind: 'serve', by: 'player', attempt: this.serveAttempt, court: this.serveCourt });
  }

  /** 玩家站到发球位了没有。站位是固定的，别让他边跑边发。 */
  private playerAtStance(): boolean {
    const p = this.playerTrack.last;
    if (!p) return false;
    const sx = serveStandX('player', this.serveCourt);
    return (
      Math.abs(p.pos[0] - sx) < 0.22 &&
      Math.abs(p.pos[2] - SERVE_STAND_Z) < 0.3 &&
      p.pos[1] > RACKET_POS[1] + 0.25
    );
  }

  /**
   * 抛球。
   *
   * 抛在**身体前上方**：x 取握点的 x（人站哪儿抛哪儿），z 再往球网方向让
   * `TOSS_FWD`，高度从出手点 2.05 竖直上抛到顶点 3.43。整条弧都在
   * `serveStrike` 那一片击球区里，与手机怎么握、怎么转无关。
   *
   * 原来是从**拍面中心**抛：竖握时在头顶（还行），横握时在胸前 0.6m 外、
   * 屏幕朝天时又是第三个地方——同一句「抛球」在三种握法下抛到三个地方，
   * 玩家举拍时球根本不在那儿（11-15 真机反馈第 1 条）。
   *
   * 抛球点定在出手那一刻的位置，之后球按自己的抛物线走：玩家得自己把拍子
   * 送到球上，不是球来找拍子。
   */
  private startToss(now: number) {
    const pose = this.playerTrack.last;
    const sx = serveStandX('player', this.serveCourt);
    const gx = pose ? pose.pos[0] : sx;
    const gz = pose ? pose.pos[2] : SERVE_STAND_Z;
    this.ball = makeBall([gx, TOSS_Y0, gz - TOSS_FWD], [0, TOSS_VY, 0]);
    this.phase = 'toss';
    this.phaseAt = now;
    this.status = '抛球';
  }

  /** 抛球阶段：球只有重力，玩家必须自己挥拍把它打出去。 */
  private tickToss(dt: number, now: number, ev: DuelEvent[]): DuelEvent[] {
    const t0 = now - dt * 1000;
    advance(
      this.ball,
      dt,
      (c) => {
        // 抛起来没打到，球落地 = 这次发球没了
        if (c.kind === 'ground' && this.phase === 'toss') this.fault('nohit', now, ev);
      },
      (p0, p1, s0, s1) => {
        const t = (s0 + s1) * 0.5;
        const pose = this.playerTrack.at(t);
        if (!pose) return true;
        const hit = tossContact(pose, p0, p1, this.ball.v[1]);
        if (!hit) return true;
        // 球碰到拍面了，但这一下没有挥拍 → 只是穿过去，继续掉
        const s = this.takeStroke(t);
        if (!s) return true;
        this.launchServe(hit.at, s, now, ev);
        return false;
      },
      t0
    );

    if (this.phase === 'toss' && now - this.phaseAt > TOSS_TIMEOUT_MS) {
      this.fault('nohit', now, ev);
    }
    return ev;
  }

  /**
   * 玩家把抛球打出去。
   *
   * 落点由**拍面的水平朝向**决定（左右）+ **俯角**映射到发球区的深浅
   * （见 `core/serve.ts` 的说明：直接从射线求交点的话，合法的俯角窗口只有
   * 3.6°，手机上没法玩）。落点定下来之后用 `aimIntoCourt` 反解出一条
   * 从击球点到那个落点的弧线——所以屏幕上那圈瞄准点就是球真正会落的地方。
   */
  private launchServe(at: V3, s: Stroke, now: number, ev: DuelEvent[]) {
    const shot = shotFromStroke(s);
    const box = serveBox(this.serveServer, this.serveCourt);
    // 拍柄方向一起传给 `serveAim`：举拍发球时手机常常是「屏幕朝天」，
    // 那时法线的水平分量只是一条噪声，改由拍框朝向当准星（见 `core/serve.ts`）。
    const aim = serveAim(at, s.face, this.serveServer, this.serveCourt, s.grip);

    const base = {
      zMin: box.z0 + 0.04,
      zMax: box.z1 - 0.04,
      xMax: HALF_WIDTH - 0.06,
      minClear: 0.08,
      maxClear: 2.8,
    };
    // 挥得越重，求解时允许的球速越高（落点不变，过去的球更快）。
    // 求解失败就放开整个区间再来一次，最后才退回「照着拍面甩出去」——
    // 那一下大概率出界，但玩家能看到一次真实的失误，比球凭空消失好。
    const want = clamp(s.speed, 16, 34);
    const v =
      aimIntoCourt(at, aim.point, shot.spin, {
        ...base,
        speed: [Math.max(12, want * 0.72), Math.min(34, want * 1.15)],
      }) ??
      aimIntoCourt(at, aim.point, shot.spin, { ...base, speed: [10, 34] }) ??
      shot.v;

    this.startServeFlight('player', at, v, shot.spin, now, ev);
    this.contactLaunchedAt = now;
    this.status = aim.inBox ? '发球' : '发球出界';
  }

  /** 机器发球：直接按其真实站位解一条进发球区、而且**接得到**的弧线。 */
  private machineServe(now: number, ev: DuelEvent[]) {
    const stand = serveStandX('machine', this.serveCourt);
    this.machine.setHome(0);
    this.machine.park();
    this.machine.pos = [stand, 1.1, OPP_BASELINE_Z + 0.5];

    const box = serveBox('machine', this.serveCourt);
    // 发球点抬到 2.35m：真实发球的击球点在头上，不是腰上。
    const from: V3 = [stand, 2.35, OPP_BASELINE_Z + 0.45];
    const spin: V3 = [-this.machine.cfg.spinRate * 0.6, 0, 0];

    const v = this.solveServe(from, spin, box) ?? ([0, 4.5, 13] as V3);

    this.startServeFlight('machine', from, v, spin, now, ev);
    this.status = '对手发球';
    ev.push({ kind: 'serve', by: 'machine', attempt: this.serveAttempt, court: this.serveCourt });
  }

  /**
   * 扫一条「进发球区 + 接到手」的机器发球弹道。
   *
   * ## 为什么不能只用 `aimIntoCourt` 的 `arriveY`
   *
   * 发球区在网和发球线之间（z −10.5…−4.5），接发方的击球面在 z=0.3——球落地之后
   * 还要再飞 4.8–10.8 米才到拍面。实测（24 个落点 × 现有参数）**一次都解不出来**，
   * 于是每次都退到「只要落点进区」那一档，发出来的球在拍面高度只剩 0.4 米，
   * 玩家连球皮都碰不到，对手的每个发球局都是白送。
   *
   * 根子在几何：平飞过去的球落地后弹一下，在 z≈−3 就二次落地了（此时拍面还在
   * 0.4m 高的贴地滚）；只有**抛高一点**的发球才能带着一整个第一弹的弧线飞到拍面。
   * 所以这里固定 `vy`=5.0–6.0（顶点约 4.2m），只扫水平速度：14–16 m/s、落点压在
   * 发球线内侧 —— 到面高度正好 1.5–1.8 米。
   *
   * ## 为什么是「扫」而不是「解」
   *
   * 弹起之后的高度没有解析式（恢复系数 + 旋转都在 `advance` 里），所以用真物理
   * 前向跑一遍最省事也最准：一次发球最多 39 条 4 秒的弹道，一分才跑一次。
   */
  private solveServe(from: V3, spin: V3, box: ServeBox): V3 | null {
    // 落点取发球区靠内的那一段。贴边线的角度会让球到拍面时飘到 ±3.5 米外，
    // 那是「发 ace」的目标，而机器发球的目标是「把一分开起来」。
    const tx = box.x0 + (box.x1 - box.x0) * (0.3 + Math.random() * 0.4);
    const dx = tx - from[0];
    const dz = (box.z0 + box.z1) / 2 - from[2];
    const R = Math.hypot(dx, dz);
    if (R < 0.5) return null;
    const ux = dx / R;
    const uz = dz / R;

    let best: V3 | null = null;
    let bestErr = Infinity;
    for (let vh = 12; vh <= 18; vh += 0.5) {
      for (const vy of [6, 5.5, 5]) {
        const v: V3 = [ux * vh, vy, uz * vh];
        const probe = makeBall(from, v, spin);
        let land: V3 | null = null;
        let arrY = NaN;
        let ok = true;
        for (let i = 0; i < 240 * 4 && ok; i++) {
          const z0 = probe.p[2];
          advance(probe, 1 / 240, (c) => {
            if (c.kind !== 'ground') return;
            if (!land) land = [c.at[0], c.at[1], c.at[2]];
            // 二次落地发生在击球面之前 = 接发方碰不到，这条不能用
            else if (c.at[2] < HIT_Z) ok = false;
          });
          if (!probe.live) break;
          if (z0 < HIT_Z && probe.p[2] >= HIT_Z) {
            arrY = probe.p[1];
            break;
          }
        }
        if (!ok || !land || !Number.isFinite(arrY)) continue;
        if (land[0] < box.x0 || land[0] > box.x1 || land[2] < box.z0 || land[2] > box.z1) continue;
        if (arrY < SERVE_ARRIVE_MIN || arrY > SERVE_ARRIVE_MAX) continue;
        const err = Math.abs(arrY - SERVE_ARRIVE_WANT);
        if (err < bestErr) {
          bestErr = err;
          best = v;
        }
      }
    }
    return best;
  }

  /**
   * 发球出手 → 进入 live，但 `servePending` 还是 true：
   * 在球第一次落地之前，所有的落点判定都要按发球区来。
   */
  private startServeFlight(
    side: DuelSide,
    at: V3,
    v: V3,
    spin: V3,
    now: number,
    ev: DuelEvent[]
  ) {
    this.ball = makeBall(at, v, spin);
    this.hitter = side;
    this.receiver = other(side);
    this.bouncesOnReceiver = 0;
    this.rally = 0;
    this.servePending = true;
    this.phase = 'live';
    this.phaseAt = now;
    this.contactSide = null;
    this.contactPoint = null;
    if (this.receiver === 'machine') this.machine.beginPlay(now);

    ev.push({
      kind: 'hit',
      by: side,
      at: [...at] as V3,
      speed: Math.hypot(v[0], v[1], v[2]),
      clean: true,
      serve: true,
    });
  }

  /* ---------------- 击球 ---------------- */

  private checkReceiverFace(
    p0: V3,
    p1: V3,
    s0: number,
    s1: number,
    now: number,
    ev: DuelEvent[]
  ): boolean {
    if (this.phase !== 'live') return true;
    const t = (s0 + s1) * 0.5;
    const track = this.receiver === 'player' ? this.playerTrack : this.machineTrack;
    const pose = track.at(t);
    if (!pose) return true;

    const hit = sweepFace(pose, p0, p1);
    if (!hit) return true;

    this.enterContact(this.receiver, hit, s0 + (s1 - s0) * hit.s, now, ev);
    // 球已被接住或已打出去，剩下的子步不能再推进
    return false;
  }

  private enterContact(side: DuelSide, hit: FaceHit, t: number, now: number, ev: DuelEvent[]) {
    this.contactSide = side;
    this.contactAt = t;
    this.contactPoint = [...hit.at] as V3;

    if (side === 'player') {
      this.diag.reaches++;
      this.diag.lastOffCenter = hit.offCenter;
    }

    // 把球按在命中点上
    this.ball.p = [hit.at[0], hit.at[1], hit.at[2]];
    this.ball.v = [0, 0, 0];
    this.phase = 'contact';
    this.phaseAt = t;

    if (side === 'player') {
      // 玩家多半是提前挥拍，先试一次，不需要任何等待
      const s = this.takeStroke(t);
      if (s) {
        this.recordLag(t, s);
        this.launchPlayer(s, now, ev);
      } else {
        this.recordLag(t, null);
      }
      return;
    }

    // 回球机：碰到拍面这一刻就知道它挥没挥。没挥 → 这一分归玩家。
    const v = this.machine.attemptReturn(now, hit.at);
    if (v) {
      this.launch('machine', hit.at, v, [-this.machine.cfg.spinRate, 0, 0], now, ev);
    } else {
      // 让球掉下去，别僵在半空
      this.ball.v = [0, -1.5, -0.5];
      this.phase = 'live';
      this.finish('player', '对手没打中', now, ev);
    }
  }

  private tickContact(now: number, ev: DuelEvent[]): DuelEvent[] {
    if (this.contactSide !== 'player') return ev;

    const s = this.takeStroke(this.contactAt);
    if (s) {
      this.recordLag(this.contactAt, s);
      this.launchPlayer(s, now, ev);
      return ev;
    }

    if (now - this.contactAt > CONTACT_HOLD_MS) {
      this.recordLag(this.contactAt, null);
      // 球不能按原速穿过拍面飞走（看起来就是穿模）。让它擦框掉下去，
      // 和 HUD 那句「漏接」对得上——墙打那边同一条处理。
      this.ball.v = [0, -1.2, -0.8];
      this.phase = 'live';
      this.finish('machine', '没挥拍', now, ev);
    }
    return ev;
  }

  private recordLag(t: number, matched: Stroke | null) {
    if (matched) {
      this.diag.lastLag = matched.t - t;
      this.diag.lastLatency = Math.max(0, this.contactLaunchedAt - t);
      return;
    }
    let lag: number | null = null;
    for (const s of this.pending) {
      if (s.used) continue;
      const d = s.t - t;
      if (lag === null || Math.abs(d) < Math.abs(lag)) lag = d;
    }
    this.diag.lastLag = lag;
  }

  private takeStroke(t: number): Stroke | null {
    let best: Stroke | null = null;
    let bestD = Infinity;
    for (const s of this.pending) {
      if (s.used) continue;
      const d = Math.abs(s.t - t);
      if (d > HIT_WINDOW_MS) continue;
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    if (best) {
      best.used = true;
      this.pending = this.pending.filter((s) => !s.used);
      return best;
    }

    const live = this.liveStroke?.(t);
    if (live) {
      live.used = true;
      this.diag.swings++;
      return live;
    }
    return null;
  }

  /**
   * 玩家出球。
   *
   * 这里**没有回球补偿**（墙打时代那个 `liftOverNet`）。
   *
   * 补偿的职责是「兜一条能过网、还能弹回自己拍面的弧线」，只对「必须让球自己回来」
   * 的玩法成立。对打里球打过网之后是对手的事，玩家打飞了就该出界。
   * 保留补偿会让玩家「怎么乱挥都能进」，这个模式就没有可练的东西了。
   */
  private launchPlayer(s: Stroke, now: number, ev: DuelEvent[]) {
    const at = this.contactPoint;
    if (!at) return;

    const shot = shotFromStroke(s);
    // 高球不好发力，理由同墙打：打断「越打越高」的正反馈（见 rally.ts 的说明）
    const pen = at[1] > 1.35 ? Math.max(0.62, 1 - (at[1] - 1.35) * 0.34) : 1;
    const v: V3 = [shot.v[0] * pen, shot.v[1] * pen, shot.v[2] * pen];

    this.launch('player', at, v, shot.spin, now, ev);
    this.contactLaunchedAt = now;
    this.status = !shot.clean ? '拍面没打开' : shot.topSpin > 60 ? '上旋' : '平击';
  }

  private launch(side: DuelSide, at: V3, v: V3, spin: V3, now: number, ev: DuelEvent[]) {
    this.ball.p = [at[0], at[1], at[2]];
    this.ball.v = [...v];
    this.ball.spin = [...spin];
    this.ball.bounces = 0;
    this.ball.live = true;

    this.hitter = side;
    this.receiver = other(side);
    this.bouncesOnReceiver = 0;
    this.rally++;
    if (this.rally > this.bestRally) this.bestRally = this.rally;

    this.phase = 'live';
    this.phaseAt = this.contactAt || now;
    this.contactSide = null;
    this.contactPoint = null;

    if (this.receiver === 'machine') this.machine.beginPlay(now);

    ev.push({
      kind: 'hit',
      by: side,
      at: [...at],
      speed: Math.hypot(v[0], v[1], v[2]),
      clean: true,
    });
  }

  /* ---------------- 球的事件 ---------------- */

  private onCollision(c: Collision, now: number, ev: DuelEvent[]) {
    switch (c.kind) {
      case 'ground': {
        const half = halfOf(c.at[2]);
        ev.push({ kind: 'ground', at: c.at, half });

        // 发球：第一次落地先按发球区判，不是按整块半场
        if (this.servePending) {
          this.gradeServe(c.at, half, now, ev);
          return;
        }

        // 已经合法弹过一次了：这一球的结果已经定了，后面弹在哪里都不再改判。
        // 少了这一条会出现很荒唐的判罚——球落在界内、对手没接到，然后球继续
        // 滚出边线，被判成「击球方出界」，得分反过来给了对手。
        // 真实网球里第一落点在界内就定局，之后球滚到哪都不影响这一分。
        if (this.bouncesOnReceiver >= 1) {
          this.bouncesOnReceiver++;
          if (this.bouncesOnReceiver >= 2) {
            ev.push({ kind: 'miss', by: this.receiver, reason: 'double' });
            this.finish(this.hitter, '两次落地', now, ev);
          }
          return;
        }

        // 第一落点才判出界/没过网。顺序很重要：压在底线外侧的球不能先被
        // 算成「接球方没接到」。
        const inside =
          Math.abs(c.at[0]) <= HALF_WIDTH &&
          c.at[2] <= BASELINE_Z &&
          c.at[2] >= OPP_BASELINE_Z;
        if (!inside || half === this.hitter) {
          ev.push({ kind: 'out', by: this.hitter, at: c.at });
          this.finish(other(this.hitter), half === this.hitter ? '没过网' : '出界', now, ev);
          return;
        }

        this.bouncesOnReceiver = 1;
        break;
      }
      case 'net':
        if (this.servePending) {
          this.fault('net', now, ev);
          break;
        }
        ev.push({ kind: 'net', by: this.hitter });
        this.ball.live = false;
        this.finish(other(this.hitter), '下网', now, ev);
        break;
    }
  }

  /**
   * 发球第一次落地：在正确的发球区里 → 这一发成功、进入正常回合；
   * 否则是一次失误。
   */
  private gradeServe(at: V3, half: DuelSide, now: number, ev: DuelEvent[]) {
    const box = serveBox(this.serveServer, this.serveCourt);
    const inBox =
      half === other(this.serveServer) &&
      at[0] >= box.x0 - 1e-9 &&
      at[0] <= box.x1 + 1e-9 &&
      at[2] >= box.z0 - 1e-9 &&
      at[2] <= box.z1 + 1e-9;

    if (inBox) {
      this.servePending = false;
      this.bouncesOnReceiver = 1;
      this.status = '接发球';
      return;
    }
    this.fault(half === this.serveServer ? 'short' : 'out', now, ev);
  }

  /**
   * 发球失误：一发还有一次机会，二发就是双误、这一分归接发方。
   *
   * 注意**不换发球区**：一发和二发站的是同一侧，规则上由「这一局已经打了
   * 几分」决定，失误本身不占分数。
   */
  private fault(reason: FaultReason, now: number, ev: DuelEvent[]) {
    if (this.phase === 'wait' || this.phase === 'over') return;
    const by = this.serveServer;
    ev.push({
      kind: 'fault',
      by,
      attempt: this.serveAttempt,
      reason,
      at: [...this.ball.p] as V3,
    });
    this.servePending = false;

    if (this.serveAttempt === 1) {
      this.serveAttempt = 2;
      this.status = '一发失误';
      this.toWait(now, FAULT_RESERVE_MS);
      return;
    }
    this.finish(other(by), '双误', now, ev);
  }

  private toWait(now: number, ms: number) {
    this.phase = 'wait';
    this.deadAt = now;
    this.waitMs = ms;
    this.contactSide = null;
    this.contactPoint = null;
    this.machine.endPlay();
    this.bouncesOnReceiver = 0;
  }

  private finish(winner: DuelSide, reason: string, now: number, ev: DuelEvent[]) {
    if (this.phase === 'wait' || this.phase === 'over') return;

    const outcome = this.match.awardPoint(winner);
    ev.push({ kind: 'point', winner, reason, rally: this.rally });
    this.status = reason;

    this.contactSide = null;
    this.contactPoint = null;
    this.machine.endPlay();
    this.servePending = false;
    this.serveAttempt = 1;

    if (outcome.gameWon) {
      ev.push({ kind: 'game', winner, games: [...this.match.games] as [number, number] });
    }
    if (outcome.tiebreakStarted) ev.push({ kind: 'tiebreak' });
    if (outcome.matchWon) {
      this.phase = 'over';
      this.status = winner === 'player' ? '你赢了这一盘' : '对手赢了这一盘';
      this.ball.live = false;
      ev.push({
        kind: 'matchOver',
        winner,
        games: [...this.match.games] as [number, number],
      });
      return;
    }

    this.toWait(now, RESERVE_MS);
  }
}
