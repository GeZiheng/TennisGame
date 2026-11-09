/**
 * 扫描「发球落地弹起再送到拍面」的可行域。
 *
 * 目标：落点在拍面前方 d 米，弹起后穿过拍面平面时高度 = targetY。
 * 这里直接网格扫 (vy, vz)，打印落点位置和弹起后到拍面的高度，
 * 先看清楚物理上哪些组合是可行的、以及「下降期到达」需要多大的 d。
 */
const { makeBall, advance } = require('../.tmp-sim/core/physics.js');
const { HIT_Z, PHYS_DT } = require('../.tmp-sim/core/court.js');

const Z0 = -11;
const Y0 = 1.4;
const targetZ = HIT_Z; // 0.3

/** 模拟一次发球，返回落点与弹起后到拍面的信息 */
function sim(vy, vz, targetY) {
  const b = makeBall([0, Y0, Z0], [0, vy, vz]);
  let firstGroundZ = null;
  let secondGround = false;
  let heightAtTarget = null;
  let vyAtTarget = null;
  let t = 0;

  for (let i = 0; i < 240 * 6; i++) {
    const zPrev = b.p[2];
    let ground = null;
    advance(b, PHYS_DT, (c) => {
      if (c.kind === 'ground') ground = c.at[2];
    });
    t += PHYS_DT;

    if (ground !== null) {
      if (firstGroundZ === null) firstGroundZ = ground;
      else secondGround = true;
    }
    if (firstGroundZ === null && b.p[2] >= targetZ) {
      // 没落地就已经到拍面了
      return { kind: 'flat', hitY: b.p[1], t };
    }
    if (firstGroundZ !== null && zPrev < targetZ && b.p[2] >= targetZ) {
      heightAtTarget = b.p[1];
      vyAtTarget = b.v[1];
      break;
    }
    if (secondGround) return { kind: 'dead', firstGroundZ, t };
    if (!b.live) break;
  }
  if (heightAtTarget === null) return { kind: 'short', firstGroundZ, t };
  return { kind: 'bounce', firstGroundZ, dropD: targetZ - firstGroundZ, hitY: heightAtTarget, vy: vyAtTarget, t };
}

const targetY = Number(process.argv[2] || 1.0);
console.log(`targetY=${targetY}m  targetZ=${targetZ}  发球点=(0,${Y0},${Z0})\n`);
console.log('  vy   vz | 首落点z  落点距拍面  弹起后到拍面高度  到时vy   状态');

const rows = [];
for (let vy = 0; vy <= 8.01; vy += 0.5) {
  for (let vz = 6; vz <= 14.01; vz += 0.5) {
    const r = sim(vy, vz, targetY);
    rows.push({ vy, vz, r });
  }
}

// 只打印「落地弹起」且高度接近 targetY 的，按落点距离排序
const ok = rows
  .filter((x) => x.r.kind === 'bounce' && Math.abs(x.r.hitY - targetY) < 0.35)
  .sort((a, b) => a.r.dropD - b.r.dropD);

for (const { vy, vz, r } of ok.slice(0, 40)) {
  console.log(
    `${vy.toFixed(1).padStart(4)} ${vz.toFixed(1).padStart(4)} | ` +
      `${r.firstGroundZ.toFixed(2).padStart(7)}  ${r.dropD.toFixed(2).padStart(9)}  ` +
      `${r.hitY.toFixed(2).padStart(16)}  ${r.vy.toFixed(1).padStart(6)}   ${r.vy < 0 ? '下降' : '上升'}`
  );
}
console.log(`\n共 ${ok.length} 个可行组合（高度误差 < 0.35m）`);

// 按落点距离分组，看每组的可达高度范围
const buckets = new Map();
for (const { vy, vz, r } of rows) {
  if (r.kind !== 'bounce') continue;
  const k = (Math.round(r.dropD * 2) / 2).toFixed(1);
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push({ vy, vz, hitY: r.hitY, vyAt: r.vy });
}
console.log('\n落点距拍面  可达高度区间   组合数   其中「下降期到达」的组合');
for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
  const arr = buckets.get(k);
  const hs = arr.map((x) => x.hitY);
  const desc = arr.filter((x) => x.vyAt < 0 && x.hitY > 0.7 && x.hitY < 1.9);
  console.log(
    `${k.padStart(10)}  ${Math.min(...hs).toFixed(2)}–${Math.max(...hs).toFixed(2)}`.padEnd(34) +
      `${String(arr.length).padStart(5)}`.padEnd(9) +
      (desc.length ? `${desc.length} 个（vy=${desc[0].vy.toFixed(1)} vz=${desc[0].vz.toFixed(1)} → 高 ${desc[0].hitY.toFixed(2)}）` : '—')
  );
}
