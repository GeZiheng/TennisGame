/**
 * 运动传感器采集。
 *
 * 几个必须处理的平台差异：
 *   - iOS 15+ 需要 DeviceMotionEvent.requestPermission()，且必须在用户手势里调用
 *   - iOS 只在安全上下文（HTTPS 或 localhost）下发事件，HTTP 下静默失效 —— 所以要有超时检测
 *   - rotationRate 的单位是 deg/s，轴顺序是 (beta→x, gamma→y, alpha→z)
 *   - accelerationIncludingGravity 的单位是 m/s²，iOS 与 Android 的符号约定历史上不一致，
 *     这里原样透传，不做符号修正，让它只服务于「峰值检测」这一个用途
 *
 * 另外同时监听 deviceorientation：它给出的 alpha/beta/gamma 是系统融合好的绝对姿态，
 * 俯仰和横滚有重力参考、不会漂。这是「球拍和手机角度一致」的关键，陀螺仪积分做不到这点。
 */

import { deviceEulerToWorldQuat } from '../core/attitude';
import { omegaFromQuatDelta } from '../core/gyro';
import type { Quat } from '../core/imu';

export interface MotionSample {
  /** rad/s，设备坐标系 */
  gyro: [number, number, number];
  /** g，设备坐标系，含重力 */
  accel: [number, number, number];
  /** 与上一帧的间隔，毫秒 */
  dtMs: number;
}

const D2R = Math.PI / 180;
const G = 9.80665;

/** 角速度的来源，界面要显示出来——排障时第一个要看的就是它。 */
export type GyroSource = 'rotationRate' | 'diff' | 'none';

export class MotionSource {
  private handler: ((e: DeviceMotionEvent) => void) | null = null;
  private orientHandler: ((e: DeviceOrientationEvent) => void) | null = null;
  private lastAt = 0;
  private sampleCount = 0;
  /** 方向事件的计数。有些机器只有这一条通道，不能因为 motion 没有就拒绝启动。 */
  private orientCount = 0;

  /** 最近一次绝对姿态（设备系 → three 世界系）。拿不到方向事件时是 null，走陀螺仪兜底。 */
  latestAbs: Quat | null = null;
  absAt = 0;

  /** 最近 1 秒方向事件的到达时刻，用来算真实采样率 */
  private poseTimes: number[] = [];

  /**
   * 姿态采样率（Hz）。
   *
   * 这个数字决定了屏幕上的球拍最多能「多顺」：发包 60Hz 也不代表姿态是 60Hz，
   * 很多机型 deviceorientation 只有 25–35Hz，拍子是 30fps 的动画。
   * 玩家分不清「网络慢」和「采样稀」，但排障时必须分得清。
   */
  get poseHz() {
    const now = performance.now();
    while (this.poseTimes.length > 0 && now - this.poseTimes[0] > 1000) this.poseTimes.shift();
    return this.poseTimes.length;
  }

  /* ---- 角速度的两种来源 ---- */
  /** devicemotion 给的原始角速度 */
  private rrGyro: [number, number, number] = [0, 0, 0];
  /** 最近一次收到 devicemotion（哪怕数值是 0），用来判断这条通道死没死 */
  private rrAt = 0;
  /** 最近一次 rotationRate 真的有大读数，用来判断它是不是「永远是 0」 */
  private lastStrongRrAt = 0;
  /** 由姿态差分反推的角速度 */
  private diffGyro: [number, number, number] = [0, 0, 0];
  private prevAbs: Quat | null = null;
  private prevAbsAt = 0;
  private useDiff = false;
  private lastAccel: [number, number, number] = [0, 0, 1];

  onSample: ((s: MotionSample) => void) | null = null;
  onError: ((msg: string) => void) | null = null;

  get count() {
    return this.sampleCount;
  }

  /** 方向事件是否在正常工作（区别于「有接口但没数据」）。 */
  get hasAbsolute(): boolean {
    return this.latestAbs !== null && performance.now() - this.absAt < 500;
  }

  /** 角速度当前取自哪条通道。`diff` 说明这机型的 rotationRate 不可用，已经自动兜底。 */
  get gyroSource(): GyroSource {
    const now = performance.now();
    if (this.useDiff) return now - this.absAt < 250 ? 'diff' : 'none';
    if (now - this.rrAt < 500) return 'rotationRate';
    if (now - this.absAt < 250) return 'diff';
    return 'none';
  }

  /**
   * 取当前角速度，顺带决定这一帧该信谁。
   *
   * 判据很简单，但必须双向：
   *   - rotationRate 出现过大读数（> 3 rad/s）→ 说明它是好的，从此一直信它
   *   - rotationRate 一直是 0、而姿态差分明显在动 → 说明它是坏的，切到差分
   * 只判一个方向的话，坏的机器上永远切不过去。
   */
  currentGyro(): [number, number, number] {
    const now = performance.now();
    const rrFresh = now - this.rrAt < 500;
    const diffFresh = now - this.absAt < 250;
    const rrMag = Math.hypot(this.rrGyro[0], this.rrGyro[1], this.rrGyro[2]);
    const diffMag = Math.hypot(this.diffGyro[0], this.diffGyro[1], this.diffGyro[2]);

    if (rrMag > 3) {
      this.lastStrongRrAt = now;
      this.useDiff = false;
    } else if (diffMag > 2.5 && diffFresh && rrMag < 0.2 && now - this.lastStrongRrAt > 1500) {
      this.useDiff = true;
    }

    if (this.useDiff) return diffFresh ? this.diffGyro : [0, 0, 0];
    if (rrFresh) return this.rrGyro;
    return diffFresh ? this.diffGyro : [0, 0, 0];
  }

  async start(): Promise<boolean> {
    if (typeof DeviceMotionEvent === 'undefined') {
      this.onError?.('这个浏览器没有 DeviceMotion 接口');
      return false;
    }

    // 两个权限请求必须在同一个用户手势里**同步发起**。
    // iOS 上 await 一次之后就脱离手势栈了，第二个请求会被静默拒绝，
    // 结果是「动得了，但倾斜永远是错的」—— 这种半残状态最难查。
    const motionEvt = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    const orientEvt =
      typeof DeviceOrientationEvent !== 'undefined'
        ? (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> })
        : null;

    const motionReq = typeof motionEvt.requestPermission === 'function' ? motionEvt.requestPermission() : null;
    const orientReq =
      orientEvt && typeof orientEvt.requestPermission === 'function' ? orientEvt.requestPermission() : null;

    if (motionReq) {
      try {
        const res = await motionReq;
        if (res !== 'granted') {
          this.onError?.('传感器权限被拒绝。到 Safari 设置里允许「运动与方向访问」后刷新页面');
          return false;
        }
      } catch {
        this.onError?.('权限请求失败，可能不在安全上下文（需要 HTTPS）');
        return false;
      }
    }

    // 方向权限拿不到不致命：退化成纯陀螺仪积分，只是会漂、而且起始倾斜是错的
    if (orientReq) {
      try {
        await orientReq;
      } catch {
        /* 忽略 */
      }
    }

    this.lastAt = 0;
    this.sampleCount = 0;
    this.orientCount = 0;

    this.orientHandler = (e: DeviceOrientationEvent) => {
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      const now = performance.now();
      const q = deviceEulerToWorldQuat(e.alpha, e.beta, e.gamma);
      this.poseTimes.push(now);

      // 差分角速度：姿态是对的，两帧之间的旋转增量就是这一瞬间真实转了多少
      if (this.prevAbs) {
        this.diffGyro = omegaFromQuatDelta(this.prevAbs, q, (now - this.prevAbsAt) / 1000);
      }
      this.prevAbs = q;
      this.prevAbsAt = now;

      this.latestAbs = q;
      this.absAt = now;
      this.orientCount++;
    };
    addEventListener('deviceorientation', this.orientHandler);

    this.handler = (e: DeviceMotionEvent) => {
      const now = performance.now();
      const rr = e.rotationRate;
      const acc = e.accelerationIncludingGravity;
      // 只要有一条能给数据就继续。原来要求 rr 和 acc 同时存在，
      // 结果 rotationRate 为 null 的机型会连加速度一起丢掉，一个采样都发不出去。
      if (!rr && !acc) return;

      // 优先用系统给的采样间隔，缺省时退回本地时钟差
      let dt = e.interval && e.interval > 0 ? e.interval : now - this.lastAt;
      if (!Number.isFinite(dt) || dt <= 0) dt = 16.7;
      dt = Math.min(Math.max(dt, 2), 100);
      this.lastAt = now;
      this.sampleCount++;

      if (rr) {
        this.rrGyro = [(rr.beta ?? 0) * D2R, (rr.gamma ?? 0) * D2R, (rr.alpha ?? 0) * D2R];
        this.rrAt = now;
      }
      if (acc) {
        this.lastAccel = [(acc.x ?? 0) / G, (acc.y ?? 0) / G, (acc.z ?? 0) / G];
      }

      this.onSample?.({ gyro: this.currentGyro(), accel: this.lastAccel, dtMs: dt });
    };

    addEventListener('devicemotion', this.handler);

    // 800ms 内一条事件都没来，基本可以断定是权限被拒、页面在后台，或者设备不支持。
    // 注意两条通道任一条活着都算能用：只有方向事件的机器，角速度走姿态差分兜底。
    await new Promise((r) => setTimeout(r, 800));
    if (this.sampleCount === 0 && this.orientCount === 0) {
      this.onError?.('收不到传感器数据：接口在，但 800ms 内一条事件都没来');
      return false;
    }
    return true;
  }

  stop() {
    if (this.handler) removeEventListener('devicemotion', this.handler);
    if (this.orientHandler) removeEventListener('deviceorientation', this.orientHandler);
    this.handler = null;
    this.orientHandler = null;
    this.latestAbs = null;
    this.prevAbs = null;
    this.rrGyro = [0, 0, 0];
    this.diffGyro = [0, 0, 0];
    this.useDiff = false;
    this.poseTimes = [];
  }
}

export interface SampleSource {
  onSample: ((s: MotionSample) => void) | null;
  onError: ((msg: string) => void) | null;
  /** 最近一次绝对姿态；没有方向事件的数据源返回 null */
  latestAbs?: Quat | null;
  /** 最近一次绝对姿态的采样时刻（与 sendFrame 同一时钟）。用来量采样→渲染的端到端延迟 */
  readonly absAt?: number;
  /** 姿态采样率（Hz），最近 1 秒的方向事件数 */
  readonly poseHz?: number;
  /** 方向事件是否新鲜（500ms 内有数据）。陈旧姿态不能当成当前姿态发出去。 */
  readonly hasAbsolute?: boolean;
  /** 角速度取自哪条通道；假数据源没有这个概念 */
  readonly gyroSource?: GyroSource;
  /** 取当前角速度（已包含 rotationRate → 姿态差分的自动兜底） */
  currentGyro?(): [number, number, number];
  start(): Promise<boolean>;
  stop(): void;
}

/**
 * 没有手机时，在地址后面加 `?demo=1` 打开这个假数据源，
 * 用来检查球拍端的运行时界面（姿态示意、仪表、溢出标记）有没有画错。
 * 它产出的数据走和真机完全相同的链路，只是不经过传感器。
 */
export class DemoSource implements SampleSource {
  onSample: ((s: MotionSample) => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private t = 0;

  async start(): Promise<boolean> {
    this.timer = setInterval(() => {
      this.t += 1 / 60;
      const swing = this.t % 2.5;
      const burst = swing < 0.4 ? Math.sin((swing / 0.4) * Math.PI) : 0;
      const amp = 0.4 + burst * 1.8;
      this.onSample?.({
        gyro: [
          Math.sin(this.t * 2.1) * amp * 6,
          Math.cos(this.t * 1.3) * amp * 4,
          Math.sin(this.t * 0.9 + 1) * amp * 3,
        ],
        accel: [
          Math.sin(this.t * 2.1) * (1 + burst * 7),
          Math.cos(this.t * 1.6) * (1 + burst * 5),
          1 + burst * 6,
        ],
        dtMs: 16.7,
      });
    }, 1000 / 60);
    return true;
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
