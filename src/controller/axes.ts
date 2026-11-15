/**
 * 手机页上那个三分量示意图（`<canvas id="axes">`）。
 *
 * 画的是**输出姿态**（已经扣掉 `yawZero`、可能还扣了漂移补偿的那一份），不是原始
 * 绝对姿态：屏幕上这支箭头必须和大屏上那支球拍指向同一个方向，否则「看着对、
 * 打不到」这类问题又多一个怀疑对象。
 */

import type { Quat } from '../core/imu';

/** 用四元数旋转向量（等价于 three 里 Vector3.applyQuaternion）。 */
function rotateVec(q: Quat, v: [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * 画三根轴：拍柄（+Y）、拍面法线（+Z）、侧向（+X）。
 *
 * 用正交投影而不是透视：这是一个读数仪表，不是场景——近大远小会让「法线朝哪」
 * 变得难判断，而它存在的唯一理由就是让玩家一眼看出法线朝哪。
 * 深度用透明度编码：指向屏幕里的轴淡、指向自己的轴实。
 */
export function drawAxes(el: HTMLCanvasElement, q: Quat) {
  const ctx = el.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(devicePixelRatio, 2);
  if (el.width !== Math.round(el.clientWidth * dpr)) {
    el.width = Math.round(el.clientWidth * dpr);
    el.height = Math.round(el.clientWidth * dpr);
  }
  const w = el.width;
  const h = el.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const s = w * 0.36;

  const project = (v: [number, number, number]) => {
    const r = rotateVec(q, v);
    return { x: cx + r[0] * s, y: cy - r[1] * s, z: r[2] };
  };

  // 参考圆
  ctx.strokeStyle = 'rgba(28,28,26,0.08)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, s, 0, Math.PI * 2);
  ctx.stroke();

  const axes: Array<[[number, number, number], string]> = [
    [[0, 1, 0], '#0f6e56'], // 拍柄方向
    [[0, 0, 1], '#185fa5'], // 拍面法线
    [[1, 0, 0], '#d85a30'], // 侧向
  ];

  for (const [dir, color] of axes) {
    const p = project(dir);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.min(1, (p.z + 1) / 2));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(28,28,26,0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
  ctx.fill();
}
