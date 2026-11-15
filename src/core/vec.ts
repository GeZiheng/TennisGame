import type { Q } from './quat';

/**
 * 三维向量小工具。
 *
 * 为什么不用 three.Vector3：core/ 这一层刻意不依赖 three.js，
 * 这样姿态、挥拍、弹道这三块数学可以直接跑在 node 里做单测，
 * 将来真要迁到 Unity 或服务端，也只需要翻译这几百行。
 */

export type V3 = [number, number, number];

/**
 * 四元数类型只是 `Q` 的别名，实现在 `core/quat.ts`。
 *
 * `Quat4` 这个名字是历史遗留（另一路叫 `Quat`，见 `imu.ts`），保留它是因为
 * 拍面/枢轴这一路的 import 都写着 `Quat4`，改名不换来任何正确性。
 */
export type Quat4 = Q;

// 四元数运算只有一份实现（`core/quat.ts`），这里再导出只是为了让
// 「向量 + 旋转」的调用方可以只 import 一个文件。
export { qconj, qslerp } from './quat';

export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const vcross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const vlen = (a: V3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);

export function vnorm(a: V3): V3 {
  const l = vlen(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** 用四元数旋转向量（等价于 three 里 Vector3.applyQuaternion）。 */
export function vrot(q: Quat4, v: V3): V3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q.xyz × v)，再 v' = v + qw*t + q.xyz × t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 线性插值两个位置，用来还原「两帧之间球穿过某个平面」的精确交点。 */
export const vlerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
