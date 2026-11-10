/**
 * 视觉走位的纯计算部分。
 *
 * 和 stats.ts 一样不依赖 DOM / three / core，编进 .tmp-test 供 Node 单测；
 * 摄像头取帧、权限、HUD 这些浏览器相关的部分在 vision.ts。
 *
 * 设计前提（见 docs/vision.md）：
 * - 只解一个轴：胸口色块的水平像素质心 → PLAYER.x。不做深度、不测前后。
 * - 直接映射，不积分：像素位置是绝对测量，一阶低通只朝目标收敛、不累积误差。
 * - 色块丢失时保持上一次站位，不钳位到边界：人走出画面 ≠ 站到了最边上。
 */

export interface VisionConfig {
  /** 目标色相中心，0–360（HSV 的 H）。品红 310、荧光绿 75、蓝 210、黄 45。 */
  hue: number;
  /** 色相容差，单位度。用环形距离，跨 0/360 也成立。 */
  hueTol: number;
  /** 饱和度下限，0–1。太低会把白墙、浅色衣服算进来。 */
  satMin: number;
  /** 明度下限，0–1。挡掉暗背景。 */
  valMin: number;
  /** 最大连通块的最小像素数。小于它算这一帧没找到色块。 */
  minArea: number;
  /** 一阶低通时间常数（ms）。走位是慢变量，挥拍是快变量，频段天然分开。 */
  tauMs: number;
  /** 站位半幅（米）。镜头盖不住键盘模式的 ±3.0，视觉模式收窄。 */
  maxX: number;
}

export const VISION_DEFAULTS: VisionConfig = {
  hue: 310,
  hueTol: 24,
  satMin: 0.35,
  valMin: 0.22,
  minArea: 24,
  tauMs: 250,
  maxX: 1.2,
};

/** 取帧尺寸。320×240 足够，60fps 全量扫描也没压力，实际每 2 帧处理一次。 */
export const VISION_W = 320;
export const VISION_H = 240;

export interface Hsv {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
}

export interface Blob {
  /** 质心 x，像素坐标 */
  cx: number;
  /** 质心 y，像素坐标 */
  cy: number;
  /** 连通块像素数 */
  area: number;
}

/** RGB 各通道 0–255 → HSV。放在 HSV 而不是 RGB 里判色，对自动曝光/白平衡漂移更钝。 */
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max < 1e-9 ? 0 : d / max, v: max };
}

/** 色相是环形量：359° 和 1° 只差 2°，不是 358°。 */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

export function hsvHit(h: number, s: number, v: number, cfg: VisionConfig): boolean {
  if (s < cfg.satMin || v < cfg.valMin) return false;
  return hueDistance(h, cfg.hue) <= cfg.hueTol;
}

/** ImageData.data（RGBA）→ 0/1 掩码，长度 = 像素数。 */
export function buildMask(rgba: Uint8ClampedArray, cfg: VisionConfig): Uint8Array {
  const n = rgba.length >> 2;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i << 2;
    const { h, s, v } = rgbToHsv(rgba[p], rgba[p + 1], rgba[p + 2]);
    mask[i] = hsvHit(h, s, v, cfg) ? 1 : 0;
  }
  return mask;
}

/**
 * 最大连通块的质心（4 邻域 BFS）。
 *
 * 为什么不用「所有命中像素的加权质心」：背景里一小块同色物体就能把质心拽偏几十像素。
 * 只认最大的那一块，等于要求「贴纸是画面里最显眼的同色区域」，这个前提可以靠选色保证。
 */
export function largestBlob(mask: Uint8Array, w: number, h: number): Blob | null {
  const n = w * h;
  if (mask.length < n || w < 1 || h < 1) return null;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let best: Blob | null = null;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      area++;
      sumX += x;
      sumY += y;
      // 四邻域；用数组下标而不是 shift()，避免大块时退化成 O(n²)
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x + 1 < w && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y + 1 < h && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    if (!best || area > best.area) best = { cx: sumX / area, cy: sumY / area, area };
  }
  return best;
}

/** 一帧的完整检测：命中掩码 → 最大连通块 → 面积门槛。 */
export function detect(rgba: Uint8ClampedArray, w: number, h: number, cfg: VisionConfig): Blob | null {
  const blob = largestBlob(buildMask(rgba, cfg), w, h);
  return blob && blob.area >= cfg.minArea ? blob : null;
}

/**
 * 像素质心 → 站位。线性映射 + 钳位，不积分、不累积误差。
 *
 * cx=0 对应 -maxX，cx=w-1 对应 +maxX。镜像方向由 vision.ts 的 flip 处理，
 * 因为那取决于摄像头驱动是否回传镜像帧，纯函数不该猜硬件。
 */
export function mapPixelX(cx: number, w: number, maxX: number): number {
  const t = cx / Math.max(1, w - 1) - 0.5;
  return Math.max(-maxX, Math.min(maxX, t * 2 * maxX));
}

/** 一阶低通。alpha 按 dt 算，掉帧时不会突然跟不上或过冲。 */
export function lowPass(prev: number, target: number, dtMs: number, tauMs: number): number {
  if (dtMs <= 0) return prev;
  if (tauMs <= 0) return target;
  const a = dtMs / (dtMs + tauMs);
  return prev + (target - prev) * a;
}
