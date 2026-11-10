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

import { qMul, qNormalize, type Quat } from './imu';

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
