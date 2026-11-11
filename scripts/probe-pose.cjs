/**
 * 诊断「挥拍一快就打不到球 / 打一会儿拍子疯狂抖」。
 *
 * 姿态连续性门原本用一个固定角度（1.2 rad）判断「这一帧是不是欧拉角换解分支」。
 * 但方向事件只有 20–25Hz 时，20–35 rad/s 的真实挥拍相邻帧就有 1.0–1.75 rad，
 * 和门限重叠。更糟的是比较基准冻结在「最后一次被采信的姿态」，跳变帧不更新它：
 * 一旦挥拍中途越过门限，整段挥拍乃至之后都被判成跳变，拍子改用削顶的陀螺积分
 * 外推，直到 500ms 兜底到期才强制跳回绝对姿态 —— 击球判空 + 肉眼可见的抖动。
 *
 * 这个探针在纯计算层复现上述序列，对照旧判据与现在的 `PoseContinuityGate`。
 * 它不碰 DOM、不碰网络，只能证明「判据本身会不会误伤」，真机效果仍需复验。
 *
 *   npm test && node scripts/probe-pose.cjs
 */
const path = require('path');

const core = path.join(__dirname, '..', '.tmp-test', 'core', 'attitude.js');
const fs = require('fs');
if (!fs.existsSync(core)) {
  console.error('缺少编译产物，请先跑：npm test');
  process.exit(1);
}
const {
  deviceEulerToWorldQuat,
  qAngle,
  PoseContinuityGate,
  MAX_POSE_JUMP,
  MAX_EXTRAP_MS,
} = require(core);

/** 历史对照：修复前 controller/advancePose 里的判据，原样复刻用于 A/B。 */
function legacyGate() {
  let lastGoodAbs = null;
  let extrapMs = 0;
  return (raw, dtMs) => {
    const jump = lastGoodAbs ? qAngle(raw, lastGoodAbs) : 0;
    const tooLong = extrapMs > MAX_EXTRAP_MS;
    if (!lastGoodAbs || jump <= MAX_POSE_JUMP || tooLong) {
      lastGoodAbs = raw;
      extrapMs = 0;
      return true;
    }
    extrapMs += dtMs;      // 基准不更新：下一帧还在跟跳变前的姿态比
    return false;
  };
}

const HZ = 25;                 // 方向事件频率（不少机型就是 20–30Hz）
const DT = 1000 / HZ;
const FRAMES = 30 * HZ;        // 30 秒
const SWING_EVERY = 2.5 * HZ;  // 每 2.5 秒挥一拍
const SWING_FRAMES = 5;        // 200ms 一拍（去 5 帧 + 回 5 帧）
const DRIFT_PER_FRAME = 0.024; // alpha 慢漂 0.6°/s

/** 生成 30 秒姿态序列：帧号 / 四元数 / 该帧是否在真实运动。 */
function makeSequence(stepRad, stayTurned) {
  const out = [];
  let gamma = 0;
  for (let i = 0; i < FRAMES; i++) {
    const phase = i % SWING_EVERY;
    let moving = false;
    if (phase < SWING_FRAMES) {
      gamma += stepRad;                       // 挥出去
      moving = true;
    } else if (phase < SWING_FRAMES * 2 && !stayTurned) {
      gamma -= stepRad;                       // 收回原位
      moving = true;
    }
    // stayTurned：挥完停在新朝向（玩家顺势转身），不再回来
    const alpha = 30 + i * DRIFT_PER_FRAME;
    out.push({
      q: deviceEulerToWorldQuat(alpha, 90, (gamma * 180) / Math.PI),
      moving,
      dtMs: DT,
    });
  }
  return out;
}

function measure(seq, decide) {
  let extrapFrames = 0;
  let run = 0;
  let maxRun = 0;
  let switches = 0;
  let prevAccepted = true;
  for (const f of seq) {
    const accepted = decide(f.q, f.dtMs, f.moving);
    if (!accepted) {
      extrapFrames++;
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
    if (accepted !== prevAccepted) switches++;
    prevAccepted = accepted;
  }
  return { extrapFrames, maxMs: Math.round(maxRun * DT), switches };
}

console.log('姿态连续性门：快挥拍是否被误判为欧拉解分支跳变');
console.log(`方向事件 ${HZ}Hz，30 秒内每 2.5s 挥一拍，固定门限 ${MAX_POSE_JUMP}rad / 外推兜底 ${MAX_EXTRAP_MS}ms\n`);

for (const stayTurned of [false, true]) {
  console.log(`【${stayTurned ? '挥完停在新朝向' : '挥完收回原位'}】`);
  console.log('  每帧转角  等效角速度  旧判据(外推帧/最长/切换)   现判据(外推帧/最长/切换)');
  for (const step of [0.4, 0.8, 1.2, 1.6]) {
    const seq = makeSequence(step, stayTurned);
    const legacyFn = legacyGate();
    const gate = new PoseContinuityGate();
    const a = measure(seq, (q, dt) => legacyFn(q, dt));
    const b = measure(seq, (q, dt, moving) => gate.decide(q, dt, moving));
    const w = (step / (DT / 1000)).toFixed(0);
    const fmt = (r) => `${String(r.extrapFrames).padStart(3)} 帧 / ${String(r.maxMs).padStart(4)}ms / ${String(r.switches).padStart(2)} 次`;
    console.log(`  ${step.toFixed(1)}rad    ${String(w).padStart(2)} rad/s   ${fmt(a)}   ${fmt(b)}`);
  }
  console.log();
}

console.log('读法：');
console.log('  · 旧判据在每帧转角 ≥1.2rad 时开始把整段挥拍踢进外推；「切换」次数就是');
console.log('    拍子在绝对姿态 / 陀螺外推之间来回跳的次数，大跳会被大屏的低平滑原样显示。');
console.log('  · 现判据只要传感器在动就采信绝对姿态，且基准每帧更新，跳变只影响一帧。');
console.log('  · 这个探针只覆盖判据本身；削顶的陀螺积分偏差、网络乱序、大屏平滑仍需真机复验。');
