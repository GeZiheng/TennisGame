/**
 * 姿态跟踪：只用陀螺仪积分 + 静止冻结 + 零偏估计。
 *
 * 为什么不用加速度计做倾角校正（也就是完整的 Madgwick）：
 * 两个平台对 accelerationIncludingGravity 的符号约定不一致（iOS 历史上 y/z 反号），
 * 一旦符号搞反，校正项会和陀螺仪互相打架，姿态直接发散。
 * 而网球挥拍是「短促爆发 + 长期静止」的节奏，只要在静止时冻结积分并持续估计陀螺零偏，
 * 漂移就足够小 —— 这是 ZUPT（零速修正）的简化版。
 *
 * P1 拿到真机数据、确认符号约定后，再补重力倾斜校正。
 */

export type Quat = [number, number, number, number]; // x, y, z, w

export const IDENTITY: Quat = [0, 0, 0, 1];

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function qNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-8) return [...IDENTITY];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** 把角速度（rad/s，设备系）积分进姿态。 */
function integrate(q: Quat, w: [number, number, number], dt: number): Quat {
  const [qx, qy, qz, qw] = q;
  const [wx, wy, wz] = w;
  const h = 0.5 * dt;
  const dq: Quat = [
    qw * wx + qy * wz - qz * wy,
    qw * wy - qx * wz + qz * wx,
    qw * wz + qx * wy - qy * wx,
    -qx * wx - qy * wy - qz * wz,
  ];
  return qNormalize([qx + dq[0] * h, qy + dq[1] * h, qz + dq[2] * h, qw + dq[3] * h]);
}

export interface TrackerOptions {
  /** 低于这个角速度（rad/s）视为静止，约 4.6°/s */
  stillThreshold?: number;
  /** 持续静止多久后开始冻结，毫秒 */
  stillHoldMs?: number;
  /** 零偏估计的平滑系数 */
  biasAlpha?: number;
}

export class ImuTracker {
  private q: Quat = [...IDENTITY];
  private bias: [number, number, number] = [0, 0, 0];
  private stillMs = 0;
  private frozen = false;

  private readonly stillThreshold: number;
  private readonly stillHoldMs: number;
  private readonly biasAlpha: number;

  constructor(opts: TrackerOptions = {}) {
    this.stillThreshold = opts.stillThreshold ?? 0.08;
    this.stillHoldMs = opts.stillHoldMs ?? 220;
    this.biasAlpha = opts.biasAlpha ?? 0.02;
  }

  get isStill(): boolean {
    return this.frozen;
  }

  get biasMagnitude(): number {
    return Math.hypot(this.bias[0], this.bias[1], this.bias[2]);
  }

  update(gyro: [number, number, number], dtMs: number): Quat {
    const dt = Math.min(Math.max(dtMs, 0.5), 100) / 1000;
    const speed = Math.hypot(gyro[0], gyro[1], gyro[2]);

    if (speed < this.stillThreshold) {
      this.stillMs += dtMs;
      // 静止时持续更新零偏，这是抑制漂移的主力
      const a = this.biasAlpha;
      this.bias[0] += (gyro[0] - this.bias[0]) * a;
      this.bias[1] += (gyro[1] - this.bias[1]) * a;
      this.bias[2] += (gyro[2] - this.bias[2]) * a;
      if (this.stillMs >= this.stillHoldMs) this.frozen = true;
    } else {
      this.stillMs = 0;
      this.frozen = false;
    }

    if (this.frozen) return this.q;

    const corrected: [number, number, number] = [
      gyro[0] - this.bias[0],
      gyro[1] - this.bias[1],
      gyro[2] - this.bias[2],
    ];
    this.q = integrate(this.q, corrected, dt);
    return this.q;
  }

  reset(): void {
    this.q = [...IDENTITY];
    this.bias = [0, 0, 0];
    this.stillMs = 0;
    this.frozen = false;
  }

  /** 相对中位姿态。玩家点「开始」那一刻的姿态被记为 0，之后所有输出都是相对它的增量。 */
  relativeTo(origin: Quat): Quat {
    return qNormalize(qMul(qConj(origin), this.q));
  }

  snapshot(): Quat {
    return [...this.q];
  }
}

