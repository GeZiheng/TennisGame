/**
 * 玩家这一侧的全部状态：站位、走位、瞄准偏移。
 *
 * ## 为什么它一个对象
 *
 * 这些东西原本是 `app.ts` 里 8 个模块级 `let` / 数组（`PLAYER`、`targetHold`、
 * `restOffset`、`contactDelta`、`contactWant`、`planOffset`、`contactSamples`、
 * `missStreak`、`prevQ`），`resetSession()` 得逐个手工清。它们共享一条更硬的约束：
 * **换一次连接，握法、学到的击球偏移、走位目标全都失效**——新会话的第一帧没有
 * 可信的姿态基准，带着上一场学到的量会「凭空带一段弧」或者「瞄着一个不存在的位置」。
 *
 * 所以它们属于同一个拥有者。这个类唯一的对外承诺是：`reset()` 之后回到
 * 「竖直握、瞄站着不动的拍面、站在家位」这个初始状态。
 *
 * ## 姿态和位置是两个输入，不要合并
 *
 * 姿态来自手机（绝对朝向），位置来自脚本或键盘（相对速度）。混在一起的话，
 * 「举着手机往右倾」会同时想改朝向和位置，手感互相打架。见 `app.ts` 顶部那段。
 */

import {
  AUTO_MOVE_DEFAULTS,
  blendCenterOffset,
  planAutoMove,
  stepAutoMove,
  stepAxis,
  TargetHold,
  type AutoMoveState,
} from '../core/auto-move';
import { FACE_CY, RACKET_POS } from '../core/court';
import type { Ball } from '../core/physics';
import { faceCenter, type RacketPose } from '../core/racket';
import { SERVE_STAND_Z } from '../core/serve';
import { clamp, type V3 } from '../core/vec';
import type { RecordSnapshot } from './recorder';

/** 走位要搬的东西。只取 `setRacketBase`，不 import 整个 `PlayScene`。 */
export interface RacketSink {
  setRacketBase(x: number, y: number, z: number): void;
}

export interface RigStep {
  /** 秒 */
  dt: number;
  /** 毫秒。`TargetHold` 按它判「球过去多久了」 */
  now: number;
  /** 发球站位目标 x（`null` = 不在发球） */
  serveStanceX: number | null;
  /** 来球。自动走位要预测它穿过击球面时的位置 */
  ball: Ball;
  /** 当前按住的键（小写）。键盘永远优先于自动走位 */
  keys: ReadonlySet<string>;
  sink: RacketSink;
}

export class PlayerRig {
  x = AUTO_MOVE_DEFAULTS.homeX;
  y = RACKET_POS[1];
  z = AUTO_MOVE_DEFAULTS.homeZ;

  /**
   * 走位用的瞄准偏移 = `restOffset + contactDelta`（世界系，长度恒为 `FACE_CY`）。
   *
   * 自动走位要的是「拍面中心对准球」，不是「握点对准球」。这两者只在拍子竖直握时
   * 重合：握法一横，拍面就在握点侧方 0.6m，而判定半轴只有 0.24m —— 站对了也打空。
   */
  readonly aim: V3 = [0, FACE_CY, 0];

  /** 自动走位开关。`?auto=0` 关，`F` 键切换，键盘按下去时整帧让位 */
  autoMove: boolean;
  /** 瞄准点学习开关。`?aim=rest` 关（回到「瞄站着不动的拍面」），用于真机 A/B */
  readonly aimLearn: boolean;

  /** **站着不动时的握法偏移**。只在角速度 < 1.2 rad/s 的帧采信，τ=0.3s */
  private readonly restOffset: V3 = [0, FACE_CY, 0];
  /** 平滑后的「击球瞬间 − 站着不动」偏移，逐帧朝 `want` 收敛（τ=0.45s） */
  private readonly delta: V3 = [0, 0, 0];
  /** 上一拍学到的目标值。只在新命中时更新，所以两拍之间是一条直线 */
  private readonly want: V3 = [0, 0, 0];
  /** 学到的样本数：0 表示还没命中过，此时 `aim` 就是老行为 */
  private samples = 0;
  /** 连续没打到的球数。用来在「学歪了」时自动退回老行为 */
  private missStreak = 0;
  private prevQ: [number, number, number, number] | null = null;

  /** 自动走位的目标保持器。跨帧状态，换会话必须一起清 */
  private readonly hold = new TargetHold();

  constructor(opts: { autoMove: boolean; aimLearn: boolean }) {
    this.autoMove = opts.autoMove;
    this.aimLearn = opts.aimLearn;
  }

  /** 握点。采集中记为 `label.G`，**只用于算 delta，禁止进特征** */
  get grip(): V3 {
    return [this.x, this.y, this.z];
  }

  /** 当帧生效的保持半径。采集时原样记下来，别在记录点另算一份 */
  get holdR(): number {
    return this.hold.radius;
  }

  /**
   * 采集用的快照。**必须在 `learn()` 之前取**，否则记到的是「学完之后」的瞄准点，
   * 残差凭空变小，等于把要诊断的那个偏差自己抹掉。
   *
   * 全部返回拷贝：`V3` 是可变元组，样本里留着引用就会被下一帧的平滑改掉。
   */
  snapshot(): Omit<RecordSnapshot, 'rally'> {
    return {
      grip: this.grip,
      rest: [this.restOffset[0], this.restOffset[1], this.restOffset[2]],
      aim: [this.aim[0], this.aim[1], this.aim[2]],
      holdR: this.holdR,
    };
  }

  /**
   * 用**这一帧**的姿态估计握法偏移（自动走位下一帧用，滞后一帧对 0.4s 的低通无感）。
   *
   * 不能直接用实时 `faceCenter`：挥拍本身把中心甩出 0.3–1.1m，每帧跟着走就是
   * 「一挥拍人被拽着跑」（`docs/history.md` 4.5 的老问题）。
   */
  trackPose(pose: RacketPose, dt: number) {
    const fc = faceCenter(pose);
    const want: V3 = [fc[0] - this.x, fc[1] - this.y, fc[2] - this.z];
    if (this.prevQ) blendCenterOffset(this.prevQ, pose.q, dt, want, this.restOffset, 1.2, 0.3);
    this.prevQ = [pose.q[0], pose.q[1], pose.q[2], pose.q[3]];

    // 学到的补偿不要在两拍之间跳：命中那一刻只有一个样本，逐帧收敛
    const k = 1 - Math.exp(-Math.max(dt, 0) / 0.45);
    for (let i = 0; i < 3; i++) {
      this.delta[i] += (this.want[i] - this.delta[i]) * k;
      this.aim[i] = this.restOffset[i] + this.delta[i];
    }
  }

  /**
   * 这一拍命中时，记下「拍面中心真的扫到了哪儿」，作为下一拍的瞄准点。
   *
   * 它和 `rest` 的差就是挥拍带来的那一段：横握绕横轴压拍 30° 就是 35cm 横向 +
   * 50cm 纵深，竖握主要是纵深和高度。每一拍重学一次（EMA 0.45），玩家换握法 /
   * 换挥拍幅度都会自己跟上。
   *
   * **只在命中时学**：没碰到球的姿态不能代表「击球那一刻」，学进去会越带越偏。
   *
   * `fc` 必须是**接触时刻**的拍面中心（`Duel` 的 `contact` 事件带出来的），
   * 不能用渲染帧的 `lastPose`：30 rad/s 时一帧差 1–30cm，而判定半轴只有 0.20–0.24。
   */
  learn(fc: readonly number[]) {
    if (!this.aimLearn) return;
    const want = [fc[0] - this.x, fc[1] - this.y, fc[2] - this.z];
    const k = this.samples === 0 ? 1 : 0.45;
    for (let i = 0; i < 3; i++) {
      // 单轴夹到 ±0.55m：0.6 的杆子再转也就这么大，超出去说明这一拍不是正常击球
      this.want[i] =
        this.want[i] +
        (clamp(want[i] - this.restOffset[i], -0.55, 0.55) - this.want[i]) * k;
      this.want[i] = clamp(this.want[i], -0.55, 0.55);
    }
    this.samples++;
    this.missStreak = 0;
  }

  /**
   * 连续漏接的兜底：学到的偏移可能把人带进「怎么打都打不到」的死角
   * （换握法、换了挥拍幅度、或者干脆没在挥），而**没命中就不学**，于是永远出不来。
   *
   * 连丢三球之后每球把 `want` 缩 30%：它在往回退到 `rest`，也就是「瞄站着不动的
   * 拍面」这个老行为——那个至少不会系统性偏半个拍面。打中一球就清零重来。
   */
  miss() {
    if (!this.aimLearn) return;
    this.missStreak++;
    if (this.missStreak < 3) return;
    for (let i = 0; i < 3; i++) this.want[i] *= 0.7;
  }

  /**
   * 走一帧。顺序是**站位 > 键盘 > 自动**，前两者任何一路生效就整车返回。
   *
   * 站位优先于一切输入：发球是**站位固定**的动作，一边跑一边发不是网球。
   * `Duel` 也按同一个位姿判「站好了没有」，所以这里搬到哪儿、判定就认哪儿。
   */
  step(s: RigStep) {
    const dt = s.dt;

    if (s.serveStanceX !== null) {
      // 握点举到 `RACKET_POS[1] + 0.32`：发球的拍面在头上，而 `playerAtStance`
      // 要求握点高过 `+0.25`。举拍是手臂动作，用 `speedY` 那一档，立刻到位。
      const ty = Math.min(AUTO_MOVE_DEFAULTS.maxGripY, RACKET_POS[1] + 0.32);
      this.x = stepAxis(this.x, s.serveStanceX, AUTO_MOVE_DEFAULTS.speed * dt, 0.02);
      this.z = stepAxis(this.z, SERVE_STAND_Z, AUTO_MOVE_DEFAULTS.speedZ * dt, 0.02);
      this.y = stepAxis(this.y, ty, AUTO_MOVE_DEFAULTS.speedY * dt, 0.005);
      s.sink.setRacketBase(this.x, this.y, this.z);
      // 站位是有意的位移，不是自动走位追球：保持器得忘掉上一分的目标，
      // 否则下一分开球的第一次追球会被 10cm 的死区吃掉。
      this.hold.reset();
      return;
    }

    let ax = 0;
    let az = 0;
    if (s.keys.has('a') || s.keys.has('arrowleft')) ax -= 1;
    if (s.keys.has('d') || s.keys.has('arrowright')) ax += 1;
    if (s.keys.has('w') || s.keys.has('arrowup')) az -= 1;
    if (s.keys.has('s') || s.keys.has('arrowdown')) az += 1;

    // 键盘优先：只要这一帧有方向键按下，自动走位就整帧不动。
    // 不用「按住时暂停 N 毫秒」那种计时器——松手瞬间接回来，手感最直接。
    if (ax !== 0 || az !== 0) {
      const l = Math.hypot(ax, az);
      const step = (AUTO_MOVE_DEFAULTS.speed * dt) / l;
      this.x = clamp(this.x + ax * step, -AUTO_MOVE_DEFAULTS.maxX, AUTO_MOVE_DEFAULTS.maxX);
      this.z = clamp(this.z + az * step, AUTO_MOVE_DEFAULTS.minZ, AUTO_MOVE_DEFAULTS.maxZ);
      // 键盘手动走位不接管高度：人一旦自己动手，握点高度缓缓回到自然位，
      // 免得「蹲着的时候按 D」变成蹲着横移。
      this.y = stepAxis(this.y, RACKET_POS[1], AUTO_MOVE_DEFAULTS.speedY * dt, 0.01);
      s.sink.setRacketBase(this.x, this.y, this.z);
      return;
    }

    if (!this.autoMove) return;

    // 自动走位：目标 = 让**拍面中心**落到球的弹道上，x 与 z 一起挪。
    // x 补偿握法偏移（横握时中心在握点侧方半米），z 决定「球到面时的高度」。
    const cfg = AUTO_MOVE_DEFAULTS;
    const state: AutoMoveState = { x: this.x, y: this.y, z: this.z, center: this.aim };
    const plan = planAutoMove(s.ball, state, cfg);
    // 规划器每帧重选平面，相邻候选的代价几乎相等时会来回跳 6cm——那就是
    // 「击球前拍子抖一下」。保持器把 10cm 以内的改主意吃掉。
    const tg = this.hold.resolve(plan, s.now);
    // 限速步进 + 边界 + 高度两段（预位 / 精确对位）都在 `stepAutoMove` 里，
    // 探针跑的是同一个函数——见 `docs/testing.md` 8.4「别在探针里再抄一份」。
    const next = stepAutoMove(this, plan, tg, dt, cfg);
    this.x = next.x;
    this.y = next.y;
    this.z = next.z;
    s.sink.setRacketBase(this.x, this.y, this.z);
  }

  /**
   * 新会话：回到「竖直握、瞄站着不动的拍面、站在家位」。
   *
   * 站位也归位：新会话是**新的一局**（`Duel.reset()` 同时清零比分），上一局的
   * 站位没有意义。原来 `app.ts` 没清这一项，靠下一帧自动走位把人在几帧内拖回来。
   */
  reset() {
    this.x = AUTO_MOVE_DEFAULTS.homeX;
    this.y = RACKET_POS[1];
    this.z = AUTO_MOVE_DEFAULTS.homeZ;
    this.hold.reset();
    this.prevQ = null;
    this.samples = 0;
    this.missStreak = 0;
    for (let i = 0; i < 3; i++) {
      this.want[i] = 0;
      this.delta[i] = 0;
    }
    this.restOffset[0] = 0;
    this.restOffset[1] = FACE_CY;
    this.restOffset[2] = 0;
    this.aim[0] = 0;
    this.aim[1] = FACE_CY;
    this.aim[2] = 0;
  }
}
