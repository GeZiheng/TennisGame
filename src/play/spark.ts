/**
 * HUD 上那条延迟曲线（`<canvas id="spark">`）。
 *
 * 单独一个文件的原因：它是 60 行纯 canvas 绘制，和游戏逻辑没有任何关系，唯一的输入
 * 是一个 `LatencyWindow`。留在 `app.ts` 里会把主循环附近塞进一堆 `ctx.moveTo`。
 */

import type { LatencyWindow } from '../core/stats';

/**
 * 画最近 120 个单向延迟样本。
 *
 * 用 CSS 像素当坐标系、backing store 按 dpr 放大：这样画布尺寸和样式表里写的高度
 * 永远一致，改 CSS 不用同步改 JS。
 */
export function drawSpark(el: HTMLCanvasElement, latency: LatencyWindow) {
  const ctx = el.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(devicePixelRatio, 2);
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return;
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const vals = latency.values.slice(-120);
  if (vals.length < 2) return;

  const maxV = Math.max(40, ...vals) * 1.15;
  const x = (i: number) => (i / (vals.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 6 - (v / maxV) * (h - 14);

  // 100ms 红线：超过它，玩家会归因为「我打空了」
  if (maxV > 100) {
    ctx.strokeStyle = '#f09595';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(100));
    ctx.lineTo(w, y(100));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = '#185fa5';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  vals.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.stroke();

  const p50 = latency.p50;
  if (Number.isFinite(p50)) {
    ctx.strokeStyle = 'rgba(15,110,86,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(p50));
    ctx.lineTo(w, y(p50));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
