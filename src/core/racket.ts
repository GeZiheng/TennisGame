/**
 * 球拍几何与拍面碰撞。
 *
 * 这里是「严格碰撞」的全部数学，也是整套判定里唯一真正需要三维求交的地方。
 *
 * ## 为什么是「线段 vs 椭圆盘」而不是「球 vs 椭球」
 *
 * 球的半径 3.35cm，球速 20–42 m/s。在 PHYS_DT（4.17ms）里球走 8–17cm，
 * 是球半径的 3–5 倍。任何「把球当成一个点、看它当前在不在拍面里」的判定，
 * 都会在高速球上系统性漏判——球在两帧之间直接穿过拍面，两端都不在椭圆内。
 *
 * 所以必须先求出**球心轨迹穿过拍面平面的那个点**，再检查交点是否落在椭圆内。
 * 球心穿过平面是「球体真正撞上拍面」的必要条件（球体是凸的，平面是无限大的），
 * 所以这个判据既不漏也不多。代价只是一次除法。
 *
 * ## 为什么位姿要插值
 *
 * 拍面位姿来自渲染循环（60Hz），物理跑 240Hz。一个物理子步里拍面最多转过 25°，
 * 直接拿上一帧的姿态会把命中点算到几厘米之外。60Hz 与 240Hz 之间有 4 倍关系，
 * 但 Vite 的 rAF 并不是严格的 60Hz，所以用**时间**做 slerp，不用帧序号。
 */

import { BALL_R, FACE_CY, FACE_MARGIN, FACE_RX, FACE_RY, RACKET_POS } from './court';
import { qconj, qslerp, vlerp, vrot, vsub, type Quat4, type V3 } from './vec';

/** 拍面在世界里的位姿。pos 是**握点**，不是拍面中心。 */
export interface RacketPose {
  /** 本地时刻（与大屏 performance.now() 同一时钟），毫秒 */
  t: number;
  /** 握点世界坐标 */
  pos: V3;
  /** 世界朝向：局部 +y 沿拍柄指向拍面，局部 ±z 是拍面法线 */
  q: Quat4;
}

/** 一次拍面命中。 */
export interface FaceHit {
  /** 命中点（世界系，球心穿过拍面平面的位置） */
  at: V3;
  /** 线段参数 0..1 */
  s: number;
  /** 面内归一化坐标，(-1,-1) 到 (1,1)，模长 > 1 表示在椭圆外 */
  u: number;
  v: number;
  /** 偏离甜区的程度：0 是正中心，1 是拍框内沿 */
  offCenter: number;
}

/** 球拍默认姿态：拍柄竖直向上、拍面朝向来球方向（+z）。 */
export const IDLE_POSE: RacketPose = {
  t: 0,
  pos: [...RACKET_POS],
  q: [0, 0, 0, 1],
};

/**
 * 把世界点变换到拍面局部系。
 *
 * 局部系原点在**握点**，+y 沿拍柄，因此拍面中心在 (0, FACE_CY, 0)，
 * 拍面平面就是局部 z = 0 的平面。
 */
function toLocal(pose: RacketPose, p: V3): V3 {
  return vrot(qconj(pose.q), vsub(p, pose.pos));
}

/** 局部系里的拍面中心。 */
const FACE_CENTER_LOCAL: V3 = [0, FACE_CY, 0];

/**
 * 拍面中心的世界坐标。
 *
 * 拍面到底在哪，一律问这个函数，不要用 `pose.pos`：`pos` 是**握点**，
 * 它到拍面中心还差 0.6 米的杆子。挥拍时拍子绕握点转，中心会跟着扫出去，
 * 所以这个偏移必须按当时的姿态算。
 */
export function faceCenter(pose: RacketPose): V3 {
  const w = vrot(pose.q, FACE_CENTER_LOCAL);
  return [pose.pos[0] + w[0], pose.pos[1] + w[1], pose.pos[2] + w[2]];
}

/**
 * 线段 p0→p1 是否撞上拍面。返回撞点，没有则 null。
 *
 * ## 判据：球心到拍面**圆盘**的距离 ≤ 球半径
 *
 * 不是「球心穿过拍面平面」。两者的差别在挥拍里立刻露出来：
 *
 *   - 球正撞拍面（球路与拍面成几十度）：最近点在平面上，两种判据完全一致。
 *   - 球**顺着拍面掠过**（球路几乎平行于拍面）：球心可能永远不穿过平面，
 *     但球体已经蹭到拍线了。真网球会「擦框」，按「必须穿过平面」判会漏——
 *     漏掉的那一瞬间在屏幕上就是「球从拍子中间穿过去」。
 *
 * 做法：在线段上取几个候选点（穿过平面的位置、面内离拍面中心最近的位置、
 * 两个端点），挑出垂距在球半径以内、且落在椭圆里的那个，取最靠中心的一个。
 * 高速球不会隧穿：线段求交而不是点判定，40 m/s 的球在 4.17ms 子步里走 17cm，
 * 端点都在拍面两侧时穿过平面的候选点落在中间，依然命中。
 *
 * 椭圆按球半径 + 容差膨胀（近似 Minkowski 和，中心区域精确，只在长轴端点处
 * 多算几毫米——那点误差远小于球本身的不确定性）。
 */
export function sweepFace(pose: RacketPose, p0: V3, p1: V3): FaceHit | null {
  const a = toLocal(pose, p0);
  const b = toLocal(pose, p1);

  const n0 = a[2] - FACE_CENTER_LOCAL[2];
  const n1 = b[2] - FACE_CENTER_LOCAL[2];
  const dn = n1 - n0;

  const du = b[0] - a[0];
  const dv = b[1] - a[1];
  const len2 = du * du + dv * dv;

  const R = BALL_R + FACE_MARGIN;
  const rx = FACE_RX + R;
  const ry = FACE_RY + R;

  // 候选：穿过平面处 + 面内离中心最近处 + 两端点。
  // 第三个是为了「球从远方飞来但从没进到拍面附近」这类情形也能正确判空。
  const cand: number[] = [];
  if (Math.abs(dn) > 1e-9) {
    const sc = -n0 / dn;
    if (sc >= 0 && sc <= 1) cand.push(sc);
  }
  const sp = len2 > 1e-12 ? (-a[0] * du - (a[1] - FACE_CENTER_LOCAL[1]) * dv) / len2 : 0;
  cand.push(sp < 0 ? 0 : sp > 1 ? 1 : sp);
  cand.push(0, 1);

  let best: FaceHit | null = null;
  let bestE2 = Infinity;
  for (const s of cand) {
    // 垂距（球心到拍面平面的距离）必须小于球半径，否则球根本没碰到拍面所在的那层
    if (Math.abs(n0 + dn * s) > R) continue;

    const u = a[0] + du * s;
    const v = a[1] + dv * s - FACE_CENTER_LOCAL[1];
    const eu = u / rx;
    const ev = v / ry;
    const e2 = eu * eu + ev * ev;
    if (e2 > 1 || e2 >= bestE2) continue;

    // 命中点回到世界系：局部 → 世界
    const wp = vrot(pose.q, [u, v + FACE_CENTER_LOCAL[1], FACE_CENTER_LOCAL[2]]);
    bestE2 = e2;
    best = {
      at: [pose.pos[0] + wp[0], pose.pos[1] + wp[1], pose.pos[2] + wp[2]],
      s,
      u: eu,
      v: ev,
      offCenter: Math.sqrt(e2),
    };
  }
  return best;
}

/**
 * 点 p 在时刻 pose 的拍面覆盖范围内吗（球心到拍面的距离小于球半径）。
 *
 * 用在线段求交不适用的时候：球被冻结在接触点上之后，它不再移动，
 * 这时候要问的是「此刻的拍面有没有罩住它」，而不是「它穿过了平面吗」。
 */
export function faceCovers(pose: RacketPose, p: V3): boolean {
  const l = toLocal(pose, p);
  const n = Math.abs(l[2] - FACE_CENTER_LOCAL[2]);
  if (n > BALL_R + FACE_MARGIN) return false;

  const u = l[0] / (FACE_RX + BALL_R + FACE_MARGIN);
  const v = (l[1] - FACE_CENTER_LOCAL[1]) / (FACE_RY + BALL_R + FACE_MARGIN);
  return u * u + v * v <= 1;
}

/**
 * 拍面位姿的时间滑窗。
 *
 * 为什么需要历史而不是「当前位姿」：
 * 挥拍事件是随包传过来的，比球晚到 20–60ms。等它到了再问「现在拍面朝哪」，
 * 玩家早就挥完了，拍面已经转到别处。必须能回到**挥拍峰值那一刻**去问。
 */
export class RacketTrack {
  private hist: RacketPose[] = [];
  /** 保留时长。比 HIT_WINDOW_MS 长一倍，覆盖「球早到 150ms」和「挥晚 150ms」两头。 */
  private readonly keepMs = 400;

  push(pose: RacketPose) {
    const last = this.hist[this.hist.length - 1];
    // 同一时刻重复推送（一帧里多次调用）直接覆盖，否则插值会除零
    if (last && Math.abs(last.t - pose.t) < 0.5) {
      this.hist[this.hist.length - 1] = pose;
      return;
    }
    this.hist.push(pose);
    const cutoff = pose.t - this.keepMs;
    while (this.hist.length > 2 && this.hist[0].t < cutoff) this.hist.shift();
  }

  get last(): RacketPose | null {
    return this.hist.length ? this.hist[this.hist.length - 1] : null;
  }

  /** 插值出时刻 t 的位姿。超出历史范围就夹到端点，绝不返回 null 中间态。 */
  at(t: number): RacketPose | null {
    const h = this.hist;
    if (h.length === 0) return null;
    if (h.length === 1) return h[0];
    if (t <= h[0].t) return h[0];
    const last = h[h.length - 1];
    if (t >= last.t) return last;

    for (let i = 1; i < h.length; i++) {
      if (h[i].t < t) continue;
      const a = h[i - 1];
      const b = h[i];
      const span = b.t - a.t;
      const k = span > 1e-6 ? (t - a.t) / span : 0;
      return { t, pos: vlerp(a.pos, b.pos, k), q: qslerp(a.q, b.q, k) };
    }
    return last;
  }

  /** 历史里是否真有覆盖时刻 t 的采样（而不是被夹到端点）。 */
  covers(t: number): boolean {
    const h = this.hist;
    if (h.length < 2) return false;
    return t >= h[0].t && t <= h[h.length - 1].t;
  }

  reset() {
    this.hist.length = 0;
  }
}
