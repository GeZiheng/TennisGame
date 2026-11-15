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
 * 来球来自**真对局**（`Duel` + 回球机），不是合成弹道：探针量的是走位，而走位
 * 面对的散布、弹跳、深浅全都来自对面那台机器。11-15 删掉对墙打之前这里借的是
 * `Rally` 的喂球；现在直接跑对局，玩家一侧永远接发球（见 `lib/probe-player.cjs`）。
 *
 * 依赖 `.tmp-duel`（先跑 `npm run core`）。
 */
const { Duel } = require('../.tmp-duel/core/duel.js');
const { HIT_Z, RACKET_POS, FACE_CY } = require('../.tmp-duel/core/court.js');
const { planAutoMove, stepAutoMove, AUTO_MOVE_DEFAULTS, TargetHold } = require('../.tmp-duel/core/auto-move.js');
const { vrot } = require('../.tmp-duel/core/vec.js');
const { ProbePlayer, poseAt } = require('./lib/probe-player.cjs');

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
  const rng = makeRng(seed);
  Math.random = rng;
  const duel = new Duel();
  duel.reset(1000);
  const player = new ProbePlayer(rng);
  const now0 = 1000;
  const frames = Math.round((SECONDS * 1000) / dt);

  let px = 0;
  let py = RACKET_POS[1];
  let pz = HIT_Z;
  let cur = null;
  const balls = [];
  const hold = new TargetHold();
  /** 上一帧是不是「这颗球还在飞」。用来切球。 */
  let wasIncoming = false;

  try {
    for (let i = 0; i < frames; i++) {
      const now = now0 + i * dt;
      const incoming = duel.phase === 'live' && duel.receiver === 'player';
      if (incoming && !wasIncoming) {
        cur = { frames: [], out: null };
        balls.push(cur);
      }
      wasIncoming = incoming;

      const cfg = AUTO_MOVE_DEFAULTS;
      const plan = planAutoMove(duel.ball, { x: px, y: py, z: pz, center: CTR }, cfg);
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
          ballZ: duel.ball.p[2], ballY: duel.ball.p[1],
          tz: tg.z, chasing: plan.chasing,
        });
      }
      px = nx;
      py = ny;
      pz = nz;

      const grip = { x: px, y: py, z: pz };
      const pose = poseAt(now, grip, Q);
      duel.pushRacket(pose);
      const stroke = player.maybeSwing(duel, now, grip);
      if (stroke) duel.submit(stroke);

      for (const e of duel.update(dt / 1000, now)) {
        if (!cur) continue;
        if (e.kind === 'hit' && e.by === 'player' && !cur.out) cur.out = 'hit';
        else if (e.kind === 'miss' && !cur.out) cur.out = e.reason;
        else if (e.kind === 'net' && e.by === 'player' && !cur.out) cur.out = 'net';
        else if (e.kind === 'out' && e.by === 'player' && !cur.out) cur.out = 'out';
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

  /**
   * 反向次数 = 相邻几帧内方向翻过来。
   *
   * `GAP` 这一条不是宽容，是**定义**：抖动是 60Hz 的来回（相邻帧就翻），而
   * 「蹲下去接低球 → 球过去了 → 停 250ms → 起身回中立位」也会在同一个轴上先负后正，
   * 中间隔着十几帧零位移（`TargetHold.settleMs`）。不卡间隔的话，每一次命中低球
   * 都会被记成一次「抖动」——那是动作，不是抖动。
   */
  const GAP = 3;
  const rev = (key) => {
    let last = 0;
    let lastAt = -99;
    let cnt = 0;
    for (let i = 0; i < seg.length; i++) {
      const v = seg[i][key];
      if (Math.abs(v) < 1e-4) continue;
      const s = Math.sign(v);
      if (last && s !== last && i - lastAt <= GAP) cnt++;
      last = s;
      lastAt = i;
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
{
  // 期望值不要写死：跑速来自 `AUTO_MOVE_DEFAULTS`，一帧的最大步长就是 speed×dt。
  // 写死成 4.8 的话，11-15 把跑速提到 5.4 之后这个读数的参照系就悄悄错了。
  const perFrame = AUTO_MOVE_DEFAULTS.speed / 60;
  console.log(
    `单帧最大位移: ${worstJump.toFixed(3)}m（横移 ${AUTO_MOVE_DEFAULTS.speed} m/s 一帧 ${perFrame.toFixed(2)}m，` +
      `${(perFrame * 1.5).toFixed(2)} 以内是正常速度）`
  );
}

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
