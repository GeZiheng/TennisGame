/**
 * 「走位瞄的是哪个拍面」探针：挥拍那一刻，拍面中心偏离瞄准点多少。
 *
 * ## 为什么需要它
 *
 * 走位瞄的是**拍面中心**（不是握点）。拍面中心 = 握点 + R·(0, 0.6, 0)，随拍子朝向
 * 一起动：横握在侧方半米、竖握在头顶半米。而 `app.ts` 估这个偏移时只在角速度
 * < 0.6 rad/s 的帧采信（挥拍中段中心会被甩出 0.3–1.1m，跟着走就是「一挥拍人被
 * 拽着跑」，`docs/history.md` 4.5）。
 *
 * 于是走位瞄的是**挥拍前**那个拍面位置。真挥起来拍子转过 40–80°，拍面中心跟着
 * 扫出去几十厘米，球到面那一刻它已经不在瞄准点上了——这就是真机反馈的
 * 「走位没控制好与球的水平距离，拍子的角度在变」（`docs/history.md` 4.23）。
 *
 * 这个探针复刻整条链路（规划 → 保持器 → 限速步进 → 挥拍枢轴 → 偏移估计），
 * 挥拍是真的在转（绕局部 x 轴），逐球量：
 *
 *   - **瞄准误差 Δ**：球穿过瞄准平面那一刻，真实拍面中心离「瞄准点」多远（x/y/z）
 *   - **球到拍面**：同一刻球心离拍面中心多远（判断「差在哪个轴上」）
 *   - **结算**：这一球拍面到底碰没碰到球
 *
 * ## 来球是喂出来的，不是回球机打的
 *
 * 对打的回球机瞄**固定高度带**（`ARRIVE_Y`），不管你把拍面放在哪儿——这对真人是
 * 对的（人自己会去够球），对探针的固定挥拍就致命：同一个 `PEAKW` 挥所有球，拍面
 * 在挥拍中段被甩出 0.3–0.4m，正好把球路扫开，量出来的是「挥拍幅度和来球高度不
 * 匹配」，不是 Δ 该补的那段误差。实测：接 `Duel` 的球，竖握/横握 16 球 0 命中。
 *
 * 所以这里自己喂：`aimIntoCourt` 把球送到**瞄准点**（`base + planOff`）上，
 * 求解器和回球机同一个。于是 Δ 就是纯粹的「瞄准点 vs 真实拍面」，不受弹道影响。
 * 也正因为喂的是瞄准点，`MODE=contact` 学出来的偏移能真的把球够到——这两种模式
 * 的命中率差别就是补偿有没有用。
 *
 * ## 用法
 *
 *   node scripts/probe-contact.cjs                 # 老的：瞄挥拍前的拍面
 *   MODE=contact node scripts/probe-contact.cjs    # 瞄「上一拍击球那一刻的拍面」
 *   GRIP=vert|tilt|horiz node scripts/probe-contact.cjs
 *   PEAKW=25 node scripts/probe-contact.cjs        # 挥拍峰值角速度
 *   V=1 node scripts/probe-contact.cjs             # 逐球打印
 *
 * 依赖 `.tmp-duel`（先跑 `npm run core`）。
 */
const { advance, aimIntoCourt, makeBall } = require('../.tmp-duel/core/physics.js');
const { BALL_R, FACE_CY, HIT_Z, OPP_HIT_Z, RACKET_POS } = require('../.tmp-duel/core/court.js');
const {
  planAutoMove,
  stepAutoMove,
  blendCenterOffset,
  AUTO_MOVE_DEFAULTS,
  TargetHold,
} = require('../.tmp-duel/core/auto-move.js');
const { faceCenter, sweepFace } = require('../.tmp-duel/core/racket.js');
const { SwingRig, SWING_RIG_DEFAULTS } = require('../.tmp-duel/core/swing-rig.js');

const GRIP = process.env.GRIP ?? 'tilt';
const MODE = process.env.MODE ?? 'rest';
const PEAKW = Number(process.env.PEAKW ?? 15);
const SECONDS = Number(process.env.SECONDS ?? 40);
const SEEDS = [11, 222, 3333];
const V = process.env.V === '1';

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const quatAxis = (axis, deg) => {
  const a = (deg * Math.PI) / 360;
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / l) * Math.sin(a), (axis[1] / l) * Math.sin(a), (axis[2] / l) * Math.sin(a), Math.cos(a)];
};
const racketQuat = (thetaDeg) => {
  const h = (thetaDeg * Math.PI) / 360;
  return [0, Math.cos(h), Math.sin(h), 0];
};

const Q =
  GRIP === 'vert' ? [0, 0, 0, 1]
  : GRIP === 'horiz' ? [0, 0, Math.SQRT1_2, Math.SQRT1_2]
  : racketQuat(14);

const SWING_MS = 150;
function swingDeg(u) {
  if (u <= 0) return 0;
  const k = Math.min(u, 1);
  return ((PEAKW * (SWING_MS / 1000)) / Math.PI) * (1 - Math.cos(Math.PI * k)) * (180 / Math.PI);
}

const makeRng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
};

/** 对面出球点：和回球机同一个（对手击球面、握点高度）。 */
const FROM = [0, 1.15, OPP_HIT_Z];
/** 上旋，和回球机同一档。 */
const SPIN = [-90, 0, 0];

const dt = 1000 / 60;

function run(seed) {
  const rng = makeRng(seed);
  const rig = new SwingRig();
  const hold = new TargetHold();
  const frames = Math.round((SECONDS * 1000) / dt);

  let px = 0;
  let py = RACKET_POS[1];
  let pz = HIT_Z;
  let prevQ = null;
  const center = [0, FACE_CY, 0];
  let learned = null;

  /** 待喂的球 + 这颗球这一拍量过了没有。 */
  let ball = null;
  let counted = false;
  /** 本帧 advance 报出来的子步（给 `sweepFace` 用，防隧穿）。 */
  let segs = [];

  let swingStart = null;
  let swung = false;
  const rows = [];
  const gripYs = [];
  let fed = 0;
  let feedFail = 0;

  /**
   * 让这颗球在 `z` 平面上到底落在哪个 x / y（以及还要飞多久）。
   *
   * 横向是解耦的（上旋轴沿 x，Magnus 力没有 x 分量），所以「穿越点的 x」可以事后
   * 一次线性修正；y 不行，所以 y 交给 `arriveY` 的硬约束。
   */
  const crossAt = (ball, z) => {
    const b = makeBall([...ball.p], [...ball.v], [...ball.spin]);
    const h = 1 / 240;
    for (let t = 0; t < 3; t += h) {
      advance(b, h, () => {});
      if (b.p[2] >= z) return { t: t + h, x: b.p[0], y: b.p[1] };
    }
    return null;
  };

  /**
   * 喂一颗「穿过 z 平面时高度 = y、横向 = x」的球。
   *
   * 落点要按目标高度挑：`aimIntoCourt` 的 `arriveY` 是硬约束，而「到面多高」由落点
   * 深度决定——深处打不出高球，浅处打不出低球。量过一次落点 × 高度的可行域：
   * y=1.2 只有落点 ≤ -6 解得出来，y=1.5–1.9 只有 -4.5..-3 这一段，y≥2.1 全无解
   * （改 `arriveTol` / `speed` 会挪动这些边界，届时重新扫一遍）。
   * 所以这里按落点深度排一条阶梯，从深到浅试，第一档全落空才放宽高度带。
   *
   * 落点的 x 是**打哪儿**，不等于**穿面时在哪儿**：从后场打一条斜线到目标落点，
   * 穿越击球面那一刻的 x 会差几十厘米。不管这个差，喂球就跟着玩家的漂移跑——
   * 实测竖握 40 秒能漂到 ±4.9m（场外），然后所有喂球都解不出来。所以解完之后
   * 按穿越点把 vx 修正一次。
   */
  const feed = (x, y, z) => {
    const opts = {
      maxClear: 2.8,
      speed: [8, 26],
      arriveZ: z,
      arriveY: [y - 0.06, y + 0.06],
      arriveTol: 0.06,
    };
    const tx = x + (rng() - 0.5) * 0.6;
    let v = null;
    for (const tz of [-10, -8, -6.5, -5.5, -4.5, -3.5, -2.5, -2]) {
      v = aimIntoCourt(FROM, [tx, BALL_R, tz], SPIN, opts);
      if (v) break;
    }
    if (!v) {
      // 退让：放宽到 ±0.14 的高度带（拍面高 0.35m、宽 0.3m，这点误差还在盘内）
      for (const tz of [-5.5, -4, -3]) {
        v = aimIntoCourt(FROM, [tx, BALL_R, tz], SPIN, {
          ...opts,
          arriveY: [y - 0.14, y + 0.14],
          arriveTol: 0.14,
        });
        if (v) break;
      }
    }
    if (!v) {
      feedFail++;
      if (process.env.DEBUG) console.log(`  喂球失败 aim=(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
      return null;
    }
    const ball = makeBall([...FROM], v, [...SPIN]);
    const c = crossAt(ball, z);
    if (c && c.t > 0.05) ball.v[0] += (x - c.x) / c.t;
    fed++;
    return ball;
  };

  let plan = null;
  for (let i = 0; i < frames; i++) {
    const now = 1000 + i * dt;

    const cfg = AUTO_MOVE_DEFAULTS;
    const planOff = MODE === 'contact' && learned ? learned : center;
    // 没球的那几帧不规划：拿一颗假球当输入会让规划器把目标拉到握点上，等于凭空
    // 插进一段「球员愣在原地」的静止，会把这些帧的握点高度也混进统计。
    if (ball) plan = planAutoMove(ball, { x: px, y: py, z: pz, center: planOff }, cfg);
    if (plan) {
      const tg = hold.resolve(plan, now);
      // 和 `app.ts` 同一个执行器（含高度两段）
      const next = stepAutoMove({ x: px, y: py, z: pz }, plan, tg, dt / 1000, cfg);
      px = next.x;
      py = next.y;
      pz = next.z;
    }
    gripYs.push(py);
    if (process.env.DEBUG && i % 60 === 0) console.log(`  i=${i} grip=(${px.toFixed(2)}, ${py.toFixed(2)}, ${pz.toFixed(2)}) planT=${plan ? plan.target.toFixed(2) : '-'}`);

    const base = [px, py, pz];
    const aim = [base[0] + planOff[0], base[1] + planOff[1], base[2] + planOff[2]];

    // 没球就喂一颗到瞄准点上
    if (!ball || !ball.live || ball.p[2] > aim[2] + 0.4) {
      ball = feed(aim[0], aim[1], aim[2]);
      counted = false;
      swung = false;
      if (!ball) continue;
    }

    // 挥拍：球快到瞄准平面时起势
    const tta = ball.v[2] > 0.5 ? (aim[2] - ball.p[2]) / ball.v[2] : Infinity;
    if (!swung && swingStart === null && tta > 0 && tta < 0.075) {
      swingStart = now;
      swung = true;
    }
    const u = swingStart === null ? -1 : (now - swingStart) / SWING_MS;
    if (swingStart !== null && u > 1.35) swingStart = null;
    const q = u < 0 ? Q : qmul(Q, quatAxis([1, 0, 0], swingDeg(u)));
    const spin = u < 0 ? 0 : PEAKW * Math.sin(Math.PI * Math.min(u, 1));

    const pos = rig.update(base, q, spin, dt / 1000, SWING_RIG_DEFAULTS);
    const pose = { t: now, pos, q };

    // 握法偏移估计：只在低角速度帧采信（和 `app.ts` 一致）
    const fc = faceCenter(pose);
    const want = [fc[0] - base[0], fc[1] - base[1], fc[2] - base[2]];
    if (prevQ) blendCenterOffset(prevQ, q, dt / 1000, want, center);
    prevQ = q;

    // 球推进一帧，同时逐子步查拍面（球一拍能走 70cm，按帧末位置判必隧穿）
    const zBefore = ball.p[2];
    segs = [];
    advance(
      ball,
      dt / 1000,
      () => {},
      (p0, p1) => {
        segs.push([p0, p1]);
      }
    );

    let touch = false;
    for (const [p0, p1] of segs) {
      const fh = sweepFace(pose, p0, p1);
      if (fh) {
        touch = true;
        break;
      }
    }

    // 「球穿过瞄准平面」= 这一拍该量的时刻
    const crossed = !counted && zBefore <= aim[2] && ball.p[2] > aim[2];
    if (crossed || touch) {
      counted = true;
      rows.push({
        kind: touch ? 'hit' : 'miss',
        ex: fc[0] - aim[0],
        ey: fc[1] - aim[1],
        ez: fc[2] - aim[2],
        // 真实拍面中心与球的距离（判断「差在哪个轴上」用）
        rbx: ball.p[0] - fc[0],
        rby: ball.p[1] - fc[1],
        rbz: ball.p[2] - fc[2],
        deg: u < 0 ? 0 : swingDeg(u),
        gripY: py,
      });
      // 学到「球到面那一刻」的偏移
      if (MODE === 'contact') {
        const k = learned ? 0.45 : 1;
        learned = learned
          ? [
              learned[0] + (want[0] - learned[0]) * k,
              learned[1] + (want[1] - learned[1]) * k,
              learned[2] + (want[2] - learned[2]) * k,
            ]
          : [...want];
      }
    }

    // 碰到就换一颗（球被拍面挡下来之后没必要再飞）
    if (touch) ball.live = false;
  }
  return { rows, gripYs, fed, feedFail };
}

const all = [];
const gys = [];
let fedTotal = 0;
let feedFailTotal = 0;
for (const seed of SEEDS) {
  const out = run(seed);
  all.push(...out.rows);
  gys.push(...out.gripYs);
  fedTotal += out.fed;
  feedFailTotal += out.feedFail;
}

const tally = {};
for (const r of all) tally[r.kind] = (tally[r.kind] ?? 0) + 1;

const mean = (a) => (a.length ? a.reduce((m, n) => m + n, 0) / a.length : 0);
const pct = (a, p) => {
  const s = [...a].sort((m, n) => m - n);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};
const mag = (rows) => rows.map((r) => Math.hypot(r.ex, r.ey, r.ez));

const hits = all.filter((r) => r.kind === 'hit');

console.log(`GRIP=${GRIP} MODE=${MODE} PEAKW=${PEAKW}  喂球 ${fedTotal}（解不出 ${feedFailTotal}）  结算 ${JSON.stringify(tally)}`);
console.log(
  `瞄准误差 |Δ| 均值 ${mean(mag(all)).toFixed(3)}m  p90 ${pct(mag(all), 0.9).toFixed(3)}m` +
    `  （x ${mean(all.map((r) => Math.abs(r.ex))).toFixed(3)} / y ${mean(all.map((r) => Math.abs(r.ey))).toFixed(3)} / z ${mean(all.map((r) => Math.abs(r.ez))).toFixed(3)}）`
);
if (hits.length) {
  console.log(
    `命中球：球心到拍面中心 均值 ${mean(hits.map((r) => Math.hypot(r.rbx, r.rby, r.rbz))).toFixed(3)}m` +
      `  转角均值 ${mean(hits.map((r) => r.deg)).toFixed(0)}°`
  );
}
console.log(
  `握点高度 均值 ${mean(gys).toFixed(2)}  范围 ${Math.min(...gys).toFixed(2)}–${Math.max(...gys).toFixed(2)}m` +
    `  ±0.05 以内占 ${((gys.filter((y) => Math.abs(y - mean(gys)) < 0.05).length / gys.length) * 100).toFixed(0)}%`
);
if (V) {
  for (const r of all.slice(0, 12)) {
    console.log(
      `  ${r.kind.padEnd(5)} Δ=(${r.ex.toFixed(2)},${r.ey.toFixed(2)},${r.ez.toFixed(2)})` +
        ` 球-拍=(${r.rbx.toFixed(2)},${r.rby.toFixed(2)},${r.rbz.toFixed(2)}) 转角${r.deg.toFixed(0)}° 握y${r.gripY.toFixed(2)}`
    );
  }
}
