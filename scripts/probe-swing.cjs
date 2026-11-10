/**
 * 诊断「一挥拍就打不到，球从拍子里穿过去」。
 *
 * 球拍是「握点固定 + 绕握点旋转」的杆子——手机只给角度，给不出手的位置。
 * 拍面中心挂在 0.6m 杆末：转 30° 平移 0.31m，转 90° 平移 0.85m，
 * 而判定椭圆半轴只有 0.20m。球如果照着「挥拍前」的位置飞，到达时拍面已经挥走。
 *
 *   现在球不再跟随拍面：飞行途中方向不被修改，只在落地弹起那一刻由
 *   `Rally.aimArrival` 瞄一次。这个探针量的是「挥拍转角越大，球到面时
 *   离拍面中心多远」，也就是物理上玩家必须自己对准的那段缺口。
 *
 *   node scripts/probe-swing.cjs
 */
const { Rally } = require('../.tmp-sim/core/rally.js');
const { makeBall, advance } = require('../.tmp-sim/core/physics.js');
const { faceCenter } = require('../.tmp-sim/core/racket.js');
const { RACKET_POS, HIT_Z, FACE_CY, FACE_RX, FACE_RY, BALL_R } = require('../.tmp-sim/core/court.js');

const DT = 1000 / 60;
/** 拍面中心静止时所在的高度 / 平面（恒等姿态下就是握点正上方 FACE_CY） */
const FACE_Y = RACKET_POS[1] + FACE_CY;
const Q0 = [0, 0, 0, 1];

/** 绕轴 axis 转 deg 度的四元数（[x,y,z,w]） */
function quatAxis(axis, deg) {
  const a = (deg * Math.PI) / 360;
  const s = Math.sin(a);
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(a)];
}

/** q0 * q1（先 q1 再 q0） */
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** 球还有多久穿过某个 z（物理前推，不按当前速度外推） */
function arrivalTime(ball, z) {
  const b = makeBall(ball.p, ball.v, ball.spin);
  b.bounces = ball.bounces;
  b.wallHits = ball.wallHits;
  let zPrev = b.p[2];
  let t = 0;
  for (let i = 0; i < 240 * 4; i++) {
    advance(b, 1 / 240, () => {});
    t += 1 / 240;
    if (zPrev < z && b.p[2] >= z) return t;
    if (!b.live) return null;
    zPrev = b.p[2];
  }
  return null;
}

function strokeAt(t) {
  return {
    t,
    peakW: 12,
    head: [0, 3, -14],
    speed: Math.hypot(0, 3, -14),
    face: [0, 0, -1],
    grip: [0, 1, 0],
    charge: 0.6,
    used: false,
  };
}

/** 只跑第一颗球：跑久了后面的球会轮流喂过来，把结论冲掉 */
function run({ axis, phiMax }) {
  const r = new Rally();
  const realRandom = Math.random;
  Math.random = () => 0.5; // 关掉横向扰动，只看纵向这条链路
  try {
    let t0 = 0;
    for (let i = 0; i < 3; i++) {
      t0 += DT;
      r.update(DT / 1000, t0); // 第三帧才真的发球
    }
    if (r.phase !== 'incoming') throw new Error('没有发球成功');

    const tArrive = arrivalTime(r.ball, HIT_Z);
    if (tArrive === null) throw new Error('球到不了拍面');

    const SWING_MS = 260; // 一次挥拍的总时长（含起势与收尾）
    const swingStart = t0 + tArrive * 1000 - SWING_MS / 2;

    let now = t0;
    let nearest = null;
    let hit = false;
    let missed = null;
    for (let i = 0; i < 60 * 4; i++) {
      now += DT;
      const u = (now - swingStart) / SWING_MS;
      const deg = phiMax > 0 && u > 0 && u < 1 ? phiMax * (u < 0.5 ? u * 2 : 1) : 0;
      const pose = { t: now, pos: [0, RACKET_POS[1], HIT_Z], q: qmul(quatAxis(axis, deg), Q0) };
      r.pushRacket(pose);

      // 球经过拍面平面那一下：记下球心到拍面中心的三维距离
      const b = r.ball;
      if (nearest === null && b.p[2] > HIT_Z - 0.1 && b.p[2] < HIT_Z + 0.1) {
        const f = faceCenter(pose);
        nearest = { d: Math.hypot(b.p[0] - f[0], b.p[1] - f[1], b.p[2] - f[2]) };
      }
      if (r.phase === 'contact') r.submit(strokeAt(now));
      for (const e of r.update(DT / 1000, now)) {
        if (e.kind === 'hit') hit = true;
        if (e.kind === 'miss') missed = e.reason;
      }
      if (hit || missed) break;
    }
    return { nearest, hit, missed };
  } finally {
    Math.random = realRandom;
  }
}

console.log(`拍面半宽 ${FACE_RX}m / 半长 ${FACE_RY}m，判定各加球半径 ${BALL_R} + 容差`);
console.log(`握点到拍面中心 ${FACE_CY}m。转 φ 度，拍面中心绕握点平移 2·${FACE_CY}·sin(φ/2)：`);
for (const d of [15, 30, 60, 90]) {
  console.log(`  ${String(d).padStart(3)}° 平移 ${(2 * FACE_CY * Math.sin((d * Math.PI) / 360)).toFixed(2)}m`);
}
console.log(`判定椭圆半轴 ≈ ${(FACE_RX + BALL_R + 0.02).toFixed(3)} × ${(FACE_RY + BALL_R + 0.02).toFixed(3)}m\n`);

for (const [label, axis] of [
  ['竖挥（绕横轴）', [1, 0, 0]],
  ['横挥（绕竖轴）', [0, 1, 0]],
  ['绕竖直轴（法线方向）', [0, 0, 1]],
]) {
  console.log(`== ${label} ==`);
  console.log('转角   球到面时距拍面中心   判定');
  console.log('─'.repeat(48));
  for (const phiMax of [0, 15, 30, 45, 60, 90, 120]) {
    const res = run({ axis, phiMax });
    const d = res.nearest ? `${res.nearest.d.toFixed(2)}m` : ' —  ';
    const verdict = res.hit ? '打中' : res.missed === 'reach' ? '够不着' : res.missed === 'late' ? '漏接' : '未接触';
    console.log(`${String(phiMax).padStart(3)}°   ${d.padEnd(18)} ${verdict}`);
  }
  console.log('');
}

console.log('「距离」= 球穿过击球面那一刻，球心到拍面中心的三维距离。');
console.log(`超过判定半轴（约 0.20m）就打不到；超过 0.3m 在屏幕上就是肉眼可见的穿模。`);
console.log(`画面上球拍中心高度 ${FACE_Y}m（握点 ${RACKET_POS[1]}m + 杆长 ${FACE_CY}m）。`);
