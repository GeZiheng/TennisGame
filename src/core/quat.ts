/**
 * 四元数。**全项目唯一一份实现**。
 *
 * 为什么单独一个文件：历史上这套代数被拆在两处——`imu.ts` 有
 * `qMul / qConj / qNormalize`（大写，姿态积分一路用），`vec.ts` 有
 * `qconj / qslerp`（小写，拍面插值一路用）。同一个共轭被写了两遍，
 * 名字还不一样；类型也分成了 `Quat` 和 `Quat4` 两个同构元组。
 * 这就是「两处写同一份，迟早会漂」的现成例子（见 `AGENTS.md` 0.3）。
 *
 * 现在：类型在 `Q`，函数在 `qmul / qconj / qnorm / qslerp`。
 * `imu.ts` 的 `Quat` 和 `vec.ts` 的 `Quat4` 都只是 `Q` 的**别名**，
 * 不是各自的一份定义——留着它们是因为调用点太多，改名不换来任何正确性。
 *
 * 约定与 three.js 一致：四元数按 `[x, y, z, w]` 排，单位元是 `[0, 0, 0, 1]`。
 */

export type Q = [number, number, number, number]; // x, y, z, w

export const IDENTITY: Q = [0, 0, 0, 1];

/** 四元数乘法（Hamilton，先 b 后 a 的复合写作 `qmul(a, b)`）。 */
export function qmul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 共轭 = 逆旋转（单位四元数前提下）。 */
export function qconj(q: Q): Q {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** 归一化。长度接近 0 时退回单位元——积分发散时这是唯一安全的出口。 */
export function qnorm(q: Q): Q {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-8) return [...IDENTITY];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/**
 * 球面线性插值。
 *
 * 拍面位姿是 60Hz 来的，物理是 240Hz 跑。要判断「球在第 3 个子步撞上拍面」，
 * 就必须知道拍面在那个**子步时刻**转过多少——直接拿上一帧的姿态会错开最多 16ms，
 * 快速挥拍时拍面已经转过 40° 以上，判定会整体偏一边。
 *
 * `q` 与 `−q` 是同一个旋转，夹角为负时翻转一侧走短弧，否则会在半圈附近
 * 插出一条完全错误的路径。
 */
export function qslerp(a: Q, b: Q, t: number): Q {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;

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
