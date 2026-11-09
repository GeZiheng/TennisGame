const { feedBounce, makeBall, advance } = require('../.tmp-sim/core/physics.js');
const { HIT_Z } = require('../.tmp-sim/core/court.js');

function measure(v, faceZ) {
  const b = makeBall([0, 1.4, -11], v);
  let after = false, tB = 0, t = 0, vFace = null;
  for (let i = 0; i < 240 * 8; i++) {
    t += 1 / 240;
    const zPrev = b.p[2];
    advance(b, 1 / 240, (c) => { if (c.kind === 'ground' && !after) { after = true; tB = t; } });
    if (after && zPrev < faceZ && b.p[2] >= faceZ) return { tFace: t, tBounce: tB, vFace: [...b.v] };
  }
  return null;
}

for (const fy of [1.0, 1.2, 1.4, 1.6, 1.8]) {
  console.log(`\n拍面高 ${fy.toFixed(1)}m`);
  console.log('  落点距拍面 | 落点z | 弹起→到面 | 到面vz | 到面vy | 顶点y@拍面后 | 全程');
  for (let d = 1.0; d <= 3.0001; d += 0.2) {
    const r = feedBounce([0, 1.4, -11], HIT_Z, fy, d, 0);
    if (!r) { console.log(`${d.toFixed(1).padStart(11)}m | 无解`); continue; }
    const m = measure(r.v, HIT_Z);
    if (!m) { console.log(`${d.toFixed(1).padStart(11)}m | 测量失败`); continue; }
    // 顶点用 feedBounce 自己算的（它会多跑一段到 v[1] < 0），不是「到拍面那一刻」
    const apexBack = r.apex[2] - HIT_Z;
    console.log(
      `${d.toFixed(1).padStart(11)}m | ${r.dropZ.toFixed(2).padStart(6)} | ${(m.tFace - m.tBounce).toFixed(2)}s | ${m.vFace[2].toFixed(1).padStart(6)} | ${m.vFace[1].toFixed(2).padStart(6)} | ${r.apex[1].toFixed(2)}@${apexBack >= 0 ? '+' : ''}${apexBack.toFixed(2)} | ${m.tFace.toFixed(2)}s`
    );
  }
}
