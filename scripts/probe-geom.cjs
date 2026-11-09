/**
 * 几何诊断：把「球到达拍面时的高度」「回球落点」这些决定手感的数字打出来。
 *
 * 用法：node scripts/sim.mjs && node scripts/probe-geom.cjs
 * （sim.mjs 负责把 core 编译成 .tmp-sim，probe 直接读编译产物）
 *
 * 回答三个问题：
 *   1. 喂球到达击球区时是多高？和各种握法的拍面中心差多少？
 *   2. 这个高度上玩家还有多少反应时间？
 *   3. 回球落在网后多远？球能不能自己飞回来？
 */
const { advance, makeBall, liftOverNet, feedVy } = require('../.tmp-sim/core/physics.js');
const court = require('../.tmp-sim/core/court.js');

const { RACKET_POS, HIT_Z, FACE_CY, NET_Z, WALL_Z, BALL_R } = court;

/** 让球从发球位飞到 z=zStop，报告途中状态 */
function flyServe(y0, vy, vz, zStop, label) {
  const b = makeBall([0, y0, -11.0], [0, vy, vz]);
  let t = 0;
  let at = null;
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 3; i++) {
    const p0 = [...b.p];
    advance(b, dt, () => {});
    t += dt;
    if (p0[2] < zStop && b.p[2] >= zStop) {
      const k = (zStop - p0[2]) / (b.p[2] - p0[2]);
      at = { y: p0[1] + (b.p[1] - p0[1]) * k, vy: b.v[1], vz: b.v[2], t };
      break;
    }
    if (b.p[1] < BALL_R) break;
  }
  if (!at) {
    console.log(`  ${label}: 没能飞到 z=${zStop}`);
    return null;
  }
  console.log(
    `  ${label}: z=${zStop} 时 y=${at.y.toFixed(2)}m  下降 ${(-at.vy).toFixed(1)}m/s  ` +
      `水平 ${at.vz.toFixed(1)}m/s  用时 ${at.t.toFixed(2)}s`
  );
  return at;
}

/** 一次回球：从击球点出发，过网、（可落地）、撞墙、弹回，报告落点和回球高度 */
function flyReturn(fromY, speed, thetaDeg, spin = [0, 0, 0]) {
  const th = (thetaDeg * Math.PI) / 180;
  const v0 = [0, Math.sin(th) * speed, -Math.cos(th) * speed];
  const p0 = [0, fromY, HIT_Z];
  const v = liftOverNet(p0, v0, spin, HIT_Z, RACKET_POS[1] + FACE_CY);
  const b = makeBall(p0, v, spin);

  let firstLandZ = null; // 网后第一落点
  let wallY = null;
  let backY = null;
  let netOk = true;
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 8; i++) {
    advance(b, dt, (c) => {
      if (c.kind === 'net') netOk = false;
      if (c.kind === 'wall') wallY = c.at[1];
      if (c.kind === 'ground' && firstLandZ === null && b.p[2] < NET_Z) firstLandZ = c.at[2];
    });
    if (wallY !== null && b.p[2] >= HIT_Z && backY === null) backY = b.p[1];
    if (wallY !== null && backY !== null) break;
    if (b.p[2] > HIT_Z + 2) break;
  }
  const depth = firstLandZ === null ? '不落地（直撞墙）' : `网后 ${(firstLandZ - NET_Z).toFixed(1)}m`;
  console.log(
    `  出球 ${speed}m/s@${thetaDeg}° → 补偿后 vy=${v[1].toFixed(1)} | 落点 ${depth} | ` +
      `撞墙 ${wallY === null ? '—' : wallY.toFixed(2) + 'm'} | 回到手边 ${backY === null ? '—' : backY.toFixed(2) + 'm'} | ${netOk ? '' : '撞网!'}`
  );
}

console.log('== 拍面高度参照（握点 %.2fm）==', RACKET_POS[1]);
console.log(`  横握（屏幕朝上，拍面水平）: 拍面中心 y=${RACKET_POS[1].toFixed(2)}m`);
for (const deg of [10, 20, 30, 65]) {
  const th = (deg * Math.PI) / 180;
  console.log(`  斜握 ${deg}°: 拍面中心 y=${(RACKET_POS[1] + FACE_CY * Math.cos(th)).toFixed(2)}m`);
}
console.log(`  竖握（屏幕朝球网）: 拍面中心 y=${(RACKET_POS[1] + FACE_CY).toFixed(2)}m`);

console.log('\n== 自适应喂球：来球高度 = 拍面中心 + 0.25m，夹 [1.20, 1.55] ==');
const y0 = 1.4;
const vz = 10.5;
for (const [faceY, label] of [
  [1.0, '横握'],
  [1.3, '半斜握'],
  [1.45, '竖握'],
]) {
  const targetY = Math.min(1.55, Math.max(1.2, faceY + 0.25));
  const vy = feedVy(y0, targetY, vz);
  flyServe(y0, vy, vz, HIT_Z, `${label}（拍面 ${faceY.toFixed(2)}m → 目标 ${targetY.toFixed(2)}m）`);
}

console.log('\n== 回球落点（当前区间 18–32 m/s，允许墙前落地）==');
for (const s of [18, 22, 26, 32]) {
  flyReturn(1.35, s, 12);
}

console.log('\n== 平打（小仰角）现在也能回来了——落点在网前 ==');
for (const s of [18, 24, 30]) {
  flyReturn(1.35, s, 4);
}
