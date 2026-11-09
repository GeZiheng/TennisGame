import type { ImuPacket } from '../core/protocol';

/**
 * 本地模拟控制器。没有手机时按 M 打开，
 * 用来验证「渲染 + 统计 + 平滑」这条链路本身没坏，
 * 免得真机连不上时分不清是网络问题还是代码问题。
 */
export class MockController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private t0 = 0;
  private prevGyro: [number, number, number] = [0, 0, 0];
  private q: [number, number, number, number] = [0, 0, 0, 1];

  start(onPacket: (p: ImuPacket) => void) {
    if (this.timer !== null) return;
    this.t0 = performance.now();
    this.timer = setInterval(() => {
      const t = (performance.now() - this.t0) / 1000;

      // 模拟「慢慢摆 + 周期性爆发挥拍」
      const swingPhase = t % 3;
      const burst = swingPhase < 0.35 ? Math.sin((swingPhase / 0.35) * Math.PI) : 0;
      const amp = 0.55 + burst * 1.6;

      const yaw = Math.sin(t * 1.7) * amp;
      const pitch = Math.sin(t * 2.3 + 1) * amp * 0.55;
      const roll = Math.sin(t * 1.1 + 2) * amp * 0.4;

      const cy = Math.cos(yaw / 2);
      const sy = Math.sin(yaw / 2);
      const cp = Math.cos(pitch / 2);
      const sp = Math.sin(pitch / 2);
      const cr = Math.cos(roll / 2);
      const sr = Math.sin(roll / 2);

      // Y * X * Z 顺序拼接
      const qx = cy * sp * cr + sy * cp * sr;
      const qy = sy * cp * cr - cy * sp * sr;
      const qz = cy * cp * sr - sy * sp * cr;
      const qw = cy * cp * cr + sy * sp * sr;
      this.q = [qx, qy, qz, qw];

      const gyro: [number, number, number] = [
        (yaw - this.prevGyro[0]) * 6,
        (pitch - this.prevGyro[1]) * 6,
        (roll - this.prevGyro[2]) * 6,
      ];
      this.prevGyro = [yaw, pitch, roll];

      const gAccel = 1 + burst * 9;
      const accel: [number, number, number] = [
        Math.sin(pitch) * gAccel,
        Math.cos(pitch) * Math.cos(roll) * gAccel,
        Math.sin(roll) * gAccel * 0.5,
      ];

      const tNow = performance.now();
      onPacket({
        seq: this.seq++,
        tSend: tNow,
        tSample: tNow,
        q: this.q,
        gyro,
        accel,
        peakG: Math.max(1, Math.hypot(...accel)),
        peakW: Math.max(0, Math.hypot(...gyro)),
      });
    }, 1000 / 60);
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running() {
    return this.timer !== null;
  }
}
