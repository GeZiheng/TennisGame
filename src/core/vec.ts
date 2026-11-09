/**
 * 三维向量小工具。
 *
 * 为什么不用 three.Vector3：core/ 这一层刻意不依赖 three.js，
 * 这样姿态、挥拍、弹道这三块数学可以直接跑在 node 里做单测，
 * 将来真要迁到 Unity 或服务端，也只需要翻译这几百行。
 */

export type V3 = [number, number, number];
export type Quat4 = [number, number, number, number];

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

/** 四元数共轭 = 逆旋转（单位四元数前提下）。 */
export const qconj = (q: Quat4): Quat4 => [-q[0], -q[1], -q[2], q[3]];

/**
 * 球面线性插值。
 *
 * 拍面位姿是 60Hz 来的，物理是 240Hz 跑。要判断「球在第 3 个子步撞上拍面」，
 * 就必须知道拍面在那个**子步时刻**转过多少——直接拿上一帧的姿态会错开最多 16ms，
 * 快速挥拍时拍面已经转过 40° 以上，判定会整体偏一边。
 */
export function qslerp(a: Quat4, b: Quat4, t: number): Quat4 {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;

  // q 与 -q 表示同一个旋转，夹角为负时翻转一侧走短弧，
  // 否则会在半圈附近插出一条完全错误的路径。
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  // 足够接近就退化成线性插值再归一化，避免 sin 接近 0 时除爆
  if (cos > 0.9995) {
    const x = a[0] + (bx - a[0]) * t;
    const y = a[1] + (by - a[1]) * t;
    const z = a[2] + (bz - a[2]) * t;
    const w = a[3] + (bw - a[3]) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }

  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const ka = Math.sin((1 - t) * theta) / s;
  const kb = Math.sin(t * theta) / s;
  return [a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb];
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 线性插值两个位置，用来还原「两帧之间球穿过某个平面」的精确交点。 */
export const vlerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
