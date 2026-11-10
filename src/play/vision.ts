/**
 * 摄像头色块追踪：只解「左右」这一个轴。
 *
 * 纯计算在 vision-math.ts，这里只管浏览器那一半：权限、取帧、预览、HUD。
 * 默认完全不启用——由 `?vision=probe|1` 打开，见 main.ts。
 *
 * 三条不能破的约定：
 * 1. 不碰 src/core/，也不改物理/判定；输出只是一个 x（米），交给 updatePlayer。
 * 2. 直接映射，不积分。低通只朝目标收敛，色块丢失时保持上次站位（不钳到边界）。
 * 3. probe 模式只显示读数、不接走位，用来先拿到真机噪声和左右方向再决定接不接。
 */
import {
  VISION_W,
  VISION_H,
  detect,
  mapPixelX,
  lowPass,
  type VisionConfig,
  type Blob,
} from './vision-math';

export type VisionMode = 'probe' | 'drive';

export interface VisionOptions {
  mode: VisionMode;
  cfg: VisionConfig;
  /** 摄像头前置帧在部分机型上是镜像的；真机走两步看读数方向，用 ?flip=1 翻。 */
  flip: boolean;
  /** 是否显示取帧预览（调色块时很有用，正式玩可以 ?preview=0 关掉）。 */
  preview: boolean;
}

export class VisionTracker {
  readonly mode: VisionMode;
  readonly cfg: VisionConfig;
  private readonly flip: boolean;
  private readonly preview: boolean;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private grabCtx: CanvasRenderingContext2D | null = null;
  private previewCtx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private retryHandler: (() => void) | null = null;

  private frame = 0;
  private lastAt = 0;
  private processed = 0;
  private hzAt = 0;
  private hz = 0;

  private posX = 0;
  private pixelX: number | null = null;
  private area = 0;
  private lost = 0;
  private status: 'starting' | 'running' | 'error' = 'starting';
  private error = '';

  constructor(opts: VisionOptions) {
    this.mode = opts.mode;
    this.cfg = opts.cfg;
    this.flip = opts.flip;
    this.preview = opts.preview;
  }

  /** 平滑后的站位（米）。probe 模式也照算，只是不接进 PLAYER。 */
  get x(): number {
    return this.posX;
  }

  get running(): boolean {
    return this.status === 'running';
  }

  async start(): Promise<void> {
    if (this.status === 'running') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('拿不到摄像头 API：必须用 HTTPS 打开（npm run dev:https）');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: VISION_W },
          height: { ideal: VISION_H },
          facingMode: 'user',
        },
        audio: false,
      });
    } catch (e) {
      this.fail(`摄像头权限被拒绝或没找到设备：${String(e)}`);
      return;
    }
    this.stream = stream;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.fail(`摄像头画面启动失败：${String(e)}`);
      return;
    }
    this.video = video;

    const grab = document.createElement('canvas');
    grab.width = VISION_W;
    grab.height = VISION_H;
    const grabCtx = grab.getContext('2d', { willReadFrequently: true });
    if (!grabCtx) {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.fail('拿不到 2D 画布上下文，无法取帧');
      return;
    }
    this.grabCtx = grabCtx;

    const previewEl = document.getElementById('vision-preview') as HTMLCanvasElement | null;
    if (this.preview && previewEl) {
      previewEl.width = VISION_W;
      previewEl.height = VISION_H;
      this.previewCtx = previewEl.getContext('2d');
    }

    // 权限已经拿到了，撤掉「点一下页面重试」的监听，别让一次点击重启摄像头。
    if (this.retryHandler) {
      document.removeEventListener('pointerdown', this.retryHandler);
      this.retryHandler = null;
    }
    this.status = 'running';
    const now = performance.now();
    this.lastAt = now;
    this.hzAt = now;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (at: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.status !== 'running' || !this.video || !this.grabCtx) return;
    // 走位是慢变量，30Hz 足够，也给主循环留 CPU。
    this.frame++;
    if (this.frame % 2 !== 0) return;

    const dtMs = Math.min(100, Math.max(1, at - this.lastAt));
    this.lastAt = at;
    if (this.video.readyState < 2) return;

    this.grabCtx.drawImage(this.video, 0, 0, VISION_W, VISION_H);
    const img = this.grabCtx.getImageData(0, 0, VISION_W, VISION_H);
    const blob = detect(img.data, VISION_W, VISION_H, this.cfg);

    if (blob) {
      const cx = this.flip ? VISION_W - 1 - blob.cx : blob.cx;
      const target = mapPixelX(cx, VISION_W, this.cfg.maxX);
      this.posX = lowPass(this.posX, target, dtMs, this.cfg.tauMs);
      this.pixelX = blob.cx;
      this.area = blob.area;
      this.lost = 0;
    } else {
      // 人走出画面或色块被挡住：保持站位，不要突然跳到边界。
      this.lost++;
      this.pixelX = null;
      this.area = 0;
    }

    this.processed++;
    if (at - this.hzAt >= 1000) {
      this.hz = Math.round((this.processed * 1000) / (at - this.hzAt));
      this.processed = 0;
      this.hzAt = at;
    }
    this.drawPreview(img, blob);
  };

  private drawPreview(img: ImageData, blob: Blob | null): void {
    const c = this.previewCtx;
    if (!c) return;
    c.putImageData(img, 0, 0);
    // 竖直中线 = PLAYER.x 为 0 的位置
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.beginPath();
    c.moveTo(VISION_W / 2, 0);
    c.lineTo(VISION_W / 2, VISION_H);
    c.stroke();
    if (!blob) return;
    c.lineWidth = 2;
    c.strokeStyle = '#00e5a0';
    c.beginPath();
    c.moveTo(blob.cx - 9, blob.cy);
    c.lineTo(blob.cx + 9, blob.cy);
    c.moveTo(blob.cx, blob.cy - 9);
    c.lineTo(blob.cx, blob.cy + 9);
    c.stroke();
    c.strokeRect(blob.cx - 11, blob.cy - 11, 22, 22);
  }

  private fail(msg: string): void {
    this.status = 'error';
    this.error = msg;
    // 有些浏览器要求用户手势后才肯弹权限框。每次失败都重新挂一次可重试钩子，
    // 否则第二次被拒之后提示还写着「点一下重试」，实际却再也不会触发。
    if (this.retryHandler) return;
    this.retryHandler = () => {
      document.removeEventListener('pointerdown', this.retryHandler!);
      this.retryHandler = null;
      this.status = 'starting';
      this.error = '';
      void this.start();
    };
    document.addEventListener('pointerdown', this.retryHandler, { once: true });
  }

  /** 由 main.ts 的 200ms HUD 定时器调用，避免每帧写 DOM。 */
  updateHud(): void {
    const set = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    const label = this.mode === 'probe' ? '只读取证（不接走位）' : '接管左右走位';
    if (this.status === 'error') {
      set('v-status', '摄像头未启用');
      set('v-detail', `${this.error} · 点一下页面重试`);
    } else if (this.status === 'starting') {
      set('v-status', '正在请求摄像头权限…');
      set('v-detail', label);
    } else {
      set('v-status', label);
      set('v-detail', this.lost > 0 ? `色块丢失中（已保持站位 ${this.lost} 帧）` : '色块已锁定');
    }
    set('v-pixel', this.pixelX === null ? '—' : `${this.pixelX.toFixed(0)} px`);
    set('v-pos', `${this.posX >= 0 ? '+' : ''}${this.posX.toFixed(2)} m`);
    set('v-area', `${this.area} px`);
    set('v-lost', String(this.lost));
    set('v-hz', `${this.hz} Hz`);
    set(
      'v-cfg',
      `色相 ${this.cfg.hue}±${this.cfg.hueTol} · 半幅 ±${this.cfg.maxX}m · 镜像 ${this.flip ? '开' : '关'} · τ ${this.cfg.tauMs}ms`
    );
    const previewEl = document.getElementById('vision-preview');
    if (previewEl) previewEl.hidden = !this.preview;
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video = null;
  }
}
