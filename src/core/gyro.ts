/**
 * 从两帧绝对姿态反推角速度。
 *
 * 为什么需要这条路：手机上有两条互相独立的传感器通道——
 *   - `deviceorientation`  → alpha/beta/gamma，系统融合好的绝对姿态，稳、不漂
 *   - `devicemotion`       → rotationRate，原始角速度
 * 它们**不是**一起工作的。部分机型（尤其是一些 Android 定制系统，以及某些 iOS 版本）
 * 前者完全正常，后者却恒为 0 或直接为 null。
 *
 * 结果就是最难查的一种故障：球拍姿态完美跟手，玩家以为一切正常，
 * 但挥拍检测拿到的 |ω| 永远是 0，一球都打不出去。
 *
 * 所以这里用姿态序列的差分当兜底：姿态是对的，差分出来的角速度就是对的
 * （只是被系统的姿态融合平滑过，峰值会被吃掉一点，对「找峰」这个用途完全够用）。
 *
 * 数学上要注意两件事：
 *   1. 用 q_prev⁻¹ ⊗ q_cur 得到的是**设备系**下的旋转增量，
 *      正好和 rotationRate 的坐标系一致，不需要再转世界系。
 *   2. q 和 -q 表示同一个旋转，必须先把 w 取正（取最短弧），
 *      否则差分会在半圈附近突然反号，打出一记看不见的假挥拍。
 */

import { qConj, qMul, type Quat } from './imu';
import type { V3 } from './vec';

/**
 * @param qPrev 上一帧姿态（世界系）
 * @param qCur  当前帧姿态（世界系）
 * @param dtSec 两帧间隔，秒
 * @returns 设备系角速度 rad/s。dt 不合理时返回 0，调用方据此判断这一帧不能用。
 */
export function omegaFromQuatDelta(qPrev: Quat, qCur: Quat, dtSec: number): V3 {
  // dt 太小是被合并的重复事件，太大是页面切后台回来，两种都不该产出角速度
  if (!(dtSec > 1e-4) || dtSec > 0.5) return [0, 0, 0];

  const d = qMul(qConj(qPrev), qCur);
  let x = d[0];
  let y = d[1];
  let z = d[2];
  let w = d[3];
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }

  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return [0, 0, 0];

  // θ = 2·atan2(|xyz|, w)；再用 θ/(|xyz|·dt) 一次性化成「轴 × 角速度」。
  // 用 atan2 而不是 acos(w)：小角度时 acos 的导数发散，噪声会被放大成假的抖动。
  const angle = 2 * Math.atan2(s, w);
  const k = angle / (s * dtSec);
  return [x * k, y * k, z * k];
}
