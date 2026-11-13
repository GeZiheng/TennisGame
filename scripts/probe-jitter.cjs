/**
 * 走位抖动探针：复刻 `app.ts` 的 `updatePlayer`（`planAutoMove` → `TargetHold` → `stepAxis`），
 * 逐帧记握点与目标，量「球到面前 300ms」里人到底在不在抖。
 *
 * 为什么需要它：抖动不是渲染问题，是**规划器每帧重新选平面**的结果——相邻两条候选
 * 弹道平面的代价只差千分之几，排序每帧翻一次，`targetZ` 就在 0.30 / 0.36 之间跳，
 * `stepAxis` 按满速走 6cm 再走回来。单测能钉住 `TargetHold` 的判据，但「一整局下来
 * 还会不会抖」只有整局跑一遍才看得见（`docs/history.md` 4.22）。
 *
 *   node scripts/probe-jitter.cjs            # 斜握 14°
 *   GRIP=horiz node scripts/probe-jitter.cjs # 横握（历史上抖得最狠的那一种）
 *   V=1 node scripts/probe-jitter.cjs        # 逐球打印反向次数
 *
 * 判据：每球「反向次数」应该接近 0。修之前斜握 1.6 / 横握 5.9 / 竖握 2.1 次。
 *
 * 依赖 `.tmp-sim`（先跑 `npm run sim`）。
 */
const { Rally } = require('../.tmp-sim/core/rally.js');
const { HIT_Z, RACKET_POS, FACE_CY } = require('../.tmp-sim/core/court.js');
const { planAutoMove, stepAutoMove, AUTO_MOVE_DEFAULTS, TargetHold } = require('../.tmp-sim/core/auto-move.js');
const { vrot } = require('../.tmp-sim/core/vec.js');

const GRIP = process.env.GRIP ?? 'tilt';
const SECONDS = Number(process.env.SECONDS ?? 40);
const VERBOSE = process.env.V === '1';
const SEEDS = [11, 222, 3333];

function racketQuat(thetaDeg) {
  const half = (thetaDeg * Math.PI) / 360;
  return [0, Math.cos(half), Math.sin(half), 0];
}
const Q =
  GRIP === 'vert' ? [0, 0, 0, 1]
  : GRIP === 'horiz' ? [0, 0, Math.SQRT1_2, Math.SQRT1_2]
  : racketQuat(14);
const CTR = vrot(Q, [0, FACE_CY, 0]);

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const dt = 1000 / 60;

function run(seed) {
  const realRandom = Math.random;
  Math.random = makeRng(seed);
  const r = new Rally();
  const now0 = 1000;
  const frames = Math.round((SECONDS * 1000) / dt);

  let px = 0;
  let py = RACKET_POS[1];
  let pz = HIT_Z;
  let swingStart = null;
  let cur = null;
  const balls = [];
  const hold = new TargetHold();

  try {
    for (let i = 0; i < frames; i++) {
      const now = now0 + i * dt;
      if (r.phase === 'incoming' && (!cur || cur.out)) {
        cur = { frames: [], out: null };
        balls.push(cur);
      }

      const cfg = AUTO_MOVE_DEFAULTS;
      const plan = planAutoMove(r.ball, { x: px, y: py, z: pz, center: CTR }, cfg);
      const tg = hold.resolve(plan, now);
      // 和 `app.ts` 同一个执行器（`stepAutoMove`），不要再抄一份限速 / 高度逻辑
      const next = stepAutoMove({ x: px, y: py, z: pz }, plan, tg, dt / 1000, cfg);
      const nx = next.x;
      const ny = next.y;
      const nz = next.z;

      if (cur) {
        cur.frames.push({
          i, x: nx, y: ny, z: nz,
          dx: nx - px, dy: ny - py, dz: nz - pz,
          ballZ: r.ball.p[2], ballY: r.ball.p[1],
          tz: tg.z, chasing: plan.chasing,
        });
      }
      px = nx;
      py = ny;
      pz = nz;

      const faceZ = pz + CTR[2];
      const tta = r.ball.v[2] > 0.5 ? (faceZ - r.ball.p[2]) / r.ball.v[2] : Infinity;
      if (r.phase === 'incoming' && swingStart === null && tta > 0 && tta < 0.075) swingStart = now;
      if (swingStart !== null && now - swingStart > 210) swingStart = null;

      r.pushRacket({ t: now, pos: [px, py, pz], q: Q });
      if (swingStart !== null && now - swingStart <= 210 && r.phase === 'incoming') {
        r.submit({ t: now, peakW: 12, head: [0, 2.5, -22], speed: 22, face: [0, 0.2, -0.98], grip: [0, 1, 0], charge: 0.6, used: false });
      }
      for (const e of r.update(dt / 1000, now)) {
        if (!cur) continue;
        if (e.kind === 'hit' && !cur.out) cur.out = 'hit';
        else if (e.kind === 'miss' && !cur.out) cur.out = e.reason;
        else if (e.kind === 'net' && !cur.out) cur.out = 'net';
      }
    }
  } finally {
    Math.random = realRandom;
  }
  return balls;
}

const all = [];
for (const seed of SEEDS) all.push(...run(seed));

const tally = {};
for (const b of all) tally[b.out ?? 'pending'] = (tally[b.out ?? 'pending'] ?? 0) + 1;

let n = 0;
let sx = 0;
let sy = 0;
let sz = 0;
let worstJump = 0;
let worst = null;

for (const b of all) {
  if (!b.out) continue;
  // 球穿过拍面所在平面的那一帧：|ballZ - faceZ| 最小的那一帧
  let idx = -1;
  let best = Infinity;
  for (let i = Math.max(0, b.frames.length - 60); i < b.frames.length; i++) {
    const d = Math.abs(b.frames[i].ballZ - (b.frames[i].z + CTR[2]));
    if (d < best) { best = d; idx = i; }
  }
  if (idx < 0) continue;
  // 到面前 18 帧（300ms）+ 击球后 5 帧（随挥那一段）
  const seg = b.frames.slice(Math.max(0, idx - 17), Math.min(b.frames.length, idx + 6));
  if (seg.length < 4) continue;

  const rev = (key) => {
    let last = 0;
    let cnt = 0;
    for (const f of seg) {
      if (Math.abs(f[key]) < 1e-4) continue;
      const s = Math.sign(f[key]);
      if (last && s !== last) cnt++;
      last = s;
    }
    return cnt;
  };
  const rx = rev('dx');
  const ry = rev('dy');
  const rz = rev('dz');
  const jump = Math.max(...seg.map((f) => Math.hypot(f.dx, f.dy, f.dz)));
  worstJump = Math.max(worstJump, jump);
  n++;
  sx += rx;
  sy += ry;
  sz += rz;
  if (VERBOSE) console.log(`  ${(b.out ?? '?').padEnd(6)} 反向 x${rx} y${ry} z${rz}  单帧最大 ${jump.toFixed(3)}m`);
  if (!worst || rz > worst.rz) worst = { b, seg, rx, ry, rz, jump };
}

console.log(`\nGRIP=${GRIP}  结算 ${JSON.stringify(tally)}  样本 ${n} 球（每球取到面前 300ms + 击球后 5 帧）`);
if (!n) process.exit(1);
console.log(`平均反向次数/球: x ${(sx / n).toFixed(2)}  y ${(sy / n).toFixed(2)}  z ${(sz / n).toFixed(2)}`);
console.log(`单帧最大位移: ${worstJump.toFixed(3)}m（横移 4.8 m/s 一帧 0.08m，0.12 以内是正常速度）`);

if (worst && worst.rz > 0) {
  console.log(`\n抖得最狠的一球（前后反向 ${worst.rz} 次）：`);
  console.log('  i     ballZ  ballY   gripY  gripZ    dY     dZ    targetZ chasing');
  for (const f of worst.seg) {
    console.log(
      `  ${String(f.i).padStart(3)}  ${f.ballZ.toFixed(2).padStart(6)} ${f.ballY.toFixed(2).padStart(6)}  ` +
        `${f.y.toFixed(2).padStart(6)} ${f.z.toFixed(2).padStart(6)}  ` +
        `${f.dy.toFixed(3).padStart(6)} ${f.dz.toFixed(3).padStart(6)}  ${f.tz.toFixed(2).padStart(7)}  ${f.chasing}`
    );
  }
}
