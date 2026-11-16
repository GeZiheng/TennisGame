/**
 * 姿态换算：传感器坐标系 → 游戏世界坐标系。
 *
 * 这里只做纯粹的数学，不碰 DOM，也不碰 three.js，方便单测。
 *
 * 三个坐标系要分清，混在一起的后果是「球拍永远歪 90°」：
 *
 *   1. 设备系（W3C DeviceMotion）：x 沿屏幕短边向右，y 沿屏幕长边向上，
 *      z 垂直屏幕向外。**它焊死在硬件上，不随屏幕旋转改变**——所以
 *      screen.orientation.angle 跟姿态换算毫无关系。
 *   2. 地球系：X 东、Y 北、Z 天顶。
 *   3. three.js 世界系：Y 朝上、Z 朝屏幕外。
 *
 * W3C 规定 deviceorientation 的合成旋转是 R = Rz(α)·Rx(β)·Ry(γ)，
 * 给出设备系 → 地球系。要落到 three 的世界系，左乘一个 Rx(-90°) 就够
 * （地球的 Z 天顶变世界的 +Y）。
 *
 * 球拍模型的本地轴正好和手机一致：拍柄沿 +Y，拍面法线沿 +Z。
 * 所以设备系 → 球拍本地系是单位矩阵，不需要任何额外映射。
 */

import { qconj, qmul, qnorm, type Quat } from './imu';

const D2R = Math.PI / 180;

/** Rx(-90°)：地球系（Z 朝上）→ three 世界系（Y 朝上）。 */
export const EARTH_TO_WORLD: Quat = [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)];

/**
 * deviceorientation 的 alpha/beta/gamma（度）→ 设备系到 three 世界系的四元数。
 *
 * 用它而不是自己积分陀螺仪，是因为这三个角是操作系统融合好的：
 * 重力参考由系统提供，俯仰和横滚不会漂。
 */
export function deviceEulerToWorldQuat(alpha: number, beta: number, gamma: number): Quat {
  const a = (alpha * D2R) / 2;
  const b = (beta * D2R) / 2;
  const g = (gamma * D2R) / 2;
  const qz: Quat = [0, 0, Math.sin(a), Math.cos(a)];
  const qx: Quat = [Math.sin(b), 0, 0, Math.cos(b)];
  const qy: Quat = [0, Math.sin(g), 0, Math.cos(g)];
  const earth = qmul(qmul(qz, qx), qy);
  return qnorm(qmul(EARTH_TO_WORLD, earth));
}

/**
 * 取出绕世界 Y 轴的朝向角（弧度）。
 *
 * 用的是 three.js 的 Euler 'YXZ' 分解，所以和 three 里的视觉效果一致。
 * 接近万向锁（手机几乎正指天或正指地）时退回另一支表达式，避免 atan2(0,0)。
 */
export function qYaw(q: Quat): number {
  const [x, y, z, w] = q;
  const r02 = 2 * (x * z + w * y);
  const r12 = 2 * (y * z - w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  if (Math.abs(r12) < 0.999999) return Math.atan2(r02, r22);
  return Math.atan2(-2 * (x * z - w * y), 1 - 2 * (y * y + z * z));
}

/**
 * 两个四元数之间的夹角（弧度，0..π）。q 与 -q 表示同一个旋转，取 |dot| 消除符号。
 *
 * 用途：识别 `deviceorientation` 在万向锁附近换欧拉角解分支造成的姿态瞬跳。
 * 那种跳变不是真实旋转，直接采信会让屏幕上整只拍子翻过去。
 */
export function qAngle(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return 2 * Math.acos(d);
}

export function yawQuat(yaw: number): Quat {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/**
 * 把绝对姿态转成「朝向归零」的输出：倾斜完全照搬手机，朝向相对启动瞬间。
 *
 * 为什么不直接用绝对姿态：alpha 的参考系各平台不一致（iOS 是任意起点，
 * Android 可能指向磁场北），直接用会让球拍凭空扭到某个方向。
 * 为什么不干脆全用相对姿态：那样手机横着拿、球拍却立着，看着就是「不一致」。
 */
export function toOutputQuat(absolute: Quat, yawZero: number): Quat {
  return qnorm(qmul(yawQuat(-yawZero), absolute));
}

/**
 * 两帧绝对姿态之间「绕世界 Y 轴」的转角增量（弧度，-π..π）。
 *
 * 用世界系增量四元数 dq = next · conj(prev)，而不是把 qYaw 减两次：qYaw 在万向锁
 * 附近会换解分支，相减会凭空造出上百度假跳变。手机静止时 beta / gamma 不变，
 * `absolute = Ry(α)·K`，于是 `dq = Ry(Δα)` 严格成立，这里读出的就是 alpha 的漂移量。
 *
 * 非静止帧它只是「投影到世界 Y 的分量」，不是完整的欧拉角差；而那些帧不参与零偏
 * 测量（见 `YawDriftObserver`），近似误差不会进入估计。
 */
function worldDeltaQuat(prev: Quat, next: Quat): Quat {
  let dq = qmul(qnorm(next), qconj(qnorm(prev)));
  // q 与 -q 是同一个旋转，固定到 w >= 0 的半球，避免读出长弧
  if (dq[3] < 0) dq = [-dq[0], -dq[1], -dq[2], -dq[3]];
  return dq;
}

export function worldYawDelta(prev: Quat, next: Quat): number {
  const dq = worldDeltaQuat(prev, next);
  return 2 * Math.atan2(dq[1], dq[3]);
}

/** `qYaw` 是否落在万向锁回退分支。该分支下 yaw 与 roll 退化，读数会依赖握位。 */
export function isYawGimbal(q: Quat): boolean {
  const [x, y, z, w] = q;
  return Math.abs(2 * (y * z - w * x)) >= 0.999999;
}

/**
 * 陀螺认为「手机没在动」的角速度上限（rad/s，≈2.3°/s）。
 *
 * **静止与否由陀螺判，不由 alpha 自己判——这是整套判据的唯一依据。** 旧版拿 alpha
 * 的变化率当门限，于是同一个挥手动作「快的那半被拒、慢的那半被积」：一拍快挥出去
 * 40°、四秒慢慢回位 4°/s，回位那半被判据当成漂移扣掉，每拍往里走一截且永不回头，
 * 方向正是「回位的那一侧」（正手随挥收在身体左侧 = 反手位）。见 `docs/history.md` 4.35。
 *
 * 陀螺不漂（零偏 0.01–0.05 rad/s，量级随机），所以「陀螺说没动」可信。门限 2.3°/s：
 * 手持准备姿势的手抖在 1–3°/s 附近，能过一部分；有意转身、走位调整 ≥10°/s 一律挡住。
 */
const STILL_GYRO_RATE = 0.04;
/**
 * 连续静止多久才能**更新**已有零偏（毫秒）。
 *
 * 只用它做「细调」：短窗口噪声大，所以权重按窗口长度算（见 `update`），400ms 的
 * 窗口只占 17%。
 */
const STILL_HOLD_MS = 400;
/**
 * **第一次**拿到零偏需要的连续静止时长（毫秒）。
 *
 * 比 `STILL_HOLD_MS` 严格得多，因为这一次的估计会直接被拿去外推：静止 1.2s 的
 * 端点差噪声约 0.05°/s，而 0.4s 的窗口能到 0.2°/s——后者在十分钟的运动里会积出
 * 上百度。宁可开局多站一会儿，也不能拿一个噪声当零偏。
 */
const BIAS_TRUST_MS = 1200;
/**
 * 零偏 EMA 的等效时间常数（毫秒）。
 *
 * 权重还按窗口长度加权（见 `update`）：停下十秒算出来的零偏，不该被下一段半秒的
 * 抖动改掉；反过来 0.4s 的窗口只占 17%，噪声进不来。
 */
const BIAS_TAU_MS = 2000;
/**
 * 零偏的物理上限（rad/s，≈5.7°/s）。
 *
 * 磁力计被降权时 yaw 退化成纯陀螺积分，真机零偏 0.5–2°/s，个别机型能到 3–4°/s。
 * 超过这个数基本是判据出错（把慢速真实转动当成静止），夹住它——宁可少补，不能让
 * 补偿量线性跑飞。
 */
const MAX_BIAS_RATE = 0.1;
/**
 * 静止帧里 alpha 变化速率的合理上限（rad/s，≈5.7°/s）。
 *
 * 已经用陀螺判过静止了，这一条只兜「静止时 alpha 却跳了」：万向锁换解分支的瞬跳、
 * 系统融合突然重收敛。那种跳变不能当漂移积分进去。
 */
const MAX_STILL_RATE = 0.1;
/**
 * 静止帧里非 Y 轴分量的角速度上限（rad/s，≈11.5°/s）。
 *
 * 纯 alpha 慢漂的 dq 是 [0, sin(Δα/2), 0, cos(Δα/2)]，x/z 严格为 0。俯仰 / 横滚
 * 会让 x/z 明显非零，此时 dq 的 Y 投影只是耦合出来的分量，不是漂移。
 */
const MAX_STILL_OFF_RATE = 0.2;
/**
 * 两帧间隔超过它就当作「中间有一段没采到」：这一帧不参与，静止窗口也作废。
 *
 * 切后台 / 锁屏回来时首帧的角差跨了几秒钟的未知运动，按它算速率没有意义。
 */
const MAX_DRIFT_GAP_MS = 250;
/** 帧间隔下限，避免除以接近 0 的 dt 把任意噪声都判成高速。 */
const MIN_DRIFT_DT_MS = 4;

/**
 * 只读漂移观测器：**在静止窗口里测零偏，运动中按零偏外推**（ZUPT）。
 *
 * 旧实现是「按角速度门限积分慢转角」：只要这一帧 alpha 变得够慢就当漂移积进去。
 * 问题在于这个门限对真实动作是双向的——快挥被拒、慢回位被吃，于是每拍往里走一截
 * （棘轮），方向恒为「回位的那一侧」。真机表现就是「打着打着拍子往反手转」。
 *
 * 现在两条路彻底分开：
 *
 *   - **静止帧**（陀螺 < `STILL_GYRO_RATE`、且 alpha 变化也小）：`acc += dy`。这是实测，
 *     顺手喂零偏估计；
 *   - **运动帧**：`acc += bias * dt`，拿最近测到的零偏外推。
 *
 * 真实动作一帧都进不了估计，所以**结构上不可能有棘轮**。代价两条：挥拍那几百毫秒
 * 靠常数外推（误差 < 0.1°）；长时间运动里零偏若估错会线性累积——`MAX_BIAS_RATE`
 * 夹住量级，下一次静止把零偏拉回来，但**已经积进 `acc` 的部分不会自动回退**，
 * 这是模型的边界，不是 bug。
 *
 * 它只回答「传感器多转了多少」，**不定义正前方、不改 yawZero 的语义**。旧的
 * `recal` 把「当前朝向」重锁成正前方，才会只在反手位回得正、正手位锁错方向。
 */
export class YawDriftObserver {
  private prev: Quat | null = null;
  private acc = 0;
  /** 零偏估计（rad/s）。`null` = 还没遇到合格的静止窗口，此时运动帧不补偿 */
  private bias: number | null = null;
  /** 当前静止窗口：长度、alpha 累计转角、时间累计（用来算零偏） */
  private stillMs = 0;
  private stillDy = 0;
  private stillDt = 0;
  /** 未按测量积分的帧数（运动 / 断档 / 跳变），用来看判据有没有乱吃 */
  private skipped = 0;

  get radians() {
    return this.acc;
  }

  get degrees() {
    return (this.acc * 180) / Math.PI;
  }

  /** 零偏（rad/s）。`null` 表示还没测到——此时运动帧不补偿，宁可不补也不能跑飞。 */
  get biasRate(): number | null {
    return this.bias;
  }

  get biasDegPerSec(): number | null {
    return this.bias === null ? null : (this.bias * 180) / Math.PI;
  }

  get skippedSteps() {
    return this.skipped;
  }

  /**
   * @param dtMs 与上一帧的间隔（毫秒）。**必填**：漏传就等于按采样率绑阈值。
   * @param gyroRate 这一帧的角速度模长（rad/s）。**必填**，它才是「有没有在动」的
   *   依据。传 `NaN` 表示这条通道当时不可用（`gyroSource === 'none'`）——一律按
   *   运动处理：拿不到陀螺就不能判断真假，乱判会把真实动作吃成漂移。
   */
  update(abs: Quat, dtMs: number, gyroRate: number): number {
    const prev = this.prev;
    this.prev = abs;
    if (!prev) return this.acc;
    if (!(dtMs > 0) || dtMs > MAX_DRIFT_GAP_MS) {
      this.skipped++;
      this.clearStill();
      return this.acc;
    }
    const dt = Math.max(dtMs, MIN_DRIFT_DT_MS) / 1000;
    const dq = worldDeltaQuat(prev, abs);
    const dy = 2 * Math.atan2(dq[1], dq[3]);
    const off = Math.hypot(dq[0], dq[2]);

    const still =
      Number.isFinite(gyroRate) &&
      gyroRate < STILL_GYRO_RATE &&
      Math.abs(dy) / dt < MAX_STILL_RATE &&
      off / dt < MAX_STILL_OFF_RATE;

    if (!still) {
      this.skipped++;
      this.clearStill();
      if (this.bias !== null) this.acc += this.bias * dt;
      return this.acc;
    }

    this.acc += dy;
    this.stillMs += dtMs;
    this.stillDy += dy;
    this.stillDt += dt;
    // 第一次要有足够长的窗口才认（`BIAS_TRUST_MS`），之后按窗口长度加权细调。
    // 注意第一次之后**仍在同一个窗口里继续刷新**：`rate` 是整个窗口的均值，窗口越
    // 长越准，所以要一直用到底，而不是在刚过门槛那一帧就冻结。
    if (this.bias === null ? this.stillMs >= BIAS_TRUST_MS : this.stillMs >= STILL_HOLD_MS) {
      const rate = this.stillDy / this.stillDt;
      const next =
        this.bias === null
          ? rate
          : this.bias + (rate - this.bias) * (this.stillMs / (this.stillMs + BIAS_TAU_MS));
      this.bias = Math.max(-MAX_BIAS_RATE, Math.min(MAX_BIAS_RATE, next));
    }
    return this.acc;
  }

  private clearStill() {
    this.stillMs = 0;
    this.stillDy = 0;
    this.stillDt = 0;
  }

  /**
   * 只清累计转角，**保留零偏**。
   *
   * 按 `R` 重标定、切换补偿开关都是这一类：`yawZero` 把已经扣掉的量吸收了，累加
   * 要重新从 0 起；但零偏是陀螺的物理属性，和「正前方指哪」无关，丢了就得重新站
   * 1.2 秒才补得回来。重连同理（`yawZero` 不重锁，观测本来就连续）。
   */
  resetAngle() {
    this.prev = null;
    this.acc = 0;
    this.clearStill();
    this.skipped = 0;
  }

  /** 整段重来（新会话）：连零偏一起清。 */
  reset() {
    this.resetAngle();
    this.bias = null;
  }
}

/**
 * 单帧姿态跳变超过它就怀疑是 `deviceorientation` 在万向锁附近换了欧拉角解分支。
 *
 * 一次挥拍中段角速度 20–35 rad/s，方向事件 20–25Hz 时相邻帧可达 1.0–1.75 rad
 * ——和这个门限**重叠**。所以不能只靠角度判，必须配合「传感器此刻是不是在动」。
 */
export const MAX_POSE_JUMP = 1.2;
/** 连续外推超过这么久就重新接受绝对姿态：玩家可能真的转过去了。 */
export const MAX_EXTRAP_MS = 500;

/**
 * 姿态连续性门：这一帧的绝对姿态能不能直接采信。
 *
 * 旧实现有两个嵌在一起的坑，真机表现为「挥快了打不到 + 打一会儿拍子疯狂抖」：
 *
 *   1. 比较基准是「最后一次被采信的姿态」，跳变帧不更新它。于是挥拍期间每一帧
 *      都在跟**挥拍前**的姿态比，整段挥拍被判成跳变，卡在陀螺外推里；
 *   2. 判据只看角度，不看有没有真实运动。方向事件 20–25Hz + 快挥拍时相邻帧
 *      转角轻松越过 1.2 rad，被当成解分支跳变，而外推用的是削顶的陀螺积分，
 *      姿态会明显偏离手机。等 MAX_EXTRAP_MS 到期强制重新接受时又是一次大跳。
 *
 * 现在判据用**相邻两帧**的差（`prevRaw` 每帧都更新），并且只要传感器在动就
 * 一律采信绝对姿态。解分支跳变通常发生在静止 / 微动时，那时仍会被拦。
 */
export class PoseContinuityGate {
  private prevRaw: Quat | null = null;
  private extrapMs = 0;

  /** 已连续外推多久（ms），排障时看得出有没有卡在外推态 */
  get extrapTime() {
    return this.extrapMs;
  }

  /**
   * @param raw    本帧绝对姿态（已做 yawZero 变换）
   * @param dtMs   距上一帧的真实墙钟间隔
   * @param moving 传感器是否检测到真实运动（角速度越过挥拍门槛）
   * @returns true = 采信绝对姿态；false = 这一帧继续用陀螺外推
   */
  decide(raw: Quat, dtMs: number, moving: boolean): boolean {
    const jump = this.prevRaw ? qAngle(raw, this.prevRaw) : 0;
    const accept =
      !this.prevRaw ||
      jump <= MAX_POSE_JUMP ||
      moving ||
      this.extrapMs > MAX_EXTRAP_MS;
    // 关键：无论采信与否都更新基准，跳变只影响这一帧，不会冻结到超时才放出来。
    this.prevRaw = raw;
    if (accept) this.extrapMs = 0;
    else this.extrapMs += Math.max(0, dtMs);
    return accept;
  }

  reset() {
    this.prevRaw = null;
    this.extrapMs = 0;
  }
}
