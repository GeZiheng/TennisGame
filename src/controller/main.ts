import { ImuTracker, qConj, qMul, qNormalize, IDENTITY, type Quat } from '../core/imu';
import { isYawGimbal, qYaw, toOutputQuat, YawDriftObserver, PoseContinuityGate } from '../core/attitude';
import { MotionSource, DemoSource, type SampleSource } from './sensors';
import { diagnose, noEventsIssue, isFatal, type EnvFacts, type EnvIssue } from './env';
import { Link, type LinkState } from '../net/link';
import { SWING_THRESHOLD } from '../core/court';
import {
  encodePacket,
  ACCEL_FULL_SCALE_G,
  GYRO_FULL_SCALE_RAD,
  PACKET_BYTES,
  type CtrlMsg,
} from '../core/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const gate = $<HTMLDivElement>('gate');
const gateTitle = $<HTMLHeadingElement>('gate-title');
const gateHint = $<HTMLParagraphElement>('gate-hint');
const gateDiag = $<HTMLDivElement>('gate-diag');
const gateMsg = $<HTMLParagraphElement>('gate-msg');
const gateActions = $<HTMLDivElement>('gate-actions');
const gateFacts = $<HTMLParagraphElement>('gate-facts');
const gateUrl = $<HTMLInputElement>('gate-url');
const copyBtn = $<HTMLButtonElement>('copy-link');
const demoBtn = $<HTMLButtonElement>('demo-btn');
const startBtn = $<HTMLButtonElement>('start');
const running = $<HTMLDivElement>('running');
const connPill = $<HTMLSpanElement>('conn-pill');
const rateEl = $<HTMLSpanElement>('rate');
const poseRateEl = $<HTMLSpanElement>('pose-rate');
const poseSrcEl = $<HTMLSpanElement>('pose-src');
const driftToggleEl = $<HTMLButtonElement>('drift-toggle');
const axesEl = $<HTMLCanvasElement>('axes');
const wBar = $<HTMLElement>('w-bar');
const wVal = $<HTMLElement>('w-val');
const gBar = $<HTMLElement>('g-bar');
const gVal = $<HTMLElement>('g-val');
const flagG = $<HTMLSpanElement>('flag-gsat');
const flagW = $<HTMLSpanElement>('flag-wsat');
const flagGyro = $<HTMLSpanElement>('flag-gyro');

const R2D = 180 / Math.PI;
const params = new URLSearchParams(location.search);
const room = (params.get('room') ?? '').toUpperCase().slice(0, 4);
const demo = params.has('demo');

/* ---------------- 偏航慢漂补偿 ---------------- */

/**
 * 默认关：现场点 HUD 上的「漂移」按钮、或手机 URL 加 ?drift=1 才接管输出。
 * 纯读数始终显示，方便先看清「手机没动时传感器多转了多少度」。
 */
const drift = new YawDriftObserver();
let driftOn = params.get('drift') === '1';
let gimbal = false;

driftToggleEl.addEventListener('click', () => {
  if (driftOn) {
    // 开 → 关：把已经扣掉的补偿固化进 yawZero，否则关掉这一刻拍子会突然歪回去。
    // 这只是数值平移，不是「按当前姿态重新定义正前方」，所以仍然与握位无关。
    if (yawZero !== null) yawZero += drift.radians;
  }
  driftOn = !driftOn;
  // 关 → 开也要清观测：之前累积的是没被补偿的漂移，一次性扣进去会跳一下
  drift.reset();
  driftToggleEl.textContent = driftOn ? '漂移补偿已开' : '漂移补偿已关';
  driftToggleEl.className = `rate ${driftOn ? 'good' : ''}`;
});

const source: SampleSource = demo ? new DemoSource() : new MotionSource();
const tracker = new ImuTracker();

let link: Link | null = null;
let origin: Quat = [0, 0, 0, 1];
/**
 * 启动瞬间的朝向。绝对姿态的 alpha 在各平台参考系不同，直接发出去球拍会凭空扭到
 * 某个方向；扣掉这个初值，朝向就变成「相对启动瞬间」，而倾斜仍然是绝对真实的。
 */
let yawZero: number | null = null;

/* ---------------- 姿态连续性 ---------------- */

/**
 * 判据与计时都在 `core/attitude.ts` 的 `PoseContinuityGate`（纯计算、有单测）。
 * 这里只负责传入「传感器此刻是不是在动」和外推所需的陀螺增量。
 *
 * 方向事件 20–25Hz 时，20–35 rad/s 的挥拍相邻帧转角可达 1.0–1.75 rad，会越过
 * 1.2 rad 的固定门限；只看角度会把整段真实挥拍判成解分支跳变，踢进陀螺外推。
 */
const poseGate = new PoseContinuityGate();
let extrapBase: Quat | null = null;     // 外推基准（最后一次可信输出）
let trackerAtBase: Quat | null = null; // 那一刻的陀螺积分快照
let poseMode: 'absolute' | 'extrap' | 'gyro' = 'gyro';
let currentQ: Quat = [...IDENTITY];
let lastPoseAt = 0;

let seq = 0;
let peakG = 0;
let peakW = 0;
let lastGyro: [number, number, number] = [0, 0, 0];
let lastSendAt = 0;
let lastAccel: [number, number, number] = [0, 0, 1];
let sendCount = 0;
let sendRate = 0;
let buf = new ArrayBuffer(PACKET_BYTES);
let wakeLock: any = null;

/* ---------------- 环境自检 ---------------- */

const env: { facts: EnvFacts | null; issues: EnvIssue[] } = demo
  ? { facts: null, issues: [] }
  : diagnose();

function renderDiag(issues: EnvIssue[]) {
  gateDiag.textContent = '';
  if (issues.length === 0) {
    gateDiag.hidden = true;
    return;
  }
  gateDiag.hidden = false;
  for (const issue of issues) {
    const card = document.createElement('div');
    card.className = 'diag-card';

    const title = document.createElement('div');
    title.className = 'diag-title';
    title.textContent = issue.title;

    const detail = document.createElement('p');
    detail.className = 'diag-detail';
    detail.textContent = issue.detail;

    const steps = document.createElement('ol');
    steps.className = 'diag-steps';
    for (const s of issue.steps) {
      const li = document.createElement('li');
      li.textContent = s;
      steps.append(li);
    }

    card.append(title, detail, steps);
    gateDiag.append(card);
  }
}

function renderFacts(f: EnvFacts) {
  const mark = (ok: boolean) => (ok ? '✓' : '✗');
  const who = f.inApp ?? (f.isIOS ? 'iOS' : f.isAndroid ? 'Android' : '桌面浏览器');
  gateFacts.textContent = `安全上下文 ${mark(f.secure)} · DeviceMotion ${mark(f.hasMotion)} · ${who}`;
  const good = f.secure && f.hasMotion && !f.inApp;
  gateFacts.className = `gate-facts ${good ? 'ok' : 'bad'}`;
}

async function copyCurrentUrl() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // http 页面拿不到剪贴板权限，退回 execCommand；还不行就靠用户长按输入框
    try {
      gateUrl.select();
      gateUrl.setSelectionRange(0, url.length);
      document.execCommand('copy');
    } catch {
      /* 让用户手动长按复制，下面会有提示 */
    }
  }
  copyBtn.textContent = '已复制，去浏览器粘贴';
  setTimeout(() => (copyBtn.textContent = '复制链接'), 2200);
}

const facts = env.facts;
if (facts) {
  renderFacts(facts);
  renderDiag(env.issues);
  gateUrl.value = location.href;

  if (isFatal(env.issues)) {
    // 确定拿不到数据的情况下，别让人白点一次按钮
    gateTitle.textContent = '这个环境拿不到传感器';
    gateHint.hidden = true;
    startBtn.hidden = true;
    gateActions.hidden = false;
  }
}

copyBtn.addEventListener('click', copyCurrentUrl);

demoBtn.addEventListener('click', () => {
  const u = new URL(location.href);
  u.searchParams.set('demo', '1');
  location.replace(u.toString());
});

/* ---------------- 传感器 ---------------- */

source.onSample = (s) => {
  tracker.update(s.gyro, s.dtMs);
  lastGyro = s.gyro;
  lastAccel = s.accel;

  const a = Math.hypot(s.accel[0], s.accel[1], s.accel[2]);
  const w = Math.hypot(s.gyro[0], s.gyro[1], s.gyro[2]);
  advancePose(s.dtMs);
  if (a > peakG) peakG = a;
  if (w > peakW) peakW = w;

  // 挥拍起势时不等定时器，立刻补一包。
  //
  // 60Hz 的 setInterval 最坏要等 16.7ms 才轮到下一次发送，而一次挥拍从起势到峰值
  // 总共只有 100–150ms，这一等就是两位数的延迟占比。只在角速度越过挥拍门槛时补发，
  // 稳态包率不变，不会平白把链路吵醒。
  if (w > SWING_THRESHOLD && performance.now() - lastSendAt > 8) sendFrame();
};

source.onError = (msg) => {
  gateMsg.textContent = msg;
  if (env.facts) renderDiag([...env.issues.filter((i) => i.id !== 'no-events'), noEventsIssue(env.facts)]);
  gateActions.hidden = false;
  gateUrl.value = location.href;
  startBtn.disabled = false;
  startBtn.textContent = '重试';
};

/* ---------------- 发送循环 ---------------- */

/** 方向事件中断 / 跳变期间，用陀螺积分的增量顶上；恢复后由绝对姿态接管。 */
function extrapolate(): Quat {
  if (!extrapBase || !trackerAtBase) return tracker.relativeTo(origin);
  const delta = qMul(qConj(trackerAtBase), tracker.snapshot()); // 设备系增量
  return qNormalize(qMul(extrapBase, delta));
}

/**
 * 每帧推进一次输出姿态。
 *
 * 绝对姿态是权威（系统融合，俯仰横滚有重力参考、不会漂）；陀螺积分只在方向
 * 事件短时中断或单帧跳变时提供增量，所以误差不会跨拍累积。关键的一点：
 * `latestAbs` 在事件停止后**不会**自动变 null，必须靠 `hasAbsolute` 判新鲜度，
 * 否则拍子会僵在最后一次挥拍瞬间的姿态上，手机回到准备姿势也不跟回来。
 */
function advancePose(dtMs: number) {
  // onSample 与 sendFrame 都可能触发：有些机型只有方向事件、没有 devicemotion，
  // 只挂在其中一个上，另一类机型的拍子就会完全不动。同一帧只推进一次，
  // 避免外推计时被走两遍。
  const at = performance.now();
  if (at - lastPoseAt < 4) return;
  // 外推计时必须用真实墙钟间隔：这个函数有两个入口（传感器回调 + 60Hz 发包），
  // 传进来的 dtMs 一个是真实采样间隔、一个是写死的 16.7，双入口会把 500ms
  // 兜底提前到约 250ms。
  const elapsed = lastPoseAt > 0 ? at - lastPoseAt : dtMs;
  lastPoseAt = at;

  const abs = source.latestAbs ?? null;
  const fresh = source.hasAbsolute === true;
  if (abs && yawZero === null) yawZero = qYaw(abs);

  if (abs && fresh) {
    gimbal = isYawGimbal(abs);
    drift.update(abs);
  }

  // 只扣「传感器多转的量」，不重新定义正前方，因此与正手 / 反手握位无关。
  const effZero = (yawZero ?? 0) + (driftOn ? drift.radians : 0);
  const raw = abs && fresh && yawZero !== null ? toOutputQuat(abs, effZero) : null;

  if (raw) {
    // 传感器说在动，就把大转角认作真实挥拍、直接采信绝对姿态。
    // 解分支跳变一般出现在静止 / 微动时，那时 moving 为 false，仍会被门拦下。
    const moving = Math.hypot(lastGyro[0], lastGyro[1], lastGyro[2]) > SWING_THRESHOLD;
    if (poseGate.decide(raw, elapsed, moving)) {
      extrapBase = raw;
      trackerAtBase = tracker.snapshot();
      poseMode = 'absolute';
      currentQ = raw;
      return;
    }
    // 单帧跳变：这一帧的绝对姿态不可信，继续沿陀螺增量走
    poseMode = 'extrap';
    currentQ = extrapolate();
    return;
  }

  poseMode = extrapBase ? 'extrap' : 'gyro';
  currentQ = extrapolate();
}

/** 只读：发送循环和姿态示意取同一份结果，避免两处各自推进状态。 */
function currentOut(): Quat {
  return currentQ;
}

/**
 * 立刻发一包。
 *
 * 抽出来是因为有两个调用方：60Hz 定时器负责保底节奏，传感器回调负责在挥拍起势时补发。
 */
function sendFrame() {
  if (!link?.isConnected) return;

  // 角速度要主动向数据源要「当前值」。
  // 只靠 onSample 赋值的话，那些没有 devicemotion 的机型上它会永远是 0，
  // 于是姿态完美、球拍能跟手，但一球都挥不出去——最难查的那种故障。
  if (source.currentGyro) {
    lastGyro = source.currentGyro();
    const w = Math.hypot(lastGyro[0], lastGyro[1], lastGyro[2]);
    if (w > peakW) peakW = w;
  }

  advancePose(16.7);
  const qOut = currentOut();
  const tSend = performance.now();

  encodePacket(
    {
      seq: seq++,
      tSend,
      // 姿态真正被采到的时刻。没有方向事件的数据源（demo）就退化成「和发送同时」，
      // 这样端到端延迟至少不会算出负数。
      tSample: source.absAt && source.absAt > 0 ? source.absAt : tSend,
      q: qOut,
      gyro: lastGyro,
      accel: lastAccel,
      peakG,
      peakW,
    },
    buf
  );
  link.sendImu(buf);
  sendCount++;
  lastSendAt = performance.now();
}

function startSending() {
  setInterval(sendFrame, 1000 / 60);
}

function startUiLoop() {
  const tick = () => {
    const wDps = Math.hypot(...lastGyro) * R2D;
    const aG = Math.hypot(...lastAccel);

    wVal.textContent = wDps.toFixed(0);
    gVal.textContent = aG.toFixed(1);

    const wRatio = Math.min(1, wDps / 2000);
    wBar.style.width = `${wRatio * 100}%`;
    wBar.className = wRatio >= 0.75 ? 'bad' : wRatio >= 0.45 ? 'warn' : '';

    const gRatio = Math.min(1, aG / ACCEL_FULL_SCALE_G);
    gBar.style.width = `${gRatio * 100}%`;
    gBar.className = gRatio >= 0.95 ? 'bad' : gRatio >= 0.55 ? 'warn' : '';

    flagG.classList.toggle('on', peakG >= ACCEL_FULL_SCALE_G * 0.97);
    flagW.classList.toggle('on', peakW >= GYRO_FULL_SCALE_RAD * 0.97);
    // 亮起来不是警告，是告诉你「这机器的 rotationRate 不能用，已经换成姿态差分兜底」——
    // 排障时这一条决定了是去查传感器还是去查别的地方
    flagGyro.classList.toggle('on', source.gyroSource === 'diff');

    drawAxes();
  };

  tick();
  setInterval(tick, 50);

  setInterval(() => {
    sendRate = sendCount;
    sendCount = 0;
    rateEl.textContent = link?.isConnected ? `${sendRate} Hz` : '— Hz';

    // 姿态采样率：决定屏幕上的球拍有多顺。发包 60Hz 也不代表姿态是 60Hz，
    // 不少机型 deviceorientation 只有 25–35Hz，那时拍子是 30fps 的动画。
    const ph = source.poseHz ?? 0;
    poseRateEl.textContent = ph > 0 ? `姿态 ${ph}Hz` : '姿态 —';
    poseRateEl.className = `rate ${ph > 0 && ph < 45 ? 'warn' : ''}`;

    // 姿态来源要一眼可见：退化成陀螺仪时会漂、起始倾角也是错的，
    // 那种状态下「球拍和手机对不上」不是 bug，是权限没给
    // 三态要如实显示：以前用 !!source.latestAbs，方向事件明明停了还亮绿灯。
    const label = poseMode === 'extrap' ? '姿态外推' : poseMode === 'gyro' ? '陀螺仪' : '绝对姿态';
    poseSrcEl.textContent = label;
    poseSrcEl.className = `rate ${poseMode === 'absolute' ? 'good' : 'warn'}`;

    const d = drift.degrees;
    driftToggleEl.textContent =
      `漂移 ${d >= 0 ? '+' : ''}${d.toFixed(1)}°${driftOn ? ' · 补偿开' : ''}${gimbal ? ' · 万向锁' : ''}`;
    driftToggleEl.className = `rate ${driftOn ? 'good' : Math.abs(d) > 20 ? 'warn' : ''}`;
  }, 1000);
}

/* ---------------- 姿态示意 ---------------- */

function rotateVec(q: Quat, v: [number, number, number]): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

function drawAxes() {
  const ctx = axesEl.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(devicePixelRatio, 2);
  if (axesEl.width !== Math.round(axesEl.clientWidth * dpr)) {
    axesEl.width = Math.round(axesEl.clientWidth * dpr);
    axesEl.height = Math.round(axesEl.clientWidth * dpr);
  }
  const w = axesEl.width;
  const h = axesEl.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const s = w * 0.36;
  const q = currentOut();

  const project = (v: [number, number, number]) => {
    const r = rotateVec(q, v);
    return { x: cx + r[0] * s, y: cy - r[1] * s, z: r[2] };
  };

  // 参考圆
  ctx.strokeStyle = 'rgba(28,28,26,0.08)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, s, 0, Math.PI * 2);
  ctx.stroke();

  const axes: Array<[ [number, number, number], string ]> = [
    [[0, 1, 0], '#0f6e56'], // 拍柄方向
    [[0, 0, 1], '#185fa5'], // 拍面法线
    [[1, 0, 0], '#d85a30'], // 侧向
  ];

  for (const [dir, color] of axes) {
    const p = project(dir);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.min(1, (p.z + 1) / 2));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(28,28,26,0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
  ctx.fill();
}

/* ---------------- 启动 ---------------- */

async function keepAwake() {
  // 已经持有就不用重复申请；松开后（切后台/熄屏）需要重新拿
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await (navigator as any).wakeLock?.request('screen');
    wakeLock?.addEventListener?.('release', () => {
      wakeLock = null;
    });
  } catch {
    /* 不支持或用户拒绝，退化成普通页面，只是会熄屏 */
  }
}

function setPill(state: LinkState) {
  if (!link) return;
  const connected = state === 'connected';
  connPill.textContent = connected
    ? '已连接'
    : state === 'waiting'
      ? '等待大屏'
      : state === 'error'
        ? '连接失败'
        : '连接中…';
  connPill.className = `pill ${connected ? 'ok' : state === 'error' ? 'bad' : ''}`;
}

async function begin() {
  if (!room && !demo) {
    gateMsg.textContent = '缺少房间号，请重新扫大屏上的二维码';
    return;
  }

  if (!demo && isFatal(env.issues)) {
    // 按钮正常情况下已经被藏起来了，这里只是兜底
    gateActions.hidden = false;
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = demo ? '启动演示数据…' : '正在启动传感器…';
  gateMsg.textContent = '';

  const ok = await source.start();
  if (!ok) return;

  if (!demo) await keepAwake();
  origin = tracker.snapshot();
  // 重新锁一次朝向基准：这一刻手机指向哪，球拍就认为那是「正前方」
  yawZero = null;
  drift.reset();
  poseGate.reset();

  gate.hidden = true;
  running.hidden = false;

  if (!room) {
    // demo 模式没有房间号，只跑本地界面，验证姿态和仪表画得对不对
    connPill.textContent = '演示数据';
    connPill.className = 'pill';
    startUiLoop();
    return;
  }

  link = new Link(room, 'peer', {
    onState: setPill,
    onImu: () => {},
    onCtrl: (msg: CtrlMsg) => {
      if (msg.t === 'recal') {
        origin = tracker.snapshot();
        // 补偿开启时，R 只清观测到的漂移量。重锁 yawZero 会把「当前朝向」重新
        // 定义成正前方，真机确认这只在反手位回得正、正手位会锁错方向。
        if (driftOn) {
          // 同样要先固化再清观测：直接 reset 会让拍子瞬间歪回累积的漂移量
          if (yawZero !== null) yawZero += drift.radians;
          drift.reset();
        } else {
          yawZero = null;
        }
        // 清掉连续性状态，下一帧直接以当前绝对姿态为新的可信基准
        poseGate.reset();
        extrapBase = null;
        trackerAtBase = null;
        link?.sendCtrl({ t: 'recal-ack', at: performance.now() });
      } else if (msg.t === 'ping') {
        // 必须回 pong，否则大屏那边的时钟同步永远收敛不了：
        // 单向延迟算不出来，所有延迟指标都是「—」，而 pkt.tSend 也没法换算到本地时钟，
        // 挥拍时刻只能退回「包到达的时刻」——网络延迟就这样被算进了击球时机里。
        const t1 = performance.now();
        link?.sendCtrl({ t: 'pong', t0: msg.t0, t1, t2: performance.now() });
      }
    },
  });

  startSending();
  startUiLoop();
}

startBtn.addEventListener('click', begin);

// demo 模式就是拿来在电脑上预览界面的，不必再点一次按钮
if (demo) begin();

addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});

addEventListener('beforeunload', () => {
  source.stop();
  link?.close();
});
