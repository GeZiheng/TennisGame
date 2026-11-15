/**
 * 击球采集：把「一次球员与来球相遇」变成一行可离线分析的数据。
 *
 * ## 它在为谁准备数据
 *
 * 为**校准器**——那个「挥拍那一刻拍面中心会偏离瞄准点多远」的模型。现在这一层是
 * `app.ts` 里一个常量 `contactDelta`（三维 EMA，正反手混成一份）。要把它升级成
 * 「带条件的函数」，先得有一批干净的样本。
 *
 * ## 一条记录分成三块，**不能混**
 *
 * - `label`：算标签要用的几何量，其中 `G`（走位给的握点）是**走位的输出**。
 *   它必须记（否则算不出 `delta`），但**绝对不能进特征**——进了就是闭环自激，
 *   模型会开始拟合自己的输出。
 * - `feat`：只放**与走位无关的外部条件**（握法、挥拍、来球）。这是模型能吃的 X。
 * - `meta`：命中与否、第几拍、漂移读数。用于筛选和整段剔除，不进 X。
 *
 * 三块分开写在文件结构里，是为了让「建模时只准 `feat` 进 X」这条约束看得见，
 * 而不是靠记性。
 *
 * ## 标签是「两个方向的差」，不是「到球的距离」
 *
 * 拍面中心挂在握点沿拍柄 `FACE_CY`=0.6m 处，所以 `fc − G` 的长度**恒为 0.6**，
 * 它是个方向。`restOffset` 同理（静止时的那个方向）。于是
 *
 *     delta = (fc − G) − rest = 0.6 × (u击球 − u站立)
 *
 * 是一个「方向转了多少」乘拍柄长，模长上界 1.2m。它和球在哪无关——校准器不需要
 * 知道球的位置，只需要知道拍子自己甩了多远。
 *
 * ## 漏接的样本必须留
 *
 * 只用「命中」的样本会引入截断偏置：保留 `|delta| < 判定半轴` 的那部分，估出来的
 * 均值必然偏小，正好把要修的那个偏差抹掉。所以 `hit: false`（球没碰到拍面盘）和
 * `stroke: null`（碰到了但没挥）这两种样本都要采，只是它们不参与「按键反弹」那类
 * 结论，参与的是均值估计。
 *
 * 具体的采集点在 `core/duel.ts` 的 `checkReceiverFace` / `enterContact` /
 * `tickContact` / `flushNearMiss`，它们统一发一个 `contact` 事件。
 */

import type { V3 } from './vec';

/** 挥出去的那一拍里，与校准有关的几个量（`Stroke` 的子集）。 */
export interface StrokeTrace {
  /** 峰值角速度 rad/s */
  peakW: number;
  /** 拍头速率 m/s */
  speed: number;
  /** 0..1 的发力程度 */
  charge: number;
  /** 拍面法线（世界系，已统一成朝球场那一面） */
  face: V3;
}

/**
 * `Duel` 在一次「相遇」里能提供的全部几何。
 *
 * 三种相遇共用这一个结构，用 `hit` / `stroke` 两个 null 区分：
 *
 * | 情形 | `hit` | `stroke` | 含义 |
 * |---|---|---|---|
 * | 正常击球 | true | 有 | 拍面接住了球，也挥了 |
 * | 碰到没挥 | true | null | 拍面接住了球，窗口中没挥拍 → 判给对手 |
 * | 没碰到 | false | null | 球从拍面旁边过去，`at` 是最近点 |
 *
 * 第三种才是「走位/瞄准偏了」的直接证据——前两种说明拍面已经在球上了。
 */
export interface ContactCapture {
  /** 相遇时刻（与大屏同一时钟，接触插值到子步） */
  t: number;
  /**
   * 那一刻拍面中心的世界坐标。
   *
   * **必须用接触时刻的姿态算**（`RacketTrack.at(t)`），不能用渲染帧的 `lastPose`：
   * 30 rad/s 的挥拍下，一帧（16.7ms）差 28°，杆端差 30cm，和判定半轴同一个量级。
   * 那点滞后是单边的，不会互相抵消，会直接变成一个假偏差。
   */
  fc: V3;
  /** 球心位置：碰到拍面时是接触点；没碰到时是最近点 */
  at: V3;
  /** 相遇前的球速（接触后会被清零，所以要在那一刻取） */
  ballV: V3;
  /** 是否真的碰到拍面盘 */
  hit: boolean;
  /** 偏离甜区：0 = 正中，1 = 拍框内沿，>1 = 盘外。没碰到时是归一化最近距离 */
  offCenter: number;
  /** 挥拍时差（ms，正 = 晚）。没挥 = null */
  lag: number | null;
  /** 挥出去那一拍；没挥 = null */
  stroke: StrokeTrace | null;
  /** 发球那一拍。采集时排除：它是举在头上打的，和地面击球不是同一类动作 */
  serve: boolean;
}

/** 一条样本。字段分组见文件头。 */
export interface ContactSample {
  /** 相遇时刻（ms，与大屏同一时基） */
  t: number;
  session: string;
  label: {
    /** 走位给的握点。**只用于算 `delta`，禁止进特征** */
    G: V3;
    /** 相遇时刻的拍面中心 */
    fc: V3;
    /** 采集时的 `restOffset` 快照（站立时的握法偏移） */
    rest: V3;
    /** `(fc − G) − rest`，单位米，模长上界 1.2 */
    delta: V3;
  };
  feat: {
    /** 握法方向（静止时的杆向量）。横/斜/竖的连续编码，和 label.rest 是同一份快照 */
    rest: V3;
    /** 挥拍时差 ms。**最关键的一个**：球在挥拍的哪一段到达，决定拍面扫出去多少 */
    lag: number | null;
    /** 峰值角速度 */
    peakW: number | null;
    /** 拍头速率 */
    speed: number | null;
    /** 发力程度 0..1 */
    charge: number | null;
    /** 拍面法线。正反手的判据在里面——反手时手机翻面，`face[2]` 反号 */
    face: V3 | null;
    /** 来球在相遇点的位置（横向 / 高度） */
    at: V3;
    /** 来球速度（模长 + 入射角） */
    ballV: V3;
  };
  meta: {
    /** 拍面是否真接住了球 */
    hit: boolean;
    /** 球是否被挥出去了 */
    swung: boolean;
    /** 发球样本标记为 true，建模时整条剔除 */
    serve: boolean;
    /** 归一化偏离甜区 */
    offCenter: number;
    /** 这一分打到第几拍 */
    rally: number;
    /** 距上一次击球的毫秒数 */
    sincePrevHit: number | null;
    /** 采集时的姿态漂移读数（度）。超阈值的整段丢弃，见 `AGENTS.md` 0.4 */
    driftDeg: number | null;
  };
}

/** 组装一条样本的外部输入。`grip` 是走位输出，只进 `label`。 */
export interface ContactSampleInput {
  t: number;
  grip: V3;
  /** `restOffset` 快照。必须取相遇前的值，不能用事后被低通改过的 */
  rest: V3;
  capture: ContactCapture;
  rally: number;
  sincePrevHit: number | null;
  driftDeg: number | null;
  session: string;
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

/** 三维拷贝：`V3` 是可变元组，样本里不能留调用方的引用。 */
const cp = (v: readonly number[]): V3 => [v[0], v[1], v[2]];

/**
 * 组装一条样本。纯函数：同样的输入一定给同样的输出。
 *
 * `delta` 在这里算而不是让调用方传，是因为它是标签的全部意义所在——
 * 让它只有一个定义点，就不可能出现「app 里算一套、分析脚本里算另一套」。
 */
export function buildContactSample(input: ContactSampleInput): ContactSample {
  const { capture: c } = input;
  const grip = cp(input.grip);
  const rest = cp(input.rest);
  const fc = cp(c.fc);
  // 杆向量 − 站立杆向量 = 「挥拍把中心甩出去的那一段」
  const delta = sub(sub(fc, grip), rest);

  return {
    t: input.t,
    session: input.session,
    label: { G: grip, fc, rest: cp(rest), delta },
    feat: {
      rest: cp(rest),
      lag: c.lag,
      peakW: c.stroke ? c.stroke.peakW : null,
      speed: c.stroke ? c.stroke.speed : null,
      charge: c.stroke ? c.stroke.charge : null,
      face: c.stroke ? cp(c.stroke.face) : null,
      at: cp(c.at),
      ballV: cp(c.ballV),
    },
    meta: {
      hit: c.hit,
      swung: c.stroke !== null,
      serve: c.serve,
      offCenter: c.offCenter,
      rally: input.rally,
      sincePrevHit: input.sincePrevHit,
      driftDeg: input.driftDeg,
    },
  };
}

/** 一条样本是否该进校准器的训练集。发球排除；其余（含漏接）全留。 */
export function usableForCalibration(s: ContactSample): boolean {
  return !s.meta.serve;
}

/**
 * 按 `lag` 分桶，返回每桶 `delta` 的均值与样本数。
 *
 * 这是那条「漏斗」的第一层：如果三桶均值几乎一样，说明 `lag` 不是主因，
 * 校准器的收益上限很低，应该回头查别的原因。不同才值得往下走（回归）。
 *
 * `bucket` 单位毫秒；默认按 [-40, 40] 之间三桶分。挥拍窗口是 ±150ms，但绝大多数
 * 命中落在 ±60ms 内，桶再宽就分不出结构了。
 */
export function lagBuckets(
  samples: readonly ContactSample[],
  edges: readonly number[] = [-25, 25]
): { lo: number; hi: number; n: number; mean: V3 }[] {
  const out: { lo: number; hi: number; n: number; mean: V3 }[] = [];
  let lo = -Infinity;
  for (const hi of [...edges, Infinity]) {
    const rows = samples.filter(
      (s) => usableForCalibration(s) && s.feat.lag !== null && s.feat.lag >= lo && s.feat.lag < hi
    );
    const mean: V3 = [0, 0, 0];
    for (const r of rows) for (let i = 0; i < 3; i++) mean[i] += r.label.delta[i];
    const n = rows.length;
    if (n > 0) for (let i = 0; i < 3; i++) mean[i] /= n;
    out.push({ lo: Number.isFinite(lo) ? lo : NaN, hi: Number.isFinite(hi) ? hi : NaN, n, mean });
    lo = hi;
  }
  return out;
}

/** 一行一条 JSON。空集合返回空串（调用方据此决定要不要写文件）。 */
export function samplesToJsonl(samples: readonly ContactSample[]): string {
  if (samples.length === 0) return '';
  return samples.map((s) => JSON.stringify(s)).join('\n') + '\n';
}

const fmt = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(3);

/**
 * 真机上的即时读数：不用导出文件就能看出「偏了还是散了」。
 *
 * 输出三行——命中样本、漏接样本、按 `lag` 分桶的 `delta` 均值。第二行是判断
 * 「截断偏置有没有被消除」的依据：漏接样本的 `delta` 模长应该比命中样本**更大**，
 * 如果反而更小，说明最近点的取法有问题。
 */
export function summarizeContacts(samples: readonly ContactSample[]): string {
  const usable = samples.filter(usableForCalibration);
  const hit = usable.filter((s) => s.meta.hit);
  const miss = usable.filter((s) => !s.meta.hit);
  const mean = (rows: readonly ContactSample[]): V3 => {
    const m: V3 = [0, 0, 0];
    for (const r of rows) for (let i = 0; i < 3; i++) m[i] += r.label.delta[i];
    if (rows.length) for (let i = 0; i < 3; i++) m[i] /= rows.length;
    return m;
  };
  const line = (name: string, rows: readonly ContactSample[]) => {
    const m = mean(rows);
    return `${name} n=${rows.length}  Δ=(${fmt(m[0])}, ${fmt(m[1])}, ${fmt(m[2])})`;
  };
  const parts = [
    line('命中  ', hit),
    line('没碰到', miss),
    ...lagBuckets(usable).map((b) => {
      const tag = Number.isNaN(b.lo) ? `<${b.hi}` : Number.isNaN(b.hi) ? `≥${b.lo}` : `${b.lo}..${b.hi}`;
      return `lag ${tag}ms n=${b.n}  Δ=(${fmt(b.mean[0])}, ${fmt(b.mean[1])}, ${fmt(b.mean[2])})`;
    }),
  ];
  return parts.join('\n');
}

/**
 * 采集缓冲。只管「攒 + 导出」，策略（什么时候开、会话怎么分）留给调用方。
 *
 * 为什么要缓冲在内存而不是边采边写：浏览器里没有随手可写的文件句柄，一段会话
 * 攒完一次性下载是最省事、也不依赖服务端的形式。
 */
export class ContactLog {
  private rows: ContactSample[] = [];
  private active = false;

  /** 开始/继续记录。重复调用是幂等的。 */
  start() {
    this.active = true;
  }

  /** 停止记录。已攒的数据保留，可以继续 `start()` 或导出。 */
  stop() {
    this.active = false;
  }

  get recording() {
    return this.active;
  }

  get count() {
    return this.rows.length;
  }

  /** 记录一条。没在记录状态时**静默丢弃**——调用方不必自己判状态。 */
  push(sample: ContactSample) {
    if (!this.active) return;
    this.rows.push(sample);
  }

  snapshot(): readonly ContactSample[] {
    return this.rows;
  }

  toJsonl(): string {
    return samplesToJsonl(this.rows);
  }

  clear() {
    this.rows = [];
  }
}
