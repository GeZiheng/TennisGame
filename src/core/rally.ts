/**
 * 对墙打。
 *
 * 规则极简：球从对面喂过来，你在击球平面附近挥拍把它打回去，撞墙、弹回、再过网。
 * 打过网一次算一拍，撞网或漏接就断。
 *
 * 三个设计决定值得单独说明，因为每一个都直接决定「手感像不像」：
 *
 * 1) 击球是**真几何碰撞**：球心轨迹与拍面椭圆盘求交（见 core/racket.ts）。
 *    拍面不是装饰，30×38cm 的椭圆就是真实可击球面积，歪一点就打不到。
 *    时间窗（±150ms）退到辅助位置，只用来回答「这一下算不算你挥的」——
 *    球可能正好撞上静止的拍子，那不该算一次击球。
 *
 * 2) 球碰到拍面后会**冻结**（最多 100ms）等挥拍事件。
 *    挥拍峰值是随包一起传过来的，包在路上要走 20–60ms，而球是本地模拟的。
 *    如果球一碰到就立刻判死，玩家永远输给网线。冻结在球正好贴住拍面的位置，
 *    视觉上就是「接触瞬间」，比让球凭空瞬移回来自然得多。
 *
 * 3) 连拍在**球过网那一刻**才 +1，撞网或漏接时归零。
 *    不能在击球瞬间 +1：那样连拍会先涨、撞网时再倒扣，玩家看到数字涨回来又掉下去，
 *    比慢半拍更让人困惑。也不能在 launch() 里加——击球点常常就在网前一两米，
 *    球还没过网就已经 +1 了，一旦下网就得回滚。只留过网这一个计数点，永远不需要回滚。
 */

import { advance, aimAfterBounce, feedBounce, feedVy, isOutOfPlay, liftOverNet, makeBall, type Ball, type Collision } from './physics';
import { shotFromStroke, type Stroke } from './swing';
import { faceCenter, RacketTrack, sweepFace, type FaceHit, type RacketPose } from './racket';
import {
  HIT_Z,
  HIT_WINDOW_MS,
  NET_Z,
  BALL_R,
  FEED_APEX_DX,
  FEED_APEX_DY,
  FEED_APEX_BACK_MIN,
  FEED_APEX_BACK_MAX,
  FEED_APEX_LEAD,
  FACE_CY,
} from './court';
import { vrot, type Quat4, type V3 } from './vec';

export type Phase = 'incoming' | 'contact' | 'outgoing' | 'dead';

/**
 * 判定「球已经从身边飞过去」时，比球拍再往身后留多少。
 *
 * 35cm：球拍本身有厚度、拍面可能被倾斜到身后一点，留一点余量免得
 * 拍面还没来得及接住球就被判死。这个偏移是相对**球拍当前位置**算的，
 * 不是固定的世界坐标——站位后退时球拍跟着退，判定线也得跟着退。
 */
const BEHIND_PAD = 0.35;

/**
 * 击球诊断。
 *
 * 这些读数是为了回答「为什么我挥了却打不到球」而存在的，不是调试残留：
 * 打不到只有三种可能，每种都能被它们区分开——
 *   - 挥拍次数 = 0            → 角速度没上来（手机那条 devicemotion 通道的问题）
 *   - 到面次数 = 0            → 球根本没穿过击球面（物理或阶段卡住）
 *   - 时差偏得离谱（> 200ms） → 两边时间基准没对上
 *   - 到面高度越界            → 球从头顶或脚边过去了
 */
export interface RallyDiag {
  /** 累计收到的挥拍次数 */
  swings: number;
  /** 球穿过击球面的次数 */
  reaches: number;
  /** 最近一次球到面时，最近那次挥拍的时差（ms）。正 = 挥晚了，负 = 挥早了，null = 没挥 */
  lastLag: number | null;
  /** 最近一次球穿过击球面时的高度（米） */
  lastAtY: number | null;
  /**
   * 最近一次击球打在拍面哪儿：0 = 甜区正中，1 = 拍框内沿，>1 = 根本没碰到（null）。
   *
   * 严格碰撞上线后，这是「为什么打不到」的第一现场：
   * 球从拍面上方 5cm 掠过和从左边 40cm 掠过，表现都是「没打到」，但改法完全不同。
   */
  lastOffCenter: number | null;
  /**
   * 球到击球面 → 球被击出的毫秒数。
   *
   * 这是玩家能感觉到的「延迟」本体，和「时差」是两件事：
   * 时差是挥拍时机准不准（关系到判不判得上），延迟是判上之后球多久才动
   * （关系到手感黏不黏）。时差 0、延迟 120ms 的体验依然是「球被吸住了才弹走」。
   */
  lastLatency: number | null;
}

export type RallyEvent =
  | {
      kind: 'hit';
      at: V3;
      speed: number;
      topSpin: number;
      sideSpin: number;
      clean: boolean;
      charge: number;
      alignment: number;
    }
  | { kind: 'ground'; at: V3; speed: number }
  | { kind: 'wall'; at: V3; speed: number }
  | { kind: 'net'; at: V3 }
  | { kind: 'miss'; reason: 'reach' | 'late' }
  | { kind: 'out' }
  | { kind: 'serve' }
  | { kind: 'streak'; value: number }
  | { kind: 'end'; value: number };

/**
 * 冻结期上限（毫秒）。
 *
 * 球碰到拍面之后，再等这么久看有没有挥拍事件到。
 *
 * 严格碰撞之后，绝大多数命中的球都是「正在挥」被 liveStroke 直接取走的，
 * 根本不需要等；剩下会等满全场的只有「压根没挥」——球粘在拍面上再过一会儿
 * 才掉下去，看起来像穿模。60ms 曾经过短：挥拍事件的路上时间是
 * 「峰值回落结算 16–33ms + 网络 20–60ms」，峰值正好落在接触点上的那一挥，
 * 事件最晚 90ms 才到，60ms 会把它误判成漏接——玩家看到球粘在拍面上然后掉下去，
 * 就是「明明打到了却不回弹」。100ms 覆盖这条链路的全部抖动，再长就只是粘滞。
 */
const CONTACT_HOLD_MS = 100;
/** 断球后多久重新喂球 */
const RESERVE_DELAY_MS = 1300;
/** 一次 incoming 最多允许这么久，防止球卡在奇怪的角落永远不结束 */
const MAX_PHASE_MS = 9000;

export class Rally {
  ball: Ball = makeBall([0, BALL_R, -6], [0, 0, 0]);
  phase: Phase = 'dead';
  streak = 0;
  best = 0;
  /** 最近一次事件的可读文本，给 HUD 用 */
  status = '等待发球';
  /** 击球诊断，用来定位「挥了却打不到」 */
  diag: RallyDiag = { swings: 0, reaches: 0, lastLag: null, lastAtY: null, lastOffCenter: null, lastLatency: null };

  private pending: Stroke[] = [];
  /** 球拍位姿滑窗。大屏端每帧 push 一次，判定时按时刻插值回去取。 */
  private rackets = new RacketTrack();
  /** 最近一次真正撞上拍面的信息，给 HUD 显示「打在甜区还是拍框」。 */
  lastHit: FaceHit | null = null;
  private deadAt = 0;
  private contactAt = 0;
  private contactPoint: V3 | null = null;
  private resumeV: V3 | null = null;
  private phaseAt = 0;
  private started = false;
  /** 这一球是否已经在落地时重瞄过（每球只瞄一次，避免一路跟着玩家拐弯） */
  private arrivalAimed = false;

  /**
   * 这一球「顶点相对拍面中心」的横向 / 竖直偏移（米），发球时抽一次、整球沿用。
   *
   * 喂球的目标是「顶点落在拍面**附近**」，不是精确送到中心。偏移一旦抽定
   * 就是这一球的性格——球偏左还是在正中，玩家得自己看。所以重瞄和跟随
   * 都瞄「拍面中心 + 这个偏移」，而不是瞄回中心（那样每球又会吸在拍线上）。
   */
  private aimDx = 0;
  private aimDy = 0;

  /**
   * @param liveStroke 抢跑取拍。球已经停在击球面上时，直接向检测器要一份
   *   「正在进行中」的挥拍快照。由大屏端注入，因为检测器不在 core 层。
   *
   *   为什么不让状态机自己等结算：结算发生在峰值**之后**，而球碰到拍面正好在
   *   峰值附近。等结算等于让球在拍面上悬十几到几十毫秒，玩家会明确感觉到
   *   「打到了，但球没走」。这个回调把那段等待彻底消掉——球到面的那一帧就出球。
   */
  constructor(private liveStroke?: (near: number) => Stroke | null) {}

  /** 球拍端传来的挥拍事件。可以在任意时刻到达，早于或晚于球都是正常的。 */
  submit(stroke: Stroke) {
    this.diag.swings++;
    this.pending.push(stroke);
    if (this.pending.length > 10) this.pending.shift();
    // 清掉过期的，避免长局之后越积越多
    const cutoff = stroke.t - HIT_WINDOW_MS * 4;
    this.pending = this.pending.filter((s) => s.t > cutoff);
  }

  /**
   * 喂一帧球拍位姿。**每一帧都要喂**，哪怕球拍没动。
   *
   * 判定要用到过去 400ms 的位姿（挥拍事件比球晚到），所以历史必须连续；
   * 只在姿态变化时才推的话，挥拍中途停顿会让插值跨过一大段空白，
   * 命中点会被算到几厘米之外。
   */
  pushRacket(pose: RacketPose) {
    this.rackets.push(pose);
  }

  reset() {
    this.phase = 'dead';
    this.deadAt = 0;
    this.streak = 0;
    this.pending = [];
    this.contactPoint = null;
    this.lastHit = null;
    this.arrivalAimed = false;
    this.aimDx = 0;
    this.aimDy = 0;
    this.rackets.reset();
    this.started = false;
    this.ball = makeBall([0, BALL_R, -6], [0, 0, 0]);
    this.status = '等待发球';
    this.diag = { swings: 0, reaches: 0, lastLag: null, lastAtY: null, lastOffCenter: null, lastLatency: null };
  }

  update(dt: number, now: number): RallyEvent[] {
    const ev: RallyEvent[] = [];
    if (!this.started) {
      this.started = true;
      this.deadAt = now - RESERVE_DELAY_MS; // 立刻发第一个球
    }

    if (this.phase === 'contact') return this.tickContact(now, ev);

    if (this.phase === 'dead') {
      // 断球后让球自己滚一会儿，1.3 秒再喂下一个。静止的画面比瞬间重置容易接受。
      advance(this.ball, dt, () => {});
      if (now - this.deadAt > RESERVE_DELAY_MS) this.serve(now, ev);
      return ev;
    }

    if (now - this.phaseAt > MAX_PHASE_MS) {
      this.kill(now, ev);
      return ev;
    }

    const prevP: V3 = [this.ball.p[0], this.ball.p[1], this.ball.p[2]];
    // 来球飞行途中不再被改方向：球只按自己的弹道走。瞄准只发生在发球
    // （serve）和落地弹起那一刻（aimArrival），这是发球机，不是追踪弹。
    // 这一帧的起始时刻。物理子步要按真实时刻去做拍面求交，
    // 不能用帧结束时刻——球在一帧里会走 70cm。
    const t0 = now - dt * 1000;
    const live = this.phase === 'incoming';
    advance(
      this.ball,
      dt,
      (c) => this.onCollision(c, ev, now),
      live ? (p0, p1, s0, s1) => this.checkFace(p0, p1, s0, s1, ev) : undefined,
      t0
    );

    // 球从身前飞到身后，拍面一次都没碰到 → 够不着。
    // 这是「严格碰撞」之后最常见的失败方式：球确实经过了你，但你拍子不在那个位置。
    //
    // 判定线要兜住**拍面最靠后的位置**，不能只看握点：球是跟着拍面中心飞的，
    // 而拍面中心可能因为倾角落在握点前方几十厘米。取两者的靠后者再加余量。
    const lastPose = this.rackets.last;
    const faceZ = lastPose ? faceCenter(lastPose)[2] : HIT_Z;
    const behindZ = (lastPose ? Math.max(lastPose.pos[2], faceZ) : HIT_Z) + BEHIND_PAD;
    if (this.phase === 'incoming' && prevP[2] < behindZ && this.ball.p[2] >= behindZ) {
      this.diag.reaches++;
      this.diag.lastAtY = this.ball.p[1];
      this.diag.lastOffCenter = null;
      this.recordLag(now, null);
      ev.push({ kind: 'miss', reason: 'reach' });
      this.status = '够不着';
      this.kill(now, ev);
      return ev;
    }

    // 成功过网
    if (this.phase === 'outgoing' && this.ball.live && prevP[2] > NET_Z && this.ball.p[2] <= NET_Z) {
      this.streak++;
      if (this.streak > this.best) this.best = this.streak;
      ev.push({ kind: 'streak', value: this.streak });
    }

    if (this.ball.live && isOutOfPlay(this.ball)) {
      this.kill(now, ev);
    }

    return ev;
  }

  /* ---------------- 击球 ---------------- */

  /**
   * 每个物理子步检查一次「球这一小步有没有撞上拍面」。
   *
   * 这一步是整个严格碰撞的入口。它拿到的不是球在这一帧的位置，
   * 而是**子步的线段和对应的起止时刻**——40 m/s 的球在一帧里走 70cm，
   * 用帧位置判定会直接穿过去，而且穿过去的时候两端都不在椭圆内。
   *
   * 时刻也参与判定：拍面是转动的，必须回到那 4.17ms 里拍面真正朝向哪里，
   * 直接用当前帧的姿态在快速挥拍时会偏几十度。
   */
  private checkFace(p0: V3, p1: V3, s0: number, s1: number, ev: RallyEvent[]) {
    if (this.phase !== 'incoming') return false;

    const pose = this.rackets.at((s0 + s1) * 0.5);
    if (!pose) return true;

    const hit = sweepFace(pose, p0, p1);
    if (!hit) return true;

    this.enterContact(hit, s0 + (s1 - s0) * hit.s, ev);
    // 球已经被接住了（或直接被打出去了），这一帧剩下的子步不能再推进
    return false;
  }

  private enterContact(hit: FaceHit, t: number, ev: RallyEvent[]) {
    // 先记诊断，再判死——就算这一拍没打好，玩家也需要知道球是从哪儿过去的
    this.diag.reaches++;
    this.diag.lastAtY = hit.at[1];
    this.diag.lastOffCenter = hit.offCenter;
    this.lastHit = hit;

    this.contactPoint = hit.at;
    this.contactAt = t;
    this.resumeV = [this.ball.v[0], this.ball.v[1], this.ball.v[2]];
    // 把球按在命中点上，等挥拍事件
    this.ball.p = [hit.at[0], hit.at[1], hit.at[2]];
    this.ball.v = [0, 0, 0];
    this.phase = 'contact';
    this.phaseAt = t;

    // 先立刻试一次：玩家提前挥拍的情况占多数，这条路径不需要任何等待
    const s = this.takeStroke(t);
    if (s) {
      this.recordLag(t, s);
      this.launch(s, ev, t);
    } else {
      this.recordLag(t, null);
    }
  }

  private tickContact(now: number, ev: RallyEvent[]): RallyEvent[] {
    if (this.phase !== 'contact') return ev;

    const s = this.takeStroke(this.contactAt);
    if (s) {
      this.recordLag(this.contactAt, s);
      this.launch(s, ev, now);
      return ev;
    }

    if (now - this.contactAt > CONTACT_HOLD_MS) {
      // 等不到了。这时候 pending 里通常还留着「挥得太晚」的那一下，
      // 记下来，HUD 会直接告诉玩家「晚 280ms」——比一句「漏接」有用得多。
      this.recordLag(this.contactAt, null);
      // 球不能再按原速穿过拍面飞走。
      //
      // 原来的做法是把球的速度还原、让它继续飞——但那在屏幕上读起来就是
      // 「球从拍子里穿过去了」，玩家会认为判定坏了。现在喂球会瞄着拍面中心，
      // 这种「视觉上明明打到了」的情形每一球都会发生，必须给它一个说得通的结局：
      // 球擦到拍框、往侧前方掉下去。看到的是「蹭到了，但没打实」，
      // 和 HUD 那句「漏接」对得上。
      this.ball.v = [this.resumeV ? this.resumeV[0] * 0.12 : 0, -1.2, -2.2];
      this.resumeV = null;
      this.phase = 'incoming';
      ev.push({ kind: 'miss', reason: 'late' });
      this.status = '漏接';
      this.kill(now, ev);
    }
    return ev;
  }

  /**
   * 记录「最近一次挥拍离球到面有多远」。
   *
   * 传入了 matched 就直接用它；否则从待处理的挥拍里挑最接近的那一个——
   * 这一步必须在接触结束之后做，因为玩家挥得稍晚时，挥拍事件是在冻结期里才到的。
   */
  private recordLag(t: number, matched: Stroke | null) {
    if (matched) {
      this.diag.lastLag = matched.t - t;
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

  private launch(s: Stroke, ev: RallyEvent[], now: number) {
    const at = this.contactPoint;
    if (!at) return;

    // 球在击球面上从「到达」到「被打出」停了多久。这是手感延迟的唯一真实度量，
    // 抢跑生效时应该接近 0，靠结算时会有几十毫秒。
    this.diag.lastLatency = Math.max(0, now - this.contactAt);

    const shot = shotFromStroke(s);

    // 高球不好发力：真实球员在头顶以上的位置也抽不快。
    //
    // 这条不是为了真实感，是为了打断一个正反馈：不加它的话，连续全力挥会让
    // 击球点一拍比一拍高（球回来得太快、来不及下落），五拍之后就够不着了。
    // 模拟里实测每拍 +0.35 米，是必须处理的系统性问题，不是偶发。
    const pen = at[1] > 1.35 ? Math.max(0.62, 1 - (at[1] - 1.35) * 0.34) : 1;
    const v: V3 =
      pen < 1 ? [shot.v[0] * pen, shot.v[1] * pen, shot.v[2] * pen] : shot.v;

    // 回球判定的「目标位姿」：拍面中心放回**击球平面 + 击球高度**，朝向沿用击球那一刻。
    //
    // 不能直接把挥拍中的 pose 传进去。玩家挥到一半时拍面中心被甩到半米外，
    // 补偿器就变成「让回球穿过一个飞在半空的拍面」——所有候选都不合格，
    // 池子空了退回兜底弧线，实测偶发撞网。
    //
    // 但朝向必须保留：斜拍面能不能兜住球是真实约束，11-04 那个「回球从倾斜拍面
    // 下方 2cm 掠过去」的 bug 正是靠这条判据抓住的。所以只把位置归一化，角度照旧。
    const pose = this.rackets.at(this.contactAt) ?? this.rackets.last;
    const q: Quat4 = pose ? pose.q : [0, 0, 0, 1];
    const w = vrot(q, [0, FACE_CY, 0]);
    const aimY = Math.min(1.9, Math.max(0.9, at[1]));
    const goal: RacketPose = {
      t: pose ? pose.t : this.contactAt,
      pos: [at[0] - w[0], aimY - w[1], HIT_Z - w[2]],
      q,
    };
    this.ball.p = [at[0], at[1], at[2]];
    this.ball.v = liftOverNet(this.ball.p, v, shot.spin, HIT_Z, aimY, goal);
    this.ball.spin = shot.spin;
    this.ball.bounces = 0;
    this.ball.live = true;
    this.phase = 'outgoing';
    // 回球飞出去之后还会有一次落地弹回，那次落地同样要按「那时的拍面」重瞄
    this.arrivalAimed = false;
    // 用击球时刻而不是当前帧时间：击球点可能是在两帧之间被插值出来的，
    // 这样「球从击球点飞出去多久了」才是准的，超时判定不会提前触发。
    this.phaseAt = this.contactAt;
    this.contactPoint = null;
    this.resumeV = null;

    const speed = Math.hypot(shot.v[0], shot.v[1], shot.v[2]);
    this.status = !shot.clean
      ? '拍面没打开'
      : shot.topSpin > 60
        ? '上旋'
        : shot.topSpin < -60
          ? '下旋'
          : '平击';

    ev.push({
      kind: 'hit',
      at: [...at],
      speed,
      topSpin: shot.topSpin,
      sideSpin: shot.sideSpin,
      clean: shot.clean,
      charge: s.charge,
      alignment: shot.alignment,
    });
    // 连拍不在这里 +1：球还没过网。加在这里的话，撞网那一拍也会被算进去，
    // 而且过网时还会再加一次，一球两分。
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

    // 没有已结算的挥拍，但玩家此刻正挥到一半 → 抢跑，当场出球。
    // 这一句就是「球弹回比接触晚」的解药：判定和发射发生在同一帧内。
    const live = this.liveStroke?.(t);
    if (live) {
      live.used = true;
      this.diag.swings++;
      return live;
    }
    return null;
  }

  /* ---------------- 球的事件 ---------------- */

  /**
   * 来球在**我方半场落地弹起**的那一刻，按「此刻的拍面」重瞄一次。
   *
   * 发球时瞄的是「发球那一刻」的拍面，而球要飞一秒多才到——这段时间里玩家
   * 会走位、会转手机准备击球，而拍面中心挂在 0.6 米长的杆子末端，手机转 30°
   * 它就平移 30 厘米，比整个拍面还宽。结果就是「球明明从身边过去了、
   * 也挥了，就是不弹」，而玩家看着屏幕上的拍子确实在自己手边。
   *
   * 落地是整条弹道上唯一一个不会被察觉的修正点：球本来就要在这里剧烈改向，
   * 横挪几厘米、纵调几厘米眼睛读不出来。修正量有上限（见 aimAfterBounce），
   * 所以不会变成追踪导弹。
   */
  private aimArrival() {
    if (this.arrivalAimed) return;
    const pose = this.rackets.last;
    if (!pose) return;
    const face = faceCenter(pose);
    const b = this.ball;
    const vz = b.v[2];
    if (vz <= 0.4) return;

    const t = (face[2] - b.p[2]) / vz;
    if (t < 0.12 || t > 1.8) return;

    // 不再预测「球到达时拍面会在哪」。
    //
    // 以前会按拍面中心 120ms 的位移外推，但拍面中心的速度**混着挥拍旋转**：
    // 手腕一转就是 4 m/s，被当成走位速度会把球瞄到半米开外。飞行途中也不再
    // 修改球的方向，所以这是整条弹道上最后一次瞄准机会，只瞄「此刻的拍面」。
    const aimX = face[0];
    const aimY = face[1];

    // 目标 = 拍面中心 + 这一球的散布，和发球时的瞄准同一个式子。
    //
    // 这里踩过的坑值得留着：曾经写成「拍面中心 + 本球偏移」，而玩家会跟着球挪半步——
    // 拍面移到球的位置，重瞄再按「拍面 + 偏移」算一遍，球又被推一份，正反馈，
    // 球越推越远，最后判「够不着」。现在重瞄的目标始终是「当前拍面 + 固定散布」，
    // 目标只随拍面动，不再是「球的位置决定下一次目标」。
    const tx = aimX + this.aimDx;
    const ty = aimY + this.aimDy;

    const r = aimAfterBounce(b, [tx, ty, face[2]]);
    if (r.ok) this.arrivalAimed = true;
  }

  private onCollision(c: Collision, ev: RallyEvent[], now: number) {
    switch (c.kind) {
      case 'ground': {
        ev.push({ kind: 'ground', at: c.at, speed: c.speed });
        // 我方半场第一次落地 = 来球的最后一次弹起，按当前的拍面重瞄
        if (this.phase === 'incoming' && c.at[2] > NET_Z && !this.arrivalAimed) {
          this.aimArrival();
        }
        // 我方半场二次落地 = 失误
        if (this.ball.bounces >= 2 && c.at[2] > NET_Z) {
          this.status = '两次落地';
          this.kill(now, ev);
        }
        break;
      }
      case 'wall':
        ev.push({ kind: 'wall', at: c.at, speed: c.speed });
        // 撞墙弹回 = 球开始朝我飞过来了，阶段必须回到「来球」。
        // 没有这一步的话，球都飞到眼前了，状态机还停在 outgoing，
        // 任何按阶段判断的逻辑（HUD 提示、测试脚本、自动演示）都会一直以为
        // 「这一拍还没结束」，于是一球打完之后就再也不动了。
        if (this.phase === 'outgoing') {
          this.phase = 'incoming';
          this.phaseAt = now;
        }
        break;
      case 'net':
        ev.push({ kind: 'net', at: c.at });
        this.ball.live = false;
        this.status = '下网';
        this.kill(now, ev);
        break;
    }
  }

  private kill(now: number, ev: RallyEvent[]) {
    if (this.phase === 'dead') return;
    if (this.streak > 0) ev.push({ kind: 'end', value: this.streak });
    this.phase = 'dead';
    this.deadAt = now;
    this.streak = 0;
    this.contactPoint = null;
  }

  private serve(now: number, ev: RallyEvent[]) {
    // 喂球参数。
    //
    // 高度是**自适应**的：瞄玩家当前拍面中心。原来写死 y0=1.75、vy=4.0
    // （到达击球线时 1.51m），那是按「竖握、拍面中心 1.45m」调出来的——
    // 换成 README 教的横握（拍面水平，中心就在握点高度），球高出拍面 66cm，
    // 大部分球从拍子上方掠过，玩家只会觉得「拍子太低、接不到」。
    //
    // 现在整条链路改成**弹地喂球**（见 physics.feedBounce）：
    // 球在玩家前方 1.55–1.85 米落地，弹起来再送到拍面附近（不是精确送到中心）。
    //
    // 这不只是「更像网球」。旧的直送方案有个结构性缺陷：玩家退到后场时
    // 飞行距离 12m 以上、vz 只有 10.5，球根本飞不到拍面就落地了，
    // 而 feedVy 把「提前落地」当成「仰角不够」，一路加到上限，
    // 于是每一球都变成从墙顶飞过的月亮球——这正是「退到后场也够不到」。
    // 弹地球不存在这个死结：落地是设计的一部分，落点由我们指定。
    //
    // 另一个收益是**落点成了视觉节拍器**：第一次落地 = 计时开始，
    // 之后球的高度单调可预测。玩家可以靠看落点学挥拍时机，
    // 而不是靠「看球什么时候到脸上」——后者在 30cm 的拍面前基本靠猜。
    const pose = this.rackets.last;
    const face = pose ? faceCenter(pose) : null;
    // 横向起点必须用**拍面中心**的 x，不能用握点的 x。
    //
    // 位姿里的 pos 是**握点**，拍面中心在沿拍柄 FACE_CY=0.6m 处；横握时两者横向能差出几十厘米。
    // 用握点的 x 发球，球会照着握把的位置喂过去——而拍面在另一边。
    const fx = face ? face[0] : 0;
    const targetZ = face ? face[2] : HIT_Z;
    // 来球高度跟着拍面中心走，再叠加这一球的竖直偏移。夹 [0.8, 1.9] 防极端姿态（手机举过头/垂到膝）。
    const fy = face ? Math.min(1.9, Math.max(0.8, face[1])) : 1.35;

    // 每球抽一次「顶点偏移」：横向 ±FEED_APEX_DX、竖直 ±FEED_APEX_DY。
    //
    // 这是「不用每次都送到拍面中心」的落地点：偏移抽定后存成字段，
    // 后面的落地重瞄也瞄「拍面中心 + 这个偏移」，不会再叠第二遍。
    // 幅度上限由判定盘决定：等效半轴横向 0.203、竖向 0.243，
    // 取 0.12 / 0.10 保证「时机对了也一定在盘内」，但甜区读数会明显散开。
    this.aimDx = (Math.random() - 0.5) * 2 * FEED_APEX_DX;
    this.aimDy = (Math.random() - 0.5) * 2 * FEED_APEX_DY;
    const aimDx = this.aimDx;
    const aimDy = this.aimDy;

    const y0 = 1.4;
    const z0 = -11.0;
    // 发球点横向对准「拍面中心 + 本球偏移」，再给 ±3cm 抖动、±5cm 横向漂移。
    // 这点小抖动只是让球路不是一条死直线；大头是上面那个偏移。
    const x0 = fx + aimDx + (Math.random() - 0.5) * 0.06;
    const vx = (Math.random() - 0.5) * 0.1;
    const targetY = fy + aimDy;

    // 落点由「顶点想在拍面之后多远」反推，不再是写死的甜点。
    //
    // 球弹起后要爬升到拍面高度（0.8–1.9m），竖直速度必须先有 sqrt(2g·h)，
    // 而弹起后的水平速度由入射角决定，两者相乘，**顶点必然落在弹起点前方
    // 2.3–2.45 米**——这是抛体运动，不是参数问题（FEED_APEX_LEAD 取 2.40）。
    // 于是「顶点在拍面之后 back 米」⇔「落点距拍面 2.40 − back 米」。
    //
    // back 在 0.55–0.85 之间：球到拍面时还有 1.1–1.7 m/s 的上升速度，
    // 是「把球往上送到你手上」那一段；落点同时压在拍面前 1.55–1.85m，
    // 沿用上一轮真机验证过、玩家觉得不远的距离。想换手感就调这两个常量，
    // 但 back 和落点是绑死的（落点 = 2.40 − back），不能各调各的。
    const back = FEED_APEX_BACK_MIN + Math.random() * (FEED_APEX_BACK_MAX - FEED_APEX_BACK_MIN);
    const dd = FEED_APEX_LEAD - back;

    let shot = null;
    // 候选落点按「离目标多远」排：先试目标，解不出再往两边各让 25cm / 50cm。
    // 兜底的 1.6 / 1.9 是「玩家举拍过高导致解不出」时的保命值。
    for (const d of [dd, dd - 0.25, dd + 0.25, dd - 0.5, dd + 0.5, 1.6, 1.9]) {
      shot = feedBounce([x0, y0, z0], targetZ, targetY, d, vx);
      if (shot) break;
    }

    if (shot) {
      this.ball = makeBall([x0, y0, z0], shot.v);
    } else {
      // 兜底：弹地解不出来时退回直送（旧方案）。虽然会有「月亮球」的毛病，
      // 但总比不发球好——这条路径只会在玩家把手机举到 1.9m 以上时走到。
      const vz = 10.5;
      this.ball = makeBall([x0, y0, z0], [vx, feedVy(y0, targetY, vz, z0, targetZ), vz]);
    }
    this.phase = 'incoming';
    this.phaseAt = now;
    this.streak = 0;
    this.pending = [];
    this.arrivalAimed = false;
    this.status = '球来了';
    ev.push({ kind: 'serve' });
  }
}

