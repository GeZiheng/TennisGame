import QRCode from 'qrcode';
import { PlayScene, type SceneMode } from './scene';
import { Sfx } from './audio';
import { Link, randomRoom, type LinkState } from '../net/link';
import {
  decodePacket,
  ACCEL_FULL_SCALE_G,
  GYRO_FULL_SCALE_RAD,
  type CtrlMsg,
} from '../core/protocol';
import { LatencyWindow, PacketStats, ClockSync } from './stats';
import { SwingDetector } from '../core/swing';
import { Rally, type RallyEvent } from '../core/rally';
import { Duel, type DuelEvent } from '../core/duel';
import { FACE_CY, HIT_WINDOW_MS, HIT_Z, RACKET_POS } from '../core/court';
import { faceCenter } from '../core/racket';
import {
  AUTO_MOVE_DEFAULTS,
  blendCenterOffset,
  planAutoMove,
  stepAxis,
  type AutoMoveState,
} from '../core/auto-move';
import { MockController } from './mock';
import { VISION_DEFAULTS } from './vision-math';
import { VisionTracker } from './vision';

/**
 * 一局游戏的**完整前端**：连接、收包、挥拍检测、走位、渲染、HUD。
 *
 * 墙打和对打共用这一份，靠 `startPlay(mode)` 参数化。分成两个文件会立刻变成
 * 700 行 × 2 份互相漂移的拷贝——网络那一段（时钟同步、重连复位、姿态连续性）
 * 是这个项目里最贵的代码，它只能有一份。
 *
 * 差异只有三处，都收在 `startPlay` 里：
 *   1. 场景（`PlayScene` 的 mode：整场 + 对手球拍 vs 半场 + 练习墙）
 *   2. 规则对象（`Duel` vs `Rally`）
 *   3. HUD 的主数字（比分 vs 连拍）
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('scene');
const panel = $<HTMLDivElement>('connect-panel');
const linkStateEl = $<HTMLParagraphElement>('link-state');
const roomEl = $<HTMLElement>('room-code');
const urlEl = $<HTMLElement>('ctrl-url');
const qrEl = $<HTMLCanvasElement>('qr');
const sparkEl = $<HTMLCanvasElement>('spark');
const verdictEl = $<HTMLElement>('verdict');

let scene: PlayScene;
const sfx = new Sfx();
const swing = new SwingDetector();
/**
 * 抢跑取拍：球停在击球面上时，直接从检测器里取「正在进行中」的这一挥。
 *
 * 不这么做的话，球要等峰值回落结算完才飞得出去——玩家手已经挥完了，
 * 球还在拍面上悬着，这就是「球弹回的点比接触点晚」的原因。
 * 取走之后立刻 consume，防止同一次挥拍在回落时被再结算一次。
 */
const liveStroke = (near: number) => {
  const live = swing.peekLive(near);
  if (!live) return null;
  swing.consumeLive();
  scene.pulseSwing();
  return live;
};

/** 当前规则对象。墙打是 `Rally`，对打是 `Duel`。 */
let game: Rally | Duel;
const isDuel = () => game instanceof Duel;

const latency = new LatencyWindow();
/** 采样 → 处理 的整条链路，比 latency 多出手机端的采样与发包等待 */
const endToEnd = new LatencyWindow();
const packets = new PacketStats();
const clock = new ClockSync();

let peakG = 0;
let peakW = 0;
let frames = 0;
let fps = 0;
let mock = new MockController();
let link: Link | null = null;

const qs = new URLSearchParams(location.search);
const room = (qs.get('room') ?? randomRoom()).toUpperCase().slice(0, 4);

/**
 * 视觉走位是实验通道，默认完全关闭：不加参数时这一整条代码不产生任何行为。
 * ?vision=probe 只显示读数、不接走位；?vision=1 才把左右站位交给摄像头。
 * 参数见 docs/vision.md，全部有缺省值，真机调色块时不用改代码。
 */
const huePresets: Record<string, number> = { magenta: 310, green: 75, blue: 210, yellow: 45, red: 0 };
const numArg = (key: string, def: number) => {
  const n = Number(qs.get(key));
  return Number.isFinite(n) && n > 0 ? n : def;
};
const hueArgRaw = qs.get('hue');
const hueArg = hueArgRaw === null
  ? VISION_DEFAULTS.hue
  : (huePresets[hueArgRaw.toLowerCase()]
    ?? (hueArgRaw.trim() !== '' && Number.isFinite(Number(hueArgRaw)) ? Number(hueArgRaw) : VISION_DEFAULTS.hue));
const visionMode = qs.get('vision');
const vision = visionMode === 'probe' || visionMode === '1' || visionMode === 'drive'
  ? new VisionTracker({
      mode: visionMode === 'probe' ? 'probe' : 'drive',
      cfg: {
        ...VISION_DEFAULTS,
        hue: hueArg,
        hueTol: numArg('tol', VISION_DEFAULTS.hueTol),
        minArea: numArg('minarea', VISION_DEFAULTS.minArea),
        tauMs: numArg('tau', VISION_DEFAULTS.tauMs),
        maxX: numArg('range', VISION_DEFAULTS.maxX),
      },
      flip: qs.get('flip') === '1',
      preview: qs.get('preview') !== '0',
    })
  : null;
/** V 键：drive 模式下临时切回键盘，做 A/B 对照用。 */
let visionOverride = false;

/**
 * 自动走位：默认**开**，`?auto=0` 关，`F` 键临时切换。
 *
 * 它替代的是「一边盯来球一边按 A/D」这个对大部分人都太难的输入。判定、出球、
 * 挥拍检测一行没动——只是把玩家横向搬到球会经过的位置。要复现「跑不到位」的
 * 手感（或者拍演示视频）就按 F 关掉。
 *
 * 视觉走位开着时自动让位（两路都写 `PLAYER.x` 会打架），见 `updatePlayer`。
 */
let autoMove = qs.get('auto') !== '0';

/**
 * 拍面中心相对**握点**的偏移（世界系，长度恒为 `FACE_CY`=0.6）。
 *
 * 自动走位要的是「拍面中心对准球」，不是「握点对准球」。这两者只在拍子竖直握时重
 * 合：握法一横，拍面就在握点侧方 0.6m，而判定半轴只有 0.24m —— 站对了也打空。
 *
 * 不能直接用实时 `faceCenter`：挥拍本身把中心甩出 0.3–1.1m，每帧跟着走就是「一挥拍
 * 人被拽着跑」（`docs/history.md` 4.5 的老问题）。所以只在角速度很低的帧采信，
 * 用 τ=0.4s 低通跟踪**握法**造成的静态偏移；挥拍期间冻结。
 */
const centerOffset: [number, number, number] = [0, FACE_CY, 0];
let prevQ: [number, number, number, number] | null = null;

function updateCenterOffset(pose: ReturnType<PlayScene['syncRacket']>, dt: number) {
  const fc = faceCenter(pose);
  const want: [number, number, number] = [
    fc[0] - pose.pos[0],
    fc[1] - pose.pos[1],
    fc[2] - pose.pos[2],
  ];
  if (prevQ) blendCenterOffset(prevQ, pose.q, dt, want, centerOffset);
  prevQ = [pose.q[0], pose.q[1], pose.q[2], pose.q[3]];
}

/* ---------------- 连接面板 ---------------- */

async function resolveControllerUrl(): Promise<{ url: string; insecure: boolean }> {
  const port = location.port ? `:${location.port}` : '';
  let host = location.hostname;
  let protocol = location.protocol.replace(':', '');
  try {
    const res = await fetch('/__lanip');
    const data = (await res.json()) as { ips?: string[]; protocol?: string };
    if (data.ips?.length) host = data.ips[0];
    // 用服务端实际跑的协议，不要用 location 的：https 模式下 location 就是 https，
    // 但如果哪天做了反代，这两者会不一致，以服务端为准更可靠
    if (data.protocol) protocol = data.protocol;
  } catch {
    /* 非 dev server 环境（比如直接预览构建产物）就只能用当前 host */
  }
  return {
    url: `${protocol}://${host}${port}/controller.html?room=${room}`,
    insecure: protocol === 'http',
  };
}

function setLinkState(state: LinkState, detail?: string) {
  // `ready` = 信令确认「房间里 host 和 peer 都在」，也就是一次新的配对。
  // 手机重新扫码会重载 controller.html，时钟和包序号都从头开始，而大屏页面
  // 一直没刷新——必须在数据到达前把上一段连接的状态清干净，见 resetSession()。
  if (state === 'ready') resetSession();

  const map: Record<LinkState, [string, string]> = {
    idle: ['准备中…', ''],
    waiting: ['等待手机接入…', ''],
    ready: ['已找到对方，正在建立直连…', ''],
    connecting: ['正在建立点对点通道…', ''],
    connected: ['已连接', 'ok'],
    closed: ['连接中断，等待重连…', 'bad'],
    error: [`连接失败：${detail ?? ''}`, 'bad'],
  };
  const [text, cls] = map[state];
  linkStateEl.textContent = text;
  linkStateEl.className = `link-state ${cls}`;

  const connected = state === 'connected';
  panel.style.display = connected ? 'none' : 'block';
  document.body.classList.toggle('playing', connected);
  if (connected) {
    sfx.unlock();
    $<HTMLElement>('game-hud').hidden = false;
  }
}

/* ---------------- 收包 ---------------- */

/**
 * 最近处理过的包序号。
 *
 * imu 通道是 `ordered: false`（为了不被重传拖慢），代价是 WiFi 抖动时旧包可能后到。
 * 直接应用会让球拍姿态「往回跳一下」——玩家未必读成「丢包」，但一定会读成「不跟手」。
 * 所以落后于已处理序号的包直接丢弃，姿态只往前走。
 */
let lastImuSeq = -1;

/**
 * 新配对 = 新会话，把只属于「一次连接」的状态全部清掉。
 *
 * 大屏页面从不刷新，`Link` 也只在 boot() 里 new 一次；手机那边重新扫码却是
 * 一个全新的页面：`performance.now()` 归零、包序号从 0 开始、姿态基准重新锁。
 * 三处残留各自都能单独造成「重连后一球都打不到」：
 *
 *   - `ClockSync` 的 offset 停在旧时钟差，而它只采纳「RTT 明显更优」的样本，
 *     收敛后门限形同锁死 → 挥拍时刻被换算到几万毫秒外，`takeStroke` 的
 *     ±150ms 窗口一条都匹配不上，连 `peekLive` 抢跑也一起失效；
 *   - `lastImuSeq` 停在旧的大序号，新会话的包全被当成乱序旧包丢掉，拍子僵住；
 *   - `SwingDetector` 里可能还留着上次挥到一半的 armed 峰，会被 `peekLive`
 *     当成「正在挥」误取；`Rally.pending` 里则是时间轴已经错掉的旧挥拍。
 *
 * 这些都不属于「一局游戏」，换人就该清零。姿态平滑（`smoothQ`）不清：新会话
 * 第一包到了会在 22ms 内收敛过去，强行归位反而让拍子凭空跳一下。
 */
function resetSession() {
  clock.reset();
  swing.reset();
  lastImuSeq = -1;
  packets.reset();
  latency.clear();
  endToEnd.clear();
  peakG = 0;
  peakW = 0;
  game.reset();
  flashHint('手机已接入 · 会话已重置');
}

function onPacket(pkt: ReturnType<typeof decodePacket>) {
  if (!pkt) return;
  const now = performance.now();

  packets.mark(pkt.seq, now);
  // 兜底：万一没收到 ready（信令层重连），也要认出新会话的 seq 从 0 重来。
  // imu 通道无序，正常乱序只差几包；回退 240 包（≈4s @60Hz）只可能是新会话。
  // 原来写的 1000 包要求上一次连接至少打满 16.7 秒，短会话重连会全量丢包。
  if (lastImuSeq > 240 && pkt.seq + 240 < lastImuSeq) lastImuSeq = -1;
  if (pkt.seq <= lastImuSeq) return;
  lastImuSeq = pkt.seq;

  if (clock.isValid) {
    const oneWay = now - clock.toLocal(pkt.tSend);
    // 时钟同步还没收敛时会出现负值，直接丢掉，别污染分位数
    if (oneWay >= 0 && oneWay < 800) latency.add(oneWay);

    // 端到端 = 采样时刻 → 这一帧被处理。比单向多出「采样等待 + 发包排队」，
    // 也就是手机那一段。两个数一起看才知道该治手机还是治网络。
    const e2e = now - clock.toLocal(pkt.tSample);
    if (e2e >= 0 && e2e < 800) endToEnd.add(e2e);
  }

  scene.setOrientation(pkt.q);
  if (pkt.peakG > peakG) peakG = pkt.peakG;
  if (pkt.peakW > peakW) peakW = pkt.peakW;

  // 挥拍检测在大屏端做，不在手机端做。
  // 理由：传感器数据本来就每一帧都传过来了，检测放这边可以统一时间轴，
  // 击球判定需要的「挥拍时刻」直接就是本地时钟，不用再做一次跨端换算。
  const tLocal = clock.isValid ? clock.toLocal(pkt.tSend) : now;
  const stroke = swing.push({ t: tLocal, omega: pkt.gyro, q: pkt.q });
  if (stroke) {
    // 先让球拍亮一下：哪怕这一下没打到球，玩家也该看到「系统知道你挥了」
    scene.pulseSwing();
    game.submit(stroke);
  }
}

function onCtrl(msg: CtrlMsg) {
  if (msg.t === 'pong') {
    clock.ingest(msg.t0, msg.t1, msg.t2, performance.now());
  }
}

/* ---------------- 游戏事件 ---------------- */

let lastSpeed = 0;
let lastShot = '—';

/**
 * 主数字：墙打是连拍，对打是比分。
 *
 * HUD 的节点是共用的（两个页面都是同一套 class），所以这里只换显示内容，
 * 不换 DOM 结构——多一套节点就多一份会跟主循环失去同步的缓存。
 */
function primaryText(): string {
  return isDuel()
    ? `${(game as Duel).score.player}:${(game as Duel).score.machine}`
    : String((game as Rally).streak);
}

/** 副数字：墙打是「最好」，对打是「最长回合」。 */
function secondaryText(): string {
  return String(isDuel() ? (game as Duel).bestRally : (game as Rally).best);
}

/**
 * 事件分发。两种模式的事件类型不同，但共享 `kind` 判别标签，
 * 所以按 kind 分支、再在 hit 里看有没有 `by` 字段区分是谁打的。
 */
function handle(e: RallyEvent | DuelEvent) {
  switch (e.kind) {
    case 'hit': {
      if ('by' in e) {
        // 对打：谁打的要区分——对手那一拍音效压低一点，否则听不出回合归属
        sfx.hit(e.by === 'player' ? 0.7 : 0.4, e.clean);
        scene.spawnHitFx(e.at, e.by === 'player' ? 0.7 : 0.45);
        if (e.by === 'player') lastSpeed = e.speed;
        flashPrimary(false);
      } else {
        sfx.hit(e.charge, e.clean);
        scene.spawnHitFx(e.at, e.charge);
        lastSpeed = e.speed;
        lastShot = !e.clean
          ? '拍面没打开'
          : e.topSpin > 60
            ? '上旋'
            : e.topSpin < -60
              ? '下旋'
              : '平击';
        flashPrimary(false);
      }
      break;
    }
    case 'ground':
      sfx.bounce('speed' in e ? e.speed : 4);
      scene.spawnBounceFx(e.at);
      break;
    case 'wall':
      sfx.wall(e.speed);
      break;
    case 'net':
      sfx.net();
      break;
    case 'out':
      if ('by' in e) {
        lastShot = '出界';
        flashHint(e.by === 'player' ? '出界了' : '对手打出界');
      }
      break;
    case 'miss':
      flashHint(e.reason === 'reach' ? '够不着，球从身边过去了' : '挥晚了');
      break;
    case 'streak':
      flashPrimary(true);
      break;
    case 'end':
      sfx.end();
      flashHint(`断了，这一轮 ${e.value} 拍`);
      break;
    case 'point':
      sfx.end();
      lastShot = e.reason;
      flashHint(`${e.winner === 'player' ? '你' : '对手'}得分 · ${e.reason}`);
      flashPrimary(true);
      break;
    case 'serve':
      if (isDuel()) flashHint('对手发球');
      break;
  }
}

/* ---------------- HUD ---------------- */

function fmt(v: number, unit = 'ms', digits = 1) {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—';
}

function flashPrimary(strong: boolean) {
  const el = $<HTMLElement>('s-streak');
  el.textContent = primaryText();
  el.classList.remove('pop', 'pop-soft');
  void el.offsetWidth; // 强制重排，否则动画不会重播
  el.classList.add(strong ? 'pop' : 'pop-soft');
}

let hintTimer = 0;
function flashHint(text: string) {
  const el = $<HTMLElement>('s-hint');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => el.classList.remove('show'), 1600);
}

function updateHud() {
  const el = (id: string) => $<HTMLElement>(id);

  el('s-streak').textContent = primaryText();
  el('s-best').textContent = secondaryText();
  el('s-speed').textContent = lastSpeed > 0 ? `${Math.round(lastSpeed * 3.6)}` : '—';
  el('s-shot').textContent = lastShot;

  el('s-fps').textContent = String(fps);
  el('s-hz').textContent = `${packets.hz}`;

  /* ---- 击球诊断：打不到球的时候，这四个数就是答案 ---- */
  const d = game.diag;
  el('s-swings').textContent = String(d.swings);
  el('s-reaches').textContent = String(d.reaches);

  const lagEl = el('s-lag');
  if (d.lastLag === null) {
    // 球到过头顶/脚边都算，但连一次挥拍都没记录到，那就是角速度没上来
    lagEl.textContent = d.reaches > 0 ? '未挥拍' : '—';
    lagEl.className = `v ${d.reaches > 0 ? 'bad' : ''}`;
  } else {
    const lag = Math.round(d.lastLag);
    const a = Math.abs(lag);
    lagEl.textContent = a <= 20 ? '正好' : `${lag > 0 ? '晚' : '早'} ${a}ms`;
    lagEl.className = `v ${a > HIT_WINDOW_MS * 2 ? 'bad' : a > HIT_WINDOW_MS ? 'warn' : ''}`;
  }

  // 甜区偏离：0% 打在拍面正中，100% 是拍框内沿，null = 压根没碰到拍面。
  //
  // 严格碰撞上线后这是「为什么打不到」的第一现场——球从拍面上方 5cm 掠过，
  // 和从左边 40cm 掠过，表现都是「没打到」，但一个要调拍面角度、一个要走位。
  const atyEl = el('s-aty');
  if (d.lastOffCenter === null) {
    atyEl.textContent = d.reaches > 0 ? '没碰到' : '—';
    atyEl.className = `v ${d.reaches > 0 ? 'bad' : ''}`;
  } else {
    const oc = Math.round(d.lastOffCenter * 100);
    atyEl.textContent = `${oc}%`;
    atyEl.className = `v ${oc > 85 ? 'warn' : ''}`;
  }

  // 拍面朝向：球拍法线（设备 +Z 经姿态旋转后）与「正对球场」的夹角。
  //
  // 系统把手机的姿态**直接**当成拍面的姿态，而手机在手里的角度和你脑子里的拍面
  // 并不重合——扁手机握在掌心必然有内外旋，常见 5–15°。出球方向有 72% 来自拍面法线，
  // 所以这个偏角会被放大 0.71 倍打到球的飞行方向上：偏 10°，十米外就差 1.2 米。
  // 表现不是「我握歪了」，而是「手感不对」——因为屏幕上没有任何东西告诉你偏了多少。
  //
  // 静止持拍、拍面正对球场时，这个数应该接近 0。如果是 10–15°，那才是真正的噪声源，
  // 比传感器本身的精度（β/γ 有重力参考，1–2°）大一个量级。
  const faceEl = el('s-face');
  // 没收到手机的姿态包时球拍是待机姿态（法线背对球场，算出来正好 180°），
  // 那个数字没有意义，宁可显示空。
  if (!lastPose || packets.hz === 0) {
    faceEl.textContent = '—';
    faceEl.className = 'v';
  } else {
    const [qx, qy, qz, qw] = lastPose.q;
    // q 作用在 (0,0,1) 上：即设备屏幕法线在世界系里的方向
    const fx = 2 * (qx * qz + qw * qy);
    const fy = 2 * (qy * qz - qw * qx);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    if (Math.abs(fy) > 0.75) {
      // 拍面几乎水平：这时候「水平偏角」没有意义，直接说明朝上/朝下
      faceEl.textContent = fy > 0 ? '朝上' : '朝下';
      faceEl.className = 'v warn';
    } else {
      const deg = (Math.atan2(fx, -fz) * 180) / Math.PI;
      const a = Math.abs(deg);
      faceEl.textContent = a < 3 ? '正' : `${deg > 0 ? '右' : '左'}${Math.round(a)}°`;
      faceEl.className = `v ${a > 20 ? 'bad' : a > 8 ? 'warn' : ''}`;
    }
  }

  // 出球延迟：球到面之后停了多久才被打出去。抢跑生效时应该是个位数。
  const latEl = el('s-latency');
  if (d.lastLatency === null) {
    latEl.textContent = '—';
    latEl.className = 'v';
  } else {
    const ms = Math.round(d.lastLatency);
    latEl.textContent = `${ms}ms`;
    latEl.className = `v ${ms > 80 ? 'bad' : ms > 40 ? 'warn' : ''}`;
  }

  const loss = packets.lossRate * 100;
  const lossEl = el('s-loss');
  lossEl.textContent = packets.hz > 0 ? `${loss.toFixed(1)}%` : '—';
  lossEl.className = `v ${loss > 3 ? 'bad' : loss > 1 ? 'warn' : ''}`;

  el('s-p50').textContent = fmt(latency.p50);
  el('s-p95').textContent = fmt(latency.p95);

  // 端到端：从手机采到这一帧姿态，到它被大屏处理完。这是玩家真正感觉到的那段延迟。
  const e2eEl = el('s-e2e');
  const e2eP50 = endToEnd.p50;
  if (Number.isFinite(e2eP50)) {
    e2eEl.textContent = `${e2eP50.toFixed(0)}ms`;
    // 端到端 <50ms 基本无感，50–90 能察觉但玩得下去，>90 就是「球拍有惯性」了
    e2eEl.className = `v ${e2eP50 > 90 ? 'bad' : e2eP50 > 50 ? 'warn' : 'accent'}`;
  } else {
    e2eEl.textContent = '—';
    e2eEl.className = 'v accent';
  }

  const jit = latency.jitter;
  const jitEl = el('s-jit');
  jitEl.textContent = Number.isFinite(jit) ? `${jit.toFixed(0)}ms` : '—';
  jitEl.className = `v ${jit > 80 ? 'bad' : jit > 30 ? 'warn' : ''}`;

  const gEl = el('s-g');
  gEl.textContent = peakG > 0 ? `${peakG.toFixed(1)}g` : '—';
  gEl.className = `v ${peakG >= ACCEL_FULL_SCALE_G * 0.97 ? 'bad' : peakG >= 8 ? 'warn' : ''}`;

  const wEl = el('s-w');
  const wDps = (peakW * 180) / Math.PI;
  wEl.textContent = peakW > 0 ? `${wDps.toFixed(0)}` : '—';
  wEl.className = `v ${peakW >= GYRO_FULL_SCALE_RAD * 0.97 ? 'bad' : wDps >= 1200 ? 'warn' : ''}`;

  const verdict = !Number.isFinite(jit)
    ? ['—', '']
    : jit < 30
      ? ['抖动健康', 'good']
      : jit < 80
        ? ['偶尔会卡', 'warn']
        : ['环境不稳', 'bad'];
  verdictEl.textContent = verdict[0];
  verdictEl.className = `verdict ${verdict[1]}`;

  // 视觉诊断只在开关打开时才有节点内容；200ms 刷一次就够，别每帧写 DOM。
  vision?.updateHud();
}

/* ---------------- 延迟曲线 ---------------- */

function drawSpark() {
  const ctx = sparkEl.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(devicePixelRatio, 2);
  // 用 CSS 像素当坐标系，backing store 按 dpr 放大：
  // 这样画布尺寸和样式表里写的高度永远一致，改 CSS 不用同步改 JS
  const w = sparkEl.clientWidth;
  const h = sparkEl.clientHeight;
  if (!w || !h) return;
  if (sparkEl.width !== Math.round(w * dpr) || sparkEl.height !== Math.round(h * dpr)) {
    sparkEl.width = Math.round(w * dpr);
    sparkEl.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const vals = latency.values.slice(-120);
  if (vals.length < 2) return;

  const maxV = Math.max(40, ...vals) * 1.15;
  const x = (i: number) => (i / (vals.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 6 - (v / maxV) * (h - 14);

  // 100ms 红线：超过它，玩家会归因为「我打空了」
  if (maxV > 100) {
    ctx.strokeStyle = '#f09595';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(100));
    ctx.lineTo(w, y(100));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = '#185fa5';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  vals.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.stroke();

  const p50 = latency.p50;
  if (Number.isFinite(p50)) {
    ctx.strokeStyle = 'rgba(15,110,86,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(p50));
    ctx.lineTo(w, y(p50));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/* ---------------- 启动 ---------------- */

async function boot() {
  roomEl.textContent = room;
  const { url, insecure } = await resolveControllerUrl();
  urlEl.textContent = url.replace(/^https?:\/\//, '');
  urlEl.title = url;

  const warn = $<HTMLParagraphElement>('proto-warn');
  if (insecure) {
    warn.hidden = false;
    warn.textContent =
      `当前是 HTTP 模式，手机浏览器不会把传感器交给网页。真机测试请改用 npm run ${
        isDuel() ? 'dev:duel:https' : 'dev:https'
      }，并在 https://localhost:${location.port ? Number(location.port) + 1 : 5174} 打开本页。`;
  }

  await QRCode.toCanvas(qrEl, url, {
    width: 336,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1c1c1a', light: '#ffffff' },
  });
  qrEl.style.width = '168px';
  qrEl.style.height = '168px';

  $<HTMLButtonElement>('copy-url').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      $<HTMLButtonElement>('copy-url').textContent = '已复制';
      setTimeout(() => ($<HTMLButtonElement>('copy-url').textContent = '复制'), 1200);
    } catch {
      /* 非安全上下文拿不到剪贴板权限，忽略 */
    }
  };

  link = new Link(room, 'host', {
    onState: setLinkState,
    onImu: (buf) => onPacket(decodePacket(buf)),
    onCtrl,
  });

  setInterval(() => link?.sendCtrl({ t: 'ping', t0: performance.now() }), 700);
  setInterval(updateHud, 200);
  setInterval(drawSpark, 140);

  if (vision) {
    $<HTMLElement>('vision-hud').hidden = false;
    void vision.start();
  }
}

/* ---------------- 走位 ---------------- */

/**
 * 站位。刻意和球拍姿态完全分开。
 *
 * 姿态来自手机（绝对朝向），位置来自键盘（相对速度）——两者混在一个输入里，
 * 「举着手机往右倾」就会同时想改朝向和位置，手感会互相打架。
 *
 * 为什么必须有它：严格碰撞上线后，可击球面积就是真实的 30×38cm 拍面，
 * 而球回来的横向落点是 ±1 米级别。拍子不能平移的话，命中率只有两成左右，
 * 玩家会觉得「这游戏判定有问题」，而实际上是「你站着没动」。
 *
 * 视觉通道（?vision=1）是另一路输入：摄像头追胸口色块，只给左右 x，
 * 前后 z 固定在击球面。默认键盘路径一行没改，方便 A/B 对照和随时回退。
 * 详见 `docs/vision.md`。
 *
 * 自动走位是第三路，也是默认那一路：`core/auto-move.ts` 预测来球穿过击球面时的
 * 横向位置，把玩家按限速搬过去，剩下挥拍交给玩家。键盘按下去时它立刻让位——
 * 手动永远优先，松手才接回来。
 */
const PLAYER = {
  x: AUTO_MOVE_DEFAULTS.homeX,
  z: AUTO_MOVE_DEFAULTS.homeZ,
  /** 手动走位速度。真实球员横移 4–5 m/s，取 4.2 让「跑不到位」是一种失误但不算苛刻。 */
  speed: 4.2,
  // 站位范围只在 `AUTO_MOVE_DEFAULTS` 里定义一次：自动走位要按同一组边界选点，
  // 两处各写一份迟早会漂。
  maxX: AUTO_MOVE_DEFAULTS.maxX,
  minZ: AUTO_MOVE_DEFAULTS.minZ,
  maxZ: AUTO_MOVE_DEFAULTS.maxZ,
};

const held = new Set<string>();

function updatePlayer(dt: number) {
  // 视觉接管：只写 x，z 固定在击球面，键盘走位整个跳过（两路输入会打架）。
  // 摄像头没跑起来时退回键盘——权限被拒也不至于把玩家卡在原地。
  if (vision && vision.mode === 'drive' && vision.running && !visionOverride) {
    PLAYER.x = vision.x;
    PLAYER.z = HIT_Z;
    scene.setRacketBase(PLAYER.x, RACKET_POS[1], PLAYER.z);
    return;
  }

  let ax = 0;
  let az = 0;
  if (held.has('a') || held.has('arrowleft')) ax -= 1;
  if (held.has('d') || held.has('arrowright')) ax += 1;
  if (held.has('w') || held.has('arrowup')) az -= 1;
  if (held.has('s') || held.has('arrowdown')) az += 1;

  // 键盘优先：只要这一帧有方向键按下，自动走位就整帧不动。
  // 不用「按住时暂停 N 毫秒」那种计时器——松手瞬间接回来，手感最直接。
  if (ax !== 0 || az !== 0) {
    const l = Math.hypot(ax, az);
    const step = (PLAYER.speed * dt) / l;
    PLAYER.x = Math.min(PLAYER.maxX, Math.max(-PLAYER.maxX, PLAYER.x + ax * step));
    PLAYER.z = Math.min(PLAYER.maxZ, Math.max(PLAYER.minZ, PLAYER.z + az * step));
    // 第三个参数是**击球锚点**的高度（拍面中心），不是握点高度。
    // 站位移动搬的是握点。手机只给角度，挪位置是键盘的事，两者互不干扰。
    scene.setRacketBase(PLAYER.x, RACKET_POS[1], PLAYER.z);
    return;
  }

  if (!autoMove) return;

  // 自动走位：目标 = 让**拍面中心**落到球的弹道上，x 与 z 一起挪。
  // x 补偿握法偏移（横握时中心在握点侧方半米），z 决定「球到面时的高度」——
  // 只调 x 的话，球高了低了都只能干看着。
  const cfg = AUTO_MOVE_DEFAULTS;
  const state: AutoMoveState = { x: PLAYER.x, z: PLAYER.z, center: centerOffset };
  const plan = planAutoMove(game.ball, state, cfg);
  const speed = plan.chasing ? cfg.speed : cfg.homeSpeed;
  const speedZ = plan.chasing ? cfg.speedZ : cfg.homeSpeed;
  PLAYER.x = Math.min(PLAYER.maxX, Math.max(-PLAYER.maxX, stepAxis(PLAYER.x, plan.target, speed * dt, cfg.deadband)));
  PLAYER.z = Math.min(PLAYER.maxZ, Math.max(PLAYER.minZ, stepAxis(PLAYER.z, plan.targetZ, speedZ * dt, cfg.deadband)));
  scene.setRacketBase(PLAYER.x, RACKET_POS[1], PLAYER.z);
}

/* ---------------- 主循环 ---------------- */

let lastFpsAt = performance.now();
let lastFrame = performance.now();
/**
 * 最近一帧的球拍位姿。HUD 的「拍面」读数用它。
 *
 * 这个数字回答的是「握持偏了多少度」：系统把手机的姿态直接当成拍面的姿态
 * （见 core/attitude.ts 的说明），而手机在手里的角度和你脑子里的拍面并不重合。
 * 因为出球方向有 72% 来自拍面法线，这个偏角会被放大 0.71 倍打到球的飞行方向上——
 * 偏 10°，十米外就差 1.2 米，玩家感觉到的就是「手感不对」而不是「我握歪了」。
 * 静止持拍、拍面正对球场时，这个数应该接近 0。
 */
let lastPose: ReturnType<PlayScene['syncRacket']> | null = null;

function loop() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  updatePlayer(dt);
  // 顺序不能换：先把球拍的平滑推进到这一刻并取位姿，再做击球判定，最后渲染球。
  // 反过来（先判定再平滑）判定拿到的是上一帧的姿态，快速挥拍时会偏几十度，
  // 表现就是「明明挥到了却判空」——而且是越用力越容易空，最难查的那种。
  lastPose = scene.syncRacket(now, dt);
  // 用**这一帧**的姿态估计握法偏移（自动走位下一帧用，滞后一帧对 0.4s 的低通无感）。
  updateCenterOffset(lastPose, dt);
  game.pushRacket(lastPose);
  // 对手的拍子画在它判定用的那个位姿上。顺序同样不能反：先定这一帧的位姿，
  // 再推进物理，最后渲染——否则屏幕上对手的拍子比判定晚一帧到位。
  if (isDuel()) scene.syncOpponent((game as Duel).machinePose(now));

  for (const e of game.update(dt, now)) handle(e);

  scene.setBall(game.ball.p, game.ball.spin);
  scene.render(dt);

  frames++;
  if (now - lastFpsAt >= 1000) {
    fps = Math.round((frames * 1000) / (now - lastFpsAt));
    frames = 0;
    lastFpsAt = now;
  }
  requestAnimationFrame(loop);
}

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  held.add(k);
  if (k === 'm') {
    if (mock.running) {
      mock.stop();
      linkStateEl.textContent = '模拟控制器已关闭';
    } else {
      mock.start((p) => onPacket(p));
      linkStateEl.textContent = '本地模拟控制器运行中（不经过网络）';
    }
  }
  if (k === 'r') {
    latency.clear();
    endToEnd.clear();
    packets.reset();
    peakG = 0;
    peakW = 0;
    // 顺带让手机重新锁一次姿态基准：发现拍子和手机歪了，按 R 就能回正
    link?.sendCtrl({ t: 'recal' });
    flashHint('统计已重置 · 姿态重标定');
  }
  if (k === 'x') {
    sfx.unlock();
    sfx.setMuted(!sfx.isMuted);
    flashHint(sfx.isMuted ? '静音' : '已开启声音');
  }
  if (k === 'c') game.reset();
  if (k === 'v') {
    if (!vision) flashHint('视觉走位未启用：地址加 ?vision=probe 或 ?vision=1');
    else if (vision.mode === 'probe') flashHint('只读取证中：右上角是读数，不接管走位');
    else {
      visionOverride = !visionOverride;
      flashHint(visionOverride ? '已切回键盘走位（对照）' : '已交给摄像头走位');
    }
  }
  if (k === 'f') {
    autoMove = !autoMove;
    flashHint(autoMove ? '自动走位已开：只要挥拍' : '自动走位已关：A/D 手动跑位');
  }
  // 浏览器要求用户手势之后才能出声
  sfx.unlock();
});

addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
// 切走标签页时把按键状态清掉，否则回来会一直朝一个方向走
addEventListener('blur', () => held.clear());

addEventListener('pointerdown', () => sfx.unlock(), { once: true });

addEventListener('beforeunload', () => {
  mock.stop();
  vision?.stop();
  link?.close();
});

/**
 * 启动。由 `main.ts`（墙打）和 `duel-main.ts`（对打）各自调用一次。
 *
 * 两个页面各是一个独立的 vite 服务（:5173 / :5174），信令也各走各的——
 * 同一台机器上可以同时开两个浏览器窗口分别打两种模式，互不干扰。
 */
export function startPlay(mode: SceneMode) {
  scene = new PlayScene(canvas, { mode });
  game = mode === 'duel' ? new Duel(liveStroke) : new Rally(liveStroke);

  document.title = mode === 'duel' ? '网球体感 P1 · 对打（脚本回球机）' : '网球体感 P1 · 对墙打';
  const label = document.getElementById('s-label');
  if (label) label.textContent = mode === 'duel' ? '比分' : '连拍';
  const subLabel = document.getElementById('s-sub-label');
  if (subLabel) subLabel.textContent = mode === 'duel' ? '最长回合' : '最好';

  // 尺寸与 resize 监听在 PlayScene 的构造函数里就装好了，这里不要重复挂。
  void boot();
  loop();
}
