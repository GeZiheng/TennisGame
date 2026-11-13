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
 * 挥拍是真的在转（绕局部 x 轴，和 `sim-e2e.cjs` 一样），逐球记：
 *
 *   - **瞄准误差**：击球那一刻，真实拍面中心离「瞄准点」多远（x/y/z 分量）
 *   - 结算（hit / reach / net）与握点高度分布
 *
 * ## 用法
 *
 *   node scripts/probe-contact.cjs                 # 老的：瞄挥拍前的拍面
 *   MODE=contact node scripts/probe-contact.cjs    # 瞄「上一拍击球那一刻的拍面」
 *   GRIP=vert|tilt|horiz node scripts/probe-contact.cjs
 *   PEAKW=25 node scripts/probe-contact.cjs        # 挥拍峰值角速度
 *
 * 依赖 `.tmp-sim`（先跑 `npm run sim`）。
 */
const { Rally } = require('../.tmp-sim/core/rally.js');
const { HIT_Z, RACKET_POS, FACE_CY } = require('../.tmp-sim/core/court.js');
const {
  planAutoMove,
  stepAutoMove,
  blendCenterOffset,
  AUTO_MOVE_DEFAULTS,
  TargetHold,
} = require('../.tmp-sim/core/auto-move.js');
const { faceCenter } = require('../.tmp-sim/core/racket.js');
const { SwingRig, SWING_RIG_DEFAULTS } = require('../.tmp-sim/core/swing-rig.js');

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

const dt = 1000 / 60;

function run(seed) {
  const realRandom = Math.random;
  Math.random = makeRng(seed);
  const r = new Rally();
  const rig = new SwingRig();
  const hold = new TargetHold();
  const frames = Math.round((SECONDS * 1000) / dt);

  let px = 0;
  let py = RACKET_POS[1];
  let pz = HIT_Z;
  let prevQ = null;
  const center = [0, FACE_CY, 0];
  let learned = null;

  let swingStart = null;
  let swung = false;
  const rows = [];
  const gripYs = [];

  try {
    for (let i = 0; i < frames; i++) {
      const now = 1000 + i * dt;
      if (r.phase === 'outgoing' || r.phase === 'dead') swung = false;

      const cfg = AUTO_MOVE_DEFAULTS;
      const planOff = MODE === 'contact' && learned ? learned : center;
      const plan = planAutoMove(r.ball, { x: px, y: py, z: pz, center: planOff }, cfg);
      const tg = hold.resolve(plan, now);
      // 和 `app.ts` 同一个执行器（含高度两段）
      const next = stepAutoMove({ x: px, y: py, z: pz }, plan, tg, dt / 1000, cfg);
      px = next.x;
      py = next.y;
      pz = next.z;
      gripYs.push(py);

      // 挥拍：球快到（瞄准的）拍面平面时起势
      const base = [px, py, pz];
      const faceZRef = pz + planOff[2];
      const tta = r.ball.v[2] > 0.5 ? (faceZRef - r.ball.p[2]) / r.ball.v[2] : Infinity;
      if (!swung && swingStart === null && r.phase === 'incoming' && tta > 0 && tta < 0.075) {
        swingStart = now;
        swung = true;
      }
      const u = swingStart === null ? -1 : (now - swingStart) / SWING_MS;
      if (swingStart !== null && u > 1.35) swingStart = null;
      const q = u < 0 ? Q : qmul(Q, quatAxis([1, 0, 0], swingDeg(u)));
      const spin = u < 0 ? 0 : PEAKW * Math.sin(Math.PI * Math.min(u, 1));

      const pos = rig.update(base, q, spin, dt / 1000, SWING_RIG_DEFAULTS);

      // 握法偏移估计：只在低角速度帧采信（和 `app.ts` 一致）
      const fc = faceCenter({ t: now, pos, q });
      const want = [fc[0] - base[0], fc[1] - base[1], fc[2] - base[2]];
      if (prevQ) blendCenterOffset(prevQ, q, dt / 1000, want, center);
      prevQ = q;

      // 喂球瞄准：MODE=contact 时和走位用同一份偏移（否则每球会差一个常量，见 docs）
      if (MODE === 'contact') r.setFaceAimOffset?.(learned ?? center);

      const aim = [base[0] + planOff[0], base[1] + planOff[1], base[2] + planOff[2]];

      r.pushRacket({ t: now, pos, q });
      if (u >= 0 && u <= 1 && r.phase === 'incoming') {
        r.submit({
          t: now, peakW: PEAKW, head: [0, 2.5, -22], speed: 22,
          face: [0, 0.2, -0.98], grip: [0, 1, 0], charge: 0.6, used: false,
        });
      }
      for (const e of r.update(dt / 1000, now)) {
        if (e.kind !== 'hit' && e.kind !== 'miss' && e.kind !== 'net') continue;
        const bp = r.ball.p;
        rows.push({
          kind: e.kind,
          ex: fc[0] - aim[0],
          ey: fc[1] - aim[1],
          ez: fc[2] - aim[2],
          // 真实拍面中心与球的距离（判断「差在哪个轴上」用）
          rbx: bp[0] - fc[0],
          rby: bp[1] - fc[1],
          rbz: bp[2] - fc[2],
          deg: u < 0 ? 0 : swingDeg(u),
          gripY: py,
        });
        // 学到「击球那一刻」的偏移
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
    }
  } finally {
    Math.random = realRandom;
  }
  return { rows, gripYs };
}

const all = [];
const gys = [];
for (const seed of SEEDS) {
  const out = run(seed);
  all.push(...out.rows);
  gys.push(...out.gripYs);
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

console.log(`GRIP=${GRIP} MODE=${MODE} PEAKW=${PEAKW}  结算 ${JSON.stringify(tally)}`);
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
      `  ${r.kind.padEnd(5)} Δ=(${r.ex.toFixed(2)},${r.ey.toFixed(2)},${r.ez.toFixed(2)}) 转角${r.deg.toFixed(0)}° 握y${r.gripY.toFixed(2)}`
    );
  }
}
