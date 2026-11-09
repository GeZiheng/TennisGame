/**
 * 诊断：玩家走开以后还打不打得到球。
 *
 * 三个阶段各 10 秒，唯一的差别是站位策略：
 *   A 原地不动（球拍 x 恒为 0）
 *   B 自动追球（玩家朝球的预测落点跑）
 *   C 走到 x=2.0 站定（正常玩家的「走位」：走了就不回来了）
 *
 * 挥拍时机三个阶段完全一样（按球到拍面的时间提前 75ms 起势），
 * 所以命中差异只能来自站位。
 */
const { SwingDetector } = require('../.tmp-sim/core/swing.js');
const { Rally } = require('../.tmp-sim/core/rally.js');
const { HIT_Z, RACKET_POS } = require('../.tmp-sim/core/court.js');
const { makeBall, advance } = require('../.tmp-sim/core/physics.js');

/**
 * 「球还有多久到拍面」：拿物理往前推。来球会先落地再弹起，
 * 按当前速度外推会提前一秒起势（见 sim-e2e.cjs 里的同名函数）。
 */
function predictReach(ball, faceZ) {
  const b = makeBall(ball.p, ball.v, ball.spin);
  b.bounces = ball.bounces;
  b.wallHits = ball.wallHits;
  let zPrev = b.p[2];
  let t = 0;
  for (let i = 0; i < 240 * 3; i++) {
    advance(b, 1 / 240, () => {});
    t += 1 / 240;
    if (zPrev < faceZ && b.p[2] >= faceZ) return t;
    if (!b.live) return null;
    zPrev = b.p[2];
  }
  return null;
}

const SWING_MS = 150;
const RESAMPLE = 2;
const SPEED = 4.2;

function racketQuat(thetaDeg) {
  const half = (thetaDeg * Math.PI) / 360;
  return [0, Math.cos(half), Math.sin(half), 0];
}

function run(label, placeX, placeZ = HIT_Z) {
  const r = new Rally();
  const det = new SwingDetector();
  const dt = 1000 / 60;
  const now0 = 1000;
  const Q = racketQuat(18);

  let swingStart = null, hasSwung = false, held = 0.4, frame = 0;
  let racketX = 0;
  const stats = { hits: 0, misses: 0, nets: 0, serves: 0, ends: 0, swings: 0, missTrace: [] };
  // 前 4 秒只走位不统计：真实玩家是「先走到位，球再发过来」，
  // 把「走到一半球已经在路上」算成漏接会把结论带偏。
  const WARMUP = 60 * 4;

  for (let i = 0; i < 60 * 10; i++) {
    const now = now0 + i * dt;
    if (r.phase === 'outgoing' || r.phase === 'dead') hasSwung = false;

    if (!hasSwung && swingStart === null && r.phase === 'incoming' && r.ball.v[2] > 0) {
      // 以「拍面实际所在的平面」预测到面时刻，不是固定的 HIT_Z——
      // 拍子倾斜 18° 时拍心在握点前方 18cm，前后走位之后这个差还要跟着人走。
      const faceZ = placeZ + 0.6 * Math.sin((18 * Math.PI) / 180);
      const reach = predictReach(r.ball, faceZ);
      if (reach !== null && reach > 0 && reach < 0.55) {
        swingStart = now + Math.max(0, reach * 1000 - SWING_MS / 2);
        hasSwung = true;
      }
    }

    if (frame % RESAMPLE === 0) {
      if (swingStart === null) held = 0.4;
      else {
        const u = (now - swingStart) / SWING_MS;
        held = u <= 0 || u >= 1 ? 0.4 : 8 * Math.sin(Math.PI * u);
      }
    }
    frame++;
    if (swingStart !== null && now - swingStart > SWING_MS + 60) {
      swingStart = null;
      hasSwung = false;
    }

    // 站位
    if (placeX === 'track' && r.ball.v[2] > 0.5) {
      const tReach = (HIT_Z - r.ball.p[2]) / r.ball.v[2];
      const aim = Math.max(-3, Math.min(3, r.ball.p[0] + r.ball.v[0] * Math.min(Math.max(tReach, 0), 2)));
      const step = SPEED * (dt / 1000);
      racketX += Math.max(-step, Math.min(step, aim - racketX));
    } else if (typeof placeX === 'number') {
      const step = SPEED * (dt / 1000);
      racketX += Math.max(-step, Math.min(step, placeX - racketX));
    }

    r.pushRacket({ t: now, pos: [racketX, RACKET_POS[1], placeZ], q: Q });
    const s = det.push({ t: now, omega: [held, 0, 0], q: Q });
    if (s) { stats.swings++; r.submit(s); }

    for (const e of r.update(dt / 1000, now)) {
      if (i < WARMUP) continue;
      if (e.kind === 'hit') stats.hits++;
      else if (e.kind === 'miss') {
        stats.misses++;
        if (stats.missTrace.length < 3)
          stats.missTrace.push(`${e.reason} 球=(${r.ball.p.map((v) => v.toFixed(2)).join(',')}) 拍x=${racketX.toFixed(2)}`);
      } else if (e.kind === 'net') stats.nets++;
      else if (e.kind === 'serve') stats.serves++;
      else if (e.kind === 'end') stats.ends++;
    }
  }
  console.log(
    `${label.padEnd(22)} 发球${String(stats.serves).padStart(2)} 挥拍${String(stats.swings).padStart(3)} ` +
      `击球${String(stats.hits).padStart(2)} 漏接${stats.misses} 撞网${stats.nets}`
  );
  if (stats.missTrace.length) console.log(`  ${stats.missTrace.join('\n  ')}`);
  return stats;
}

console.log('站位对命中率的影响（三阶段各 10 秒，挥拍时机相同）\n');
run('A 原地不动 x=0', 0);
run('B 自动追球', 'track');
run('C 走开站定 x=2.0', 2.0);
run('D 走开站定 x=-2.0', -2.0);
run('E 前压 z-0.55', 0, HIT_Z - 0.55);
run('F 后退 z+1.35', 0, HIT_Z + 1.35);
