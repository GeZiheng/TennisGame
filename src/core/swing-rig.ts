/**
 * 挥拍枢轴：让球拍绕**身体**转，而不是绕着拍柄底部转。
 *
 * ## 真网球拍的三段式
 *
 * 1. **转腰带动**：引拍结束到击球前，拍子是被躯干端着的——手跟着肩走一段弧，
 *    拍头在更外面，速度主要来自转体；
 * 2. **手肘制动**：击球前一刻大臂减速、肘几乎停住，拍头绕肘甩出去。这就是
 *    「拍头速度 20 m/s，手只有 3 m/s」的来源；
 * 3. **随挥**：击球之后又回到绕躯干转，拍子收在身体另一侧。
 *
 * 现在这套实现是「握点固定 + 整支拍子绕握点转」，等于把拍柄底部当成一个铰链。
 * 挥起来像一根绕手腕转的棍子，不像挥拍——这就是玩家反馈的第 2 条。
 *
 * ## 只测得到握点姿态，所以要「造」一段平移
 *
 * 手机只给姿态（朝向），给不出躯干和肘的位置。所以这里不去反解真实骨架，而是
 * 给握点补上它本来就该有的那段平移：**把整支拍子绕一个虚拟枢轴转同样的角**。
 * 枢轴在腰和肘之间按手部角速度切换——慢的时候是腰（转体带动），快的时候是肘
 * （小半径、手几乎停住、拍头甩），速度回落又回到腰（随挥）。这条曲线不需要
 * 状态机，它直接由角速度读出来，因此「起势 → 击球 → 随挥」自动接上。
 *
 * ## 为什么用「拍柄方向的最小弧」而不是姿态增量
 *
 * 手腕的内外旋（绕拍柄轴的自转）在姿态里是很可观的角度，但它**不该**让握点位移：
 * 手心转一下，拍子原地翻个面。如果直接拿完整姿态增量去绕枢轴转，一次翻腕就会把
 * 拍子甩出去半米。取拍柄方向（局部 +y）从准备姿态到当前姿态的最小弧，正好只保留
 * 「拍子扫过的那段弧」：自转对它是零，扫拍对它是全额。
 *
 * ## 幅度：gain 只缩转角，不缩半径
 *
 * `gain` 把轨道转角按比例缩小。缩掉的那部分转动本来就应该发生在手腕和肘上，
 * 视觉上就是「手走的弧比拍头短」——真实挥拍正是这样。gain=1 会让手也走满整段弧，
 * 看起来像整个人被拍子拽着走。
 *
 * ## 代价：击球点会跟着平移
 *
 * `RacketPose` 同时喂渲染和 `sweepFace`，所以「看到的弧」永远等于「判定的弧」。
 * 代价是球到面那一刻拍面中心相对原位偏了一段（gain 0.4、转角 40° 时约 12cm），
 * 在判定盘半轴（横 0.20 / 竖 0.24）以内，而且判定本身是**扫掠**的：拍面在整段
 * 挥拍里从球附近扫过，不是只在一个点上等球。实测见 `docs/history.md` 4.22。
 */

import { clamp, qslerp, vcross, vdot, vlen, vnorm, vrot, type Quat4, type V3 } from './vec';

/** 局部 +y = 拍柄方向。判断「拍子扫过多少弧」只看这一个方向。 */
const UP: V3 = [0, 1, 0];

export interface SwingRigConfig {
  /** 腰部枢轴相对握点的偏移（米）。握点在 1.3m，腰在 0.86m、身后 0.20m。 */
  waist: V3;
  /** 肘部枢轴相对握点的偏移（米）。前臂约 26cm，肘在握点斜下后方。 */
  elbow: V3;
  /** 低于这个角速度（rad/s）完全算「转体带动」。 */
  slowSpin: number;
  /** 高于这个角速度完全算「肘部制动」。 */
  fastSpin: number;
  /** 轨道转角上限（弧度）。防拍子被甩到天上时整支飞出去。 */
  maxAngle: number;
  /** 轨道转角相对拍柄真实转角的比例。见文件头「幅度」。 */
  gain: number;
  /**
   * 握点相对基座的最大位移（米）。**这一条才是真正管手感的**。
   *
   * 转角按 gain 缩了之后，大挥（拍柄扫过 100° 以上）依然会把握点搬走半米——
   * 而喂球是瞄着**挥拍前**那个拍面中心的。搬得越多，命中率掉得越狠：
   * 模拟器 A/B（`RIG=1`，全力档 28 rad/s，拍柄扫过 115°）不限位移时那一拍
   * 拍面中心离原位 0.9m，直接漏接；限到 0.08m 之后 30/30 全过。
   *
   * 0.18m 的依据是模拟器实测（`RIG=1` 扫 0.06 → 0.60）：
   *   - 0.06 / 0.08 / 0.10 / 0.15 / 0.20 → 396 击球、1 例 reach 差异；
   *   - 0.35 / 0.60 → 396 击球、2 例 reach（拍面被搬到球下方 0.85m）。
   * 也就是说 0.20 以内**不比 0.08 差**（那 1 例在 28 rad/s、拍柄扫过 149° 的
   * 极端档上本来就在边缘），再往上才开始真的漏。判定盘等效半轴是横 0.20 / 竖 0.24，
   * 加上喂球自身 ±0.12 的散布，0.18 是「能看出弧、又留一半余量」的那一档。
   */
  maxShift: number;
  /** 准备姿态的跟踪门限（rad/s）：比这慢才算「没在挥」，可以采信为新基准。 */
  refSpin: number;
  /** 准备姿态的跟踪时间常数（秒）。 */
  refTau: number;
  /** 腰 ⇄ 肘切换的时间常数（秒）。太小会在门限附近来回切。 */
  blendTau: number;
}

export const SWING_RIG_DEFAULTS: SwingRigConfig = {
  waist: [0, -0.44, 0.2],
  elbow: [0, -0.26, 0.06],
  slowSpin: 6,
  fastSpin: 18,
  maxAngle: (110 * Math.PI) / 180,
  gain: 0.4,
  maxShift: 0.18,
  refSpin: 1.2,
  refTau: 0.5,
  blendTau: 0.06,
};

const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 罗德里格斯公式：把向量 r 绕单位轴 u 转 ang。 */
function rotateAbout(r: V3, u: V3, ang: number): V3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const cross = vcross(u, r);
  const dot = vdot(u, r);
  return [
    r[0] * c + cross[0] * s + u[0] * dot * (1 - c),
    r[1] * c + cross[1] * s + u[1] * dot * (1 - c),
    r[2] * c + cross[2] * s + u[2] * dot * (1 - c),
  ];
}

/**
 * 有状态的挥拍枢轴。每帧喂一次握点基座、手机姿态和手部角速度，吐出一个新的握点。
 *
 * 状态只有两个，都必须是「跨帧」的：准备姿态（否则每帧都从当前姿态出发，
 * 转角恒为 0，等于没做）与腰/肘混合系数（否则在门限附近会一帧腰一帧肘地抖）。
 */
export class SwingRig {
  /** 准备姿态：几乎不转的帧里慢慢跟过去。换握法、慢漂、按 R 重标定都靠它吸收。 */
  private ref: Quat4 | null = null;
  /** 0 = 腰，1 = 肘。 */
  private hinge = 0;
  /** 这一帧用的枢轴（世界系），给调试和探针看。 */
  pivot: V3 = [0, 0, 0];
  /** 这一帧的轨道转角（弧度，已乘 gain）。 */
  angle = 0;

  /**
   * 一帧的握点。
   *
   * @param base 走位给出的握点（静止姿态下球拍组原点的位置）
   * @param q 手机姿态（已经平滑过的那一份，和判定用的完全一致）
   * @param spin 手部角速度（rad/s）。由调用方从相邻两帧姿态算，不要用「平滑误差」
   *   那种代理量——它和真实角速度差一个 τ 因子，用来切枢轴会切错。
   */
  update(base: V3, q: Quat4, spin: number, dt: number, cfg: SwingRigConfig = SWING_RIG_DEFAULTS): V3 {
    // ---- 1. 维护准备姿态 ----
    if (!this.ref) {
      this.ref = [q[0], q[1], q[2], q[3]];
    } else if (spin < cfg.refSpin) {
      // τ=0.5s：挥拍间隙（几十到几百毫秒）里跟得上握法变化，又不会在起势的
      // 头几帧被 2 rad/s 的慢速动作带跑。
      this.ref = qslerp(this.ref, q, 1 - Math.exp(-Math.max(dt, 0) / cfg.refTau));
    }

    // ---- 2. 拍柄扫过的弧 ----
    const d0 = vnorm(vrot(this.ref, UP));
    const d1 = vnorm(vrot(q, UP));
    const raw = Math.acos(clamp(vdot(d0, d1), -1, 1));
    const axisRaw = vcross(d0, d1);
    const al = vlen(axisRaw);

    // 拍柄方向几乎没变（静止、或者只是原地翻腕）→ 没有弧可走，握点不动。
    //
    // 这里**不清 hinge**：转角趋零时枢轴在哪都不影响输出（位移是转角的函数），
    // 清了反而会在「挥到一半停一下」之后把肘部状态抹掉，下一帧枢轴突变。
    if (al < 1e-4 || raw < 1e-3) {
      this.angle = 0;
      this.pivot = [base[0], base[1], base[2]];
      return [base[0], base[1], base[2]];
    }

    const axis: V3 = [axisRaw[0] / al, axisRaw[1] / al, axisRaw[2] / al];
    const ang = Math.min(raw, cfg.maxAngle);
    this.angle = ang * cfg.gain;

    // ---- 3. 腰 ⇄ 肘 ----
    const want = smoothstep(cfg.slowSpin, cfg.fastSpin, spin);
    this.hinge += (want - this.hinge) * (1 - Math.exp(-Math.max(dt, 0) / cfg.blendTau));
    const off = lerp3(cfg.waist, cfg.elbow, this.hinge);
    const P: V3 = [base[0] + off[0], base[1] + off[1], base[2] + off[2]];
    this.pivot = P;

    // ---- 4. 绕枢轴走弧 ----
    const r: V3 = [base[0] - P[0], base[1] - P[1], base[2] - P[2]];
    const r2 = rotateAbout(r, axis, this.angle);
    // 位移（不是位置）限幅：方向保留，长度夹到 maxShift。限位置会在换枢轴时
    // 贴着球壳滑，方向和幅度都不对。
    const d: V3 = [r2[0] - r[0], r2[1] - r[1], r2[2] - r[2]];
    const dl = vlen(d);
    const k = dl > cfg.maxShift && dl > 1e-9 ? cfg.maxShift / dl : 1;
    return [base[0] + d[0] * k, base[1] + d[1] * k, base[2] + d[2] * k];
  }

  /** 换会话 / 重连时清干净：准备姿态必须重新学，否则第一帧就带一段凭空的弧。 */
  reset() {
    this.ref = null;
    this.hinge = 0;
    this.angle = 0;
    this.pivot = [0, 0, 0];
  }
}
