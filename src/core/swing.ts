/**
 * 挥拍检测：把一串角速度采样变成「一次击球」。
 *
 * 思路是三点峰值检测，不用积分，也不用机器学习。原因很实际：
 * 真机实测手机陀螺仪在挥拍峰值处经常被量程削顶（2000°/s），
 * 一旦削顶，积分出来的轨迹就是错的；但「这里有个峰」这个事实依然是可靠的。
 * 所以只做峰值检测 + 特征分类，不做轨迹还原。
 *
 * 得到峰值之后，拍头速度用刚体公式 v = ω × r 算：
 * r 是握把到拍头的向量（拍柄方向 × 等效臂长），ω 是角速度在世界系下的方向。
 * 这一步是整个「伪物理」的地基——它把「手腕转得多快」翻译成「拍头打在球上有多重」。
 */

import { vcross, vmul, vlen, vrot, clamp, type V3 } from './vec';
import type { Quat } from './imu';
import {
  SWING_ARM,
  SPEED_GAIN,
  SPEED_MIN,
  SPEED_MAX,
  SWING_THRESHOLD,
  SWING_MAX_MS,
  STROKE_COOLDOWN_MS,
  FALL_RATIO,
  HIT_WINDOW_MS,
} from './court';

export interface StrokeSample {
  /** 本地时间（毫秒，与大屏端 performance.now() 同一时基） */
  t: number;
  /** 角速度 rad/s，设备坐标系 */
  omega: V3;
  /** 世界系姿态 */
  q: Quat;
}

export interface Stroke {
  /** 峰值所在的时刻。击球判定用它去和球的穿越时刻对齐。 */
  t: number;
  /** 峰值角速度 rad/s */
  peakW: number;
  /** 拍头线速度向量（世界系，m/s，已含手感放大） */
  head: V3;
  /** 拍头速率 */
  speed: number;
  /** 拍面法线（世界系，单位向量） */
  face: V3;
  /** 拍柄指向（世界系，单位向量） */
  grip: V3;
  /** 0..1 的发力程度，用来做音量和特效强弱 */
  charge: number;
  /**
   * 这一拍是不是「球已经碰到拍面了，先打出去再说」的抢跑版本。
   *
   * 正常结算要等峰值回落，比真实接触晚十几到几十毫秒。为了让球在接触的**那一帧**
   * 就飞出去，contact 阶段会直接从检测器里取一份进行中的快照先发射，标上这个标记。
   * 它只影响诊断和音效的措辞，物理上和其他 Stroke 完全一样。
   */
  provisional?: boolean;
  /** 已被 Consumption：一次挥拍只能打一个球 */
  used: boolean;
}

/** 超过这个角速度就算「全力」，用于把 charge 归一化到 0..1。 */
const CHARGE_FULL_W = 19;

/**
 * 挥拍检测：把一串角速度采样变成「一次击球」。
 *
 * ## 为什么是「迟滞 + 峰值保持」而不是三点比较
 *
 * 早期版本用三点峰值检测（要求 w[i] 同时大于左右邻居）。这个判据在实验室里很干净，
 * 在真机上却会**整段失效**，原因是两条通道的频率不匹配：
 *
 *     大屏端发包      60 Hz
 *     devicemotion    60 Hz（正常）／**0 Hz**（部分机型完全不支持）
 *     deviceorientation  20–60 Hz 不等
 *
 * 走姿态差分兜底时，角速度只在新姿态帧到来时才变，但发包一直在进行，于是同一个值
 * 会连续出现 2~4 次。序列变成 `…, 12, 12, 12, …`，「严格大于左右邻居」在平台段上
 * 恒不成立，整次挥拍被静默丢弃——这就是「球到面 43 次，挥拍只记到 1 次」的原因。
 *
 * 现在改成状态机：
 *   - 越过门槛 → 进入 armed，开始跟踪峰值
 *   - 记录这一路上最大的 |ω| 及其时刻（重复值不会破坏它）
 *   - 跌到峰值的 FALL_RATIO（0.9）→ 结算，用**峰值那一刻**的姿态和角速度建拍
 *   - 超过 SWING_MAX_MS 还没回落 → 那是「转」不是「挥」，丢弃
 *
 * 好处有三个：对重复值完全免疫；拿到的是真实峰值而不只是某个局部高点；
 * 冷却仍然按两个峰的间隔算，不会因为结算晚而误伤下一拍。
 *
 * 结算本身也是有代价的——它必然发生在峰值之后，而球碰到拍面就在峰值附近。
 * 所以真正击球时不会等结算，而是用 peekLive() 直接取「进行中」的峰先打出去
 * （见 Rally 的 liveStroke 参数）。这个类只负责「什么时候算一拍」，
 * 不负责「什么时候该让球飞」。
 *
 * 不用积分、不做轨迹还原，是因为手机陀螺仪在挥拍峰值处经常被 2000°/s 量程削顶。
 * 削顶之后积分出来的轨迹是错的，但「这里有个峰」这个事实永远可靠。
 */
export class SwingDetector {
  /** 是否已越过门槛、正在跟踪一个峰 */
  private armed = false;
  /** 本次峰的起点时刻，用来判「转太久」 */
  private armedAt = -1e9;
  private peakW = 0;
  private peakAt = -1e9;
  private peakSample: StrokeSample | null = null;
  /** 上一次真正出拍的峰值时刻，用于冷却 */
  private lastFireAt = -1e9;
  /**
   * 这次挥拍已经被「接触抢跑」消费掉了。
   *
   * 抢跑时峰值还没走完，之后的采样还会继续落在峰上甚至更高。不拦住的话，
   * 同一次挥拍会在回落时再结算一次，一挥手打出两个球。
   * 解锁条件是角速度真正跌破门槛——那时候动作确实做完了。
   */
  private blocked = false;

  /** 复位（换人、重新校准后调用）。 */
  reset() {
    this.armed = false;
    this.armedAt = -1e9;
    this.peakW = 0;
    this.peakAt = -1e9;
    this.peakSample = null;
    this.lastFireAt = -1e9;
    this.blocked = false;
  }

  /** 当前是否正在一次挥拍中（已越过门槛，峰还没结算）。 */
  get swinging(): boolean {
    return this.armed;
  }

  /**
   * 喂一个采样。这一下如果结算出一个峰，返回 Stroke，否则 null。
   *
   * 注意返回的时刻是**峰值时刻**而不是当前时刻：结算总是发生在峰值之后一两帧，
   * 但 stroke.t 必须是峰值那一刻，否则和球的时间窗对不上。
   */
  push(s: StrokeSample): Stroke | null {
    const w = vlen(s.omega);

    // ---- 起势：还没 armed，只看有没有越过门槛 ----
    if (!this.armed) {
      // 上一次被抢跑消费掉了，等这一挥真正结束（角速度落回门槛以下）才允许重新武装
      if (this.blocked) {
        if (w < SWING_THRESHOLD * 0.7) this.blocked = false;
        return null;
      }
      if (w < SWING_THRESHOLD) return null;
      this.armed = true;
      this.armedAt = s.t;
      this.peakW = w;
      this.peakAt = s.t;
      this.peakSample = s;
      return null;
    }

    // ---- 跟踪：一路上只记最大值 ----
    if (w > this.peakW) {
      this.peakW = w;
      this.peakAt = s.t;
      this.peakSample = s;
    }

    // 匀速转动几秒钟，那是转身不是挥拍。这里直接丢弃，不结算。
    if (s.t - this.armedAt > SWING_MAX_MS) {
      this.armed = false;
      return null;
    }

    // ---- 结算：跌到峰值的 FALL_RATIO 以下就算挥完 ----
    // 这个门槛直接决定「球晚多久才飞出去」，见 court.ts 里的说明。
    if (w >= this.peakW * FALL_RATIO) return null;

    const sample = this.peakSample;
    const peakW = this.peakW;
    const peakAt = this.peakAt;
    this.armed = false;

    // 冷却按两个峰的真实间隔算。结算晚一点不应该影响下一拍。
    if (peakAt - this.lastFireAt < STROKE_COOLDOWN_MS) return null;
    this.lastFireAt = peakAt;

    return this.buildStroke(sample!, peakW);
  }

  /**
   * 取一份「正在进行中」的挥拍快照，**不消费**。
   *
   * 为什么需要它：正常结算是峰值之后才发生的，而球碰到拍面的时刻正好在峰值附近。
   * 如果一定要等结算，球就得在击球面上悬着等十几到几十毫秒才飞出去——玩家会觉得
   * 「我明明打到了，球怎么才弹回来」。
   *
   * 参数 near 是「球到击球面的时刻」。只有当前峰的时刻和它落在同一个匹配窗口内，
   * 才认这是一次有效击球；否则说明球到面时玩家根本没在挥，把快照给出去了也接不上。
   */
  peekLive(near: number): Stroke | null {
    if (!this.armed || !this.peakSample) return null;
    if (Math.abs(this.peakAt - near) > HIT_WINDOW_MS) return null;
    const s = this.buildStroke(this.peakSample, this.peakW);
    s.provisional = true;
    return s;
  }

  /**
   * 确认采用 peekLive 给出的快照。
   *
   * 之后这次挥拍不会再被结算，也不能在它还没做完的时候重新武装——
   * 否则同一次挥手会在回落时再冒出一个峰，打出一个多余的球。
   */
  consumeLive() {
    if (!this.armed) return;
    this.lastFireAt = this.peakAt;
    this.armed = false;
    this.peakSample = null;
    this.peakW = 0;
    this.blocked = true;
  }

  private buildStroke(s: StrokeSample, peakW: number): Stroke {
    const q = s.q;
    // 设备系 → 世界系。手机本地轴和球拍本地轴一致（拍柄 +Y，拍面法线 +Z），
    // 所以这里不需要额外的坐标系转换矩阵。
    const omegaW = vrot(q, s.omega);
    const grip = vrot(q, [0, 1, 0]);
    const face = vrot(q, [0, 0, 1]);

    // 拍头速度 v = ω × r
    const head = vcross(omegaW, vmul(grip, SWING_ARM));
    const raw = vlen(head);

    // 放大到「真实球拍能打出的速度区间」，同时夹住上下限：
    // 下限保证轻碰也能过网（否则新手第一下就下网，直接劝退），
    // 上限防止数据毛刺打出一颗炮弹。
    const gained = clamp(raw * SPEED_GAIN, SPEED_MIN, SPEED_MAX);
    const k = raw > 1e-6 ? gained / raw : 0;
    const headScaled: V3 = [head[0] * k, head[1] * k, head[2] * k];

    return {
      t: s.t,
      peakW,
      head: headScaled,
      speed: gained,
      face,
      grip,
      charge: clamp((peakW - SWING_THRESHOLD) / CHARGE_FULL_W, 0, 1),
      used: false,
    };
  }
}

/**
 * 由一次挥拍算出球的出射速度与旋转。纯函数，方便调参和单测。
 *
 * 这个模型不追求物理正确，追求「玩家的意图能被兑现」：
 *   - 拍面朝哪，球往哪飞（网球的核心就是拍面控制）
 *   - 挥得越快，球越快
 *   - 向上刷球 = 上旋，向下切 = 下旋
 *
 * 拍面几乎背对球场时判为失误，这不是 bug，是玩法：不转正拍面就打不出去，
 * 和真实网球一样。
 */
export interface Shot {
  v: V3;
  spin: V3;
  /** 拍面与球场的夹角余弦。太低说明拍面没打开。 */
  alignment: number;
  /** 是否是一次干净的击球（拍面朝向够正） */
  clean: boolean;
  /** 上旋为正、下旋为负，单位 rad/s */
  topSpin: number;
  /** 侧旋，rad/s */
  sideSpin: number;
}

const FORWARD: V3 = [0, 0, -1];
const UP: V3 = [0, 1, 0];

export function shotFromStroke(stroke: Stroke): Shot {
  const face = stroke.face;
  const headDir = vlen(stroke.head) > 1e-6 ? unit(stroke.head) : FORWARD;

  // 拍面朝向球场的程度。-1 表示完全背对，1 表示正对。
  const alignment = dot(face, FORWARD);

  // 出球方向 = 拍面法线为主，挥拍方向为辅。
  // 纯用拍面法线会让「挥拍方向完全不影响结果」，玩家会觉得自己的动作没用；
  // 纯用挥拍方向又会让拍面控制失效。7:3 是试出来的一个折中。
  const mixed: V3 = [
    face[0] * 0.72 + headDir[0] * 0.3,
    face[1] * 0.72 + headDir[1] * 0.3 + 0.06,
    face[2] * 0.72 + headDir[2] * 0.3,
  ];
  let dir = unit(mixed);

  // 拍面完全背对（alignment 很负）时故意不改方向——让球照着拍面飞出去，
  // 玩家会立刻看到「球往后飞了」，这比任何文字提示都直接。
  const clean = alignment > 0.15;

  // 球速：拍头速度沿出球方向的分量 + 一点基础速度。
  // 用投影而不是全量，是因为「横向挥拍、球却往正前方飞」时，横挥那部分能量
  // 应该变成旋转，而不是凭空加到球速上。
  //
  // 下限 SPEED_MIN 不是防呆，是玩法需要：场地往返 24 米，低于 18 m/s 的球
  // 从墙上弹回来会擦网或者在中场就趴下，玩家会看到「球打出去了，然后没了」。
  // 底速从 4 降到 3：配合 18–32 的区间，轻挥也够过网，但不额外加厚——
  // 「落点离球网近一些」要的是轻球真的轻。
  const along = Math.max(0, dot(stroke.head, dir));
  const speed = clamp(along * 0.85 + 3, SPEED_MIN, SPEED_MAX);

  const v: V3 = [dir[0] * speed, dir[1] * speed, dir[2] * speed];

  // 旋转：把挥拍速度分解到「垂直于出球方向」的平面上。
  // 向上的分量刷出上旋，向下的切出下旋，侧向的分量给侧旋。
  const right = unit(vcross(dir, UP));
  const up2 = vcross(right, dir);

  const tangential: V3 = [
    stroke.head[0] - dir[0] * dot(stroke.head, dir),
    stroke.head[1] - dir[1] * dot(stroke.head, dir),
    stroke.head[2] - dir[2] * dot(stroke.head, dir),
  ];
  const topComp = dot(tangential, up2);
  const sideComp = dot(tangential, right);

  // 上旋的旋转轴 = 出球方向 × 上。绕它正转，球顶部向前转 —— 那就是上旋。
  const topSpin = clamp(topComp * 26, -420, 420);
  const sideSpin = clamp(sideComp * 18, -260, 260);

  const spinAxis = unit(add(vmul(unit(vcross(dir, UP)), topSpin), vmul(right, sideSpin)));
  const spinRate = Math.hypot(topSpin, sideSpin);
  const spin: V3 = vmul(spinAxis, spinRate);

  return { v, spin, alignment, clean, topSpin, sideSpin };
}

/* ---------------- 本地小工具（避免把 vec 的每个函数都 import 一遍） ---------------- */

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function unit(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1];
}
