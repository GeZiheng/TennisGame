/**
 * 调参诊断：逐 vy 扫描一次出球，同时报告「旧判据」（过 targetZ 竖平面的
 * 高度是否落在 ±12cm 窗口）和「严格盘形判定」（回球是否真的穿过拍面盘）
 * 各自会选哪个仰角。
 *
 * 内置的参数是 sim「中力」档一次真实的 reach 漏接（ tilt 18° 拍面），
 * 就是它钉出了「竖平面窗口对斜拍面是错的」这个 bug——换任何出球参数都能跑。
 *
 * 用法：node scripts/sim.mjs && node scripts/probe-scan2.cjs
 * （sim.mjs 负责把 core 编译成 .tmp-sim）
 */
const { advance, makeBall } = require('../.tmp-sim/core/physics.js');
const { sweepFace } = require('../.tmp-sim/core/racket.js');
const court = require('../.tmp-sim/core/court.js');
const { HIT_Z, NET_Z, BALL_R } = court;

/* ---- 默认复刻那次失败出球；改这三个数就能扫描任意一拍 ---- */
const at = [0.35, 1.59, 0.49];
const vRaw = [0.0, 6.16, -15.65];
const spin = [-25.6, 0, 0];
const theta = 18;
const pose = { t: 0, pos: [0.35, 1.0, HIT_Z], q: (() => { const h = (theta * Math.PI) / 360; return [0, Math.cos(h), Math.sin(h), 0]; })() };
const targetZ = 0.489;
const targetY = 1.569;
const LO = targetY - 0.12;
const HI = targetY + 0.12;

console.log(`出球 v=(${vRaw}) spin=(${spin}) 窗口 [${LO.toFixed(2)}, ${HI.toFixed(2)}]\n`);

function scan(vy) {
  const b = makeBall(at, [vRaw[0], vy, vRaw[2]], spin);
  let wallY = null;
  let reachedWall = false;
  let bounces = 0;
  let bouncesAfter = 0;
  let bad = false;
  let faceHit = null;
  let planeY = null;
  let planeVy = null;

  for (let i = 0; i < 1600; i++) {
    let hitWall = false;
    advance(
      b,
      1 / 240,
      (c) => {
        if (c.kind === 'net') bad = true;
        if (c.kind === 'wall') { hitWall = true; wallY = c.at[1]; }
        if (c.kind === 'ground') {
          if (reachedWall) bouncesAfter++;
          else { bounces++; if (bounces === 1 && c.at[2] > NET_Z) bad = true; }
        }
      },
      (p0, p1) => {
        if (reachedWall && !bad && b.p[2] > NET_Z && !faceHit) {
          const h = sweepFace(pose, p0, p1);
          if (h) faceHit = h.at;
        }
      }
    );
    if (bad) return { vy, fail: 'net' };
    if (hitWall) reachedWall = true;
    if (reachedWall) {
      if (faceHit) return { vy, wallY, faceHit, bouncesAfter, planeY, planeVy };
      if (planeY === null && b.p[2] >= targetZ) { planeY = b.p[1]; planeVy = b.v[1]; }
      if (b.p[2] > targetZ + 0.8) return { vy, wallY, planeY, planeVy, bouncesAfter, fail: 'past' };
      if (bouncesAfter >= 2) return { vy, wallY, planeY, planeVy, bouncesAfter, fail: 'bounce2' };
    } else if (bounces > 2) return { vy, wallY, fail: 'out' };
  }
  return { vy, wallY, fail: 'timeout' };
}

const f = (x, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));
console.log('  vy   撞墙    过targetZ高  到时vy  撞墙后落地  旧判据(窗口内?)  盘形判定');
const rows = [];
for (let vy = 0; vy <= 13.001; vy += 0.2) {
  const r = scan(vy);
  rows.push(r);
  const inWin = r.planeY !== null && r.planeY >= LO && r.planeY <= HI;
  const oldTag = r.fail === 'net' ? '撞网' : r.fail ? r.fail : inWin ? '√ 接受' : `× (${f(r.planeY)})`;
  const newTag = r.faceHit ? `√ 命中 (${r.faceHit[1].toFixed(2)}, ${r.faceHit[2].toFixed(2)})` : '×';
  console.log(
    `${r.vy.toFixed(1).padStart(5)}  ${f(r.wallY).padStart(5)}  ${f(r.planeY).padStart(9)}  ${f(r.planeVy, 1).padStart(6)}  ` +
      `${String(r.bouncesAfter ?? '—').padStart(8)}       ${oldTag.padStart(12)}   ${newTag}`
  );
}

const oldPick = rows.find((r) => !r.fail && r.planeY !== null && r.planeY >= LO && r.planeY <= HI);
const newPick = rows.find((r) => r.faceHit);
console.log(`\n旧判据第一个可行解: ${oldPick ? `vy=${oldPick.vy.toFixed(1)}（撞墙 ${f(oldPick.wallY)}m）` : '无'}`);
console.log(`盘形判定第一个可行解: ${newPick ? `vy=${newPick.vy.toFixed(1)}（撞墙 ${f(newPick.wallY)}m）` : '无'}`);
