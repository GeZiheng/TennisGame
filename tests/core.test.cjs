const assert = require('node:assert');
const { encodePacket, decodePacket, PACKET_BYTES } = require('./core/protocol.js');
const { ImuTracker, qconj, qmul, qnorm } = require('./core/imu.js');
const { deviceEulerToWorldQuat, qYaw, toOutputQuat, qAngle,
  worldYawDelta, isYawGimbal, YawDriftObserver,
  PoseContinuityGate, MAX_POSE_JUMP, MAX_EXTRAP_MS } = require('./core/attitude.js');
const { LatencyWindow, ClockSync, PacketStats } = require('./core/stats.js');
const { SwingDetector, shotFromStroke } = require('./core/swing.js');
const { omegaFromQuatDelta } = require('./core/gyro.js');
const { makeBall, advance, aimIntoCourt, predictAtPlane, sampleCrossings } = require('./core/physics.js');
const { planAutoMove, stepAxis, stepAutoMove, blendCenterOffset, AUTO_MOVE_DEFAULTS, TargetHold, CROSS_STEP } = require('./core/auto-move.js');
const { SwingRig, SWING_RIG_DEFAULTS } = require('./core/swing-rig.js');
const { BallMachine, MACHINE_L2, ARRIVE_Y_MIN, ARRIVE_Y_MAX } = require('./core/machine.js');
const { Duel } = require('./core/duel.js');
const { TennisMatch, pointLabel, isDeuce, advantageSide } = require('./core/match.js');
const { serveBox, serveStandX, inServeBox, serveAim, serveStrike, tossContact, OPP_SERVICE_Z,
  TOSS_Y0, TOSS_VY, SERVE_ANCHOR_R, SERVE_STRIKE_UP, SERVE_STRIKE_FWD, SERVE_STAND_Z } = require('./core/serve.js');
const { BALL_R, HIT_Z, RACKET_POS, FACE_RX, FACE_RY, FACE_CY, NET_Z, NET_H, HALF_WIDTH, PHYS_DT, OPP_HIT_Z, OPP_BASELINE_Z, BASELINE_Z, GRAVITY } = require('./core/court.js');
const { sweepFace, faceCovers, faceCenter, frontFace, RacketTrack, IDLE_POSE } = require('./core/racket.js');
const { buildContactSample, lagBuckets, samplesToJsonl, summarizeContacts, usableForCalibration,
  aimResidual, ContactLog, FEATURE_KEYS } = require('./core/contact-log.js');

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.log(` FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
};

console.log('协议');

t('定长 68 字节', () => assert.strictEqual(PACKET_BYTES, 68));

t('编解码往返一致', () => {
  const p = {
    seq: 123456,
    tSend: 98765.4321,
    tSample: 98760.1234,
    q: [0.1, -0.2, 0.3, 0.927],
    gyro: [1.5, -2.25, 0.75],
    accel: [0.11, 0.98, -0.3],
    peakG: 15.6,
    peakW: 31.2,
  };
  const buf = encodePacket(p);
  assert.strictEqual(buf.byteLength, 68);
  const back = decodePacket(buf);
  assert.strictEqual(back.seq, p.seq);
  assert.ok(Math.abs(back.tSend - p.tSend) < 1e-6);
  assert.ok(Math.abs(back.tSample - p.tSample) < 1e-6);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(back.q[i] - p.q[i]) < 1e-6);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back.gyro[i] - p.gyro[i]) < 1e-5);
  assert.ok(Math.abs(back.peakG - p.peakG) < 1e-4);
});

t('缓冲区复用不串包', () => {
  const shared = new ArrayBuffer(68);
  const a = decodePacket(encodePacket({ seq: 1, tSend: 1, tSample: 1, q: [0, 0, 0, 1], gyro: [0, 0, 0], accel: [0, 0, 1], peakG: 1, peakW: 0 }, shared));
  const b = decodePacket(encodePacket({ seq: 2, tSend: 2, tSample: 2, q: [0, 1, 0, 0], gyro: [1, 1, 1], accel: [0, 0, 2], peakG: 2, peakW: 5 }, shared));
  assert.strictEqual(a.seq, 1);
  assert.strictEqual(b.seq, 2);
  assert.strictEqual(b.q[1], 1);
});

t('短包被拒绝', () => {
  assert.strictEqual(decodePacket(new ArrayBuffer(10)), null);
});

t('旧版 60 字节包仍能解码（手机端缓存没刷新时不至于彻底失联）', () => {
  const buf = new ArrayBuffer(60);
  const dv = new DataView(buf);
  dv.setUint32(0, 42, true);
  dv.setFloat64(4, 5000, true);
  dv.setFloat32(12, 0, true);
  dv.setFloat32(16, 0, true);
  dv.setFloat32(20, 0, true);
  dv.setFloat32(24, 1, true);
  dv.setFloat32(28, 1, true);
  dv.setFloat32(32, 2, true);
  dv.setFloat32(36, 3, true);
  dv.setFloat32(40, 0, true);
  dv.setFloat32(44, 1, true);
  dv.setFloat32(48, 0, true);
  dv.setFloat32(52, 9, true);
  dv.setFloat32(56, 12, true);
  const p = decodePacket(buf);
  assert.strictEqual(p.seq, 42);
  assert.strictEqual(p.tSend, 5000);
  assert.strictEqual(p.tSample, 5000, '旧包没有采样时刻，应退化成发送时刻');
  assert.deepStrictEqual(p.gyro, [1, 2, 3]);
  assert.strictEqual(p.peakW, 12);
});

console.log('姿态');

t('静止时冻结，不产生漂移', () => {
  const tk = new ImuTracker();
  for (let i = 0; i < 100; i++) tk.update([0, 0, 0], 16.7);
  const q = tk.snapshot();
  assert.deepStrictEqual(q, [0, 0, 0, 1]);
  assert.ok(tk.isStill, '应该判定为静止');
});

t('绕 Z 轴转 90° 后四元数正确', () => {
  const tk = new ImuTracker();
  // 90°/s，持续 1 秒。要分多帧喂，因为 dt 被钳到 100ms 以内防止长间隔积分出错
  for (let i = 0; i < 60; i++) tk.update([0, 0, Math.PI / 2], 1000 / 60);
  const q = tk.snapshot();
  const expected = Math.SQRT1_2;
  assert.ok(Math.abs(Math.abs(q[2]) - expected) < 0.02, `z 分量应接近 ${expected}，实际 ${q[2]}`);
});

t('相对姿态：中位自身返回单位四元数', () => {
  const tk = new ImuTracker();
  tk.update([0.5, 0.5, 0.5], 50);
  const origin = tk.snapshot();
  const rel = tk.relativeTo(origin);
  assert.ok(Math.abs(Math.abs(rel[3]) - 1) < 1e-6, `w 应为 ±1，实际 ${rel[3]}`);
});

t('四元数乘法/共轭自洽 q ⊗ q* = 1', () => {
  const q = qnorm([0.3, -0.4, 0.5, 0.7]);
  const r = qmul(q, qconj(q));
  assert.ok(Math.abs(r[0]) < 1e-9 && Math.abs(r[1]) < 1e-9 && Math.abs(r[2]) < 1e-9);
  assert.ok(Math.abs(Math.abs(r[3]) - 1) < 1e-9);
});

console.log('姿态换算（设备系 → 世界系）');

t('qAngle 把 q 与 -q 视为同一个旋转', () => {
  const q = deviceEulerToWorldQuat(30, 45, 20);
  assert.ok(qAngle(q, q) < 1e-9);
  assert.ok(qAngle(q, [-q[0], -q[1], -q[2], -q[3]]) < 1e-9);
});

t('qAngle 能识别 90 度的姿态瞬跳', () => {
  const a = [0, 0, 0, 1];
  const b = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]; // 绕世界 Y 转 90°
  assert.ok(Math.abs(qAngle(a, b) - Math.PI / 2) < 1e-9);
  assert.ok(qAngle(a, [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)]) < Math.PI / 5);
});

/** 用四元数旋转一个向量 */
const rot = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

const angleBetween = (a, b) => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const na = Math.hypot(...a);
  const nb = Math.hypot(...b);
  return (Math.acos(Math.max(-1, Math.min(1, dot / (na * nb)))) * 180) / Math.PI;
};

// 球拍模型的本地轴：拍柄沿 +Y，拍面法线沿 +Z（和手机设备轴一致）
const HANDLE = [0, 1, 0];
const FACE_NORMAL = [0, 0, 1];

t('手机直立（β=90）→ 拍柄朝上', () => {
  const q = deviceEulerToWorldQuat(0, 90, 0);
  const h = rot(q, HANDLE);
  assert.ok(angleBetween(h, [0, 1, 0]) < 0.5, `拍柄应朝上，实际 ${h.map((n) => n.toFixed(2))}`);
  const n = rot(q, FACE_NORMAL);
  assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9);
  assert.ok(angleBetween(n, [0, 1, 0]) > 80, '立着的时候拍面应该朝前，不是朝天');
});

t('手机平放朝天（β=0）→ 拍柄水平、拍面朝天', () => {
  const q = deviceEulerToWorldQuat(0, 0, 0);
  const h = rot(q, HANDLE);
  assert.ok(Math.abs(h[1]) < 1e-6, `拍柄应水平，实际 y=${h[1]}`);
  assert.ok(angleBetween(h, [0, 0, -1]) < 0.5, '拍柄应指向屏幕里侧');
  const n = rot(q, FACE_NORMAL);
  assert.ok(angleBetween(n, [0, 1, 0]) < 0.5, '拍面应朝天');
});

t('后仰 30° → 拍柄与竖直夹角 30°', () => {
  const q = deviceEulerToWorldQuat(0, 60, 0);
  const h = rot(q, HANDLE);
  assert.ok(Math.abs(angleBetween(h, [0, 1, 0]) - 30) < 0.5, `夹角应约 30°，实际 ${angleBetween(h, [0, 1, 0]).toFixed(1)}`);
});

t('绕长轴侧转 45° → 拍面法线倾斜 45°', () => {
  // 平放时绕手机长轴（Y）滚 45°，拍面法线应从朝天变成斜 45°
  const q = deviceEulerToWorldQuat(0, 0, 45);
  const n = rot(q, FACE_NORMAL);
  assert.ok(
    Math.abs(angleBetween(n, [0, 1, 0]) - 45) < 0.5,
    `法线与竖直夹角应约 45°，实际 ${angleBetween(n, [0, 1, 0]).toFixed(1)}`
  );
  const h = rot(q, HANDLE);
  assert.ok(Math.abs(h[1]) < 1e-6, '绕长轴滚转不应让拍柄离开水平面');
});

t('朝向归零后 yaw 为 0，倾斜保持不变', () => {
  const abs = deviceEulerToWorldQuat(137, 60, 20);
  const out = toOutputQuat(abs, qYaw(abs));
  assert.ok(Math.abs(qYaw(out)) < 1e-6, `归零后 yaw 应为 0，实际 ${qYaw(out)}`);
  // 倾斜不能被动过：拍柄与竖直的夹角应与绝对姿态一致
  assert.ok(
    Math.abs(angleBetween(rot(out, HANDLE), [0, 1, 0]) - angleBetween(rot(abs, HANDLE), [0, 1, 0])) < 1e-6,
    '归零不应改变倾斜'
  );
});

t('alpha 变化只改变朝向，不改变倾斜', () => {
  const a = deviceEulerToWorldQuat(0, 60, 0);
  const b = deviceEulerToWorldQuat(40, 60, 0);
  const dyaw = Math.abs(((qYaw(b) - qYaw(a)) * 180) / Math.PI);
  assert.ok(Math.abs(dyaw - 40) < 0.5, `朝向应变化 40°，实际 ${dyaw.toFixed(1)}`);
  const tiltA = angleBetween(rot(a, HANDLE), [0, 1, 0]);
  const tiltB = angleBetween(rot(b, HANDLE), [0, 1, 0]);
  assert.ok(Math.abs(tiltA - tiltB) < 0.5, '倾斜不应随 alpha 改变');
});

console.log('偏航慢漂观测（alpha 慢漂 / 握位依赖）');

t('两帧纯 yaw 增量能还原，且 q 与 -q 同解', () => {
  const a = deviceEulerToWorldQuat(20, 75, 10);
  const b = deviceEulerToWorldQuat(25, 75, 10);
  const d = (worldYawDelta(a, b) * 180) / Math.PI;
  assert.ok(Math.abs(d - 5) < 0.2, `应为 5°，实际 ${d.toFixed(2)}°`);
  const negB = [-b[0], -b[1], -b[2], -b[3]];
  assert.ok(Math.abs(worldYawDelta(a, negB) - worldYawDelta(a, b)) < 1e-9, 'q 与 -q 不应得到不同结果');
});

t('纯俯仰变化不该被算成偏航漂移', () => {
  const a = deviceEulerToWorldQuat(30, 60, 0);
  const b = deviceEulerToWorldQuat(30, 65, 0);
  assert.ok(Math.abs(worldYawDelta(a, b)) < 0.02, '俯仰的旋转轴在水平面内，不应投影到世界 Y');
});

t('竖直持握时 gamma 会混进世界 Y 转角（反手位依赖的数学根因）', () => {
  // β=90 时 Rx(β-90) 退成单位阵，absolute = Ry(α+γ)：alpha 与 gamma 同轴，
  // 所以「换握位」在 qYaw 看来和「转身」没区别，重锁正前方必然依赖握位。
  const a = deviceEulerToWorldQuat(30, 90, 0);
  const b = deviceEulerToWorldQuat(30, 90, 40);
  const d = (worldYawDelta(a, b) * 180) / Math.PI;
  assert.ok(Math.abs(d - 40) < 0.5, `应约 40°，实际 ${d.toFixed(1)}°`);
});

t('万向锁回退分支必须能被识别', () => {
  assert.strictEqual(isYawGimbal([0, 0, 0, 1]), false);
  const gimbalQ = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // Rx(90°)，|r12| = 1
  assert.strictEqual(isYawGimbal(gimbalQ), true);
});

// 真机 `deviceorientation` 大多是 20–25Hz，这里统一按 50ms 一帧构造
const DT_20HZ = 50;

// 陀螺读数：静止时是噪声量级（远低于 STILL_GYRO_RATE = 0.04 rad/s ≈ 2.3°/s），
// 挥拍中段实测 8 rad/s 量级。ZUPT 判据全靠这一个数，所以测试里必须显式给。
const GYRO_STILL = 0.01;
const GYRO_SWING = 8;

/** 按恒定角速度推进若干帧：alpha 是「传感器看到的朝向」，gyro 是「手机转了多少」 */
function driftFrames(o, degPerSec, ms, gyro = GYRO_STILL, from = 0) {
  const n = Math.round(ms / DT_20HZ);
  let alpha = from;
  for (let i = 0; i < n; i++) {
    alpha += (degPerSec * DT_20HZ) / 1000;
    o.update(deviceEulerToWorldQuat(alpha, 90, 0), DT_20HZ, gyro);
  }
  return alpha;
}

t('静止窗口里测零偏，运动帧按零偏外推', () => {
  const o = new YawDriftObserver();
  driftFrames(o, 1.5, 2000);
  assert.ok(Math.abs(o.degrees - 3) < 0.1, `静止 2s × 1.5°/s 应积 3°，实际 ${o.degrees.toFixed(2)}°`);
  assert.ok(o.biasDegPerSec !== null, '静置 2s 必须已经学到零偏');
  assert.ok(Math.abs(o.biasDegPerSec - 1.5) < 0.15, `零偏应约 1.5°/s，实际 ${o.biasDegPerSec.toFixed(2)}°/s`);

  const before = o.degrees;
  driftFrames(o, 200, 1000, GYRO_SWING, 3);
  assert.ok(Math.abs(o.degrees - before - 1.5) < 0.1,
    `运动 1s 应按零偏外推 1.5°，实际涨了 ${(o.degrees - before).toFixed(2)}°`);
});

// 4.35 的回归测试：旧实现的棘轮——快挥出去被拒、慢回位被当成漂移吃掉，
// 每拍往里走一截且永不回头。现在静止由陀螺判，回位那半根本不进估计。
t('棘轮回归：快挥出去再慢回位，回位不能被吃成漂移', () => {
  const o = new YawDriftObserver();
  let a = driftFrames(o, 1.5, 2000); // 静置，学到 1.5°/s 的零偏
  const before = o.degrees;
  a = driftFrames(o, 400, 100, GYRO_SWING, a);   // 100ms 转 40°，一次快挥（真动作）
  driftFrames(o, 4, 10000, 0.07, a);             // 4°/s 慢慢回位 10s，共 40°
  const grew = o.degrees - before;
  // 这 10 秒只该补 1.5°/s × 10s = 15°，那 40° 回位一度都不能进
  assert.ok(Math.abs(grew - 15) < 1, `应只涨 15°（零偏外推），实际涨了 ${grew.toFixed(1)}°`);
});

t('慢速真实转动（4°/s）不会被学成零偏', () => {
  const o = new YawDriftObserver();
  driftFrames(o, 4, 3000, 0.07); // 陀螺 0.07 rad/s > 2.3°/s 门限 → 一直是「在动」
  assert.strictEqual(o.biasDegPerSec, null, '没有合格静止窗口，不该凭空产生零偏');
  assert.ok(Math.abs(o.degrees) < 1e-9, `运动中不该积分，实际 ${o.degrees.toFixed(2)}°`);
});

t('陀螺不可用（NaN）时一律按运动处理：不学零偏、也不吃真实转动', () => {
  const o = new YawDriftObserver();
  driftFrames(o, 1.5, 2000, NaN);
  assert.strictEqual(o.degrees, 0, '拿不到陀螺就不能猜漂移');
  assert.strictEqual(o.biasDegPerSec, null);
  assert.ok(o.skippedSteps > 0);
});

// 4.34 的回归测试：门限必须按角速度判，不能按「每帧角度」判。
// 旧代码是 0.05 rad/帧，20Hz 下等于 72°/s —— 拿着手机转身就被当成漂移积进去。
t('有意转动（30°/s）在 20Hz 与 60Hz 下都不该被积分', () => {
  for (const dt of [DT_20HZ, 1000 / 60]) {
    const o = new YawDriftObserver();
    const perFrame = 30 * (dt / 1000); // 30°/s 折算到每帧
    const gyro = (30 * Math.PI) / 180; // 0.52 rad/s，远高于静止门限
    let q = deviceEulerToWorldQuat(0, 90, 0);
    o.update(q, dt, gyro);
    for (let i = 1; i <= 60; i++) {
      q = deviceEulerToWorldQuat(i * perFrame, 90, 0);
      o.update(q, dt, gyro);
    }
    assert.ok(Math.abs(o.degrees) < 1e-9,
      `${dt.toFixed(1)}ms 帧间隔下 30°/s 不该积分，实际 ${o.degrees.toFixed(2)}°`);
    assert.strictEqual(o.skippedSteps, 60);
  }
});

t('同一个物理慢漂在 20Hz 与 60Hz 下积分出同样的角度', () => {
  const acc = [DT_20HZ, 1000 / 60].map((dt) => {
    const o = new YawDriftObserver();
    const perFrame = 1.5 * (dt / 1000); // 恒定 1.5°/s
    let q = deviceEulerToWorldQuat(0, 90, 0);
    o.update(q, dt, GYRO_STILL);
    const n = Math.round(2000 / dt); // 都跑 2 秒
    for (let i = 1; i <= n; i++) {
      q = deviceEulerToWorldQuat(i * perFrame, 90, 0);
      o.update(q, dt, GYRO_STILL);
    }
    return o.degrees;
  });
  assert.ok(Math.abs(acc[0] - acc[1]) < 0.05,
    `两种采样率应积出同样角度，实际 ${acc[0].toFixed(2)}° vs ${acc[1].toFixed(2)}°`);
  assert.ok(Math.abs(acc[0] - 3) < 0.05, `2s × 1.5°/s 应是 3°，实际 ${acc[0].toFixed(2)}°`);
});

t('采样断档（切后台回来）那一帧不积分', () => {
  const o = new YawDriftObserver();
  o.update(deviceEulerToWorldQuat(0, 90, 0), DT_20HZ, GYRO_STILL);
  o.update(deviceEulerToWorldQuat(50, 90, 0), 3000, GYRO_STILL); // 断档 3 秒、转了 50°
  assert.ok(Math.abs(o.degrees) < 1e-9, `断档帧不该积分，实际 ${o.degrees.toFixed(2)}°`);
  assert.strictEqual(o.skippedSteps, 1);
});

t('换握位的大跳变不会被当成漂移', () => {
  const o = new YawDriftObserver();
  o.update(deviceEulerToWorldQuat(10, 90, 0), DT_20HZ, GYRO_STILL);
  o.update(deviceEulerToWorldQuat(10, 90, 90), DT_20HZ, GYRO_STILL); // 正手 ↔ 反手
  assert.ok(Math.abs(o.degrees) < 1e-9, `大跳变不该积分，实际 ${o.degrees}`);
  assert.strictEqual(o.skippedSteps, 1);
});

t('把观测到的漂移扣进 yawZero 后，输出姿态回到启动那一刻', () => {
  const start = deviceEulerToWorldQuat(10, 90, 0);
  const zero = qYaw(start);
  const out0 = toOutputQuat(start, zero);

  const o = new YawDriftObserver();
  let q = start;
  o.update(q, DT_20HZ, GYRO_STILL);
  // 2°/s × 10s = 20°，20Hz 下每帧 0.1°
  for (let i = 1; i <= 200; i++) {
    q = deviceEulerToWorldQuat(10 + i * 0.1, 90, 0);
    o.update(q, DT_20HZ, GYRO_STILL);
  }
  const raw = toOutputQuat(q, zero);
  const fixed = toOutputQuat(q, zero + o.radians);
  const driftErr = (qAngle(raw, out0) * 180) / Math.PI;
  const fixedErr = (qAngle(fixed, out0) * 180) / Math.PI;
  assert.ok(driftErr > 15, `不补偿应歪掉约 20°，实际 ${driftErr.toFixed(1)}°`);
  assert.ok(fixedErr < 0.5, `补偿后应回正，实际 ${fixedErr.toFixed(1)}°`);
});

t('resetAngle 保留零偏（按 R 重标定后不用重新站定）', () => {
  const o = new YawDriftObserver();
  driftFrames(o, 1.5, 2000);
  const bias = o.biasDegPerSec;
  assert.ok(bias !== null, '前提：已经学到零偏');
  o.resetAngle();
  assert.strictEqual(o.radians, 0);
  assert.strictEqual(o.biasDegPerSec, bias, '重标定改的是正前方，不改陀螺零偏');
});

t('reset 后观测归零（新会话：连零偏一起清）', () => {
  const o = new YawDriftObserver();
  driftFrames(o, 1.5, 2000);
  assert.ok(Math.abs(o.degrees) > 1, '先要真的积到漂移');
  assert.ok(o.biasDegPerSec !== null, '先要真的学到零偏');
  o.reset();
  assert.strictEqual(o.radians, 0);
  assert.strictEqual(o.biasDegPerSec, null);
  assert.strictEqual(o.skippedSteps, 0);
});

console.log('姿态连续性门（快挥拍 / 解分支跳变）');

t('真实快挥拍越过大转角门限时仍必须采信绝对姿态', () => {
  const gate = new PoseContinuityGate();
  const a = deviceEulerToWorldQuat(30, 90, 0);
  const b = deviceEulerToWorldQuat(30, 90, 100); // 100°，明确超过 1.2rad
  assert.ok(qAngle(a, b) > MAX_POSE_JUMP, '前提：这一帧确实越过了固定门限');
  gate.decide(a, 40, false);
  assert.strictEqual(gate.decide(b, 40, true), true, '传感器在动，不能把真实挥拍判成解分支跳变');
  assert.strictEqual(gate.extrapTime, 0);
});

t('静止 / 微动时的大跳变仍要拦下（解分支跳变）', () => {
  const gate = new PoseContinuityGate();
  gate.decide(deviceEulerToWorldQuat(30, 90, 0), 40, false);
  assert.strictEqual(gate.decide(deviceEulerToWorldQuat(30, 90, 100), 40, false), false);
  assert.ok(gate.extrapTime > 0, '被拦的帧要计入外推时长');
});

t('跳变只拦一帧：基准不能冻结在跳变前（旧实现会卡满 500ms）', () => {
  const gate = new PoseContinuityGate();
  gate.decide(deviceEulerToWorldQuat(30, 90, 0), 40, false);
  // 换解分支后停在新姿态，之后相邻帧只有很小变化
  assert.strictEqual(gate.decide(deviceEulerToWorldQuat(30, 90, 100), 40, false), false);
  assert.strictEqual(gate.decide(deviceEulerToWorldQuat(30, 90, 101), 40, false), true,
    '下一帧是相邻帧差 1°，应当恢复采信；冻结基准会继续拦到超时');
});

t('连续外推超过 MAX_EXTRAP_MS 强制重新锚定', () => {
  const gate = new PoseContinuityGate();
  gate.decide(deviceEulerToWorldQuat(30, 90, 0), 16.7, false); // 先建立基准帧
  let accepted = false;
  let maxExtrap = 0;
  for (let i = 1; i <= 40; i++) {
    const q = deviceEulerToWorldQuat(30, 90, i * 100); // 每帧都是大跳变
    if (gate.decide(q, 16.7, false)) { accepted = true; break; }
    // 重锚那一帧计时会清零，所以要在采信之前取峰值
    maxExtrap = Math.max(maxExtrap, gate.extrapTime);
  }
  assert.strictEqual(accepted, true, '外推不能无限期卡住');
  assert.ok(maxExtrap >= MAX_EXTRAP_MS, `强制重锚应发生在超时之后，峰值 ${maxExtrap.toFixed(0)}ms`);
});

t('方向事件 25Hz + 35rad/s 全程采信，不出现一帧外推', () => {
  const gate = new PoseContinuityGate();
  const dtMs = 1000 / 25;
  const perFrameDeg = (35 * dtMs / 1000) * 180 / Math.PI; // 80°/帧 > 1.2rad
  for (let i = 0; i < 30; i++) {
    const q = deviceEulerToWorldQuat(30, 90, i * perFrameDeg);
    assert.strictEqual(gate.decide(q, dtMs, true), true, `第 ${i} 帧不该被踢进外推`);
  }
  assert.strictEqual(gate.extrapTime, 0);
});

t('reset 后回到「第一帧无条件采信」', () => {
  const gate = new PoseContinuityGate();
  gate.decide(deviceEulerToWorldQuat(30, 90, 0), 40, false);
  assert.strictEqual(gate.decide(deviceEulerToWorldQuat(30, 90, 100), 40, false), false);
  gate.reset();
  assert.strictEqual(gate.extrapTime, 0);
  assert.strictEqual(gate.decide(deviceEulerToWorldQuat(30, 90, 0), 40, false), true);
});

t('非 Y 轴的微小俯仰不算偏航漂移（避免补偿随机游走）', () => {
  const o = new YawDriftObserver();
  o.update(deviceEulerToWorldQuat(30, 60, 0), DT_20HZ, GYRO_STILL);
  o.update(deviceEulerToWorldQuat(30, 61.5, 0), DT_20HZ, GYRO_STILL); // 纯俯仰 1.5°，投影到 Y 上很小
  assert.ok(Math.abs(o.degrees) < 0.01, `俯仰不该进漂移累积，实际 ${o.degrees.toFixed(3)}°`);
});

t('纯 yaw 慢漂仍被完整积分（纯度判据不能误伤）', () => {
  const o = new YawDriftObserver();
  o.update(deviceEulerToWorldQuat(0, 90, 0), DT_20HZ, GYRO_STILL);
  // 1.5°/s = 20Hz 下每帧 0.075°；这是「纯 yaw」，不该被 off-axis 判据拦下
  for (let i = 1; i <= 40; i++) {
    o.update(deviceEulerToWorldQuat(i * 0.075, 90, 0), DT_20HZ, GYRO_STILL);
  }
  assert.ok(Math.abs(o.degrees - 3) < 0.1, `应累积 3°，实际 ${o.degrees.toFixed(2)}°`);
  assert.strictEqual(o.skippedSteps, 0);
});

console.log('统计');

t('分位数取整不越界', () => {
  const w = new LatencyWindow();
  for (let i = 1; i <= 100; i++) w.add(i);
  assert.strictEqual(Math.round(w.p50), 50);
  assert.strictEqual(Math.round(w.p95), 95);
});

t('样本很少时也不崩', () => {
  const w = new LatencyWindow();
  w.add(42);
  assert.strictEqual(w.pct(95), 42);
  assert.strictEqual(w.jitter, 0);
  assert.ok(Number.isNaN(new LatencyWindow().p50));
});

t('滑动窗口只保留最近 240 个', () => {
  const w = new LatencyWindow();
  for (let i = 0; i < 500; i++) w.add(i);
  assert.strictEqual(w.count, 240);
});

t('丢包率计算考虑乱序', () => {
  const p = new PacketStats();
  // 收到 1,2,4,5，缺 3 → 期望 5，实收 4，丢 20%
  for (const s of [1, 2, 4, 5]) p.mark(s, 0);
  assert.strictEqual(p.lossRate, 1 - 4 / 5);
  // 乱序到达不应被算成丢包
  const q = new PacketStats();
  for (const s of [5, 1, 3, 2, 4]) q.mark(s, 0);
  assert.strictEqual(q.lossRate, 0);
});

console.log('时钟同步');

t('单向延迟在已知偏移下被正确还原', () => {
  // 场景：球拍端时钟比大屏端快 5000ms，去程 12ms、回程 12ms、球拍处理 3ms
  const D = 5000;
  const GO = 12;
  const BACK = 12;
  const PROC = 3;

  const t0 = 1000;                 // 大屏发出（大屏时钟）
  const t1 = t0 + D + GO;          // 球拍收到（球拍时钟）
  const t2 = t1 + PROC;            // 球拍回发（球拍时钟）
  const t3 = t0 + GO + PROC + BACK; // 大屏收到（大屏时钟）

  const sync = new ClockSync();
  sync.ingest(t0, t1, t2, t3);
  assert.ok(sync.isValid);
  assert.strictEqual(sync.lastRtt, GO + BACK, `RTT 应只算网络往返，不含对端处理，实际 ${sync.lastRtt}`);
  assert.ok(Math.abs(sync.offsetMs - D) < 1e-6, `偏移应为 ${D}，实际 ${sync.offsetMs}`);

  // 球拍在 8000（球拍时钟）发出一个包，换算到大屏时钟应为 3000，12ms 后即 3012 到达
  const tSend = 8000;
  const arrive = 3012;
  const measured = arrive - sync.toLocal(tSend);
  assert.ok(Math.abs(measured - GO) < 1e-6, `还原出的单向延迟应为 ${GO}，实际 ${measured}`);
});

t('只采纳更优的 RTT 样本，慢样本不污染偏移', () => {
  const sync = new ClockSync();
  sync.ingest(0, 5000 + 10, 5000 + 12, 22); // RTT 20
  const offsetA = sync.toLocal(0);
  sync.ingest(0, 5000 + 300, 5000 + 302, 900); // RTT 600，明显是抖动
  const offsetB = sync.toLocal(0);
  assert.ok(Math.abs(offsetA - offsetB) < 1e-6, '慢样本不应改变偏移估计');
});

t('对端页面重载导致时钟基准突变时，必须重新锚定', () => {
  // 第一段连接：大屏已跑 40s，手机页面刚打开，球拍时钟比大屏慢 30s
  const sync = new ClockSync();
  sync.ingest(40000, 10010, 10012, 40022); // RTT 20
  assert.ok(Math.abs(sync.offsetMs + 30000) < 1e-6, `初始偏移应约 -30000，实际 ${sync.offsetMs}`);
  assert.strictEqual(sync.lastRtt, 20);

  // 手机重新扫码、页面重载：performance.now() 归零，时钟差变成 -300000。
  // 这次 RTT 仍是 20，并不比 bestRtt * 0.9 更优 —— 只认最优样本的老逻辑
  // 会永远卡在 -30000，把新会话的挥拍时刻算到 270 秒之前。
  sync.ingest(300000, 10, 12, 300022);
  assert.ok(
    Math.abs(sync.offsetMs + 300000) < 1e-6,
    `应重新锚定到新会话的偏移，实际 ${sync.offsetMs}`
  );
  // 手机发出 tSend=1000 的包，换算到大屏应是 301000；沿用旧偏移会算成 31000，
  // 与 ±150ms 的击球窗口差了六个数量级，每一球都会漏接。
  assert.ok(Math.abs(sync.toLocal(1000) - 301000) < 1e-6, '重锚后时间戳必须落回大屏当前时基');
});

t('reset 之后必须重新收敛，不能沿用上一段连接的偏移', () => {
  const sync = new ClockSync();
  sync.ingest(40000, 10010, 10012, 40022); // 上一段连接：偏移 -30000
  assert.ok(sync.isValid);

  sync.reset();
  assert.ok(!sync.isValid, 'reset 后不能拿旧的 offset 去换算时间戳');
  assert.strictEqual(sync.offsetMs, 0);

  sync.ingest(0, 5010, 5012, 22); // 新会话：球拍时钟快 5s
  assert.ok(Math.abs(sync.offsetMs - 5000) < 1e-6, `新偏移应为 5000，实际 ${sync.offsetMs}`);
  assert.ok(Math.abs(sync.toLocal(8000) - 3000) < 1e-6);
});

console.log('角速度兜底（由姿态差分反推）');

/** 由轴角构造四元数 */
const qAA = (axis, deg) => {
  const h = (deg * Math.PI) / 360;
  const n = Math.hypot(...axis);
  const s = Math.sin(h) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};

t('绕设备 x 轴 30°/16.7ms → ω ≈ 31.4 rad/s', () => {
  const w = omegaFromQuatDelta([0, 0, 0, 1], qAA([1, 0, 0], 30), 0.0167);
  assert.ok(Math.abs(w[0] - (Math.PI / 6) / 0.0167) < 0.05, `wx=${w[0].toFixed(3)}`);
  assert.ok(Math.abs(w[1]) < 1e-9 && Math.abs(w[2]) < 1e-9);
});

t('带上基准姿态后，增量仍然落在设备系', () => {
  // 先随便转一个姿态，再绕自身 x 轴追加 20°：算出来的 ω 必须还是纯 x
  const base = qAA([0, 1, 0], 70);
  const cur = qmul(base, qAA([1, 0, 0], 20));
  const w = omegaFromQuatDelta(base, cur, 0.02);
  assert.ok(Math.abs(w[0] - (Math.PI / 9) / 0.02) < 0.05, `wx=${w[0].toFixed(3)}`);
  assert.ok(Math.abs(w[1]) < 1e-6 && Math.abs(w[2]) < 1e-6, '不该漏到别的轴上');
});

t('q 与 −q 是同一个姿态，差分必须为 0', () => {
  // 不取最短弧的话这里会算出「转了 360°」的假角速度
  const q = qAA([0.3, -0.5, 0.8], 47);
  const w = omegaFromQuatDelta(q, q.map((v) => -v), 0.016);
  assert.ok(Math.hypot(...w) < 1e-9, `实际 ${w.map((v) => v.toFixed(4))}`);
});

t('dt 不合理时不产出角速度', () => {
  assert.deepStrictEqual(omegaFromQuatDelta([0, 0, 0, 1], qAA([1, 0, 0], 90), 0), [0, 0, 0]);
  assert.deepStrictEqual(omegaFromQuatDelta([0, 0, 0, 1], qAA([1, 0, 0], 90), 2), [0, 0, 0]);
  assert.deepStrictEqual(omegaFromQuatDelta([0, 0, 0, 1], [0, 0, 0, 1], 0.016), [0, 0, 0]);
});

console.log('挥拍检测');

/** 按 16ms 等间隔喂一串角速度幅值，返回期间产生的所有 Stroke */
const feed = (det, mags, t0 = 0, dt = 16) => {
  const out = [];
  mags.forEach((w, i) => {
    const s = det.push({ t: t0 + i * dt, omega: [w, 0, 0], q: [0, 0, 0, 1] });
    if (s) out.push(s);
  });
  return out;
};

t('静止晃动不触发', () => {
  const det = new SwingDetector();
  let n = 0;
  for (let i = 0; i < 200; i++) {
    // 0.5–2.5 rad/s 的手抖，全部低于阈值
    if (det.push({ t: i * 16, omega: [0.5 + (i % 5) * 0.5, 0, 0], q: [0, 0, 0, 1] })) n++;
  }
  assert.strictEqual(n, 0);
});

t('一次挥拍只出一个峰，不会一挥手打出三四个球', () => {
  const det = new SwingDetector();
  const out = feed(det, [1, 2, 3, 5, 9, 14, 15.5, 11, 6, 3, 1]);
  assert.strictEqual(out.length, 1, `应恰好 1 次，实际 ${out.length}`);
  assert.ok(Math.abs(out[0].peakW - 15.5) < 1e-9);
});

t('260ms 冷却期内不重复触发，之后恢复', () => {
  const det = new SwingDetector();
  const first = feed(det, [1, 2, 3, 5, 9, 14, 15.5, 11, 6, 3, 1]);
  assert.strictEqual(first.length, 1);

  // 紧接着再挥一拍：物理上不可能，必须被冷却挡掉
  const during = feed(det, [1, 2, 9, 15, 11, 4], 176);
  assert.strictEqual(during.length, 0, '冷却期内不应触发');

  // 隔了 400ms 之后应该能正常识别
  const after = feed(det, [1, 2, 9, 15, 11, 4], 500);
  assert.strictEqual(after.length, 1, '冷却过后应恢复触发');
});

t('结算发生在峰值后 1–2 帧，而不是等整个动作收完', () => {
  const det = new SwingDetector();
  // 峰值在 index 6，之后是真实挥拍的拖尾（14 → 12 → 9 → 6 …）。
  // 旧版要等跌到峰值的 75%（11.6）才结算，那时球已经在击球面上悬了 50–90ms。
  const mags = [1, 2, 3, 5, 9, 14, 15.5, 14, 12, 9, 6, 4, 2, 1];
  let firedIdx = -1;
  mags.forEach((w, i) => {
    const s = det.push({ t: i * 16, omega: [w, 0, 0], q: [0, 0, 0, 1] });
    if (s && firedIdx < 0) firedIdx = i;
  });
  assert.ok(firedIdx > 0, '应该识别到挥拍');
  const delayMs = (firedIdx - 6) * 16;
  assert.ok(delayMs <= 32, `结算比峰值晚 ${delayMs}ms，应控制在 2 帧（32ms）以内`);
});

t('平台段（同一个值被重复发送）上也能及时结算', () => {
  const det = new SwingDetector();
  // 60Hz 发包 + 30Hz 姿态：峰值被连发三次
  const mags = [1, 3, 9, 15, 15, 15, 12, 8, 4, 1];
  let firedIdx = -1;
  mags.forEach((w, i) => {
    const s = det.push({ t: i * 16, omega: [w, 0, 0], q: [0, 0, 0, 1] });
    if (s && firedIdx < 0) firedIdx = i;
  });
  assert.ok(firedIdx > 0, '平台段不该吞掉挥拍');
  assert.ok((firedIdx - 3) * 16 <= 64, `平台结束后应尽快结算，实际 ${(firedIdx - 3) * 16}ms`);
});

t('球到面时能直接取到「正在挥」的快照，且窗口外的时刻不给', () => {
  const det = new SwingDetector();
  feed(det, [1, 3, 8, 15], 0, 16);
  assert.strictEqual(det.swinging, true, '刚过峰值应处于挥拍中');

  const live = det.peekLive(48);
  assert.ok(live, '峰值时刻应能取到快照');
  assert.strictEqual(live.provisional, true, '快照要标记成抢跑版本');
  assert.ok(Math.abs(live.peakW - 15) < 1e-9, `快照应带当前峰值，实际 ${live.peakW}`);

  // 球到面时刻离峰太远，说明这一下不是在打这个球
  assert.strictEqual(det.peekLive(48 + 400), null, '窗口外的时刻不该给快照');
});

t('抢跑消费掉的那一挥，回落时不会被重复结算', () => {
  const det = new SwingDetector();
  const out = [];
  const mags = [1, 3, 8, 15, 14, 12, 8, 5, 2, 1, 1];
  mags.forEach((w, i) => {
    const s = det.push({ t: i * 16, omega: [w, 0, 0], q: [0, 0, 0, 1] });
    if (s) out.push(s);
    if (i === 3) det.consumeLive();
  });
  assert.strictEqual(out.length, 0, `抢跑之后不该再结算，实际多出 ${out.length} 次`);
});

t('抢跑之后动作落回去，还能正常识别下一拍', () => {
  const det = new SwingDetector();
  feed(det, [1, 3, 8, 15], 0, 16);
  det.consumeLive();
  feed(det, [14, 10, 4, 1, 1], 64, 16); // 收势
  const out = feed(det, [1, 3, 9, 15, 11, 4], 600);
  assert.strictEqual(out.length, 1, '第二拍应正常识别');
});

t('拍头速度 = ω × r，且必然垂直于握把', () => {
  const det = new SwingDetector();
  const out = feed(det, [1, 2, 9, 30, 15, 5]);
  assert.strictEqual(out.length, 1);
  const s = out[0];
  // 单位姿态下 grip=(0,1,0)、ω=(30,0,0)，ω×r 只能落在 +Z 上
  assert.ok(s.head[2] > 1, `拍头应朝 +Z，实际 ${s.head.map((v) => v.toFixed(2))}`);
  assert.ok(Math.abs(s.head[0]) < 1e-6 && Math.abs(s.head[1]) < 1e-6, '拍头速度只应有 Z 分量');
  const along = s.head[0] * s.grip[0] + s.head[1] * s.grip[1] + s.head[2] * s.grip[2];
  assert.ok(Math.abs(along) < 1e-9, `v=ω×r 必须垂直于 r，实际点积 ${along}`);
});

/**
 * 真机上最致命的一种输入形态：
 * 大屏以 60Hz 发包，但 deviceorientation 只有 30Hz（很多安卓机、以及 iOS 省电模式），
 * 于是同一个角速度值会被连发好几次，序列里出现「平台段」。
 * 老的三点检测要求 w1 严格大于左右两边，平台段上每个点都不满足，整次挥拍被静默丢掉。
 * 这是「挥拍 = 1，到面 = 43」的直接原因。
 */
t('同一采样被重复发送（平台段）仍能检测到挥拍', () => {
  // 每个值重复发送 3 次，模拟 20Hz 姿态 / 60Hz 发包
  const stretched = [0.4, 1.2, 4.0, 8.5, 13.2, 13.2, 13.2, 9.1, 5.0, 2.0, 0.8];
  const det = new SwingDetector();
  let n = 0;
  stretched.forEach((w, i) => {
    for (let k = 0; k < 3; k++) {
      if (det.push({ t: i * 50 + k * 16.7, omega: [w, 0, 0], q: [0, 0, 0, 1] })) n++;
    }
  });
  assert.strictEqual(n, 1, `平台段输入应识别出 1 次挥拍，实际 ${n}`);
});

t('重复采样下拿到的峰值是真实峰值，不是平台后的残余', () => {
  const det = new SwingDetector();
  let got = null;
  [0.4, 2.0, 7.0, 15.8, 15.8, 15.8, 15.8, 6.0, 1.0].forEach((w, i) => {
    for (let k = 0; k < 2; k++) {
      const s = det.push({ t: i * 33 + k * 16.5, omega: [w, 0, 0], q: [0, 0, 0, 1] });
      if (s) got = s;
    }
  });
  assert.ok(got, '应该识别出挥拍');
  assert.ok(Math.abs(got.peakW - 15.8) < 1e-9, `峰值应为 15.8，实际 ${got.peakW}`);
});

t('一直匀速转动不算挥拍（超时兜底）', () => {
  const det = new SwingDetector();
  let n = 0;
  // 稳定 6 rad/s 转了 2 秒：那是「转」，不是「挥」
  for (let i = 0; i < 120; i++) {
    if (det.push({ t: i * 16.7, omega: [6, 0, 0], q: [0, 0, 0, 1] })) n++;
  }
  assert.strictEqual(n, 0, `匀速转动不应产生挥拍，实际 ${n}`);
});

t('球速被夹在可打区间内，毛刺不会打出炮弹', () => {
  const det = new SwingDetector();
  const soft = feed(det, [1, 2, 4, 6, 9, 5, 2])[0];
  assert.ok(Math.abs(soft.speed - 18) < 1e-9, `轻挥应兜到下限 18，实际 ${soft.speed}`);

  det.reset();
  const hard = feed(det, [1, 3, 10, 30, 60, 40, 10])[0];
  assert.ok(Math.abs(hard.speed - 32) < 1e-9, `重挥应削到上限 32，实际 ${hard.speed}`);
  assert.ok(hard.charge >= 0 && hard.charge <= 1);
});

console.log('出球模型');

const strokeOf = (head, face = [0, 0, -1], grip = [0, 1, 0]) => ({
  t: 0,
  peakW: 12,
  head,
  speed: Math.hypot(...head),
  face,
  grip,
  charge: 0.5,
  used: false,
});

t('拍面正对球场 → 球朝 -Z 飞，判为干净击球', () => {
  const shot = shotFromStroke(strokeOf([0, 2, -14]));
  assert.ok(shot.clean);
  assert.ok(shot.alignment > 0.9);
  assert.ok(shot.v[2] < -15, `应向 -Z 飞，实际 vz=${shot.v[2]}`);
  assert.ok(Math.abs(shot.v[0]) < 1, '不该无故横飞');
});

t('拍框正对来球（拍面侧着 90°）→ 球横飞，判为没打开', () => {
  const shot = shotFromStroke(strokeOf([6, 0, -14], [1, 0, 0]));
  assert.strictEqual(shot.clean, false);
  assert.ok(shot.alignment < 0.2, `侧着时对齐度应接近 0，实际 ${shot.alignment.toFixed(2)}`);
});

t('反手：法线朝后照样打出，方向和正手完全一致（拍子是双面的）', () => {
  // 11-15 真机反馈「反手无法接球」：设备只给一根 +z 法线，反手时手机翻了个面，
  // 这根法线指着身后。不翻的话这里会走「拍面背对」那条分支，球飞回自己半场。
  const fore = shotFromStroke(strokeOf([0, 2, -14], [0, 0, -1]));
  const back = shotFromStroke(strokeOf([0, 2, -14], [0, 0, 1]));
  assert.ok(back.clean, '反手不该被判成「拍面没打开」');
  assert.ok(back.v[2] < -15, `反手也要朝 -Z 飞，实际 vz=${back.v[2].toFixed(1)}`);
  assert.ok(Math.abs(back.v[0] - fore.v[0]) < 1e-9 && Math.abs(back.v[2] - fore.v[2]) < 1e-9,
    '两面等价：同一个动作、同样的出球');
  assert.ok(Math.abs(back.spin[1] - fore.spin[1]) < 1e-9, '旋转也不该因为翻面而反号');
});

t('frontFace：只翻「明确背对球场」的，拍面接近水平时不乱翻', () => {
  // 用分量比较而不是 deepStrictEqual：翻面会得到 -0，而 -0 与 0 在严格相等里不相等
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
  assert.ok(same(frontFace([0, 0, 1]), [0, 0, -1]), '明确朝后 → 翻');
  assert.ok(same(frontFace([0, 0, -1]), [0, 0, -1]), '已经朝前 → 不动');
  assert.ok(same(frontFace([0, 1, 0]), [0, 1, 0]), '屏幕朝天：法线水平分量在零附近抖，不能翻');
  assert.ok(same(frontFace([0.2, -0.3, 0.1]), [0.2, -0.3, 0.1]), '接近侧向也不翻');
  const once = frontFace([-0.3, -0.2, 0.9]);
  assert.ok(same(frontFace(once), once), '幂等：翻过之后不会再翻回去');
});

t('向上刷 = 上旋，向下切 = 下旋', () => {
  const top = shotFromStroke(strokeOf([0, 9, -8]));
  const slice = shotFromStroke(strokeOf([0, -9, -8]));
  assert.ok(top.topSpin > 100, `上刷应为上旋，实际 ${top.topSpin.toFixed(1)}`);
  assert.ok(slice.topSpin < -100, `下切应为下旋，实际 ${slice.topSpin.toFixed(1)}`);
});

t('横向挥拍 → 侧旋，并让球往挥拍那一侧偏', () => {
  const side = shotFromStroke(strokeOf([10, 0, -14]));
  assert.ok(Math.abs(side.sideSpin) > 40, `应有侧旋，实际 ${side.sideSpin.toFixed(1)}`);
  assert.ok(side.v[0] > 1, `球应跟着挥拍方向偏，实际 vx=${side.v[0].toFixed(2)}`);
  assert.ok(side.v[2] < -15, '偏归偏，不能丢掉向前的速度');

  // 挥得越横，侧旋越大
  const light = shotFromStroke(strokeOf([5, 0, -14]));
  assert.ok(Math.abs(side.sideSpin) > Math.abs(light.sideSpin));
});

console.log('弹道');

/** 平飞 0.5 秒后，竖直速度变成多少 */
const vyAfter = (spin) => {
  const b = makeBall([0, 3, 0], [0, 2, -20], spin);
  for (let i = 0; i < 30; i++) advance(b, 1 / 60, () => {});
  return b.v[1];
};

t('上旋球必须比平击球下坠得快（马格努斯叉乘顺序）', () => {
  const flat = vyAfter([0, 0, 0]);
  // 球朝 -Z 飞，上旋轴是 +X。叉乘写反（ω×v）的话这里会变成「上飘」，整个旋转玩法就废了
  const top = vyAfter([400, 0, 0]);
  assert.ok(flat - top > 0.6, `上旋应额外下坠，平击 vy=${flat.toFixed(2)} 上旋 vy=${top.toFixed(2)}`);
});

t('静止的球不再刷碰撞事件', () => {
  const b = makeBall([0, BALL_R, -3], [0, 0, 0]);
  let n = 0;
  for (let i = 0; i < 120; i++) advance(b, 1 / 60, () => n++);
  assert.strictEqual(n, 0, `静止球不该产生事件，实际 ${n} 个`);
});

console.log('拍面碰撞');

/** 默认拍：竖直握拍、拍面朝 +z、拍面中心在 (0, 0.85+0.6, HIT_Z) */
const flatPose = (t = 0, x = 0) => ({ t, pos: [x, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] });
const FACE_MID_Y = RACKET_POS[1] + 0.6;

t('球从正面穿过拍面中心 → 命中，甜区偏离接近 0', () => {
  const h = sweepFace(flatPose(), [0, FACE_MID_Y, HIT_Z + 0.5], [0, FACE_MID_Y, HIT_Z - 0.5]);
  assert.ok(h, '正中心的球必须命中');
  assert.ok(Math.abs(h.at[2] - HIT_Z) < 1e-6, `命中点应在拍面上，实际 z=${h.at[2]}`);
  assert.ok(h.offCenter < 0.05, `应在甜区，实际偏离 ${h.offCenter.toFixed(2)}`);
});

t('横向偏出拍框 → 不算命中', () => {
  // 半宽 15cm + 球半径 3.35cm + 容差 1.2cm ≈ 19.5cm
  const near = sweepFace(flatPose(), [0.18, FACE_MID_Y, HIT_Z + 0.4], [0.18, FACE_MID_Y, HIT_Z - 0.4]);
  const far = sweepFace(flatPose(), [0.42, FACE_MID_Y, HIT_Z + 0.4], [0.42, FACE_MID_Y, HIT_Z - 0.4]);
  assert.ok(near, '18cm 还在拍框内沿，应该算擦框命中');
  assert.strictEqual(far, null, '42cm 已经远在拍面之外，不该命中');
});

t('纵向偏出拍头 → 不算命中', () => {
  // 半长 19cm + 球半径 + 容差 ≈ 23.5cm
  const ok = sweepFace(flatPose(), [0, FACE_MID_Y + 0.2, HIT_Z + 0.4], [0, FACE_MID_Y + 0.2, HIT_Z - 0.4]);
  const over = sweepFace(flatPose(), [0, FACE_MID_Y + 0.5, HIT_Z + 0.4], [0, FACE_MID_Y + 0.5, HIT_Z - 0.4]);
  assert.ok(ok, '20cm 还在拍面内，应该命中');
  assert.strictEqual(over, null, '50cm 已过拍头，不该命中');
});

t('一步跨过整个拍面也不漏（这是必须做线段求交的唯一理由）', () => {
  // 40 m/s 的球在 4.17ms 子步里走 17cm，但一帧里能走 70cm——
  // 起点和终点都在拍面两侧远处，任何「点在不在椭圆里」的判定都会漏。
  const h = sweepFace(flatPose(), [0, FACE_MID_Y, HIT_Z + 0.45], [0, FACE_MID_Y, HIT_Z - 0.45]);
  assert.ok(h, '高速球穿过去必须仍能命中');
  // 反证：同一对端点，单纯的点判定两端都不在拍面上
  assert.strictEqual(faceCovers(flatPose(), [0, FACE_MID_Y, HIT_Z + 0.45]), false);
  assert.strictEqual(faceCovers(flatPose(), [0, FACE_MID_Y, HIT_Z - 0.45]), false);
});

t('球顺着拍面掠过（球路几乎平行于拍面）时算接触，不算穿模', () => {
  // 判据是「球心到拍面圆盘的距离 ≤ 球半径」，不是「球心穿过拍面平面」。
  //
  // 差别只在掠射时出现：球路几乎平行于拍面，球心可能永远不穿过平面，
  // 但球体已经压到拍线上了。按「必须穿过平面」判会漏，而漏掉的那 16ms
  // 在屏幕上就是「球从拍子中间穿过去」——玩家不会认为是自己拍面角度不对，
  // 只会认为碰撞坏了。真网球这时候是擦框，也是要弹一下的。
  const s = Math.SQRT1_2;
  const edge = { t: 0, pos: [0, RACKET_POS[1], HIT_Z], q: [0, s, 0, s] };
  const h = sweepFace(edge, [0, FACE_MID_Y, HIT_Z + 0.5], [0, FACE_MID_Y, HIT_Z - 0.5]);
  assert.ok(h, '球心正在拍面这层里，球体必然压到拍线 → 必须算接触');

  // 但「碰到了」不等于「打好了」：拍面法线几乎垂直于来球，出球方向会歪到一边，
  // shotFromStroke 会判「拍面没打开」。这条分开的判定是玩法的一部分。
  const shot = shotFromStroke({
    t: 0,
    peakW: 12,
    head: [0, 2, -12],
    speed: 12,
    face: [1, 0, 0],
    grip: [0, 1, 0],
    charge: 0.5,
    used: false,
  });
  assert.ok(!shot.clean, '拍面侧对球场时不该判干净击球');
});

t('拍面前倾 45° 后，拍面中心确实前移下移（并且仍能接住正对它来的球）', () => {
  const s = Math.sin(Math.PI / 8);
  const c = Math.cos(Math.PI / 8);
  const tilt = { t: 0, pos: [0, RACKET_POS[1], HIT_Z], q: [s, 0, 0, c] };
  // 拍面中心 = 握点 + R·(0, FACE_CY, 0)，前倾后 z 变大、y 变小
  // 半角是 22.5°，但旋转量是 45°，所以拍面中心用的是 cos45/sin45
  const cy = RACKET_POS[1] + 0.6 * Math.SQRT1_2;
  const cz = HIT_Z + 0.6 * Math.SQRT1_2;
  const h = sweepFace(tilt, [0, cy, cz + 0.5], [0, cy, cz - 0.5]);
  assert.ok(h, '正对倾斜后的拍面中心来球，必须命中');
  assert.ok(h.offCenter < 0.1, `应打在甜区附近，实际 ${h.offCenter.toFixed(2)}`);
  // 拍面角度真的改变了可击球位置：前倾 45° 后中心前移 42cm、下降 18cm。
  // 这就是「拍面参与判定」的直接证据——相机位、站位都不变，只是手腕角度变了。
  assert.ok(cz > HIT_Z + 0.35, `前倾后拍面中心应前移，实际 z=${cz.toFixed(2)}`);
  assert.ok(cy < FACE_MID_Y - 0.12, `前倾后拍面中心应降低，实际 y=${cy.toFixed(2)}`);
});

t('位姿插值：两帧之间取到的是中间姿态，不是前一帧', () => {
  const track = new RacketTrack();
  track.push({ t: 0, pos: [0, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] });
  const s = Math.SQRT1_2;
  track.push({ t: 100, pos: [0, RACKET_POS[1], HIT_Z], q: [0, s, 0, s] });
  const mid = track.at(50);
  assert.ok(mid, '区间内必须有位姿');
  // 90° 的一半 = 45°，四元数 w = cos(22.5°)
  const half = Math.cos(Math.PI / 8);
  assert.ok(Math.abs(mid.q[3] - half) < 1e-6, `插值应是 45°，实际 w=${mid.q[3].toFixed(4)}`);
  assert.ok(Math.abs(mid.q[1] - Math.sin(Math.PI / 8)) < 1e-6);
});

t('位姿插值走短弧：q 与 -q 是同一个旋转，不能算出反向路径', () => {
  const track = new RacketTrack();
  track.push({ t: 0, pos: [0, 1, 0], q: [0, 0, 0, 1] });
  // 故意用 -q 表示同一个「转了 10°」的姿态
  const a = (10 * Math.PI) / 180 / 2;
  track.push({ t: 100, pos: [0, 1, 0], q: [-0, -Math.sin(a) * -1, -0, -Math.cos(a)] });
  const mid = track.at(50);
  assert.ok(mid.q[3] < 0 === false || Math.abs(mid.q[3]) > 0.9, '插值不应飞到反方向');
  assert.ok(Math.abs(Math.abs(mid.q[3]) - Math.cos(2.5 * Math.PI / 180)) < 0.05);
});

console.log('挥拍时的球拍位姿');

/** 绕世界轴转 deg 度 → [x,y,z,w] */
const quatAxis = (axis, deg) => {
  const a = (deg * Math.PI) / 360;
  const s = Math.sin(a);
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(a)];
};
const vdist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

t('挥拍时拍面中心会绕握点扫出去——这是正常挥拍，不是 bug', () => {
  // 手机只给得出角度、给不出手的位置，所以球拍只能是「握点固定 + 绕握点旋转」。
  // 拍面中心挂在 0.6m 杆末，转 60° 就扫出 0.6m，比整个拍面（半宽 15cm）还宽。
  //
  // 这条测试钉住的是**这个几何事实本身**：谁要是又把拍面中心锚死，
  // 屏幕上就会变成「拍子只会转、不会挥」，那就不是挥拍了。
  const rest = { t: 0, pos: [...RACKET_POS], q: [0, 0, 0, 1] };
  const swung = { t: 0, pos: [...RACKET_POS], q: quatAxis([1, 0, 0], 60) };
  const d = vdist(faceCenter(swung), faceCenter(rest));
  assert.ok(d > 0.45, `转 60° 拍面中心应当扫出半米以上，实际 ${d.toFixed(2)}m`);
});

t('参考握法下拍面中心就在握点正上方 FACE_CY', () => {
  const pose = { t: 0, pos: [...RACKET_POS], q: [0, 0, 0, 1] };
  const fc = faceCenter(pose);
  assert.ok(Math.abs(fc[1] - (RACKET_POS[1] + FACE_CY)) < 1e-9, '拍面中心高度不对');
  assert.ok(Math.abs(fc[0] - RACKET_POS[0]) < 1e-9 && Math.abs(fc[2] - RACKET_POS[2]) < 1e-9);
});

/* ================= 对打（脚本回球机 + 判分） =================
 *
 * 这一整节都跑在「场地里没有墙」的前提下——11-15 删掉对墙打之后，物理里那个
 * 练习墙碰撞面也一起删了（`physics.ts` 的 `advance` 不再有 wall 分支），所以这里
 * 没有开关要拨。放在文件最后是因为下面这些用例的球都从对手底线附近起飞。
 */

/**
 * 复算一条弹道，给出过网高度、到面高度、第一落点。
 *
 * 判定层的 `shootToLand` 没有导出，这里用 `advance` 的子步回调自己插值——
 * 顺便保证断言看的是**真实物理**，而不是求解器自己算的那份中间量。
 */
function flightOf(from, v, spin) {
  const b = makeBall(from, [...v], [...spin]);
  let netY = null;
  let planeY = null;
  let land = null;
  const st = { netted: false };
  for (let i = 0; i < 240 * 8 && b.live; i++) {
    advance(
      b,
      PHYS_DT,
      (c) => {
        if (c.kind === 'net') st.netted = true;
        if (c.kind === 'ground' && !land) land = [c.at[0], c.at[2]];
      },
      (p0, p1) => {
        const cross = (plane) => {
          if (p1[2] === p0[2]) return null;
          if ((p0[2] - plane) * (p1[2] - plane) > 0) return null;
          return p0[1] + ((p1[1] - p0[1]) * (plane - p0[2])) / (p1[2] - p0[2]);
        };
        if (netY === null) netY = cross(NET_Z);
        if (planeY === null) planeY = cross(HIT_Z);
      }
    );
  }
  return { netY, planeY, land, netted: st.netted };
}

/** 回球机的真实出球条件（和 machine.ts 的 aimOpts 一致） */
const DUEL_FROM = [0, 1.15, OPP_HIT_Z];
const DUEL_SPIN = [-90, 0, 0];
const DUEL_AIM = {
  maxClear: 2.8,
  speed: [8, 26],
  arriveZ: HIT_Z,
  arriveY: [ARRIVE_Y_MIN, ARRIVE_Y_MAX],
  arriveTol: 0.12,
};

console.log('自动走位（把玩家搬到球会经过的位置）');

/**
 * 站位状态 + 握法偏移。`center` 是拍面中心相对握点的偏移（世界系），长度 0.6。
 * 竖握 = 拍柄朝上，中心在握点正上方；横握 = 拍柄朝侧，中心在握点侧方。
 */
const VERT = (x = 0, z = HIT_Z) => ({ x, z, center: [0, FACE_CY, 0] });
const HORIZ = (x = 0, z = HIT_Z) => ({ x, z, center: [FACE_CY, 0, 0] });

/** 一条真实的回球机来球（和 duel-sim 用同一组求解条件）。 */
const duelShot = (arriveY) => {
  const from = [0, 1.15, OPP_HIT_Z];
  const v = aimIntoCourt(from, [0, BALL_R, -4], [-90, 0, 0], { ...DUEL_AIM, arriveY });
  assert.ok(v, `arriveY ${arriveY} 应该解得出来`);
  return makeBall(from, v, [-90, 0, 0]);
};

t('朝我飞来的球 → 握点目标让拍面中心落在球的弹道上', () => {
  const b = duelShot([1.4, 1.45]);
  const plan = planAutoMove(b, VERT());
  assert.equal(plan.chasing, true);
  assert.ok(plan.eta > 0.5, `应该给出到面剩余时间，实际 ${plan.eta}`);
  // 竖握时中心在握点正上方，所以握点 x 就该等于球在那个平面的 x
  const at = predictAtPlane(b, plan.targetZ);
  assert.ok(at, '目标平面应该在弹道上');
  assert.ok(Math.abs(plan.target - at.x) < 0.06, `握点 x ${plan.target.toFixed(3)} 应贴合球心 x ${at.x.toFixed(3)}`);
  assert.ok(plan.targetZ >= AUTO_MOVE_DEFAULTS.minZ && plan.targetZ <= AUTO_MOVE_DEFAULTS.maxZ,
    `目标 z ${plan.targetZ} 必须落在可站范围里`);
});

t('弹道采样：10cm 等距、时间递增，且和精确穿面点吻合', () => {
  const b = duelShot([1.4, 1.45]);
  const pts = sampleCrossings(b, AUTO_MOVE_DEFAULTS.minZ, AUTO_MOVE_DEFAULTS.maxZ);
  assert.ok(pts.length >= 15, `1.9m 范围按 10cm 分格应该十几点，实际 ${pts.length}`);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].t > pts[i - 1].t, `第 ${i} 点时间没递增`);
    assert.ok(Math.abs(pts[i].z - pts[i - 1].z - 0.1) < 1e-6, `第 ${i} 点网格不均匀`);
  }
  // 同一平面，采样插值与精确穿越的时间差最多一个物理帧（1/240s）
  const mid = pts[Math.floor(pts.length / 2)];
  const exact = predictAtPlane(b, mid.z);
  assert.ok(exact, '中间那个平面应该在弹道上');
  assert.ok(Math.abs(exact.t - mid.t) < 0.02, `时间差 ${Math.abs(exact.t - mid.t).toFixed(3)}s`);
  assert.ok(Math.abs(exact.y - mid.y) < 0.06, `高度差 ${Math.abs(exact.y - mid.y).toFixed(3)}m`);
});

t('横握时补偿拍面中心的横向偏移：握点要站到球的侧边半个拍杆', () => {
  const b = duelShot([1.4, 1.45]);
  const vert = planAutoMove(b, VERT());
  const horiz = planAutoMove(b, HORIZ());
  assert.equal(horiz.chasing, true);
  // 中心在握点 +x 侧 0.6m，握点就得往 -x 挪同样多，才让**中心**落到球上
  const at = predictAtPlane(b, horiz.targetZ);
  assert.ok(Math.abs(horiz.target + FACE_CY - at.x) < 0.06,
    `握点 ${horiz.target.toFixed(2)} + 0.6 应落在球心 ${at.x.toFixed(2)}`);
  // 竖握时两者重合：这条对照证明偏移只来自握法，不是别的东西
  const atV = predictAtPlane(b, vert.targetZ);
  assert.ok(Math.abs(vert.target - atV.x) < 0.06);
  assert.ok(Math.abs((horiz.target + FACE_CY) - (vert.target + FACE_CY * 0)) > 0.4 ||
            Math.abs(horiz.target - vert.target) > 0.4,
    `横握要少走约 0.6m，实际竖 ${vert.target.toFixed(2)} / 横 ${horiz.target.toFixed(2)}`);
});

t('高低差靠举拍/屈膝解决，不再靠前后跑', () => {
  // 这是 11-13 第二次修正的核心：握点高度变成第三个自由度之后，「球高了」的答案
  // 不再是「退到球掉下来」，而是「把拍子沉下去」。后者既不退到场外，也不会把球
  // 接在腰以下（那正是「看着打上了却没打上」的根源）。
  const b = duelShot([1.4, 1.45]);
  const vert = planAutoMove(b, VERT());
  const horiz = planAutoMove(b, HORIZ());
  assert.equal(vert.chasing, true);
  assert.equal(horiz.chasing, true);

  // 拍面中心 = 握点 + 中心偏移。选出来的握点高度必须让拍面正好落在球的到面高度上
  assert.ok(Math.abs(vert.targetY + FACE_CY - vert.hitY) < 0.03,
    `竖握：握点 ${vert.targetY.toFixed(2)} + 0.6 应等于球高 ${vert.hitY && vert.hitY.toFixed(2)}`);
  assert.ok(Math.abs(horiz.targetY + 0 - horiz.hitY) < 0.03,
    `横握：握点 ${horiz.targetY.toFixed(2)} 应等于球高 ${horiz.hitY && horiz.hitY.toFixed(2)}`);
  // 竖握要沉到 0.85 一带（屈膝），横握几乎不用动（来球本来就对着胸口）
  assert.ok(vert.targetY < RACKET_POS[1] - 0.3, `竖握应该屈膝，实际握点 ${vert.targetY.toFixed(2)}`);
  assert.ok(Math.abs(horiz.targetY - RACKET_POS[1]) < 0.25, `横握不该大动，实际 ${horiz.targetY.toFixed(2)}`);
  // 两种握法都不为高度退/进太多
  assert.ok(Math.abs(vert.targetZ - AUTO_MOVE_DEFAULTS.homeZ) < 0.4,
    `竖握站位不该为高度跑动：${vert.targetZ.toFixed(2)}`);
  assert.ok(Math.abs(horiz.targetZ - AUTO_MOVE_DEFAULTS.homeZ) < 0.4,
    `横握站位不该为高度跑动：${horiz.targetZ.toFixed(2)}`);
  // 握点高度必须落在身体范围内
  assert.ok(vert.targetY >= AUTO_MOVE_DEFAULTS.minGripY - 1e-9 && vert.targetY <= AUTO_MOVE_DEFAULTS.maxGripY + 1e-9);
});

t('不朝我飞就不追：几乎没有前进速度的慢球不当成来球', () => {
  // 球就在身边横向飘（z 速度 0.4 m/s < 门槛 0.6），预测器照样算得出它穿过
  // 击球面的点，所以「不追」必须由 z 速度判据负责，不能靠预测器返回 null 兜住。
  const b = makeBall([1.4, 1.5, HIT_Z - 0.1], [1.2, 0.8, 0.4]);
  assert.ok(predictAtPlane(b, HIT_Z), '这条慢球也应该能算出穿面点');
  const plan = planAutoMove(b, VERT());
  assert.equal(plan.chasing, false, '前进速度低于门槛，不是「朝我来的球」');
  assert.equal(plan.target, 0);
  assert.equal(plan.eta, null);
});

t('不朝我飞就不追：飞向对面的球也不追', () => {
  const plan = planAutoMove(makeBall([0.6, 1.4, -6], [0.6, 0.4, -4]), VERT());
  assert.equal(plan.chasing, false);
  assert.equal(plan.target, 0);
});

t('球越过拍面所在平面就站住：不跟着球往后跑', () => {
  // 旧版用 maxZ（底线外）当上界，于是球飞过身侧之后规划器还在往后找一个
  // 「更高/更低」的平面，人就被球牵着退——玩家看到的是「球贴着我飞、拍子却够不到」。
  // 现在判据是**拍面所在平面**：过了就站住，这一拍认了。
  const behind = makeBall([1.4, 1.2, HIT_Z + 0.4], [0, 0.2, 5]);
  const plan = planAutoMove(behind, VERT());
  assert.equal(plan.chasing, false);
  assert.equal(plan.target, 0, '站住 = 目标就是当前位置');
  assert.equal(plan.targetZ, HIT_Z);

  // 还差 1 米才到身边：必须追
  const front = makeBall([1.4, 1.2, HIT_Z - 1.0], [0, 0.2, 5]);
  assert.equal(planAutoMove(front, VERT()).chasing, true, '还没到身边就该追');
});

t('网前的短球要往前迎，不是站在击球面等它二次落地', () => {
  // 这条球弹起后最高只到 0.86m，在 z≈-1.0 就二次落地判死（弹道采样在这里截断）。
  // 规划器必须把目标放到身前一米以上，否则玩家会站在原地等一颗永远到不了的球。
  const b = makeBall([0, 0.9, -6], [0, 3.0, 4.0]);
  const pts = sampleCrossings(b, AUTO_MOVE_DEFAULTS.minZ, AUTO_MOVE_DEFAULTS.maxZ);
  assert.ok(pts.length > 4, `应该采到几个点，实际 ${pts.length}`);
  assert.ok(pts[pts.length - 1].z < HIT_Z - 0.5,
    `二次落地之后不该再采样，最远只到 z=${pts[pts.length - 1].z.toFixed(2)}`);
  const plan = planAutoMove(b, VERT());
  assert.equal(plan.chasing, true);
  assert.ok(plan.targetZ < AUTO_MOVE_DEFAULTS.homeZ - 1.0,
    `要往前迎：目标 z=${plan.targetZ.toFixed(2)}`);
  assert.ok(plan.targetZ >= AUTO_MOVE_DEFAULTS.minZ - 1e-9, '不能跑出可站范围');
});

t('球已经死了就回中线，不留在原地发呆', () => {
  const b = makeBall([0, 1.2, -6], [0, 0, 0]);
  b.live = false;
  const plan = planAutoMove(b, VERT());
  assert.equal(plan.chasing, false);
  assert.equal(plan.target, 0);
});

t('限速：一帧最多挪 speed×dt，不会瞬移过去', () => {
  const dt = 1 / 60;
  const got = stepAxis(3, 0, AUTO_MOVE_DEFAULTS.speed * dt, 0);
  assert.ok(Math.abs(got - (3 - AUTO_MOVE_DEFAULTS.speed * dt)) < 1e-9, `实际 ${got}`);
});

t('进了死区就停，不贴着球正下方左右抖', () => {
  assert.equal(stepAxis(0.03, 0, 0.08, 0.05), 0.03);
  assert.equal(stepAxis(0.049, 0, 0.08, 0.05), 0.049);
});

t('一步够得到就正好停在目标上，不越过它', () => {
  assert.equal(stepAxis(0.2, 0, 0.5, 0), 0);
  assert.equal(stepAxis(-0.2, 0, 0.5, 0), 0);
});

t('反向也对称（左跑和右跑一样快）', () => {
  assert.equal(stepAxis(0, 2, 0.5, 0), 0.5);
  assert.equal(stepAxis(0, -2, 0.5, 0), -0.5);
});

t('握法偏移只在没挥拍的帧采信：挥拍中冻结，静止两秒内收敛', () => {
  const q0 = [0, 0, 0, 1];
  const off = [0, FACE_CY, 0];
  // 静止帧：握法从竖握换到横握。τ=0.4s，2 秒 = 5τ，残差 <1%
  for (let i = 0; i < 120; i++) {
    assert.equal(blendCenterOffset(q0, q0, 1 / 60, [FACE_CY, 0, 0], off), true);
  }
  assert.ok(Math.abs(off[0] - FACE_CY) < 0.02, `x 应该收到 ${FACE_CY}，实际 ${off[0].toFixed(3)}`);
  assert.ok(Math.abs(off[1]) < 0.02, `y 应该收到 0，实际 ${off[1].toFixed(3)}`);
  // 挥拍帧：16.7ms 转 0.5rad ≈ 30 rad/s，整帧拒绝——
  // 挥拍中拍面中心会被甩出 0.3–1.1m，采进来就是「一挥拍人被拽着跑」
  const qFast = [0, Math.sin(0.25), 0, Math.cos(0.25)];
  const before = [...off];
  assert.equal(blendCenterOffset(q0, qFast, 1 / 60, [0, FACE_CY, 0], off), false);
  assert.deepEqual(off, before, '挥拍中不许改偏移');
});

console.log('走位目标保持（击球前不再抖）');

/** 造一份「规划器每帧改主意」的 plan：在 z 上隔着 6cm 来回跳，其余不变。 */
const planAt = (x, z, y = RACKET_POS[1], chasing = true) => ({
  target: x, targetZ: z, targetY: y, chasing, eta: 0.2, hitY: y, reachable: true,
});

t('6cm 的来回改主意被吃掉：目标不动，人就不动', () => {
  // 真机原状：候选平面网格跟着球往前滑，相邻两格的代价差千分之几，
  // 排序每帧翻一次 → targetZ 在 0.30 / 0.36 之间跳 → 人按 speedZ 满速
  // 走 6cm 再走回来，60Hz 方波（相机也跟着一起晃）。
  const hold = new TargetHold();
  let t = 1000;
  let z = null;
  for (let i = 0; i < 60; i++) {
    const tg = hold.resolve(planAt(0, 0.3 + (i % 2 ? 0.06 : 0)), t);
    if (z === null) z = tg.z;
    assert.equal(tg.z, z, `第 ${i} 帧目标被 6cm 的抖动带着跑了`);
    t += 16.7;
  }
  assert.equal(z, 0.3);
});

t('相邻一格（一个采样步长）在弹道上交替胜出：不许跟着翻', () => {
  // 11-15 的回归：`holdR` 曾经等于 `CROSS_STEP`（都是 0.10）。候选点是沿弹道按
  // 0.10m 采的，两个相邻候选的距离正好 0.10 —— 交替胜出时每次切换 0.101，
  // 「刚好越过阈值」，判据形同虚设。实测横握 741–743 帧连翻两次：
  // (y1.229,z0.000) → (1.301,-0.083) 0.110 换过去，→ (1.235,-0.006) 0.101 换回来。
  const hold = new TargetHold();
  let now = 1000;
  // 两个候选：z 差一格，y 沿弹道跟着抬 0.03（合起来 hypot(0.10,0.03)=0.104）
  const a = planAt(0, 0.3, 1.229);
  const b = planAt(0, 0.4, 1.259);
  let first = hold.resolve(a, now);
  assert.ok(Math.abs(first.z - 0.3) < 1e-9);
  for (let i = 0; i < 40; i++) {
    now += 16.7;
    const tg = hold.resolve(i % 2 ? b : a, now);
    assert.ok(Math.abs(tg.z - 0.3) < 1e-9, `第 ${i} 帧被相邻一格带跑了：z=${tg.z}`);
    assert.ok(Math.abs(tg.y - 1.229) < 1e-9, `第 ${i} 帧 y 跟着抬了：${tg.y}`);
  }
});

t('保持阈值必须严格大于候选间距，否则判据等于没设', () => {
  // 这条是给未来的人看的：想调小 `holdR` 压延迟，先看它有没有掉到 `CROSS_STEP` 以下。
  const hold = new TargetHold();
  let switched = false;
  let now = 1000;
  hold.resolve(planAt(0, 0, 0), now);
  for (let i = 0; i < 8; i++) {
    now += 16.7;
    const tg = hold.resolve(planAt(0, i % 2 ? CROSS_STEP : 0, 0), now);
    if (Math.abs(tg.z) > 1e-9) switched = true;
  }
  assert.equal(switched, false, '`holdR` 掉到了采样步长以下，相邻候选会互相踢');
});

t('一次跨过半个场地就是真的改主意：立刻采纳', () => {
  const hold = new TargetHold();
  hold.resolve(planAt(0, 0.3), 1000);
  const tg = hold.resolve(planAt(0.5, 0.3), 1017);
  assert.equal(tg.x, 0.5, '换落点了就必须挪');
});

t('球过去之后先挥完这一拍，250ms 后才回中线', () => {
  const hold = new TargetHold();
  // 追低球：握点压到 0.9
  hold.resolve(planAt(1.2, 0.4, 0.9), 1000);
  // 球越过拍面：chasing=false，目标变成回中点（y 回 1.3）
  const a = hold.resolve(planAt(0, HIT_Z, RACKET_POS[1], false), 1030);
  assert.equal(a.y, 0.9, '刚过去这 30ms 不许回位——那正是挥拍的最后几帧');
  const b = hold.resolve(planAt(0, HIT_Z, RACKET_POS[1], false), 1200);
  assert.equal(b.y, 0.9, '250ms 之内仍然保持');
  const c = hold.resolve(planAt(0, HIT_Z, RACKET_POS[1], false), 1320);
  assert.equal(c.y, RACKET_POS[1], '超过 250ms 才回中线');
});

console.log('走位执行（高度两段）');

/** 一份「球在手边」的 plan：只有 eta 和 chasing 影响执行器。 */
const planWithEta = (eta, chasing = true) => ({
  target: 0, targetZ: HIT_Z, targetY: RACKET_POS[1],
  chasing, eta, hitY: 1.5, reachable: true,
});
const tgY = (y) => ({ x: 0, y, z: HIT_Z });
const CUR = { x: 0, y: RACKET_POS[1], z: HIT_Z };

t('球还远（eta 1.2s）时只做预位：一帧只挪一点点，不瞬间到位', () => {
  const dt = 1 / 60;
  const next = stepAutoMove(CUR, planWithEta(1.2), tgY(1.65), dt);
  // 预位速度 1.8 m/s → 一帧 3cm；老行为是 9 m/s（一帧 15cm，看起来就是瞬移）
  assert.ok(next.y > RACKET_POS[1] && next.y < RACKET_POS[1] + 0.05,
    `一帧应该只挪 3cm 左右，实际 ${(next.y - RACKET_POS[1]).toFixed(3)}m`);
});

t('预位幅度就是 ±20cm：球还远时握点不会越过中立位上下 20cm', () => {
  const dt = 1 / 60;
  let cur = { ...CUR };
  for (let i = 0; i < 120; i++) cur = stepAutoMove(cur, planWithEta(1.2), tgY(1.65), dt);
  assert.ok(Math.abs(cur.y - (RACKET_POS[1] + 0.2)) < 0.03,
    `高球预位应该停在 ${RACKET_POS[1] + 0.2}，实际 ${cur.y.toFixed(2)}`);

  let low = { ...CUR };
  for (let i = 0; i < 120; i++) low = stepAutoMove(low, planWithEta(1.2), tgY(0.75), dt);
  assert.ok(Math.abs(low.y - (RACKET_POS[1] - 0.2)) < 0.03,
    `低球预位应该停在 ${RACKET_POS[1] - 0.2}，实际 ${low.y.toFixed(2)}`);
});

t('球到面前（eta → 0）全行程打开：该蹲多深就蹲多深', () => {
  const dt = 1 / 60;
  let cur = { ...CUR };
  for (let i = 0; i < 30; i++) cur = stepAutoMove(cur, planWithEta(0), tgY(0.75), dt);
  assert.ok(Math.abs(cur.y - 0.75) < 1e-6, `0.5s 之后必须到 0.75，实际 ${cur.y.toFixed(2)}`);
});

t('预位 → 精确对位是连续开闸，不是到点硬切', () => {
  // 同一份目标（0.75），eta 从 0.45 一路降到 0：能到的高度必须单调下探，
  // 而且任何一档都不许越过 0.75。硬切的话 0.45 那一档会突然从 1.10 跳到 0.75，
  // 目标一帧跳一次、人就反向一次（探针里 y 反向 0.04 次/球）。
  const dt = 1 / 60;
  const settle = (eta) => {
    let cur = { ...CUR };
    for (let i = 0; i < 200; i++) cur = stepAutoMove(cur, planWithEta(eta), tgY(0.75), dt);
    return cur.y;
  };
  const y045 = settle(0.45);
  const y030 = settle(0.3);
  const y015 = settle(0.15);
  const y000 = settle(0);
  assert.ok(y045 > y030 && y030 > y015 && y015 > y000,
    `应该单调下探，实际 ${[y045, y030, y015, y000].map((v) => v.toFixed(2)).join(' > ')}`);
  assert.ok(Math.abs(y045 - (RACKET_POS[1] - 0.2)) < 0.03,
    `球还远（eta=0.45）时应该停在预位下沿附近，实际 ${y045.toFixed(2)}`);
  assert.ok(y000 < RACKET_POS[1] - 0.4, `球到面时应该蹲得比预位深得多，实际 ${y000.toFixed(2)}`);
});

t('球已经过去：回位用 homeSpeed，不是 9 m/s 的竖直弹跳', () => {
  const dt = 1 / 60;
  const next = stepAutoMove({ x: 0, y: 0.75, z: HIT_Z }, planWithEta(null, false), tgY(RACKET_POS[1]), dt);
  // 3.2 m/s → 一帧 5.3cm；9 m/s 是 15cm，正好落在挥拍最后两帧上
  assert.ok(next.y - 0.75 < 0.06, `回位一帧 ${(next.y - 0.75).toFixed(3)}m 太快`);
});

t('横移 / 前后 / 高度三轴各自限速，边界夹得住', () => {
  const dt = 1 / 60;
  const plan = planWithEta(0.5);
  const next = stepAutoMove({ x: 0, y: RACKET_POS[1], z: HIT_Z }, plan,
    { x: 9, y: 1.65, z: 9 }, dt);
  assert.ok(next.x - 0 <= AUTO_MOVE_DEFAULTS.speed * dt + 1e-9, `x 超速 ${next.x}`);
  assert.ok(next.z - HIT_Z <= AUTO_MOVE_DEFAULTS.speedZ * dt + 1e-9, `z 超速 ${next.z}`);
  assert.ok(next.x <= AUTO_MOVE_DEFAULTS.maxX + 1e-9, 'x 出了边线');
  assert.ok(next.z <= AUTO_MOVE_DEFAULTS.maxZ + 1e-9, 'z 出了纵深');
  assert.ok(next.y <= AUTO_MOVE_DEFAULTS.maxGripY + 1e-9, '高度越过上限');
});

console.log('走位 · 站位范围（边线外 / 网前）');

/**
 * 11-15 真机反馈第 3 条：两侧落点刁钻的球「走位被约束在了场内」，
 * 于是边线外 0.5m 的球永远够不到；网前的短球也一直在原地等它弹两下。
 * 这一组钉的是**站位边界**，不是规划器的代价函数。
 */
const walkState = () => ({ x: 0, y: RACKET_POS[1], z: HIT_Z, center: [0, FACE_CY, 0] });

t('边线外的球也站得到：目标 x 跑出单打边线', () => {
  // 从底线外斜抽过来、到击球面时 x≈4.6（单打边线 4.115 外 0.5m）
  const ball = makeBall([-1, 0.5, -6], [7.1, 5.5, 8], [0, 0, 0]);
  const plan = planAutoMove(ball, walkState(), AUTO_MOVE_DEFAULTS);
  assert.ok(plan.chasing);
  assert.ok(Math.abs(plan.target) > HALF_WIDTH,
    `目标 x=${plan.target.toFixed(2)} 还夹在场内（边线 ${HALF_WIDTH}）——「跑出去接」是合法的`);
});

t('网前的短球会往前跑；旧的 minZ 只会站在原地看它弹两下', () => {
  // 一记软吊：第一落点 z≈-7.5，弹起后没力，第二落点 z≈-4.3 —— 它到不了击球面。
  const ball = makeBall([0, 1.2, -12], [0, 2.5, 6], [0, 0, 0]);
  const plan = planAutoMove(ball, walkState(), AUTO_MOVE_DEFAULTS);
  const old = planAutoMove(ball, walkState(), { ...AUTO_MOVE_DEFAULTS, minZ: HIT_Z - 3.0 });
  assert.ok(plan.chasing, '新的纵深范围下应该往前去追');
  assert.ok(plan.targetZ < HIT_Z - 3.0,
    `只跑到 z=${plan.targetZ.toFixed(2)}，还是够不到第二落点`);
  assert.ok(old.targetZ > plan.targetZ + 3,
    `对照组：旧的 minZ=-2.7 下它停在 z=${old.targetZ.toFixed(2)}（等于放弃这一分）`);
});

t('纵深和横移的范围都不越界：跑得出去，也收得回来', () => {
  assert.ok(AUTO_MOVE_DEFAULTS.maxX > HALF_WIDTH, '横向必须能出边线');
  assert.ok(AUTO_MOVE_DEFAULTS.minZ < HIT_Z - 3.0, '纵向必须比中场更靠前');
  assert.ok(AUTO_MOVE_DEFAULTS.minZ > NET_Z + 1.5, '但不能一路跑到网前扑救');
  assert.ok(AUTO_MOVE_DEFAULTS.maxZ >= BASELINE_Z - 0.5, '至少能退到底线附近');
});

console.log('挥拍枢轴（腰 → 肘 → 腰）');

const BASE = [0, RACKET_POS[1], HIT_Z];
const IDENT = [0, 0, 0, 1];
/** 绕世界 x 轴转角 a 的四元数：拍柄从竖直往前压，正手挥拍的标准动作。 */
const tiltX = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

t('静止 / 姿态没变 → 握点就是基座，一点都不动', () => {
  const rig = new SwingRig();
  for (let i = 0; i < 30; i++) {
    const p = rig.update(BASE, IDENT, 0, 1 / 60);
    assert.ok(dist3(p, BASE) < 1e-9, `第 ${i} 帧动了 ${dist3(p, BASE)}`);
  }
});

t('原地翻腕（绕拍柄轴自转）不该让握点跑掉', () => {
  // 这是这一层最关键的判据：姿态增量里手腕自转可以很大，但手心转一下只是
  // 拍子原地翻面。用拍柄方向的**最小弧**做枢轴旋转，自转对它是零。
  const rig = new SwingRig();
  rig.update(BASE, IDENT, 0, 1 / 60);
  const roll = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]; // 绕自身 y 轴 90°
  const p = rig.update(BASE, roll, 3, 1 / 60);
  assert.ok(dist3(p, BASE) < 1e-6, `翻腕把握点搬走了 ${dist3(p, BASE).toFixed(3)}m`);
});

t('拍柄往前压 40°：握点朝击球方向走一段弧，且不超过位移上限', () => {
  const rig = new SwingRig();
  rig.update(BASE, IDENT, 0, 1 / 60);
  // 慢速 → 绕腰。角度取负：绕 +x 转是拍柄朝 +z（身后）倒，绕 -x 才是往前压
  const p = rig.update(BASE, tiltX(-0.7), 2, 1 / 60);
  assert.ok(p[2] < BASE[2] - 0.05, `应该往 -z（球那边）走，实际 dz ${(p[2] - BASE[2]).toFixed(3)}`);
  assert.ok(p[1] < BASE[1], '绕腰往前压，握点应该同时下沉');
  assert.ok(dist3(p, BASE) <= SWING_RIG_DEFAULTS.maxShift + 1e-9,
    `位移 ${dist3(p, BASE).toFixed(3)} 越过了上限 ${SWING_RIG_DEFAULTS.maxShift}`);

  // 大挥：位移一定被限住，否则拍面会被搬出判定位（喂球是瞄挥拍前那个位置的）
  const big = rig.update(BASE, tiltX(-2.0), 2, 1 / 60);
  assert.ok(dist3(big, BASE) <= SWING_RIG_DEFAULTS.maxShift + 1e-9,
    `114° 时位移 ${dist3(big, BASE).toFixed(3)} 应该被夹到 ${SWING_RIG_DEFAULTS.maxShift}`);
});

t('同一条挥拍动作，慢挥绕腰、快挥绕肘（手几乎停住，拍头甩出去）', () => {
  // 两段完全一样的拍柄轨迹，只有手部角速度不同：2 rad/s（转体带动）对 25 rad/s（肘部制动）。
  // 转角走 0 → 0.3 rad，远在位移上限之内，这样才能比较「同样转一点、手握点走多远」。
  const run = (spin) => {
    const rig = new SwingRig();
    rig.update(BASE, IDENT, 0, 1 / 60);
    let p = BASE;
    for (let i = 1; i <= 24; i++) p = rig.update(BASE, tiltX(-0.3 * (i / 24)), spin, 1 / 60);
    return { p, r: dist3(rig.pivot, BASE) };
  };
  const slow = run(2);
  const fast = run(25);

  assert.ok(slow.r > fast.r + 0.1, `腰的半径 ${slow.r.toFixed(3)} 应该明显大于肘的 ${fast.r.toFixed(3)}`);
  assert.ok(dist3(slow.p, BASE) > dist3(fast.p, BASE) * 1.4,
    `慢挥握点应该走得远得多：腰 ${dist3(slow.p, BASE).toFixed(3)} vs 肘 ${dist3(fast.p, BASE).toFixed(3)}`);
});

t('枢轴在两个门限之间连续切换，握点不跳', () => {
  const rig = new SwingRig();
  rig.update(BASE, IDENT, 0, 1 / 60);
  // 先走一帧让「零位移」的那一帧过去（第一帧从基座跳到弧上不算跳变）
  let prev = rig.update(BASE, tiltX(-0.6), 15, 1 / 60);
  let worst = 0;
  for (let i = 0; i < 120; i++) {
    // 角速度在 0 → 30 rad/s 之间扫一圈，正好穿过 slowSpin/fastSpin
    const spin = 15 + 15 * Math.sin((i / 120) * Math.PI * 2);
    const p = rig.update(BASE, tiltX(-0.6), spin, 1 / 60);
    worst = Math.max(worst, dist3(p, prev));
    prev = p;
  }
  assert.ok(worst < 0.03, `单帧最大跳变 ${worst.toFixed(3)}m，枢轴切换必须连续`);
});

t('reset 之后重新学准备姿态：不带着上一段的弧', () => {
  const rig = new SwingRig();
  rig.update(BASE, IDENT, 0, 1 / 60);
  rig.update(BASE, tiltX(0.8), 5, 1 / 60);
  rig.reset();
  // 新会话第一帧：姿态是「挥到一半」的那个，但没有基准 → 不该凭空带弧
  const p = rig.update(BASE, tiltX(0.8), 0, 1 / 60);
  assert.ok(dist3(p, BASE) < 1e-9, `reset 后第一帧动了 ${dist3(p, BASE).toFixed(3)}m`);
});

t('端到端：中途跑开 2.2m，自动走位把人带回球的落点', () => {
  // 这一段验的是 `planAutoMove` + `TargetHold` + 限速步进三层的合力，和「谁在对面
  // 打过来的」无关，所以不需要规则引擎：造一颗朝玩家飞的球就够了。11-15 删掉
  // 对墙打之前这里跑的是 `Rally`，那是唯一能借到「连续来球」的地方；现在借物理。
  // 从 x=+1.2 飞过来，人站在 -1.2 —— 横向要跑 2.4m，而球到拍面还有 0.86 秒
  // （5.4 m/s 够跑 4.6m，留足余量，这条测的是「会不会跑」而不是「跑得多快」）。
  const ball = makeBall([1.2, 1.8, -10], [0, 3.5, 12]);
  const dt = 1 / 60;
  let now = 1000;
  let px = 0;
  let pz = HIT_Z;
  const hold = new TargetHold();
  const devs = [];
  // 和 `app.ts` 同一套：规划 → `TargetHold` → 限速步进。少了保持器的话，
  // 规划器每帧在相邻候选平面之间改主意，人会跟着抖。
  for (let i = 0; i < 60 * 4; i++) {
    now += dt * 1000;
    if (i === 20) px = -1.2; // 走错方向跑开，此后完全交给自动走位
    const plan = planAutoMove(ball, { x: px, z: pz, center: [0, FACE_CY, 0] });
    const tg = hold.resolve(plan, now);
    const speed = plan.chasing ? AUTO_MOVE_DEFAULTS.speed : AUTO_MOVE_DEFAULTS.homeSpeed;
    const speedZ = plan.chasing ? AUTO_MOVE_DEFAULTS.speedZ : AUTO_MOVE_DEFAULTS.homeSpeed;
    px = Math.max(
      -AUTO_MOVE_DEFAULTS.maxX,
      Math.min(AUTO_MOVE_DEFAULTS.maxX, stepAxis(px, tg.x, speed * dt, AUTO_MOVE_DEFAULTS.deadband))
    );
    pz = Math.max(
      AUTO_MOVE_DEFAULTS.minZ,
      Math.min(AUTO_MOVE_DEFAULTS.maxZ, stepAxis(pz, tg.z, speedZ * dt, AUTO_MOVE_DEFAULTS.deadband))
    );
    // 球穿过**这一帧的**站位平面那一刻，量球心与握点的横向差（竖握 = 与拍面中心的差）
    const prevZ = ball.p[2];
    const faceZ = pz + FACE_CY;
    advance(ball, dt, () => {});
    if ((prevZ - faceZ) * (ball.p[2] - faceZ) <= 0 && ball.p[2] !== prevZ) {
      devs.push(Math.abs(ball.p[0] - px));
    }
    if (!ball.live) break;
  }
  assert.ok(devs.length >= 1, `球应该至少过一次拍面，实际 ${devs.length}`);
  const worst = Math.max(...devs);
  assert.ok(worst <= 0.25, `最差到面横向偏差 ${worst.toFixed(3)}m，应该 ≤0.25`);
});

console.log('对打 · 求解器的到面高度约束');

t('回球机要的是「弹起来爬到你手上」的球：界内、过网、到面高度在 ARRIVE_Y 带内', () => {
  const v = aimIntoCourt(DUEL_FROM, [0, BALL_R, -4], DUEL_SPIN, DUEL_AIM);
  assert.ok(v, '从底线中线打 -4 应该有解');
  const r = flightOf(DUEL_FROM, v, DUEL_SPIN);
  assert.ok(!r.netted, '不能撞网');
  assert.ok(r.netY !== null && r.netY > NET_H, `过网高度必须高于网 ${NET_H}，实际 ${r.netY}`);
  assert.ok(r.land, '必须落地');
  assert.ok(Math.abs(r.land[1] + 4) < 0.5, `落点 z 应压在 -4 附近，实际 ${r.land[1].toFixed(2)}`);
  assert.ok(Math.abs(r.land[0]) < HALF_WIDTH, '落点必须在边线内');
  assert.ok(r.planeY !== null, '球到面时必须还活着');
  assert.ok(
    r.planeY >= ARRIVE_Y_MIN - 0.12 && r.planeY <= ARRIVE_Y_MAX + 0.12,
    `到面高度 ${r.planeY.toFixed(3)} 超出 ${ARRIVE_Y_MIN}–${ARRIVE_Y_MAX} ±0.12`
  );
});

t('到面高度是硬约束：举过头顶、压到脚边都必须判无解', () => {
  const high = aimIntoCourt(DUEL_FROM, [0, BALL_R, -4], DUEL_SPIN, { ...DUEL_AIM, arriveY: [3.0, 3.5] });
  assert.strictEqual(high, null, '3 米高的到面高度不可能，必须判无解，不能硬给一条弧线');
  // 这一条是实测踩出来的：第一版发球只约束落点，到面高度解出来 0.17m，
  // 而玩家拍面中心永远在握点上方 0.6m，一帧都接不到。
  const low = aimIntoCourt(DUEL_FROM, [0, BALL_R, -4], DUEL_SPIN, { ...DUEL_AIM, arriveY: [0.15, 0.35] });
  assert.strictEqual(low, null, '0.2 米高的到面高度（球落到脚边）同样无解');
});

t('arriveTol 收紧后，解出来的到面高度也跟着收', () => {
  const v = aimIntoCourt(DUEL_FROM, [0, BALL_R, -4], DUEL_SPIN, {
    ...DUEL_AIM,
    arriveY: [1.45, 1.5],
    arriveTol: 0.02,
  });
  assert.ok(v, '1.45–1.5 这一段应该有解');
  const r = flightOf(DUEL_FROM, v, DUEL_SPIN);
  const slack = 0.02 + 1e-3; // 过网/落点是按 240Hz 采样判的，留一点数值余量
  assert.ok(
    r.planeY >= 1.45 - slack && r.planeY <= 1.5 + slack,
    `到面高度 ${r.planeY.toFixed(3)} 超出 1.45–1.5 ±0.02`
  );
});

console.log('对打 · 回球机');

t('球不再朝它飞时不给预测', () => {
  const m = new BallMachine(MACHINE_L2);
  m.beginPlay(0);
  assert.strictEqual(m.pickIntercept(1000, makeBall([0, 1.2, -15], [0, 0.5, 6])), null, '球在往回飞');
  assert.strictEqual(m.pickIntercept(1000, makeBall([0, 1.2, -15], [0, 0.5, 0])), null, '只横向漂移也不算');
});

t('预测点必须落在本方半场、不贴网、也不退出挡板', () => {
  const m = new BallMachine(MACHINE_L2);
  m.beginPlay(0);
  const cases = [
    [[0.8, 1.2, -15], [0, 1, -8]],
    [[3.0, 1.0, -20], [1, 2, -9]],
    [[-2.5, 1.6, -18], [-1, 0.5, -10]],
  ];
  for (const [p, v] of cases) {
    const r = m.pickIntercept(1000, makeBall(p, v));
    assert.ok(r, `球 ${JSON.stringify(p)} 应该给出预测点`);
    assert.ok(r.t > 0, 't 必须是从现在算起的正数');
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), 'x/y 必须是有限数');
    // Z_NEAR = NET_Z - 1.6、Z_FAR = OPP_BASELINE_Z - 0.8，这里不导常量，只钉住「在本方半场」。
    assert.ok(r.z < NET_Z - 1.5, `预测点 z=${r.z.toFixed(2)} 太贴网`);
    assert.ok(r.z > OPP_BASELINE_Z - 0.9, `预测点 z=${r.z.toFixed(2)} 已经退到挡板外`);
  }
});

t('同种子出招一致；reset 重播，park 不重播', () => {
  const draw = (m) => [0, 1, 2].map(() => m.chooseTarget());
  const a = new BallMachine(MACHINE_L2);
  const b = new BallMachine(MACHINE_L2);
  const ref = draw(b);
  assert.deepStrictEqual(draw(a), ref, '同种子必须给出同一串落点');
  a.reset();
  assert.deepStrictEqual(draw(a), ref, 'reset 是「换一局」，必须把随机数拨回种子');
  a.park();
  assert.notDeepStrictEqual(draw(a), ref, 'park 是「这一分结束」，不能把随机数拨回种子，否则每分落点一模一样');
});

t('反应延迟内它不动，反应完才朝球跑', () => {
  const m = new BallMachine(MACHINE_L2); // reactMs = 300
  m.beginPlay(0);
  const ball = makeBall([3.0, 1.0, -20], [0, 2, -9]);
  for (let i = 0; i < 15; i++) m.update(1 / 60, (i * 1000) / 60, ball); // 250ms，还在延迟里
  assert.ok(Math.abs(m.pos[0]) < 1e-9, `反应延迟内不该横移，实际 x=${m.pos[0]}`);
  for (let i = 15; i < 60; i++) m.update(1 / 60, (i * 1000) / 60, ball);
  assert.ok(m.pos[0] > 0.5, `反应结束后应该朝球那一侧跑，实际 x=${m.pos[0].toFixed(2)}`);
});

console.log('对打 · 判分');

/** 摆一个「玩家刚打完、球飞向对手」的活球局，不经过挥拍直接给判分喂输入 */
const armedDuel = (bounces) => {
  const d = new Duel();
  d.phase = 'live';
  d.hitter = 'player';
  d.receiver = 'machine';
  d.rally = 3;
  d.bouncesOnReceiver = bounces;
  return d;
};

const runFrames = (d, frames = 30) => {
  const ev = [];
  for (let i = 0; i < frames; i++) ev.push(...d.update(1 / 60, (i * 1000) / 60));
  return ev;
};

t('第一落点定局：界内弹过一次后滚出边线，算对手没接到而不是击球方出界', () => {
  const d = armedDuel(1);
  d.ball = makeBall([4.0, 0.6, -6], [26, 0, 0]); // 从边线内侧横向滚出界
  const ev = runFrames(d);
  const pt = ev.filter((e) => e.kind === 'point');
  assert.strictEqual(pt.length, 1, '一分只能结束一次');
  assert.strictEqual(pt[0].winner, 'player', '球已经合法落在对方场内，这一分归击球方');
  assert.strictEqual(pt[0].reason, '对手没接到');
  assert.ok(!ev.some((e) => e.kind === 'out'), '滚出边线不是击球方出界，不能补一条 out 事件');
});

t('对照：没落地就飞出场外，算击球方出界', () => {
  const d = armedDuel(0);
  d.ball = makeBall([4.0, 0.6, -6], [26, 0, 0]);
  const ev = runFrames(d);
  const pt = ev.filter((e) => e.kind === 'point');
  assert.strictEqual(pt.length, 1);
  assert.strictEqual(pt[0].winner, 'machine');
  assert.strictEqual(pt[0].reason, '出界');
});

t('接球方半场弹第二次就判「两次落地」', () => {
  const d = armedDuel(1);
  const ev = [];
  d.onCollision({ kind: 'ground', at: [0.3, BALL_R, -15] }, 100, ev);
  assert.ok(
    ev.some((e) => e.kind === 'miss' && e.reason === 'double' && e.by === 'machine'),
    '要给出「接球方两次落地」的 miss 事件'
  );
  const pt = ev.filter((e) => e.kind === 'point');
  assert.strictEqual(pt[0].winner, 'player');
  assert.strictEqual(pt[0].reason, '两次落地');
});

t('第一落点在自己半场判没过网，落对方半场边线外判出界', () => {
  const a = armedDuel(0);
  let ev = [];
  a.onCollision({ kind: 'ground', at: [0, BALL_R, -4] }, 100, ev); // -4 在网这一侧
  assert.ok(ev.some((e) => e.kind === 'out' && e.by === 'player'), '要给出击球方 out 事件');
  assert.strictEqual(ev.find((e) => e.kind === 'point').reason, '没过网');
  assert.strictEqual(ev.find((e) => e.kind === 'point').winner, 'machine');

  const b = armedDuel(0);
  ev = [];
  b.onCollision({ kind: 'ground', at: [HALF_WIDTH + 0.4, BALL_R, -15] }, 100, ev);
  assert.strictEqual(ev.find((e) => e.kind === 'point').reason, '出界');
  assert.strictEqual(ev.find((e) => e.kind === 'point').winner, 'machine');
});

t('撞网判下网', () => {
  const d = armedDuel(0);
  const ev = [];
  d.onCollision({ kind: 'net' }, 100, ev);
  const pt = ev.filter((e) => e.kind === 'point');
  assert.strictEqual(pt[0].reason, '下网');
  assert.strictEqual(pt[0].winner, 'machine');
});

console.log('\n对打 · 计分（分 → 局 → 盘）');

/** 连拿 4 分 = 一局（不涉及平分的情况）。 */
const winGame = (m, side) => {
  for (let i = 0; i < 4; i++) m.awardPoint(side);
};

t('记分牌：0 / 15 / 30 / 40', () => {
  const m = new TennisMatch('player');
  const seq = [pointLabel(m.points, 0, false)];
  for (let i = 0; i < 3; i++) {
    m.awardPoint('player');
    seq.push(pointLabel(m.points, 0, false));
  }
  assert.deepStrictEqual(seq, ['0', '15', '30', '40']);
});

t('40-40 必须净胜两分：占先 → 被追平 → 再连拿两分才赢局', () => {
  const m = new TennisMatch('player');
  for (let i = 0; i < 3; i++) {
    m.awardPoint('player');
    m.awardPoint('machine');
  }
  assert.ok(isDeuce(m.points, false), '3:3 是平分');
  assert.strictEqual(advantageSide(m.points, false), null);

  m.awardPoint('player');
  assert.strictEqual(advantageSide(m.points, false), 'player');
  assert.strictEqual(pointLabel(m.points, 0, false), 'AD', '领先一分显示 AD');
  assert.strictEqual(pointLabel(m.points, 1, false), '40');
  assert.strictEqual(m.games[0], 0, '占先还没拿局');

  m.awardPoint('machine');
  assert.ok(isDeuce(m.points, false), '被追平回平分');
  assert.strictEqual(pointLabel(m.points, 1, false), '40', '追平的一方也显示 40');

  assert.strictEqual(m.awardPoint('player').gameWon, false, '占先不算拿局');
  assert.ok(m.awardPoint('player').gameWon, '连拿两分才拿局');
  assert.strictEqual(m.games[0], 1);
});

t('发球区按本局已打分的奇偶交替；一局结束换发球方', () => {
  const m = new TennisMatch('player');
  const courts = [];
  for (let i = 0; i < 4; i++) {
    courts.push(m.serveCourt());
    m.awardPoint('player');
  }
  assert.deepStrictEqual(courts, ['deuce', 'ad', 'deuce', 'ad']);
  assert.strictEqual(m.games[0], 1);
  assert.strictEqual(m.serveServer(), 'machine', '一局结束就换发球方');
  assert.strictEqual(m.serveCourt(), 'deuce', '新的一局回到右区');
});

t('先到 6 局且净胜 2 局才赢盘：5-4 不够，6-4 才结束', () => {
  const m = new TennisMatch('player');
  for (let i = 0; i < 5; i++) {
    winGame(m, 'player');
    if (i < 4) winGame(m, 'machine');
  }
  assert.deepStrictEqual(m.games, [5, 4]);
  assert.ok(!m.over, '5-4 净胜不够两局，比赛继续');

  winGame(m, 'player');
  assert.deepStrictEqual(m.games, [6, 4]);
  assert.ok(m.over);
  assert.strictEqual(m.winner, 'player');
  assert.deepStrictEqual(m.sets, [1, 0], '一盘定胜负');
});

t('6-6 进抢七；抢七先到 7 且净胜 2 直接赢盘', () => {
  const m = new TennisMatch('player');
  for (let i = 0; i < 6; i++) {
    winGame(m, 'player');
    winGame(m, 'machine');
  }
  assert.deepStrictEqual(m.games, [6, 6]);
  assert.ok(m.tiebreak, '6-6 要进抢七');
  assert.ok(!m.over);

  for (let i = 0; i < 7; i++) m.awardPoint('player');
  assert.ok(m.over, '抢七是这一盘的最后一段，赢下来就结束');
  assert.strictEqual(m.winner, 'player');
  assert.deepStrictEqual(m.games, [7, 6]);
});

t('抢七发球轮转是 1-2-2：先发的人只发第 1 分', () => {
  const m = new TennisMatch('player');
  for (let i = 0; i < 6; i++) {
    winGame(m, 'player');
    winGame(m, 'machine');
  }
  // 12 局打完，第 12 局是机器发的（偶数局都是它）。抢七由「本该发第 13 局」的人先发，
  // 也就是玩家。注意抢七那一下 `awardPoint` 提前返回、没有翻 `server`，
  // 所以这里读到的是第 12 局的发球方，先发的人必须是它的对手。
  assert.strictEqual(m.serveServer(), 'player');

  const servers = [];
  for (let i = 0; i < 5; i++) {
    servers.push(m.serveServer());
    m.awardPoint('player');
  }
  assert.deepStrictEqual(servers, ['player', 'machine', 'machine', 'player', 'player']);
});

console.log('\n对打 · 发球几何');

t('发球区永远是斜对角（两边都朝球网看，世界的 x 符号是反的）', () => {
  const pd = serveBox('player', 'deuce');
  assert.ok(pd.x1 <= 0, '玩家从右区发，落点在对手半场的 x<=0 那半边');
  assert.strictEqual(pd.z0, OPP_SERVICE_Z);
  assert.strictEqual(pd.z1, NET_Z);

  assert.ok(serveBox('player', 'ad').x0 >= 0, '玩家从左区发到 x>=0');
  assert.ok(serveBox('machine', 'deuce').x0 >= 0, '机器的右区是世界 x>0，所以落点也在 x>0');
  assert.ok(serveBox('machine', 'ad').x1 <= 0);
});

t('发球站位：自己那一侧 × 右/左，不是直接拿 court 当符号', () => {
  assert.ok(serveStandX('player', 'deuce') > 0, '玩家的右区是 +x');
  assert.ok(serveStandX('player', 'ad') < 0);
  assert.ok(serveStandX('machine', 'deuce') < 0, '机器的右区是 -x');
  assert.ok(serveStandX('machine', 'ad') > 0);
  assert.strictEqual(serveStandX('player', 'deuce'), -serveStandX('player', 'ad'));
});

t('inServeBox 认的是 box，不是「界内」', () => {
  assert.ok(inServeBox([-2, BALL_R, -13], 'player', 'deuce'));
  assert.ok(!inServeBox([2, BALL_R, -13], 'player', 'deuce'), '另一半区不算');
  assert.ok(!inServeBox([-2, BALL_R, -6], 'player', 'deuce'), '过了发球线不算（那是底线区）');
  assert.ok(!inServeBox([-2, BALL_R, 0], 'player', 'deuce'), '自己半场更不算');
});

t('拍面朝向 → 发球落点：左右决定进不进区，俯角决定深浅', () => {
  const contact = [serveStandX('player', 'deuce'), 2.2, 1.3];
  const box = serveBox('player', 'deuce');
  const cx = (box.x0 + box.x1) / 2;
  const czz = (box.z0 + box.z1) / 2;

  const face = (pitchDeg, yaw) => {
    const p = (pitchDeg * Math.PI) / 180;
    return [Math.cos(p) * Math.sin(yaw), -Math.sin(p), -Math.cos(p) * Math.cos(yaw)];
  };
  const yaw = Math.atan2(cx - contact[0], contact[2] - czz);

  const mid = serveAim(contact, face(10.5, yaw), 'player', 'deuce');
  assert.ok(mid.inBox, `瞄区中心应该在区内（实测 x=${mid.point[0].toFixed(2)}）`);
  assert.ok(!mid.far);

  const wrong = serveAim(contact, face(10.5, Math.atan2(-cx - contact[0], contact[2] - czz)), 'player', 'deuce');
  assert.ok(!wrong.inBox, '瞄另一半区就是失误——左右不夹，否则没人会发球失误');

  const deep = serveAim(contact, face(3.5, yaw), 'player', 'deuce');
  const shallow = serveAim(contact, face(17, yaw), 'player', 'deuce');
  assert.ok(deep.point[2] < shallow.point[2], '拍面压得越多球越浅（z 越大）');
  assert.ok(deep.point[2] >= box.z0 && shallow.point[2] <= box.z1, '整段俯角都落在发球区里');
});

t('抛球接触只认下落段：上升段一律不算', () => {
  const pose = { t: 0, pos: [0, 1.3, 1.3], q: [0, 0, 0, 1] };
  const c = faceCenter(pose); // 竖直握拍 ⇒ 拍面中心在握点正上方 0.6m
  assert.ok(Math.abs(c[1] - 1.9) < 1e-6);

  const hi = [c[0], c[1] + 0.2, c[2]];
  const lo = [c[0], c[1] + 0.15, c[2]];
  assert.ok(tossContact(pose, hi, lo, -2), '下落且在判定球内 → 算碰到');
  assert.strictEqual(tossContact(pose, hi, lo, 3), null, '还在上升 → 不算（否则抛球那一刻就发完了）');

  const far = [c[0], c[1] + 0.6, c[2]];
  assert.strictEqual(tossContact(pose, far, [far[0], far[1] - 0.02, far[2]], -2), null);
});

console.log('\n对打 · 发球手感（抛球高度 / 击球区 / 左右窗口）');

const serveGrip = () => [serveStandX('player', 'deuce'), RACKET_POS[1] + 0.32, SERVE_STAND_Z];
/** 屏幕朝前 ⇒ 拍柄竖直向上、拍面中心在握点正上方（最自然的举拍姿势） */
const SERVE_VERTICAL = { t: 0, pos: serveGrip(), q: [0, 0, 0, 1] };
/**
 * 屏幕朝天 ⇒ 法线朝上、拍柄朝前。举高手机时最常见的那一握：
 * 法线的水平分量几乎为零，按法线算出来的偏角是一条噪声。
 */
const SERVE_FLAT = { t: 0, pos: serveGrip(), q: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] };

t('抛球顶点在举高的拍面上方 1 米以上，而且有真正的上升段', () => {
  const apex = TOSS_Y0 + (TOSS_VY * TOSS_VY) / (2 * GRAVITY);
  const faceY = faceCenter(SERVE_VERTICAL)[1];
  assert.ok(apex - faceY > 1.0,
    `顶点 ${apex.toFixed(2)}m 只比拍面（${faceY.toFixed(2)}）高 ${(apex - faceY).toFixed(2)}m，看不出是抛球`);
  const rise = TOSS_VY / GRAVITY;
  assert.ok(rise > 0.4, `上升段只有 ${rise.toFixed(2)}s，来不及把拍子举上去`);
});

t('击球区锚在握点前上方：竖握、横握（屏幕朝天）都能打到同一颗抛球', () => {
  const grip = serveGrip();
  const anchor = [grip[0], grip[1] + SERVE_STRIKE_UP, grip[2] - SERVE_STRIKE_FWD];

  // 1. 两种握法的击球区中心都被钳在锚点附近 —— 球抛在锚点上就一定够得着
  for (const pose of [SERVE_VERTICAL, SERVE_FLAT]) {
    const sc = serveStrike(pose);
    const d = Math.hypot(sc[0] - anchor[0], sc[1] - anchor[1], sc[2] - anchor[2]);
    assert.ok(d <= SERVE_ANCHOR_R + 1e-9,
      `击球区中心离锚点 ${d.toFixed(2)}m，超过钳制半径 ${SERVE_ANCHOR_R}`);
  }

  // 2. 球沿锚点那条竖直线落下来，两种握法都要在某个高度真的打到它
  for (const pose of [SERVE_VERTICAL, SERVE_FLAT]) {
    let hitY = null;
    for (let y = anchor[1] + 0.5; y > anchor[1] - 0.1; y -= 0.01) {
      const hi = [anchor[0], y + 0.01, anchor[2]];
      const lo = [anchor[0], y, anchor[2]];
      if (tossContact(pose, hi, lo, -3)) {
        hitY = y;
        break;
      }
    }
    assert.ok(hitY !== null, '抛在锚点上的球必须能被击中——横握也一样');
    assert.ok(hitY > anchor[1] - 0.15, `击球点掉到 ${hitY.toFixed(2)}m 了，那不是上手发球`);
  }
});

t('屏幕朝天时改看拍框：不再一律判成「一定不准」', () => {
  const contact = serveStrike(SERVE_FLAT);
  const flatFace = [0, 1, 0]; // 法线朝天
  const shaft = [0, 0, -1]; // 拍柄朝前
  const withShaft = serveAim(contact, flatFace, 'player', 'deuce', shaft);
  assert.ok(!withShaft.far, '拍柄朝前时应该能算出落点');
  const noShaft = serveAim(contact, flatFace, 'player', 'deuce');
  assert.ok(noShaft.far, '没有拍柄信息时只能承认「不准」');
});

t('左右合法窗口约 23°（几何射线只有 15.6°），中心仍指向区中心', () => {
  const contact = serveStrike(SERVE_VERTICAL);
  const box = serveBox('player', 'deuce');
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  const yawBox = Math.atan2(cx - contact[0], contact[2] - cz);
  const faceAt = (offDeg) => {
    const y = yawBox + (offDeg * Math.PI) / 180;
    const p = (10.5 * Math.PI) / 180;
    return [Math.cos(p) * Math.sin(y), -Math.sin(p), -Math.cos(p) * Math.cos(y)];
  };

  const mid = serveAim(contact, faceAt(0), 'player', 'deuce');
  assert.ok(mid.inBox, '指向区中心必须在区内');
  assert.ok(Math.abs(mid.point[0] - cx) < 0.15,
    `指向区中心应落在中心附近，实际 x=${mid.point[0].toFixed(2)}（中心 ${cx.toFixed(2)}）`);

  let lo = null;
  let hi = null;
  for (let d = -40; d <= 40; d += 0.25) {
    if (serveAim(contact, faceAt(d), 'player', 'deuce').inBox) {
      if (lo === null) lo = d;
      hi = d;
    }
  }
  assert.ok(hi - lo >= 20, `合法窗口只有 ${(hi - lo).toFixed(1)}°，手机上压不住`);
  assert.ok(hi - lo <= 32, `窗口 ${(hi - lo).toFixed(1)}° 太宽了，等于不用瞄`);

  // 「发错区 = 失误」这条规则还在：转过头就出区
  assert.ok(!serveAim(contact, faceAt(hi + 4), 'player', 'deuce').inBox);
  assert.ok(!serveAim(contact, faceAt(lo - 4), 'player', 'deuce').inBox);
});

console.log('\n对打 · 发球判罚');

const servingDuel = () => {
  const d = new Duel();
  d.phase = 'toss'; // 抛球/发球途中，球还没落地
  d.hitter = 'player';
  d.receiver = 'machine';
  d.serveServer = 'player';
  d.serveCourt = 'deuce';
  d.servePending = true;
  d.serveAttempt = 1;
  return d;
};

t('发进正确的区：这一发成功，进入正常回合', () => {
  const d = servingDuel();
  const ev = [];
  d.onCollision({ kind: 'ground', at: [-2, BALL_R, -13] }, 100, ev);
  assert.ok(!ev.some((e) => e.kind === 'fault'), '进区不该报失误');
  assert.strictEqual(d.servePending, false, '进了区就不再按发球区判');
  assert.strictEqual(d.bouncesOnReceiver, 1, '接发方已经有一弹了');
});

t('发到另一半区是一次失误；一发失误之后还有二发', () => {
  const d = servingDuel();
  const ev = [];
  d.onCollision({ kind: 'ground', at: [2, BALL_R, -13] }, 100, ev);
  const f = ev.find((e) => e.kind === 'fault');
  assert.ok(f, '要报 fault');
  assert.strictEqual(f.attempt, 1);
  assert.strictEqual(f.reason, 'out');
  assert.strictEqual(d.serveAttempt, 2, '升到二发');
  assert.strictEqual(d.phase, 'wait', '回去重新抛球');
  assert.ok(!ev.some((e) => e.kind === 'point'), '一发失误不判分');
});

t('落到自己半场算「没过网」，也是失误', () => {
  const d = servingDuel();
  const ev = [];
  d.onCollision({ kind: 'ground', at: [1, BALL_R, 0] }, 100, ev);
  assert.strictEqual(ev.find((e) => e.kind === 'fault').reason, 'short');
});

t('发球撞网也是失误', () => {
  const d = servingDuel();
  const ev = [];
  d.onCollision({ kind: 'net' }, 100, ev);
  assert.strictEqual(ev.find((e) => e.kind === 'fault').reason, 'net');
  assert.ok(!ev.some((e) => e.kind === 'net' && e.by), '发球撞网不该再报一条普通的下网');
});

t('二发再失误就是双误，这一分归接发方', () => {
  const d = servingDuel();
  d.serveAttempt = 2;
  const ev = [];
  d.onCollision({ kind: 'ground', at: [2, BALL_R, -13] }, 100, ev);
  const pt = ev.find((e) => e.kind === 'point');
  assert.strictEqual(pt.winner, 'machine');
  assert.strictEqual(pt.reason, '双误');
  assert.strictEqual(d.match.points[1], 1);
});

t('只有玩家发球局才把人钉在发球位', () => {
  const d = new Duel();
  assert.strictEqual(d.playerServeStanceX, serveStandX('player', 'deuce'));
  d.phase = 'live';
  assert.strictEqual(d.playerServeStanceX, null, '相持中要放开走位');
  d.phase = 'wait';
  d.match.server = 'machine';
  assert.strictEqual(d.playerServeStanceX, null, '对手的发球局不给发球位');
});

console.log('对打 · 击球采集');

/** 造一个「球正飞向玩家拍面」的对打局，姿态恒为 IDLE（拍面中心在握点正上方 0.6m）。 */
const liveDuelWithBall = (ballX = 0) => {
  const d = new Duel();
  d.phase = 'live';
  d.hitter = 'machine';
  d.receiver = 'player';
  d.servePending = false;
  const fc = faceCenter(IDLE_POSE);
  // +0.37 是 0.28s 自由落体的高度，让球到面时正好落在拍面中心附近
  d.ball = makeBall([ballX, fc[1] + 0.37, -3], [0, 0, 12]);
  return { d, fc };
};

/** 跑若干帧，返回全部事件。`submitAt` 那一刻塞一份挥拍。 */
const runLive = (ballX, submitAt = null) => {
  const { d, fc } = liveDuelWithBall(ballX);
  let now = 0;
  const out = [];
  for (let i = 0; i < 400; i++) {
    now += 1000 / 60;
    d.pushRacket({ t: now, pos: [...IDLE_POSE.pos], q: [...IDLE_POSE.q] });
    if (submitAt !== null && Math.abs(now - submitAt) < 1) {
      d.submit({ t: now, peakW: 18, head: [0, 0, 20], speed: 20, face: [0, 0, -1], grip: [0, 1, 0], charge: 0.6, used: false });
    }
    for (const e of d.update(1 / 60, now)) out.push(e);
    if (out.some((e) => e.kind === 'point')) break;
  }
  return { ev: out, fc };
};

t('球碰到拍面：发一条 hit=true 的 contact，fc 是接触时刻的拍面中心', () => {
  const { ev, fc } = runLive(0);
  const c = ev.find((e) => e.kind === 'contact');
  assert.ok(c, '应该有 contact 事件');
  assert.strictEqual(c.by, 'player');
  assert.strictEqual(c.c.hit, true);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(c.c.fc[i] - fc[i]) < 1e-6, '姿态恒定，fc 应等于静止时拍面中心');
  assert.ok(c.c.offCenter < 1, '命中时应在盘内');
  assert.ok(c.c.ballV[2] > 0, '来球速度要在接触前取，不能是被清成 0 的那份');
});

t('没碰到拍面：也发一条 contact，hit=false 且带最近点', () => {
  const { ev } = runLive(0.4);
  const c = ev.find((e) => e.kind === 'contact');
  assert.ok(c, '漏接也要有样本，否则训练集有截断偏置');
  assert.strictEqual(c.c.hit, false);
  assert.ok(c.c.offCenter > 1, '偏离 0.4m 应在盘外');
  assert.ok(Math.abs(c.c.at[0] - 0) < 0.5, 'at 是球最接近拍面中心那一点，不是随便一帧');
});

t('命中且挥出去：contact 带 stroke；同一拍只记一条', () => {
  const { ev } = runLive(0, 300);
  const cs = ev.filter((e) => e.kind === 'contact');
  assert.strictEqual(cs.length, 1, '一拍只能记一条（否则「挥晚了但打到」会被记成「没挥」）');
  assert.strictEqual(cs[0].c.hit, true);
  assert.ok(cs[0].c.stroke, '挥了就该带上强度信息');
  assert.strictEqual(cs[0].c.stroke.peakW, 18);
});

t('挥了但没碰到：stroke 有值、hit=false —— 这才是「瞄准偏了」', () => {
  const { ev } = runLive(0.4, 300);
  const c = ev.find((e) => e.kind === 'contact');
  assert.strictEqual(c.c.hit, false);
  assert.ok(c.c.stroke, '「挥了没碰到」不能记成「没挥」');
  assert.ok(c.c.lag !== null);
});

t('delta = (fc − 握点) − restOffset，模长不超过一根拍柄的两倍', () => {
  const s = buildContactSample({
    t: 100,
    grip: [0, 1.3, 0.3],
    rest: [0, 0.6, 0],
    planOffset: [0, 0.6, 0], holdR: 0.14, deadband: 0.05, deadbandY: 0.02,
    capture: { t: 100, fc: [0.1, 1.9, 0.4], at: [0.1, 1.9, 0.4], ballV: [0, 0, 10],
      hit: true, offCenter: 0.1, lag: 12, stroke: { peakW: 20, speed: 22, charge: 0.5, face: [0, 0, -1] }, serve: false },
    rally: 2, sincePrevHit: 1200, driftDeg: null, session: 's1',
  });
  assert.ok(Math.abs(s.label.delta[0] - 0.1) < 1e-9);
  assert.ok(Math.abs(s.label.delta[1] - 0.0) < 1e-9);
  assert.ok(Math.abs(s.label.delta[2] - 0.1) < 1e-9);
  const norm = Math.hypot(...s.label.delta);
  assert.ok(norm <= 1.2 + 1e-9, '两根 0.6m 的杆，差的最大模长就是 1.2');
});

t('样本里的坐标是拷贝：改源数组不会改到已记的样本', () => {
  const grip = [0, 1.3, 0.3];
  const rest = [0, 0.6, 0];
  const s = buildContactSample({
    t: 1, grip, rest,
    planOffset: [0, 0.6, 0], holdR: 0.14, deadband: 0.05, deadbandY: 0.02,
    capture: { t: 1, fc: [0, 1.9, 0.3], at: [0, 1.9, 0.3], ballV: [0, 0, 10],
      hit: true, offCenter: 0, lag: null, stroke: null, serve: false },
    rally: 1, sincePrevHit: null, driftDeg: null, session: 's1',
  });
  grip[1] = 99;
  rest[1] = 99;
  assert.strictEqual(s.label.G[1], 1.3);
  assert.strictEqual(s.label.rest[1], 0.6);
  assert.strictEqual(s.feat.rest[1], 0.6);
});

const mkSample = (lag, dx, opts = {}) => buildContactSample({
  t: 0, grip: [0, 1.3, 0.3], rest: [0, 0.6, 0],
  planOffset: opts.planOffset || [0, 0.6, 0], holdR: opts.holdR ?? 0.14, deadband: opts.deadband ?? 0.05, deadbandY: 0.02,
  capture: { t: 0, fc: [dx, 1.9, 0.3], at: [dx, 1.9, 0.3], ballV: [0, 0, 10],
    hit: opts.hit !== false, offCenter: 0.1, lag, stroke: null, serve: opts.serve === true },
  rally: 1, sincePrevHit: null, driftDeg: null, session: 's1',
});

t('发球样本排除在训练集之外，漏接样本保留', () => {
  assert.strictEqual(usableForCalibration(mkSample(10, 0.1)), true);
  assert.strictEqual(usableForCalibration(mkSample(10, 0.1, { hit: false })), true, '漏接必须留，否则有截断偏置');
  assert.strictEqual(usableForCalibration(mkSample(10, 0.1, { serve: true })), false);
});

t('lag 分桶：三桶、lag 为 null 的不进桶、发球不进桶', () => {
  const rows = [
    mkSample(-50, 0.2), mkSample(-10, 0.4), mkSample(40, 0.6), mkSample(null, 0.9),
    mkSample(5, 0.8, { serve: true }),
  ];
  const b = lagBuckets(rows, [-25, 25]);
  assert.strictEqual(b.length, 3);
  assert.strictEqual(b[0].n, 1);
  assert.strictEqual(b[1].n, 1);
  assert.strictEqual(b[2].n, 1);
  assert.ok(Math.abs(b[0].mean[0] - 0.2) < 1e-9);
  assert.ok(Math.abs(b[2].mean[0] - 0.6) < 1e-9);
});

t('样本记下相遇前的瞄准点与走位容差，且必须是快照', () => {
  // 这三项是为了「事后还原当时瞄的是哪、允许多少静差」，不是特征
  const aim = [0.02, 0.61, -0.13];
  const s = buildContactSample({
    t: 0, grip: [0, 1.3, 0.3], rest: [0, 0.6, 0],
    planOffset: aim, holdR: 0.14, deadband: 0.05, deadbandY: 0.02,
    capture: { t: 0, fc: [0.1, 1.9, 0.3], at: [0.1, 1.9, 0.3], ballV: [0, 0, 10],
      hit: true, offCenter: 0.2, lag: 10, stroke: null, serve: false },
    rally: 1, sincePrevHit: null, driftDeg: null, session: 's1',
  });
  assert.deepStrictEqual(s.meta.planOffset, [0.02, 0.61, -0.13]);
  assert.strictEqual(s.meta.holdR, 0.14);
  assert.strictEqual(s.meta.deadband, 0.05);
  assert.strictEqual(s.meta.deadbandY, 0.02, '竖直轴死区更小，不能只记一个 deadband');

  // `planOffset` 在 app 里是每帧原地改的模块级数组。存引用的话，导出时所有样本
  // 都会显示「最后一帧」的瞄准点，而文件看起来完全正常——这是最难查的那种错。
  aim[0] = 9;
  assert.strictEqual(s.meta.planOffset[0], 0.02, 'planOffset 必须存快照，不能留引用');

  // 它和 `G` 是同一个东西的两种形式，进了特征就是闭环自激
  assert.ok(!('planOffset' in s.feat) && !('holdR' in s.feat) && !('deadband' in s.feat),
    '走位容差与瞄准点只能进 meta');
});

t('feat 与白名单逐字一致：at 会被走位泄漏，只能待在 meta 里', () => {
  const s = mkSample(10, 0.1);

  // 白名单是「建模时 X 只准取这些」的唯一一处定义。这条断言把它和实际输出钉在一起：
  // 以后谁往 feat 里加字段而没登记，或者把 meta 的东西挪回 feat，都会红。
  assert.deepStrictEqual(Object.keys(s.feat).sort(), [...FEATURE_KEYS].sort());
  for (const k of FEATURE_KEYS) assert.ok(k in s.feat, `白名单里的 ${k} 没被写出来`);

  // `at` 记的是球的世界坐标，而球是打到身边才打得到的——实测与 `label.G` 的 x 分量
  // 相关 0.994、|at − G| 均值 0.565m。喂进模型等于把握点（走位输出）塞回 X。
  assert.ok(!('at' in s.feat), 'at 不能进特征');
  // 但诊断还要用它还原漏接几何，所以不能删
  assert.deepStrictEqual(s.meta.at, [0.1, 1.9, 0.3]);
});

t('driftDeg 与 driftComp 成对记录，缺省按「没补偿」处理', () => {
  const mk = (extra) => buildContactSample({
    t: 0, grip: [0, 1.3, 0.3], rest: [0, 0.6, 0], planOffset: [0, 0.6, 0],
    holdR: 0.14, deadband: 0.05, deadbandY: 0.02,
    capture: { t: 0, fc: [0.1, 1.9, 0.3], at: [0.1, 1.9, 0.3], ballV: [0, 0, 10],
      hit: true, offCenter: 0.2, lag: 10, stroke: null, serve: false },
    rally: 1, sincePrevHit: null, session: 's1', ...extra,
  });

  // 手机没接上 / 旧版页面没发报文：只能是 null（不知道）。记成 0 会让
  // 「漂移超标整段剔除」把可疑样本全放过。
  const unknown = mk({ driftDeg: null });
  assert.strictEqual(unknown.meta.driftDeg, null);
  assert.strictEqual(unknown.meta.driftComp, false);

  // 补偿开时 `driftDeg` 是「已经扣掉了多少」，关时是「此刻歪了多少」——同一个数
  // 两种含义，必须成对记才能解释。
  const on = mk({ driftDeg: 12.5, driftComp: true });
  assert.strictEqual(on.meta.driftDeg, 12.5);
  assert.strictEqual(on.meta.driftComp, true);
});

t('瞄准残差 = 拍面中心偏离瞄准点，且正好等于 fc − p', () => {
  // G = p − planOffset，所以 p = G + planOffset；残差应当逐分量等于 fc − p
  const G = [0, 1.3, 0.3];
  const planOffset = [0, 0.6, 0.02];
  const p = [G[0] + planOffset[0], G[1] + planOffset[1], G[2] + planOffset[2]];
  const fc = [0.1, 1.9, 0.4];
  const s = buildContactSample({
    t: 0, grip: G, rest: [0, 0.6, 0], planOffset, holdR: 0.14, deadband: 0.05, deadbandY: 0.02,
    capture: { t: 0, fc, at: p, ballV: [0, 0, 10], hit: true, offCenter: 0.2,
      lag: 0, stroke: null, serve: false },
    rally: 1, sincePrevHit: null, driftDeg: null, session: 's1',
  });
  const r = aimResidual(s);
  // 残差是三次减法叠出来的，不能按位比（0.6 − 0.6 会留 1e-16）
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(r[i] - (fc[i] - p[i])) < 1e-9, `第 ${i} 轴：残差应等于 fc − p`);
  }
  assert.ok(Math.abs(r[0] - 0.1) < 1e-9 && Math.abs(r[1]) < 1e-9 && Math.abs(r[2] - 0.08) < 1e-9);

  // 旧样本（11-15 之前）没有 planOffset，不能算出残差，返回 null 而不是 0
  delete s.meta.planOffset;
  assert.strictEqual(aimResidual(s), null, '缺字段要显式返回 null，不能编一个 0 出来');
});

t('JSONL：一行一条、分组齐全、空集合给空串', () => {
  assert.strictEqual(samplesToJsonl([]), '');
  const text = samplesToJsonl([mkSample(10, 0.1), mkSample(20, 0.3)]);
  const lines = text.trim().split('\n');
  assert.strictEqual(lines.length, 2);
  const row = JSON.parse(lines[0]);
  for (const k of ['label', 'feat', 'meta']) assert.ok(row[k], `缺 ${k} 组`);
  assert.ok('G' in row.label && 'delta' in row.label);
  assert.ok('lag' in row.feat && 'rest' in row.feat);
  assert.strictEqual(row.label.rest[1], 0.6, 'label 和 feat 的 rest 应是同一份快照');
  assert.ok('planOffset' in row.meta && 'holdR' in row.meta && 'deadband' in row.meta
    && 'deadbandY' in row.meta, 'meta 应带上瞄准点与走位容差');
  assert.ok('driftDeg' in row.meta && 'driftComp' in row.meta,
    'meta 应带上漂移读数与其补偿状态');
});

t('分组读数把「命中」和「没碰到」分开列', () => {
  const text = summarizeContacts([mkSample(10, 0.2), mkSample(10, 0.6, { hit: false })]);
  assert.ok(text.includes('命中'));
  assert.ok(text.includes('没碰到'));
  assert.ok(text.includes('n=1'), '两组各一条，不能合并');
});

t('采集未开启时 push 静默丢弃，开了才攒', () => {
  const log = new ContactLog();
  log.push(mkSample(10, 0.1));
  assert.strictEqual(log.count, 0);
  log.start();
  log.push(mkSample(10, 0.1));
  assert.strictEqual(log.count, 1);
  log.stop();
  log.push(mkSample(10, 0.1));
  assert.strictEqual(log.count, 1);
  assert.strictEqual(log.toJsonl().trim().split('\n').length, 1);
});

/**
 * 发球不进采集，是一条**定下来的规则**（抛球位置 4.25 已定稿，不需要校准），
 * 不是「恰好没采到」。它现在由 `checkReceiverFace` 的 `phase !== 'live'` 挡住，
 * 而那条判断很容易在重构里被顺手改掉，所以在这里钉住。
 */
t('发球：抛球阶段挥拍能打出去，但一条 contact 样本都不产生', () => {
  const d = new Duel();
  d.phase = 'toss';
  d.hitter = 'player';
  d.receiver = 'machine';
  d.serveServer = 'player';
  d.serveCourt = 'deuce';
  d.servePending = true;

  const g = IDLE_POSE.pos;
  // 抛球落在握点前上方，正好穿过 `tossContact` 的击球区
  d.ball = makeBall([g[0], g[1] + 1.2, g[2] - 0.25], [0, -1, 0]);

  let now = 0;
  const out = [];
  let swung = false;
  for (let i = 0; i < 240; i++) {
    now += 1000 / 60;
    d.pushRacket({ t: now, pos: [...g], q: [...IDLE_POSE.q] });
    // 球落到击球区附近时挥一拍
    if (!swung && d.ball.p[1] < g[1] + 0.75) {
      swung = true;
      d.submit({
        t: now, peakW: 18, head: [0, 0, 20], speed: 20,
        face: [0, 0, -1], grip: [0, 1, 0], charge: 0.6, used: false,
      });
    }
    for (const e of d.update(1 / 60, now)) out.push(e);
    if (out.some((e) => e.kind === 'hit' && e.serve)) break;
  }

  assert.ok(out.some((e) => e.kind === 'hit' && e.serve), '这一发应该真的打出去了，否则测不到东西');
  assert.strictEqual(out.filter((e) => e.kind === 'contact').length, 0,
    '发球是另一条路径：不许往校准器的训练集里塞样本');
  assert.ok(swung, '挥拍要在球落地前发生');
});

console.log(`\n${pass} 项通过`);
