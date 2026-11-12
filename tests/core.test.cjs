const assert = require('node:assert');
const { encodePacket, decodePacket, PACKET_BYTES } = require('./core/protocol.js');
const { ImuTracker, qConj, qMul, qNormalize } = require('./core/imu.js');
const { deviceEulerToWorldQuat, qYaw, toOutputQuat, qAngle,
  worldYawDelta, isYawGimbal, YawDriftObserver,
  PoseContinuityGate, MAX_POSE_JUMP, MAX_EXTRAP_MS } = require('./core/attitude.js');
const { LatencyWindow, ClockSync, PacketStats } = require('./play/stats.js');
const { VISION_DEFAULTS, rgbToHsv, hueDistance, hsvHit, buildMask, largestBlob, detect, mapPixelX, lowPass } = require('./play/vision-math.js');
const { SwingDetector, shotFromStroke } = require('./core/swing.js');
const { omegaFromQuatDelta } = require('./core/gyro.js');
const { makeBall, advance, liftOverNet, aimIntoCourt, setWallActive, predictAtPlane, sampleCrossings } = require('./core/physics.js');
const { planAutoMove, stepAxis, blendCenterOffset, AUTO_MOVE_DEFAULTS } = require('./core/auto-move.js');
const { Rally } = require('./core/rally.js');
const { BallMachine, MACHINE_L2, ARRIVE_Y_MIN, ARRIVE_Y_MAX } = require('./core/machine.js');
const { Duel } = require('./core/duel.js');
const { BALL_R, WALL_Z, WALL_H, HIT_Z, RACKET_POS, FACE_RX, FACE_RY, FACE_CY, NET_Z, NET_H, HALF_WIDTH, PHYS_DT, OPP_HIT_Z, OPP_BASELINE_Z, FEED_APEX_DX, FEED_APEX_DY, FEED_APEX_BACK_MIN, FEED_APEX_BACK_MAX } = require('./core/court.js');
const { sweepFace, faceCovers, faceCenter, RacketTrack, IDLE_POSE } = require('./core/racket.js');

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
  const q = qNormalize([0.3, -0.4, 0.5, 0.7]);
  const r = qMul(q, qConj(q));
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

t('慢漂被积分、挥拍的大转角原样放过，且挥拍后继续积分', () => {
  const o = new YawDriftObserver();
  let q = deviceEulerToWorldQuat(0, 90, 0);
  o.update(q);
  for (let i = 1; i <= 30; i++) {
    q = deviceEulerToWorldQuat(i * 0.4, 90, 0); // 每帧 +0.4°，慢漂
    o.update(q);
  }
  assert.ok(Math.abs(o.degrees - 12) < 0.1, `30 帧 ×0.4° 应累积 12°，实际 ${o.degrees.toFixed(2)}°`);

  q = deviceEulerToWorldQuat(12 + 25, 90, 0); // 单帧 25°，一次中等挥拍
  o.update(q);
  assert.ok(Math.abs(o.degrees - 12) < 0.1, `挥拍不该计入漂移，实际 ${o.degrees.toFixed(2)}°`);
  assert.strictEqual(o.skippedSteps, 1);

  q = deviceEulerToWorldQuat(37 + 0.4, 90, 0);
  o.update(q);
  assert.ok(Math.abs(o.degrees - 12.4) < 0.1, `挥拍后应继续积分，实际 ${o.degrees.toFixed(2)}°`);
});

t('换握位的大跳变不会被当成漂移', () => {
  const o = new YawDriftObserver();
  o.update(deviceEulerToWorldQuat(10, 90, 0));
  o.update(deviceEulerToWorldQuat(10, 90, 90)); // 正手 ↔ 反手
  assert.ok(Math.abs(o.degrees) < 1e-9, `大跳变不该积分，实际 ${o.degrees}`);
  assert.strictEqual(o.skippedSteps, 1);
});

t('把观测到的漂移扣进 yawZero 后，输出姿态回到启动那一刻', () => {
  const start = deviceEulerToWorldQuat(10, 90, 0);
  const zero = qYaw(start);
  const out0 = toOutputQuat(start, zero);

  const o = new YawDriftObserver();
  let q = start;
  o.update(q);
  for (let i = 1; i <= 40; i++) {
    q = deviceEulerToWorldQuat(10 + i * 0.5, 90, 0); // 一路慢漂 20°
    o.update(q);
  }
  const raw = toOutputQuat(q, zero);
  const fixed = toOutputQuat(q, zero + o.radians);
  const driftErr = (qAngle(raw, out0) * 180) / Math.PI;
  const fixedErr = (qAngle(fixed, out0) * 180) / Math.PI;
  assert.ok(driftErr > 15, `不补偿应歪掉约 20°，实际 ${driftErr.toFixed(1)}°`);
  assert.ok(fixedErr < 0.5, `补偿后应回正，实际 ${fixedErr.toFixed(1)}°`);
});

t('reset 后观测归零（对应按 R / 新会话）', () => {
  const o = new YawDriftObserver();
  let q = deviceEulerToWorldQuat(0, 90, 0);
  o.update(q);
  for (let i = 1; i <= 30; i++) {
    q = deviceEulerToWorldQuat(i * 0.4, 90, 0);
    o.update(q);
  }
  assert.ok(Math.abs(o.degrees) > 1, '先要真的积到漂移');
  o.reset();
  assert.strictEqual(o.radians, 0);
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
  o.update(deviceEulerToWorldQuat(30, 60, 0));
  o.update(deviceEulerToWorldQuat(30, 61.5, 0)); // 纯俯仰 1.5°，投影到 Y 上很小
  assert.ok(Math.abs(o.degrees) < 0.01, `俯仰不该进漂移累积，实际 ${o.degrees.toFixed(3)}°`);
  assert.strictEqual(o.skippedSteps, 1);
});

t('纯 yaw 慢漂仍被完整积分（纯度判据不能误伤）', () => {
  const o = new YawDriftObserver();
  let q = deviceEulerToWorldQuat(0, 90, 0);
  o.update(q);
  for (let i = 1; i <= 30; i++) o.update(deviceEulerToWorldQuat(i * 0.4, 90, 0));
  assert.ok(Math.abs(o.degrees - 12) < 0.1, `应累积 12°，实际 ${o.degrees.toFixed(2)}°`);
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
  const cur = qMul(base, qAA([1, 0, 0], 20));
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

t('拍面背对 → 球往后飞，判为没打开', () => {
  const shot = shotFromStroke(strokeOf([0, 2, -14], [0, 0, 1]));
  assert.strictEqual(shot.clean, false);
  assert.ok(shot.v[2] > 0, `拍面背对时球应往身后飞，实际 vz=${shot.v[2]}`);
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

t('高速球不会穿墙', () => {
  const b = makeBall([0, 1.4, -6], [0, 0, -42]);
  let wall = null;
  let net = false;
  for (let i = 0; i < 300; i++) {
    advance(b, 1 / 60, (c) => {
      if (c.kind === 'wall') wall = c.at;
      if (c.kind === 'net') net = true;
    });
    assert.ok(b.p[2] >= WALL_Z + BALL_R - 1e-6, `第 ${i} 帧球跑到墙外：${b.p[2]}`);
  }
  assert.ok(wall, '应该撞到墙');
  assert.strictEqual(net, false, '1.4 米高出手不该撞网');
});

t('撞墙后能量保留足够，球能弹回来', () => {
  const b = makeBall([0, 1.4, -6], [0, 0, -20]);
  let vzAfter = null;
  for (let i = 0; i < 60 && vzAfter === null; i++) {
    advance(b, 1 / 60, (c) => {
      if (c.kind === 'wall') vzAfter = b.v[2];
    });
  }
  assert.ok(vzAfter !== null, '应该撞到墙');
  assert.ok(vzAfter > 8, `反弹速度应够大，实际 ${vzAfter.toFixed(1)}`);
  assert.strictEqual(b.wallHits, 1);
});

t('静止的球不再刷碰撞事件', () => {
  const b = makeBall([0, BALL_R, -3], [0, 0, 0]);
  let n = 0;
  for (let i = 0; i < 120; i++) advance(b, 1 / 60, () => n++);
  assert.strictEqual(n, 0, `静止球不该产生事件，实际 ${n} 个`);
});

console.log('回球补偿');

/** 按给定出球速度模拟到「球回到击球面」，返回那一刻的高度 */
const backY = (v) => {
  const b = makeBall([0, 0.9, HIT_Z], v);
  let reachedWall = false;
  for (let i = 0; i < 2400; i++) {
    advance(b, 1 / 240, (c) => {
      if (c.kind === 'wall') reachedWall = true;
    });
    if (reachedWall && b.p[2] >= HIT_Z) return b.p[1];
    if (reachedWall && b.bounces >= 2) return null;
  }
  return null;
};

t('轻打重打都能把球兜回来，且回来时够得着', () => {
  for (const sp of [20, 26, 32, 42]) {
    const out = liftOverNet([0, 0.9, HIT_Z], [0, 0, -sp]);
    assert.ok(out[1] > 0, `${sp} m/s 的平击应被抬高`);
    const y = backY(out);
    assert.ok(y !== null, `${sp} m/s 的球没能回到击球面`);
    assert.ok(y > 0.3 && y < 2.0, `${sp} m/s 回球高度 ${y.toFixed(2)}m 不在可击球区间`);
  }
});

t('已经抬起来的球只会被微调，不会被压成平击', () => {
  // 允许压低（压平之后撞墙位置更低、回来也更低，是有效的调节手段），
  // 但幅度必须是「微调」：从 10 压到 0 会让玩家的高吊球变成平击，
  // 那是替他改球路，不是补偿。
  const out = liftOverNet([0, 0.9, HIT_Z], [0, 10, -15]);
  assert.ok(out[1] > 6, `高球不该被压成平球，实际 ${out[1].toFixed(2)}`);
  assert.ok(out[1] <= 10, `不该把球抬得更高，实际 ${out[1].toFixed(2)}`);
});

t('贴墙时不做补偿', () => {
  // 球已经在墙边，再怎么抬也回不来，直接原样返回避免死循环
  const v = [0, 1, -10];
  assert.deepStrictEqual(liftOverNet([0, 1, WALL_Z + 0.1], v), v);
});

/**
 * 把一条出球完整模拟到「回到拍面」，报告拍面求交结果和撞墙高度。
 * 和 probe 内部同一套逻辑：撞墙之后才检查拍面，逐个物理子步求交。
 */
function traceReturn(p, v, spin, pose) {
  const b = makeBall(p, v, spin);
  let wallY = null;
  let reachedWall = false;
  let hit = null;
  for (let i = 0; i < 1600; i++) {
    let hitWall = false;
    advance(
      b,
      1 / 240,
      (c) => {
        if (c.kind === 'wall') {
          hitWall = true;
          wallY = c.at[1];
        }
      },
      (p0, p1) => {
        if (reachedWall && !hit && b.p[2] > NET_Z) {
          const h = sweepFace(pose, p0, p1);
          if (h) hit = h;
        }
      }
    );
    if (hitWall) reachedWall = true;
    if (reachedWall && (hit || b.p[2] > HIT_Z + 1)) break;
  }
  return { hit, wallY };
}

t('补偿瞄的是拍面本身：倾斜拍面下不会选出从拍沿下面掠过的弧线', () => {
  // 复刻 sim「中力」档一次真实的 reach 漏接（见 scripts/probe-scan2.cjs）：
  // 拍面后仰 18°，旧判据「球过竖平面时高度在 ±12cm 窗口内」会选中
  // vy=12.6 的 7.8m 高吊——回球在玩家脚前大力弹起，从拍面下沿下面 2cm
  // 掠过。竖平面窗口对斜拍面是错的：球穿过**倾斜盘平面**的点比穿过竖平面
  // 低 15cm，窗口既错位又太窄。
  const theta = 18;
  const half = (theta * Math.PI) / 360;
  const pose = { t: 0, pos: [0.35, RACKET_POS[1], HIT_Z], q: [0, Math.cos(half), Math.sin(half), 0] };
  const face = faceCenter(pose);
  // 触球点贴在拍面中心下方 1cm —— 跟握点高度无关（原来写死 1.59，那是握点 1.0 时的拍面）。
  const at = [0.35, face[1] - 0.01, 0.49];
  const v = [0, 6.16, -15.65];
  const spin = [-25.6, 0, 0];

  const out = liftOverNet(at, v, spin, face[2], face[1], pose);

  // 不能再是高吊：撞墙高度必须留在可见墙面以内
  const tr = traceReturn(at, out, spin, pose);
  assert.ok(tr.hit, '选了 pose 之后，回球必须真的穿过拍面');
  assert.ok(tr.wallY !== null && tr.wallY <= WALL_H, `撞墙高度应 ≤ ${WALL_H}m，实际 ${tr.wallY?.toFixed(2)}`);
  assert.ok(out[1] < 10, `不该再选出 12+ 的高吊仰角，实际 ${out[1].toFixed(2)}`);
  // 而且不是勉强擦框：补偿用的是击球瞬间的位姿快照，瞄得居中才有余量
  assert.ok(tr.hit.offCenter < 0.5, `回球应打在拍面中部，实际偏离 ${tr.hit.offCenter.toFixed(2)}`);

  // 反证：同一拍不给 pose（旧判据）确实会选中那个高吊
  const legacy = liftOverNet(at, v, spin, face[2], face[1]);
  assert.ok(legacy[1] > 12, `旧判据应当选中高吊（这正是被修复的 bug），实际 ${legacy[1].toFixed(2)}`);
});

t('回球补偿：竖直拍面下盘形判定和窗口判定给出同样能打的结果', () => {
  // 这条钉住「传了 pose 不会把本来能打的球改坏」。
  //
  // 位姿按 `Rally.launch` 的规矩**归一化**：回球目标是 `aimY`（= 触球高度），
  // 位姿平移到「拍面中心正好落在 aimY」，朝向照旧。所以这里不能拿 `RACKET_POS`
  // 那个真实握点当位姿——那样拍面中心在 1.9m，而球是从 1.0m 出手的，等于要求
  // 一条「从腰高爬回头顶」的弧线，撞墙高度必然超 5.2m（实测 5.9m）。
  const at = [0, 1.0, HIT_Z];
  const aimY = at[1];
  const pose = { t: 0, pos: [at[0], aimY - FACE_CY, HIT_Z], q: [0, 0, 0, 1] };
  const face = faceCenter(pose);
  assert.ok(Math.abs(face[1] - aimY) < 1e-9 && Math.abs(face[2] - HIT_Z) < 1e-9, '归一化位姿不对');
  for (const sp of [20, 26, 32]) {
    const out = liftOverNet(at, [0, 0, -sp], [0, 0, 0], face[2], face[1], pose);
    const tr = traceReturn(at, out, [0, 0, 0], pose);
    assert.ok(tr.hit, `${sp} m/s 的回球应穿过拍面`);
    assert.ok(tr.wallY !== null && tr.wallY <= WALL_H, `${sp} m/s 撞墙高度应 ≤ ${WALL_H}m`);
  }
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

t('挥拍过程中球拍一直在转，球也必须打得中（真机的主场景）', () => {
  // 模拟器里曾经球拍位姿全程静止，这条路径从来没被覆盖过——真机上几乎
  // 每一拍都在转，于是「模拟全绿、真机全漏」。
  //
  // 现在球拍是老老实实绕握点转的（拍面中心会扫出去半米），球不再追拍面，
  // 靠发球瞄准 + 落地重瞄把球送到拍面附近。这条测试钉住的是：
  // 正常的连续摆动节奏下，物理弹道仍然能命中。
  const r = new Rally();
  const dt = 1000 / 60;
  let now = 0;
  let hits = 0;
  for (let i = 0; i < 60 * 10 && hits === 0; i++) {
    now += dt;
    // 连续摆动：±70° 来回转，幅度覆盖一次真实的正手挥拍
    const deg = 70 * Math.sin((now / 1000) * 5);
    r.pushRacket({ t: now, pos: [...RACKET_POS], q: quatAxis([1, 0, 0], deg) });
    if (r.phase === 'contact') {
      // 这里不能用下面状态机段里的 strokeAt：它在文件后面才声明（TDZ）
      r.submit({
        t: now,
        peakW: 12,
        head: [0, 3, -14],
        speed: Math.hypot(0, 3, -14),
        face: [0, 0, -1],
        grip: [0, 1, 0],
        charge: 0.6,
        used: false,
      });
    }
    for (const e of r.update(dt / 1000, now)) if (e.kind === 'hit') hits++;
  }
  assert.ok(hits >= 1, '球拍在挥动过程中也必须能打中球');
});

console.log('对墙打状态机');

/** 一次「正常」挥拍，供状态机测试复用 */
const strokeAt = (t) => ({
  t,
  peakW: 12,
  head: [0, 3, -14],
  speed: Math.hypot(0, 3, -14),
  face: [0, 0, -1],
  grip: [0, 1, 0],
  charge: 0.6,
  used: false,
});

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 模拟玩家的走位：把球拍搬到球的落点上。
 *
 * 严格碰撞之后这一步是必需的——拍面只有 30×38cm，球的横向落点是米级的，
 * 站着不动必然大半够不着。这就是「加移动」要解决的事，测试里先把走位理想化，
 * 这样验证的是几何判定本身，而不是「模拟玩家走得准不准」。
 *
 * follow: false 用来反证：站着不动应该大量够不着。
 */
/**
 * 物理前推：球穿过击球面时的 x。
 *
 * 不能用「当前位置 + 当前速度 × 剩余时间」线性外推——来球会先落地再弹起，
 * 落地时横向速度被摩擦削掉约四分之一，线性外推会把它算多，走位就跟着偏。
 * 喂球现在带 ±16cm 的横向散布（见 court.ts 的 FEED_APEX_DX），这点预测误差
 * 足以让球从拍框外擦过去，所以这里必须用真实物理。
 */
function predictX(ball) {
  const b = makeBall([...ball.p], [...ball.v], [...ball.spin]);
  b.bounces = ball.bounces;
  b.wallHits = ball.wallHits;
  let prevZ = b.p[2];
  for (let i = 0; i < 240 * 3; i++) {
    advance(b, 1 / 240, () => {});
    if (prevZ < HIT_Z && b.p[2] >= HIT_Z) return b.p[0];
    if (!b.live) return b.p[0];
    prevZ = b.p[2];
  }
  return b.p[0];
}

function placeRacket(rally, now, follow = true, fixedX = 0) {
  let px = fixedX;
  if (follow) {
    const b = rally.ball;
    px = clamp(b.v[2] > 0.1 ? predictX(b) : b.p[0], -3, 3);
  }
  rally.pushRacket({ t: now, pos: [px, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] });
}

/** 按 60fps 推进，返回各类事件计数 */
function drive(rally, frames, onFrame, opts) {
  const dt = 1000 / 60;
  const follow = !opts || opts.follow !== false;
  const fixedX = (opts && opts.x) || 0;
  const stats = { hits: 0, nets: 0, misses: [], grounds: 0, walls: 0, streaks: 0, ends: 0, serves: 0 };
  let now = 0;
  let px = fixedX;
  for (let i = 0; i < frames; i++) {
    now += dt;
    // 走位有速度上限（极速 4.2 m/s ≈ 0.07m/帧）。玩家是走过去的，不是瞬移。
    //
    // 这条限速不只是「像人」：拍面会跟着球走，而走位若用整条弹道外推
    // 又会追过头，两个预测回路互相带偏，球到达时偏到盘外。
    // 限速把回路打断，和真人走位一致。
    if (follow && rally.ball.v[2] > 0.1) {
      const want = clamp(predictX(rally.ball), -3, 3);
      const step = 0.07;
      px += Math.max(-step, Math.min(step, want - px));
    }
    rally.pushRacket({ t: now, pos: [px, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] });
    const evs = rally.update(dt / 1000, now);
    for (const e of evs) {
      if (e.kind === 'hit') stats.hits++;
      else if (e.kind === 'net') stats.nets++;
      else if (e.kind === 'miss') stats.misses.push(e.reason);
      else if (e.kind === 'ground') stats.grounds++;
      else if (e.kind === 'wall') stats.walls++;
      else if (e.kind === 'streak') stats.streaks++;
      else if (e.kind === 'end') stats.ends++;
      else if (e.kind === 'serve') stats.serves++;
    }
    if (onFrame) onFrame(rally, now, evs);
  }
  return stats;
}

t('发球是弹地喂球：先落一次地，再以腰高送到拍面', () => {
  // 真实网球绝大多数来球是弹地之后的。除了像不像的问题，落点还是玩家
  // 唯一可靠的「计时信号」——球一落地，之后的高度单调可预测，挥拍时机可以
  // 靠看落点学出来。直送过来的球没有这个锚点，玩家只能等球飞到脸前再反应。
  //
  // 这条测试钉三件事：
  //   1. 来球在到达拍面之前**必须落地一次**（0 次 = 退回直送，2 次 = 球没送到）
  //   2. 落点在拍面前方 1.3–2.4 米（顶点最远只能到 2.0–2.3m，见 serve 的说明；
  //      取这条带是因为「再远就够不着、再近就变成急升球」两头都试过）
  //   3. 击球高度贴合拍面中心（发球时按此刻的拍面中心瞄，不能"又高又飘"）
  const r = new Rally();
  const dt = 1000 / 60;
  let now = 0;
  const groundZ = [];
  let hit = null;

  for (let i = 0; i < 300 && !hit; i++) {
    now += dt;
    placeRacket(r, now, true);
    // 球到面那一帧立刻挥拍（和真实玩家一样：不是等球粘住了才动）
    if (r.phase === 'contact') r.submit(strokeAt(now));
    for (const e of r.update(dt / 1000, now)) {
      if (e.kind === 'ground') groundZ.push(e.at[2]);
      if (e.kind === 'hit') hit = e.at;
    }
  }
  assert.ok(hit, '应该能打到来球');
  assert.strictEqual(groundZ.length, 1, `来球必须先落且只落一次，实际 ${groundZ.length} 次`);
  // placeRacket 用的是无旋转姿态（拍面竖直朝球场），中心在握点上方 FACE_CY
  const faceY = faceCenter({ t: now, pos: [0, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] })[1];
  const dropZ = groundZ[0];
  assert.ok(
    dropZ < HIT_Z - 1.3 && dropZ > HIT_Z - 2.4,
    `落点应该在拍面前 1.3–2.4m，实际 ${(HIT_Z - dropZ).toFixed(2)}m`
  );
  assert.ok(
    Math.abs(hit[1] - faceY) < 0.3,
    `击球高度应贴合拍面中心 ${faceY.toFixed(2)}m，实际 ${hit[1].toFixed(2)}m`
  );
});

t('喂球只要求「顶点落在拍面附近」：位置有散布，但都在够得着的范围里', () => {
  // 这是「不用每次都朝着拍面中心喂球」的直接验收。
  //
  // 抓 feedBounce 的返回值（它现在会报弹起后的顶点 apex），连续发一串球，
  // 检查两件事：
  //   1) 顶点确实在拍面附近——前后在 FEED_APEX_BACK_MIN..MAX 一带，
  //      横向 / 竖直不超过散布半径（否则就是「够不到」那类反馈）
  //   2) 顶点位置**真的在变**——没有散布的话每球都吸在同一个点上，
  //      玩家只需要判时间、不用判方向，接球就退化成打地鼠
  const phys = require('./core/physics.js');
  const shots = [];
  const orig = phys.feedBounce;
  phys.feedBounce = function (...args) {
    const out = orig.apply(null, args);
    if (out) shots.push(out);
    return out;
  };
  const r = new Rally();
  try {
    // 不挥拍：让每球都因为「漏接」结束，然后发下一球。
    // 站着不动，所以发球那一刻的拍面中心就是 x=0 / y=1.6。
    drive(r, 60 * 30, null, { follow: false });
  } finally {
    phys.feedBounce = orig;
  }

  assert.ok(shots.length >= 6, `30 秒至少该发 6 球，实际 ${shots.length}`);
  const faceY = RACKET_POS[1] + FACE_CY;

  for (const s of shots) {
    assert.ok(s.apex, '每个解都应该报出顶点');
    const back = s.apex[2] - HIT_Z; // 顶点在拍面之后多远
    assert.ok(
      back > FEED_APEX_BACK_MIN - 0.25 && back < FEED_APEX_BACK_MAX + 0.25,
      `顶点应该在拍面之后 ${FEED_APEX_BACK_MIN}–${FEED_APEX_BACK_MAX}m，实际 ${back.toFixed(2)}m`
    );
    assert.ok(
      Math.abs(s.apex[0]) < FEED_APEX_DX + 0.12,
      `顶点横向偏出太多：${s.apex[0].toFixed(2)}m`
    );
    assert.ok(
      Math.abs(s.apex[1] - faceY) < FEED_APEX_DY + 0.2,
      `顶点高度偏离拍面中心太多：${(s.apex[1] - faceY).toFixed(2)}m`
    );
  }

  // 散布必须存在（不然就是「精确送到中心」换了层皮）
  const xs = shots.map((s) => s.apex[0]);
  const span = Math.max(...xs) - Math.min(...xs);
  assert.ok(span > 0.08, `顶点横向应该散开，实际跨度只有 ${span.toFixed(3)}m`);
});

t('发球之后走开，球不会跟着换落点（飞行途中不再改方向）', () => {
  // 反证：以前靠 steerToRacket 在最后 0.55s 把球带向拍面，玩家发球后横移
  // 1.2m 球照样送到手上——那是追踪弹，不是网球。现在飞行途中不再改方向，
  // 只在落地弹起那一刻按当时拍面重瞄一次（横向上限 1.6 m/s，2 米飞行约 20cm）。
  // 所以走开超过重瞄能力之后，第一颗球应该从新站位旁边飞过去（reach）。
  const r = new Rally();
  const dt = 1000 / 60;
  let now = 0;
  let x = 0;
  let servedAt = null;
  let moved = false;
  let firstMiss = null;

  for (let i = 0; i < 60 * 9 && firstMiss === null; i++) {
    now += dt;
    if (servedAt === null && r.phase === 'incoming') servedAt = now;
    // 发球后 0.35 秒横移 1.2 米：远超落地重瞄的 20cm 能力
    if (servedAt !== null && !moved && now - servedAt > 350) {
      x = 1.2;
      moved = true;
    }
    r.pushRacket({ t: now, pos: [x, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] });
    // 全程不挥拍；只看第一颗球的死法，后面重新发的球会瞄新站位，不该混进来
    for (const e of r.update(dt / 1000, now)) {
      if (e.kind === 'miss' && firstMiss === null) firstMiss = e.reason;
    }
  }

  assert.equal(firstMiss, 'reach', `球不该再追着新站位跑，实际死法 ${firstMiss}`);
});

t('没挥拍时球不会原速穿过拍面，而是擦框掉下去', () => {
  // 喂球现在瞄着拍面中心，所以「球看着明明到了拍子上」是每一球的常态。
  // 如果这时把球速原样还原、让它继续飞，屏幕上就是「球从拍子里穿过去」，
  // 玩家会判定「碰撞坏了」。现在给它一个说得通的结局：擦框、往侧前方掉。
  const r = new Rally();
  const dt = 1000 / 60;
  let now = 0;
  let late = null;
  for (let i = 0; i < 60 * 6 && late === null; i++) {
    now += dt;
    placeRacket(r, now, true);
    for (const e of r.update(dt / 1000, now)) {
      if (e.kind === 'miss' && e.reason === 'late') late = now;
    }
  }
  assert.ok(late !== null, '不挥拍应该判 late（球到了拍面但没挥）');
  assert.ok(
    Math.hypot(...r.ball.v) < 4,
    `球应该擦框掉下去，实际还带着 ${Math.hypot(...r.ball.v).toFixed(1)} m/s`
  );
  assert.ok(r.ball.v[2] <= 0, `不应该继续往身后飞，实际 vz=${r.ball.v[2].toFixed(1)}`);
});

t('一直好好挥拍就能一直对拉下去', () => {
  const r = new Rally();
  // 18 秒：一个往返约 2.5s（出球 0.8s + 回球落地再飞回来 1.7s），
  // 14 秒只够 5–6 拍，正好卡在断言边界上——那是窗口太紧，不是rally断了。
  const stats = drive(r, 60 * 18, (rally, now) => {
    // 球回到身前 1.3 米内、正朝我飞来（或已经冻结在击球点上等我）时挥拍。
    // 每帧都提交，由 used 标记去重，等价于「玩家在正确的时机挥了一下」。
    const reachable =
      rally.phase === 'contact' || (rally.phase === 'incoming' && rally.ball.v[2] > 0);
    if (reachable && rally.ball.p[2] > -1) rally.submit(strokeAt(now));
  });
  assert.strictEqual(stats.serves, 1, `整局不该重新发球，实际发了 ${stats.serves} 次`);
  assert.ok(stats.hits >= 6, `18 秒内应打出 6 拍以上，实际 ${stats.hits}`);
  assert.deepStrictEqual(stats.misses, [], '不该漏接');
  assert.strictEqual(stats.nets, 0, '不该撞网');
  assert.strictEqual(stats.ends, 0, '不该断球');
  assert.ok(stats.walls > 0, '应该撞到练习墙');
  assert.ok(stats.grounds > 0, '应该有落地反弹');
  // 连拍只在过网时 +1：过网次数与击球次数应当是 1:1（最后一拍可能还没过网）
  assert.ok(
    Math.abs(stats.streaks - stats.hits) <= 1,
    `过网 ${stats.streaks} 次 / 击球 ${stats.hits} 次，连拍被重复计数了`
  );
  assert.ok(r.best >= 5);
});

t('站到边上不动，球也要喂到手上', () => {
  // 真机反馈：「一开始不动时还打得到，移动起来之后就打不到了」。
  // 根因是喂球从场地正中发、横向速度随机 ±1.2，落点铺开 ±1.3m——
  // 玩家一按 WASD 走开两米，球就从他身边飞过去，而且屏幕上没有
  // 「你站歪了多少」的参照，他不知道要回来。现在发球按此刻拍面中心定横向起点；
  // 球一旦飞起来就不再改方向（飞行途中的跟随已撤销）。
  for (const px of [0, 2, -2.5]) {
    const r = new Rally();
    const dt = 1000 / 60;
    let now = 0;
    const stats = { hits: 0, misses: [] };
    for (let i = 0; i < 60 * 12; i++) {
      now += dt;
      placeRacket(r, now, false, px);
      // 球回到身前时挥拍，等价于「这个人站位不动，但挥拍时机是对的」
      const reachable = r.phase === 'contact' || (r.phase === 'incoming' && r.ball.v[2] > 0);
      if (reachable && r.ball.p[2] > -1) r.submit(strokeAt(now));
      for (const e of r.update(dt / 1000, now)) {
        if (e.kind === 'hit') stats.hits++;
        else if (e.kind === 'miss') stats.misses.push(`${e.reason}@x${px}`);
      }
    }
    assert.deepStrictEqual(stats.misses, [], `站 x=${px} 时不该漏接，实际漏了 ${stats.misses.join(',')}`);
    assert.ok(stats.hits >= 3, `站 x=${px} 时 12 秒应打出 3 拍以上，实际 ${stats.hits}`);
  }
});

t('不挥拍就是漏接，球飞过去之后重新发球', () => {
  const r = new Rally();
  const stats = drive(r, 60 * 6);
  assert.strictEqual(stats.hits, 0);
  assert.ok(stats.misses.length >= 1);
  assert.ok(stats.misses.every((m) => m === 'late'), `应为 late，实际 ${stats.misses}`);
  assert.ok(stats.serves >= 2, '断球后应重新发球');
  assert.strictEqual(stats.ends, 0, '连拍为 0 时不该报断球');
});

t('击球判定是 ±150ms 时间窗，早了晚了都不算', () => {
  for (const [lag, expect] of [
    [100, true],
    [250, false],
  ]) {
    const r = new Rally();
    const dt = 1000 / 60;
    let now = 0;
    let submitted = false;
    let hit = false;
    let missed = false;
    for (let i = 0; i < 260 && !hit && !missed; i++) {
      now += dt;
      placeRacket(r, now, true);
      for (const e of r.update(dt / 1000, now)) {
        if (e.kind === 'hit') hit = true;
        if (e.kind === 'miss') missed = true;
      }
      // 球一到击球面就立刻提交一个「时间戳偏 lag 毫秒」的挥拍
      if (!submitted && r.phase === 'contact') {
        submitted = true;
        r.submit(strokeAt(now - lag));
      }
    }
    assert.ok(submitted, '应该进入过击球冻结状态');
    assert.strictEqual(hit, expect, `滞后 ${lag}ms 的挥拍应${expect ? '被接受' : '被拒绝'}`);
  }
});

t('抢跑：球到面那一帧就出球，根本不会停在接触阶段', () => {
  let everContact = false;
  // 模拟大屏端的接线：状态机问一次，检测器就交出「正在进行中」的这一挥
  const r = new Rally((near) => strokeAt(near));
  const stats = drive(r, 60 * 3, (rally) => {
    if (rally.phase === 'contact') everContact = true;
  });
  assert.ok(stats.hits > 0, '抢跑之后应该能连续打到球');
  assert.strictEqual(r.diag.lastLatency, 0, `出球延迟应为 0，实际 ${r.diag.lastLatency}ms`);
  // 球一次都没在击球面上停留过——玩家视觉上就不会看到「球悬着等我挥」
  assert.strictEqual(everContact, false, '抢跑生效时球不该停在接触阶段');
});

t('对照：没有抢跑时，球必须在击球面上悬一帧以上', () => {
  // 这条测的是「出球延迟」，所以把喂球散布固定住：偶尔碰到顶点偏 16cm 的球
  // 可能根本不接触，测的就变成「散布下能不能碰到」了。
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const r = new Rally();
    let contact = null;
    drive(r, 60 * 3, (rally) => {
      if (rally.phase !== 'contact') return;
      if (contact === null) contact = rally.contactAt;
      // 老路径：挥拍事件早就提交了，但要等状态机下一帧才发现它
      rally.submit(strokeAt(rally.contactAt));
    });
    assert.notStrictEqual(contact, null, '应该进入过接触阶段');
    assert.ok(r.diag.lastLatency !== null, '出球延迟应被记录');
    assert.ok(
      r.diag.lastLatency > 15,
      `老路径必然要等一帧以上，实际 ${r.diag.lastLatency}ms——这个数就是玩家感觉到的「晚」`
    );
  } finally {
    Math.random = realRandom;
  }
});

t('击球诊断：一次没挥时明确显示「没有挥拍」', () => {
  const r = new Rally();
  // 4 秒：弹地喂球的球要先飞 8-10 米落地，再弹起来飞 2.5 米到拍面，
  // 一个来球约 1.6-2.1s，1.5s 只够看球落地。
  drive(r, 60 * 4);
  assert.ok(r.diag.reaches >= 1, '球应该到过击球面');
  assert.strictEqual(r.diag.swings, 0);
  assert.strictEqual(r.diag.lastLag, null, '没挥过就不该有时差');
  assert.ok(r.diag.lastAtY !== null && r.diag.lastAtY > 0.1 && r.diag.lastAtY < 2.35);
});

t('击球诊断：时差的正负号能区分挥早还是挥晚', () => {
  // 这条只关心「时差符号」，所以把喂球散布固定住（Math.random = 0.5 → 偏移 0）。
  // 否则偶尔遇到顶点偏 16cm 的球、模拟走位又差几厘米，这一球可能根本不接触，
  // 时差就成了 null——测的变成了「散布下能不能碰到」，而不是「符号对不对」。
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    for (const [off, sign, label] of [
      [-90, -1, '早'],
      [90, 1, '晚'],
    ]) {
      const r = new Rally();
      let done = false;
      // 抓**第一拍**刚打完那一刻的 lastLag：260 帧里回球会飞回来再接一次，
      // 那一拍没挥拍，lastLag 会被覆盖成 null。测的是第一拍，就在这里取。
      let lag = null;
      drive(r, 260, (rally, now, evs) => {
        if (!done && rally.phase === 'contact') {
          done = true;
          rally.submit(strokeAt(now + off));
        }
        if (lag === null && evs.some((e) => e.kind === 'hit')) lag = rally.diag.lastLag;
      });
      assert.ok(lag !== null, `${label}：应记录到挥拍`);
      assert.strictEqual(Math.sign(lag), sign, `${label}：符号不对，实际 ${lag}`);
      assert.ok(Math.abs(Math.abs(lag) - Math.abs(off)) < 40, `${label}：幅值偏差过大 ${lag}`);
    }
  } finally {
    Math.random = realRandom;
  }
});

t('击球诊断：挥得太后仍能看出晚了多久', () => {
  const r = new Rally();
  let done = false;
  drive(r, 260, (rally, now) => {
    if (!done && rally.phase === 'contact') {
      done = true;
      // 超出冻结期才到，判定必然是漏接，但时差必须被记下来
      rally.submit(strokeAt(now + 420));
    }
  });
  assert.ok(r.diag.lastLag !== null, '应记录到挥拍');
  assert.ok(r.diag.lastLag > 200, `应显示明显挥晚，实际 ${r.diag.lastLag}`);
});

t('拍面只有 30×38cm：球心偏出 25cm 就打空', () => {
  // 严格碰撞的反证：拍面尺寸真的在限制范围，不是摆设。
  //
  // 原来这条用的是「站着不动」——喂球从场地正中发、横向铺开 ±1.3m，
  // 不走位自然够不着。现在发球按此刻拍面中心瞄准（见 serve 的说明），
  // 「站着不动」反而成了能打到的那一类，所以直接问几何本身：
  // 同一条水平飞过的球，偏 15cm 中、偏 25cm 不中。
  const pose = { t: 0, pos: [0, RACKET_POS[1], HIT_Z], q: [0, 0, 0, 1] };
  const cy = RACKET_POS[1] + FACE_CY;
  const shot = (dx) => sweepFace(pose, [dx, cy, HIT_Z + 1], [dx, cy, HIT_Z - 1]);
  assert.ok(shot(0), '正中必须命中');
  assert.ok(shot(0.15), '偏 15cm（还在拍框内）必须命中');
  assert.strictEqual(shot(0.25), null, '偏 25cm（超出拍框）必须打空');
});

t('走位到位时能连续打到球，且甜区偏离是「附近」而不是每次都正中', () => {
  // 喂球的目标已经改成「顶点落在拍面附近」而不是「精确送到中心」
  // （见 court.ts 的 FEED_APEX_DX / DY）。所以这里不能再要求每球都打在甜区，
  // 要验证的是两件事：走位到位时球一定在判定盘内（能打到），
  // 以及偏离确实有散布（有一球靠近中心，但不是全部）。
  const r = new Rally();
  const offs = [];
  drive(r, 60 * 12, (rally, now, evs) => {
    for (const e of evs) if (e.kind === 'hit') offs.push(rally.lastHit.offCenter);
    if (rally.phase === 'contact' || (rally.phase === 'incoming' && rally.ball.v[2] > 0)) {
      rally.submit(strokeAt(now));
    }
  });
  assert.ok(offs.length >= 3, `走位到位应该能连续接到球，实际只接到 ${offs.length} 次`);
  assert.ok(
    offs.every((v) => v < 1),
    `所有命中都必须在判定盘内，实际最大偏 ${Math.max(...offs).toFixed(2)}`
  );
  // 「散布真的存在」由「喂球只要求顶点落在拍面附近」那条单独验证（它抓得到 apex 分布）。
  // 这里只看打得到 + 不总是正中：样本只有几球，卡跨度阈值会偶发红。
  assert.ok(
    Math.min(...offs) < 0.9,
    `不该每球都擦着拍框，实际最小偏 ${Math.min(...offs).toFixed(2)}`
  );
});

console.log('视觉走位（纯计算）');

// 32×24 的合成画面：底色是低饱和浅灰，命中色是品红（h=300，默认 hue=310 ±24）。
const VW = 32;
const VH = 24;
function vframe(paint) {
  const d = new Uint8ClampedArray(VW * VH * 4);
  for (let i = 0; i < VW * VH; i++) {
    const p = i << 2;
    d[p] = 240; d[p + 1] = 240; d[p + 2] = 240; d[p + 3] = 255;
  }
  if (paint) paint(d);
  return d;
}
function vrect(d, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * VW + x) << 2;
      d[p] = 255; d[p + 1] = 0; d[p + 2] = 255;
    }
  }
}

t('rgbToHsv 给出正确的色相、饱和度和明度', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);
  near(rgbToHsv(255, 0, 0).h, 0);
  near(rgbToHsv(0, 255, 0).h, 120);
  near(rgbToHsv(0, 0, 255).h, 240);
  near(rgbToHsv(255, 0, 255).h, 300);
  near(rgbToHsv(128, 128, 128).s, 0);
  near(rgbToHsv(128, 128, 128).v, 128 / 255);
});

t('hueDistance 是环形距离，跨 0/360 不会算成 358 度', () => {
  assert.strictEqual(hueDistance(359, 1), 2);
  assert.strictEqual(hueDistance(350, 10), 20);
  assert.strictEqual(hueDistance(0, 180), 180);
  assert.strictEqual(hueDistance(310, 310), 0);
});

t('hsvHit 挡掉低饱和、低明度和色相不符的像素', () => {
  const c = VISION_DEFAULTS;
  assert.strictEqual(hsvHit(310, 1, 1, c), true);
  assert.strictEqual(hsvHit(300, 1, 1, c), true, '品红 300 落在 310±24 内');
  assert.strictEqual(hsvHit(310, 0.1, 1, c), false, '白墙不能被当成色块');
  assert.strictEqual(hsvHit(310, 1, 0.1, c), false, '暗背景不能被当成色块');
  assert.strictEqual(hsvHit(20, 1, 1, c), false, '差 70 度的红色不算');
});

t('largestBlob 只认最大连通块，同色噪点拽不偏质心', () => {
  const d = vframe((buf) => {
    vrect(buf, 10, 8, 16, 14);   // 36 像素的大块
    vrect(buf, 0, 0, 2, 2);      // 4 像素的干扰块
  });
  const blob = largestBlob(buildMask(d, VISION_DEFAULTS), VW, VH);
  assert.ok(blob, '应该找到色块');
  assert.strictEqual(blob.area, 36);
  assert.ok(Math.abs(blob.cx - 12.5) < 1e-6, `质心 x 应为 12.5，实际 ${blob.cx}`);
  assert.ok(Math.abs(blob.cy - 10.5) < 1e-6, `质心 y 应为 10.5，实际 ${blob.cy}`);
});

t('largestBlob 空掩码返回 null', () => {
  assert.strictEqual(largestBlob(buildMask(vframe(), VISION_DEFAULTS), VW, VH), null);
});

t('detect 用面积门槛挡掉小噪点', () => {
  const small = vframe((buf) => vrect(buf, 3, 3, 6, 6)); // 9 像素 < minArea 24
  assert.strictEqual(detect(small, VW, VH, VISION_DEFAULTS), null);
  const big = vframe((buf) => vrect(buf, 10, 8, 16, 14));
  const b = detect(big, VW, VH, VISION_DEFAULTS);
  assert.ok(b && b.area === 36, '36 像素的色块必须检出');
});

t('mapPixelX 线性映射并在两端钳位', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);
  near(mapPixelX(15.5, VW, 1.2), 0);
  near(mapPixelX(0, VW, 1.2), -1.2);
  near(mapPixelX(VW - 1, VW, 1.2), 1.2);
  near(mapPixelX(-20, VW, 1.2), -1.2);
  near(mapPixelX(999, VW, 1.2), 1.2);
});

t('lowPass 单调收敛、不过冲，退化参数直通', () => {
  let x = 0;
  for (let i = 0; i < 40; i++) {
    const next = lowPass(x, 1, 250, VISION_DEFAULTS.tauMs);
    assert.ok(next <= 1 + 1e-9, '低通不能过冲');
    assert.ok(next >= x, '低通必须单调朝目标收敛');
    x = next;
  }
  assert.ok(x > 0.99, `40 步后应该基本收敛，实际 ${x}`);
  assert.strictEqual(lowPass(0, 1, 16, 0), 1, 'tau=0 表示不平滑');
  assert.strictEqual(lowPass(0.4, 1, 0, 250), 0.4, 'dt=0 时保持');
});

/* ================= 对打（脚本回球机 + 判分） =================
 *
 * 这一整节都跑在「练习墙关掉」的前提下：球从对手底线附近起飞，而练习墙就在
 * WALL_Z=-11.9，墙一开，球出生那一刻就被抓回墙前（探针没关墙，得出一整族
 * 错误的调参结论，见 docs/history.md 4.16）。放在文件最后是因为 wallActive
 * 是模块级开关，`new Duel()` 也会关掉它，跑在前面会污染墙打那批用例。
 */
setWallActive(false);

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

t('前后走位：拍面中心低（横握）时往后退，让球降到拍面高度', () => {
  const b = duelShot([1.4, 1.45]);
  const vert = planAutoMove(b, VERT()); // 中心 1.6m，和来球高度基本一致
  const horiz = planAutoMove(b, HORIZ()); // 中心 1.0m，得等球掉下来
  assert.ok(horiz.targetZ > vert.targetZ + 0.5,
    `横握站位 ${horiz.targetZ.toFixed(2)} 应明显比竖握 ${vert.targetZ.toFixed(2)} 靠后`);
  assert.ok(horiz.hitY < vert.hitY,
    `横握接到的球应该更低：${horiz.hitY && horiz.hitY.toFixed(2)} vs ${vert.hitY && vert.hitY.toFixed(2)}`);
  assert.ok(horiz.targetZ <= AUTO_MOVE_DEFAULTS.maxZ + 1e-9, '不能退到场外');
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

t('已经从我身边过去的球不追（追不上，只会把人拖走）', () => {
  // 「过去」的判据是球已经越过拍面能覆盖的最深处（maxZ + 中心偏移），
  // 不是「越过 HIT_Z」——站得靠后时球在 HIT_Z 之后仍然来得及。
  const behind = makeBall([1.4, 1.2, AUTO_MOVE_DEFAULTS.maxZ + 0.5], [0, 0.2, 5]);
  assert.equal(planAutoMove(behind, VERT()).chasing, false);
  // 同样位置但还在可站范围内：必须追
  const front = makeBall([1.4, 1.2, AUTO_MOVE_DEFAULTS.maxZ - 0.3], [0, 0.2, 5]);
  assert.equal(planAutoMove(front, VERT()).chasing, true, '还在可及范围内就该追');
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

t('端到端：中途跑开 2.2m，自动走位仍把球拉回判定位内', () => {
  // 墙打的球是瞄着「发球那一刻的拍面」来的，落地重瞄只能横移 20cm。
  // 玩家中途按错方向跑到边上，球就不会来找他了——这是「够不到」的典型现场。
  setWallActive(true);
  const realRandom = Math.random;
  let rs = 20261112;
  Math.random = () => {
    rs = (rs * 1103515245 + 12345) % 2147483648;
    return rs / 2147483648;
  };
  try {
    const r = new Rally();
    const dt = 1 / 60;
    let now = 1000;
    let px = 0;
    let pz = HIT_Z;
    const devs = [];
    for (let i = 0; i < 60 * 32; i++) {
      now += dt * 1000;
      if (i === 40) px = 2.2; // 跑开，此后完全交给自动走位
      const plan = planAutoMove(r.ball, { x: px, z: pz, center: [0, FACE_CY, 0] });
      const speed = plan.chasing ? AUTO_MOVE_DEFAULTS.speed : AUTO_MOVE_DEFAULTS.homeSpeed;
      const speedZ = plan.chasing ? AUTO_MOVE_DEFAULTS.speedZ : AUTO_MOVE_DEFAULTS.homeSpeed;
      px = Math.max(-AUTO_MOVE_DEFAULTS.maxX,
        Math.min(AUTO_MOVE_DEFAULTS.maxX, stepAxis(px, plan.target, speed * dt, AUTO_MOVE_DEFAULTS.deadband)));
      pz = Math.max(AUTO_MOVE_DEFAULTS.minZ,
        Math.min(AUTO_MOVE_DEFAULTS.maxZ, stepAxis(pz, plan.targetZ, speedZ * dt, AUTO_MOVE_DEFAULTS.deadband)));
      r.pushRacket({ t: now, pos: [px, RACKET_POS[1], pz], q: [0, 0, 0, 1] });
      // 球穿过**这一帧的**站位平面那一刻，量球心与握点的横向差（竖握 = 与拍面中心的差）
      const prevZ = r.ball.p[2];
      const prevPz = pz;
      r.update(dt, now); // 不挥拍，球擦框掉落，于是会一直重发
      if ((prevZ - prevPz) * (r.ball.p[2] - prevPz) <= 0 && r.ball.p[2] !== prevZ) {
        devs.push(Math.abs(r.ball.p[0] - px));
      }
    }
    assert.ok(devs.length >= 6, `32 秒里应该有多次来球，实际 ${devs.length}`);
    const worst = Math.max(...devs);
    // 判定半轴 0.203，但喂球本身还有 ±0.12 的顶点散布，留到 0.25 算「进判定位」
    assert.ok(worst <= 0.25, `最差到面横向偏差 ${worst.toFixed(3)}m，应该 ≤0.25`);
  } finally {
    Math.random = realRandom;
    // 后面的对打用例全部从 OPP_HIT_Z 之后起飞，必须关墙——这里显式还回去，
    // 别指望「文件里没写过 setWallActive(true) 就等于墙关着」。
    setWallActive(false);
  }
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

t('Duel 构造时就关掉练习墙（否则从对手底线发的球会被抓回网前）', () => {
  setWallActive(true);
  const stuck = makeBall([0, 1.5, -15], [0, 0, -6]);
  advance(stuck, PHYS_DT, () => {});
  assert.ok(stuck.p[2] > -12.0, `墙开着时球被挡在网后 1.4 米，实际 z=${stuck.p[2].toFixed(2)}`);

  const d = new Duel();
  assert.strictEqual(d.score.player, 0, '新开一局比分归零');
  const free = makeBall([0, 1.5, -15], [0, 0, -6]);
  advance(free, PHYS_DT, () => {});
  assert.ok(free.p[2] < -15, `Duel 构造后球应该能自由飞过 WALL_Z，实际 z=${free.p[2].toFixed(2)}`);
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

console.log(`\n${pass} 项通过`);
