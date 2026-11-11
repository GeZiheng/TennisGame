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

import { qConj, qMul, qNormalize, type Quat } from './imu';

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
  const earth = qMul(qMul(qz, qx), qy);
  return qNormalize(qMul(EARTH_TO_WORLD, earth));
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
  return qNormalize(qMul(yawQuat(-yawZero), absolute));
}

/**
 * 两帧绝对姿态之间「绕世界 Y 轴」的转角增量（弧度，-π..π）。
 *
 * 用世界系增量四元数 dq = next · conj(prev)，而不是把 qYaw 减两次：qYaw 在万向锁
 * 附近会换解分支，相减会凭空造出上百度假跳变。手机静止时 beta / gamma 不变，
 * `absolute = Ry(α)·K`，于是 `dq = Ry(Δα)` 严格成立，这里读出的就是 alpha 的漂移量。
 *
 * 非静止帧它只是「投影到世界 Y 的分量」，不是完整的欧拉角差；但那些帧根本不参与
 * 积分（见 YawDriftObserver），近似误差不会进入结果。
 */
function worldDeltaQuat(prev: Quat, next: Quat): Quat {
  let dq = qMul(qNormalize(next), qConj(qNormalize(prev)));
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
 * 相邻两帧绕世界 Y 的转角超过它，就认为是玩家真的在挥拍 / 换握，不积分。
 *
 * 真机慢漂约 1–2°/s，30–60Hz 采样下每帧不到 0.1°；一次中等挥拍中段角速度可达
 * 20 rad/s，相邻帧增量是十几到几十度。两者差两个数量级，门限很安全。
 * 用幅度而不是「静止门控」：挥拍那几百毫秒里 alpha 一样在漂，只积分静止帧会漏掉。
 */
const MAX_DRIFT_STEP = 0.05; // rad ≈ 2.9°/帧
/**
 * 增量四元数里 x / z 分量的上限（≈1.1° 的非 Y 轴旋转）。
 *
 * 纯 alpha 慢漂的 dq 是 [0, sin(Δα/2), 0, cos(Δα/2)]，x/z 严格为 0。手机俯仰、
 * 横滚（挥拍起收势、换握、手抖）会让 x/z 明显非零，此时 dq 的 Y 投影只是
 * 「耦合出来的分量」，不是漂移。把它积分进 acc 会让 effZero 变成随机游走，
 * 补偿开启时表现就是拍子慢慢乱晃。
 */
const MAX_DRIFT_OFF_AXIS = 0.01;

/**
 * 只读漂移观测器：累积「慢变」的绕 Y 转角，快变（真实挥拍 / 换握）原样放过。
 *
 * `deviceorientation` 的 alpha 会因室内磁场 / 系统融合重收敛慢慢走掉，而 beta /
 * gamma 有重力参考、不漂。把这个慢变量积分出来扣掉即可。
 *
 * 它只回答「传感器多转了多少」，**不定义正前方、不改 yawZero 的语义**。旧的
 * `recal` 把「当前朝向」重锁成正前方，才会只在反手位回得正、正手位锁错方向。
 */
export class YawDriftObserver {
  private prev: Quat | null = null;
  private acc = 0;
  /** 被判为真实动作或非纯 Y 旋转而跳过的帧数，可用来看补偿有没有误吃挥拍 */
  private skipped = 0;

  get radians() {
    return this.acc;
  }

  get degrees() {
    return (this.acc * 180) / Math.PI;
  }

  get skippedSteps() {
    return this.skipped;
  }

  update(abs: Quat): number {
    if (this.prev) {
      const dq = worldDeltaQuat(this.prev, abs);
      const dy = 2 * Math.atan2(dq[1], dq[3]);
      const off = Math.hypot(dq[0], dq[2]);
      if (Math.abs(dy) < MAX_DRIFT_STEP && off < MAX_DRIFT_OFF_AXIS) this.acc += dy;
      else this.skipped++;
    }
    this.prev = abs;
    return this.acc;
  }

  reset() {
    this.prev = null;
    this.acc = 0;
    this.skipped = 0;
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
