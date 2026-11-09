/**
 * 「落地弹起再送到拍面」的单参数求解原型。
 *
 * 参数化用一个东西：**发球飞行时间 t**（从发球点到第一次落地）。
 *   - t 小 = 平送快攻，入射角浅，弹起低
 *   - t 大 = 慢高吊，入射角陡，弹起高
 * 落点固定为「拍面前方 dropDist 米」，所以 t 一定，vy/vz 就定了
 * （无阻力估算 + 数值修正）。回球高度随 t 严格单调增 → 二分 t 即可。
 *
 * 这样不需要二维搜索：一次求解约 20 次模拟，比网格便宜两个数量级。
 */
const { makeBall, advance } = require('../.tmp-sim/core/physics.js');
const { HIT_Z, BALL_R, PHYS_DT } = require('../.tmp-sim/core/court.js');

const Z0 = -11;
const Y0 = 1.4;

/** 第一次落地的 z（没有落地返回 null） */
function firstDrop(vy, vz) {
  const b = makeBall([0, Y0, Z0], [0, vy, vz]);
  for (let i = 0; i < 240 * 5; i++) {
    let g = null;
    advance(b, PHYS_DT, (c) => {
      if (c.kind === 'ground') g = c.at[2];
    });
    if (g !== null) return g;
    if (!b.live) break;
  }
  return null;
}

/** 弹起后穿过 targetZ 的高度 + 到时 vy；失败返回 null */
function bounceHeight(vy, vz, targetZ) {
  const b = makeBall([0, Y0, Z0], [0, vy, vz]);
  let dropped = false;
  let grounds = 0;
  for (let i = 0; i < 240 * 6; i++) {
    const zPrev = b.p[2];
    advance(b, PHYS_DT, (c) => {
      if (c.kind === 'ground') grounds++;
    });
    if (grounds > 0) dropped = true;
    if (dropped && grounds >= 2) return null; // 二次落地，球没送到
    if (dropped && zPrev < targetZ && b.p[2] >= targetZ) return { y: b.p[1], v: b.v[1] };
    if (!dropped && b.p[2] >= targetZ) return { y: -999, v: b.v[1] }; // 没落地就到了，不算弹地
    if (!b.live) break;
  }
  return null;
}

/** 给定飞行时间 t 与落点，解出 (vy, vz) —— 无阻力估算 + 落点修正 */
function shoot(t, dropZ) {
  const dist = dropZ - Z0;
  let vy = (BALL_R - Y0 + 0.5 * 9.80665 * t * t) / t;
  let vz = dist / t;
  for (let k = 0; k < 4; k++) {
    const d = firstDrop(vy, vz);
    if (d === null) break;
    const err = dropZ - d; // 落点偏近 → 需要更大 vz
    if (Math.abs(err) < 0.01) break;
    vz += err / t;
  }
  return { vy, vz };
}

/** 解发球：落点 = targetZ - dropDist，弹起后到 targetZ 高度 = targetY */
function solve(targetZ, targetY, dropDist) {
  const dropZ = targetZ - dropDist;
  const evalT = (t) => {
    const { vy, vz } = shoot(t, dropZ);
    const h = bounceHeight(vy, vz, targetZ);
    return { vy, vz, h };
  };
  let lo = 0.45;
  let hi = 2.0;
  const hLo = evalT(lo).h;
  const hHi = evalT(hi).h;
  // 单调性自检
  const sample = [];
  for (let i = 0; i <= 6; i++) {
    const t = lo + ((hi - lo) * i) / 6;
    const e = evalT(t);
    sample.push(`${t.toFixed(2)}s→${e.h ? e.h.y.toFixed(2) : '—'}${e.h && e.h.v < 0 ? '↓' : '↑'}`);
  }
  if (!hLo || !hHi) return { fail: 'bounds', sample };
  let a = lo;
  let b = hi;
  for (let i = 0; i < 18; i++) {
    const mid = (a + b) / 2;
    const e = evalT(mid);
    if (!e.h || e.h.y < targetY) a = mid;
    else b = mid;
  }
  const t = (a + b) / 2;
  const e = evalT(t);
  return { ...e, t, dropZ, sample };
}

console.log('== 单参数（飞行时间 t）求解自检 ==');
for (const targetY of [0.9, 1.0, 1.2, 1.4, 1.6]) {
  for (const dropDist of [2.4, 2.8, 3.2]) {
    const r = solve(HIT_Z, targetY, dropDist);
    if (r.fail) {
      console.log(`目标高${targetY} 落点前${dropDist}m → 无解 (${r.fail})  单调性: ${r.sample.join(' ')}`);
      continue;
    }
    const dir = r.h.v < -0.2 ? '下降' : r.h.v > 0.2 ? '上升' : '顶点';
    console.log(
      `目标高${targetY} 落点前${dropDist}m → t=${r.t.toFixed(2)}s vy=${r.vy.toFixed(2)} vz=${r.vz.toFixed(2)} ` +
        `落点z=${r.dropZ.toFixed(2)} 到拍面高=${r.h.y.toFixed(2)} vy=${r.h.v.toFixed(1)} ${dir}` +
        (Math.abs(r.h.y - targetY) > 0.08 ? '  ⚠误差大' : '')
    );
  }
}

console.log('\n== 单调性样本（targetY=1.0, dropDist=2.8）==');
const s = solve(HIT_Z, 1.0, 2.8);
console.log(s.sample.join('  '));
