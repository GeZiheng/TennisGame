/**
 * 对打：玩家 vs 脚本回球机。
 *
 * ## 和墙打（`Rally`）的关系
 *
 * 复用的部分：`advance` 的物理、`sweepFace` 的拍面判定、`shotFromStroke`
 * 的挥拍→出球、`RacketTrack` 的位姿插值、`SwingDetector`（在外面）。
 * 不共享的部分：状态机、判分、发球。所以这是**另一个类**，不是 `Rally` 加个
 * 模式开关——两者的阶段语义完全不同（一个是「球会不会自己回来」，
 * 一个是「这一分归谁」），捏在一起只会让两边都难读。
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
 *   serve(机器) → live → 落地界内 → 玩家击球 → live → 机器击球/没接到
 *              → …… → point → wait → serve
 *
 * `bouncesOnReceiver` 是「接球方半场上弹了几次」。网球规则：可以弹一次，
 * 弹第二次就失分。
 */

import {
  advance,
  aimIntoCourt,
  makeBall,
  setWallActive,
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
} from './court';
import { ARRIVE_Y_MAX, ARRIVE_Y_MIN, BallMachine, type MachineConfig } from './machine';
import type { V3 } from './vec';

export type DuelSide = 'player' | 'machine';
export type DuelPhase = 'wait' | 'live' | 'contact';

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

export type DuelEvent =
  | { kind: 'hit'; by: DuelSide; at: V3; speed: number; clean: boolean }
  | { kind: 'ground'; at: V3; half: DuelSide }
  | { kind: 'net'; by: DuelSide }
  | { kind: 'out'; by: DuelSide; at: V3 }
  | { kind: 'miss'; by: DuelSide; reason: 'late' | 'double' | 'stop' }
  | { kind: 'point'; winner: DuelSide; reason: string; rally: number }
  | { kind: 'serve'; by: DuelSide };

/** 一分结束后多久重新发球 */
const RESERVE_MS = 1700;
/** 玩家碰到球之后等挥拍事件的上限。和墙打同一个理由：网络在路上要走 20–60ms。 */
const CONTACT_HOLD_MS = 100;
/** 一球的最长存活时间，防止球卡在角落永远不结束 */
const MAX_RALLY_MS = 14000;
/** 击球面之后多远算「球已经过去了」，只用来给提示，不定输赢 */
const BEHIND_PAD = 0.4;

const other = (s: DuelSide): DuelSide => (s === 'player' ? 'machine' : 'player');
const halfOf = (z: number): DuelSide => (z > NET_Z ? 'player' : 'machine');

export class Duel {
  ball: Ball = makeBall([0, BALL_R, OPP_BASELINE_Z + 0.45], [0, 0, 0]);
  phase: DuelPhase = 'wait';
  score: DuelScore = { player: 0, machine: 0 };
  /** 本次回合双方各击球一次算一拍 */
  rally = 0;
  bestRally = 0;
  status = '准备中';

  /** 必须接下一拍的一方 */
  receiver: DuelSide = 'player';
  /** 上一个击球方 */
  hitter: DuelSide = 'machine';

  readonly machine: BallMachine;
  diag: DuelDiag = { swings: 0, reaches: 0, lastOffCenter: null, lastLag: null, lastLatency: null };

  private playerTrack = new RacketTrack();
  private machineTrack = new RacketTrack();
  private pending: Stroke[] = [];

  private started = false;
  private phaseAt = 0;
  private deadAt = 0;

  /** 接球方半场上的落地次数。0/1 合法，2 失分。 */
  private bouncesOnReceiver = 0;
  private contactSide: DuelSide | null = null;
  /** 这一拍真正打出去的时刻，用来算「球在拍面上停了多久」 */
  private contactLaunchedAt = 0;
  private contactAt = 0;
  private contactPoint: V3 | null = null;

  /**
   * @param liveStroke 抢跑取拍，理由同 `Rally`：球已经贴在拍面上时，
   *   直接从检测器里取「正在进行中」的那一挥，别让球悬着等结算。
   */
  constructor(
    private liveStroke?: (near: number) => Stroke | null,
    cfg?: MachineConfig
  ) {
    this.machine = new BallMachine(cfg);
    // 对打没有练习墙。这一句必须在构造时生效：球从对手底线飞过来，
    // 会先经过网后 1.4 米那堵墙（WALL_Z=-11.9），墙一开一球都过不了网。
    setWallActive(false);
  }

  /**
   * 每帧喂玩家位姿。判定与渲染必须用同一份（AGENTS.md 硬约束 3）。
   *
   * 名字和 `Rally.pushRacket` 对齐：上层只有一个主循环，两种模式不该有两套动词。
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
    this.score = { player: 0, machine: 0 };
    this.rally = 0;
    this.bestRally = 0;
    this.pending = [];
    this.playerTrack.reset();
    this.machineTrack.reset();
    this.machine.reset(now);
    this.ball = makeBall([0, BALL_R, OPP_BASELINE_Z + 0.45], [0, 0, 0]);
    this.started = false;
    this.status = '准备中';
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
      this.deadAt = now - RESERVE_MS; // 立刻开第一球
    }

    if (this.phase === 'contact') return this.tickContact(now, ev);

    if (this.phase === 'wait') {
      // 让球自己滚完再重发，静止画面比瞬间重置容易接受
      advance(this.ball, dt, () => {});
      if (now - this.deadAt > RESERVE_MS) this.serve(now, ev);
      return ev;
    }

    if (now - this.phaseAt > MAX_RALLY_MS) {
      this.finish(other(this.hitter), '超时', now, ev);
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
        this.finish(other(this.receiver), '球停住了', now, ev);
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
      if (this.bouncesOnReceiver >= 1) this.finish(this.hitter, '对手没接到', now, ev);
      else this.finish(other(this.hitter), '出界', now, ev);
    }

    return ev;
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
   * 和墙打最大的不同：这里**没有 `liftOverNet`**。
   *
   * 墙打模式必须给回球兜一条能过网、还能弹回自己拍面的弧线，否则玩家永远打不出
   * 一个能继续的回合。对打不一样——球打过网之后是对手的事，玩家打飞了就该出界。
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
        ev.push({ kind: 'net', by: this.hitter });
        this.ball.live = false;
        this.finish(other(this.hitter), '下网', now, ev);
        break;
      case 'wall':
        // 对打模式墙是关的；走到这里说明模式没切干净。不吞事件，交给上面兜底。
        break;
    }
  }

  private finish(winner: DuelSide, reason: string, now: number, ev: DuelEvent[]) {
    if (this.phase === 'wait') return;
    this.score[winner]++;
    ev.push({ kind: 'point', winner, reason, rally: this.rally });
    this.status = reason;
    this.phase = 'wait';
    this.deadAt = now;
    this.contactSide = null;
    this.contactPoint = null;
    this.machine.endPlay();
    this.bouncesOnReceiver = 0;
  }

  /* ---------------- 发球 ---------------- */

  /**
   * 发球。v1 固定由回球机发——玩家的发球需要抛球动作，那是另一套输入设计，
   * 先不做。所以这一局现在是「接发球 + 对拉」的形态，回合从机器发球开始。
   */
  private serve(now: number, ev: DuelEvent[]) {
    this.machine.park();
    this.pending = [];

    const from: V3 = [this.machine.homeX, 1.45, OPP_BASELINE_Z + 0.45];
    // 落点只能落在「能接到」的那条窄带上（见 machine.ts 的说明），
    // 横向随机，让接发球需要判断左右。
    const tx = (Math.random() - 0.5) * 4.2;
    const tz = -1.7 - Math.random() * 1.9;
    const spin: V3 = [-this.machine.cfg.spinRate * 0.5, 0, 0];

    const v =
      aimServe(from, [tx, BALL_R, tz], spin) ??
      aimServe(from, [0, BALL_R, NET_Z + 3], spin) ??
      ([0, 3.4, 15] as V3);

    this.ball = makeBall(from, v, spin);
    this.hitter = 'machine';
    this.receiver = 'player';
    this.bouncesOnReceiver = 0;
    this.rally = 0;
    this.phase = 'live';
    this.phaseAt = now;
    this.contactSide = null;
    this.contactPoint = null;
    this.status = '球来了';
    ev.push({ kind: 'serve', by: 'machine' });
  }
}

/**
 * 发球用的求解包装。
 *
 * 单独包一层是因为发球点在底线外 0.45 米，比中场击球更远，需要更快的初速
 * 才能把球送到 15 米外；`aimIntoCourt` 的默认扫描区间是按中场调的。
 * 第一次解不出来时放宽过网高度上限再试一次——抬高了才能用更小的速度够距离。
 */
function aimServe(from: V3, target: V3, spin: V3): V3 | null {
  // 发球也必须满足到面高度。第一版只约束落点，实测到面高度 0.17m，
  // 玩家一帧都接不到——拍面中心永远在握点上方 0.6m，够不到脚边的球。
  // 到面高度带和回球用的是同一段（`machine.ts` 的 ARRIVE_Y_*）：玩家能接的高度
  // 里只有这段既够得着又不至于把球打成月亮球。
  const base = { arriveZ: HIT_Z, arriveY: [ARRIVE_Y_MIN, ARRIVE_Y_MAX] as [number, number] };
  return (
    aimIntoCourt(from, target, spin, { ...base, maxClear: 2.2, speed: [9, 14] }) ??
    aimIntoCourt(from, target, spin, { ...base, maxClear: 2.4, speed: [8, 16] }) ??
    aimIntoCourt(from, target, spin, { ...base, maxClear: 2.6, minClear: 0.15, speed: [7, 18] })
  );
}
