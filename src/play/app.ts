/**
 * 一局游戏的**编排层**：连接、收包、挥拍检测、主循环、事件分发、键位。
 *
 * 只有对打一种模式（对墙打在 11-15 删掉了，见 `docs/history.md` 4.27）。
 *
 * ## 分工
 *
 * | 谁 | 管什么 |
 * |---|---|
 * | `core/duel.ts` | 规则（分 → 局 → 盘、两次发球） |
 * | `core/machine.ts` | 对手 |
 * | `play/player.ts` | 站位、走位、瞄准偏移（**手感状态**） |
 * | `play/session.ts` | 时钟、丢包、延迟、序号（**一次连接**的状态） |
 * | `play/recorder.ts` | 击球采集与落盘 |
 * | `play/scene.ts` | 画面 |
 * | `play/hud.ts` / `spark.ts` / `panel.ts` | 只读状态、只写 DOM |
 * | **这里** | 把它们串成一条主循环 |
 *
 * ## 这个文件里刻意只剩两件事
 *
 * 1. **主循环的调用顺序**。它是全项目唯一有强制先后关系的地方（见 `loop()` 的注释），
 *    分散到别的文件就没人看得出顺序是有意的了。
 * 2. **会话复位的一次性通知**。`resetSession()` 现在只有 6 行——每个对象自己负责
 *    「重连时该清什么」。原来它是 15 个赋值，加一个状态就得记得回来补一行，
 *    而 `docs/history.md` 4.12 的 bug 正是漏清了一个。
 *
 * 网络层（时钟同步、重连复位、姿态连续性、抢跑取拍）是这个项目里最贵也最爱出错的
 * 代码，它不该有第二个拷贝。
 */

import { PlayScene } from './scene';
import { Sfx } from './audio';
import { Link } from '../net/link';
import { decodePacket, type CtrlMsg } from '../core/protocol';
import { SwingDetector } from '../core/swing';
import { Duel, type DuelEvent } from '../core/duel';
import { serveAim, serveBox, serveStrike } from '../core/serve';
import { vrot } from '../core/vec';
import type { RacketPose } from '../core/racket';
import type { ContactCapture } from '../core/contact-log';
import { Session } from './session';
import { PlayerRig } from './player';
import { ContactRecorder } from './recorder';
import { ConnectPanel } from './panel';
import { drawSpark } from './spark';
import * as hud from './hud';
import { MockController } from './mock';

const qs = new URLSearchParams(location.search);

/**
 * 挥拍枢轴（`core/swing-rig.ts`）：默认开，`?rig=0` 关，`G` 键切。
 *
 * 它把握点从「钉在原地」改成「绕腰/肘走一段弧」，所以拍面中心在挥拍中会平移
 * 最多 0.18m。判定是扫掠的、位移也限了幅，模拟器 A/B 里命中率没有变化，但
 * 「手感对不对」只有真机能回答。
 */
let rigOn = qs.get('rig') !== '0';

const sfx = new Sfx();
const swing = new SwingDetector();
const session = new Session();
const sparkEl = document.getElementById('spark') as HTMLCanvasElement;

/**
 * 自动走位与瞄准点学习的开关。
 *
 * `?auto=0` 关自动走位（回到 A/D 手动跑位）；`?aim=rest` 关瞄准点学习（回到
 * 「瞄站着不动的拍面」）。后者没绑键位——它是「这一局怎么打」的选择，不是临场动作。
 */
const rig = new PlayerRig({
  autoMove: qs.get('auto') !== '0',
  aimLearn: qs.get('aim') !== 'rest',
});

const recorder = new ContactRecorder({
  onHint: hud.flashHint,
  onBadge: hud.setRecBadge,
  // 命中就学：这是采集打开时唯一还在跑的「过渡路径」，断掉会让走位立刻变差
  onHit: (fc) => rig.learn(fc),
});

const panel = new ConnectPanel({
  onPairReady: () => resetSession(),
  onUnlock: () => sfx.unlock(),
});

let scene: PlayScene;
/** 规则对象。只有一个实现者，但保留具名变量：主循环里 `game.` 比 `duel.` 更说明意图 */
let game: Duel;
let link: Link | null = null;
let mock = new MockController();

let fps = 0;
let frames = 0;
let lastFpsAt = performance.now();
let lastFrame = performance.now();

/**
 * 最近一帧的球拍位姿。HUD 的「拍面」读数用它。
 *
 * 这个数字回答的是「握持偏了多少度」：系统把手机的姿态直接当成拍面的姿态
 * （见 `core/attitude.ts`），而手机在手里的角度和你脑子里的拍面并不重合。
 * 因为出球方向有 72% 来自拍面法线，这个偏角会被放大 0.71 倍打到球的飞行方向上——
 * 偏 10°，十米外就差 1.2 米，玩家感觉到的就是「手感不对」而不是「我握歪了」。
 */
let lastPose: RacketPose | null = null;
let lastSpeed = 0;
let lastShot = '—';

/** 当前按住的键（小写）。`rig.step` 每帧读它，手动永远优先于自动走位 */
const held = new Set<string>();

/* ---------------- 抢跑取拍 ---------------- */

/**
 * 球停在击球面上时，直接从检测器里取「正在进行中」的这一挥。
 *
 * 不这么做的话，球要等峰值回落结算完才飞得出去——玩家手已经挥完了，球还在拍面上
 * 悬着，这就是「球弹回的点比接触点晚」的原因。取走之后立刻 consume，防止同一次
 * 挥拍在回落时被再结算一次。
 */
const liveStroke = (near: number) => {
  const live = swing.peekLive(near);
  if (!live) return null;
  swing.consumeLive();
  scene.pulseSwing();
  return live;
};

/* ---------------- 会话 ---------------- */

/**
 * 新配对 = 新会话，把只属于「一次连接」的状态全部清掉。
 *
 * 大屏页面从不刷新，`Link` 也只在 boot() 里 new 一次；手机那边重新扫码却是
 * 一个全新的页面：`performance.now()` 归零、包序号从 0 开始、姿态基准重新锁。
 *
 * 每一处残留都能单独造成「重连后一球都打不到」，所以清理分散在四个拥有者里
 * （`Session` / `SwingDetector` / `Duel` / `PlayerRig`），这里只负责通知。
 * **加新的会话状态时，请给它找一个拥有者，而不是回来往这个函数里补一行。**
 *
 * 姿态平滑（`scene.smoothQ`）不清：新会话第一包到了会在 22ms 内收敛过去，
 * 强行归位反而让拍子凭空跳一下。
 */
function resetSession() {
  session.reset();
  swing.reset();
  game.reset();
  scene.resetRig();
  rig.reset();
  // 采集换段：新会话的手机 `performance.now()` 归零、`yawZero` 重锁，
  // 上一段样本的时间轴和姿态基准都对不上了。
  recorder.nextSession();
  hud.flashHint('手机已接入 · 会话已重置');
}

/* ---------------- 收包 ---------------- */

function onPacket(pkt: ReturnType<typeof decodePacket>) {
  if (!pkt) return;
  const now = performance.now();
  // 序号判定 + 延迟统计 + 峰值都在 Session 里：乱序包既不该进统计也不该更新峰值
  if (!session.ingest(pkt, now)) return;

  scene.setOrientation(pkt.q);

  // 挥拍检测在大屏端做，不在手机端做。
  // 理由：传感器数据本来就每一帧都传过来了，检测放这边可以统一时间轴，
  // 击球判定需要的「挥拍时刻」直接就是本地时钟，不用再做一次跨端换算。
  const tLocal = session.clock.isValid ? session.clock.toLocal(pkt.tSend) : now;
  const stroke = swing.push({ t: tLocal, omega: pkt.gyro, q: pkt.q });
  if (stroke) {
    // 先让球拍亮一下：哪怕这一下没打到球，玩家也该看到「系统知道你挥了」
    scene.pulseSwing();
    game.submit(stroke);
  }
}

function onCtrl(msg: CtrlMsg) {
  if (msg.t === 'pong') {
    session.clock.ingest(msg.t0, msg.t1, msg.t2, performance.now());
  }
}

/* ---------------- 事件 ---------------- */

/**
 * 采集一条相遇样本。
 *
 * 快照要在 `rig.learn()` **之前**取——`recorder.record()` 内部会在命中时回调
 * `onHit` → `rig.learn()`。取晚了记到的就是「学完之后」的瞄准点。
 */
function recordContact(c: ContactCapture) {
  recorder.record(c, { ...rig.snapshot(), rally: game.rally });
}

/**
 * 事件分发。
 *
 * 每个事件都带 `by`，所以不用再区分「这一拍是谁打的」——墙打时代要靠
 * `'by' in e` 判断，因为那种模式的事件里没有这个字段。
 */
function handle(e: DuelEvent) {
  switch (e.kind) {
    case 'contact':
      // 三种相遇（命中 / 碰到没挥 / 没碰到）共用这一个入口。
      // 发球不走这条路径（它走 `tickToss` → `launchServe`），所以这里只有地面击球。
      if (e.by === 'player') recordContact(e.c);
      break;
    case 'hit': {
      // 谁打的要区分——对手那一拍音效压低一点，否则听不出回合归属
      sfx.hit(e.by === 'player' ? 0.7 : 0.4, e.clean);
      scene.spawnHitFx(e.at, e.by === 'player' ? 0.7 : 0.45);
      if (e.by === 'player') {
        lastSpeed = e.speed;
        // 拍型只有玩家那一拍有意义：对手的出球是求解器直接给的，没有「上旋/平击」
        lastShot = e.serve ? '发球' : e.clean ? '击球' : '拍面没打开';
      }
      hud.flashPrimary(game, false);
      break;
    }
    case 'ground':
      sfx.bounce(4);
      scene.spawnBounceFx(e.at);
      break;
    case 'net':
      if (e.by === 'player') rig.miss();
      sfx.net();
      break;
    case 'out':
      lastShot = '出界';
      hud.flashHint(e.by === 'player' ? '出界了' : '对手打出界');
      break;
    case 'miss':
      // 对手漏接也会走到这里，只有玩家的漏接能说明「瞄准学歪了」
      if (e.by === 'player') rig.miss();
      hud.flashHint(e.reason === 'stop' ? '球停在拍面上了' : '两跳，球在你这边落了两次');
      break;
    case 'point':
      sfx.end();
      lastShot = e.reason;
      hud.flashHint(`${e.winner === 'player' ? '你' : '对手'}得分 · ${e.reason}`);
      hud.flashPrimary(game, true);
      break;
    case 'fault': {
      // 二发的失误由紧跟其后的 point 事件播报（「双误」），这里不抢话。
      if (e.attempt === 1) {
        const why: Record<string, string> = {
          out: '出界',
          net: '下网',
          short: '没过网',
          nohit: '没挥到球',
          stop: '没打出去',
        };
        const text = why[e.reason] ?? e.reason;
        hud.flashHint(e.by === 'player' ? `一发失误（${text}）· 还有一次` : `对手一发失误（${text}）`);
      }
      if (e.reason === 'net') sfx.net();
      break;
    }
    case 'game':
      sfx.end();
      hud.flashHint(e.winner === 'player' ? '这一局拿下' : '这一局被对手拿下');
      break;
    case 'tiebreak':
      hud.flashHint('6:6 · 抢七，先到 7 分', 2600);
      break;
    case 'matchOver':
      sfx.end();
      lastShot = '比赛结束';
      hud.flashHint(
        `${e.winner === 'player' ? '你赢了这一盘' : '对手赢了这一盘'} ${e.games[0]}:${e.games[1]} · 按 C 重开`,
        6000
      );
      hud.flashPrimary(game, true);
      break;
    case 'serve': {
      const who = e.by === 'player' ? '你发球' : '对手发球';
      const court = e.court === 'deuce' ? '右区' : '左区';
      hud.flashHint(`${who} · ${e.attempt === 1 ? '一发' : '二发'} · ${court}`);
      break;
    }
  }
}

/* ---------------- 发球辅助 ---------------- */

/**
 * 地面上的发球区 + 拍面指向的落点圈。
 *
 * 只在**发球这一刻**显示（`setup` / `toss` / 球还没第一次落地）。相持中把地板
 * 染一块绿会抢视觉，而发球恰恰是唯一「必须落进某个格子」的球，提示要给在这里。
 *
 * 落点圈红绿两色用的是和判定完全相同的 `serveAim()`：绿 = 球会落进正确的区，
 * 红 = 会失误。所以玩家在**抛球之前**就能看到自己瞄对了没有——这是「必须发到
 * 正确的区」这条规则唯一的可学习入口，没有它就只能靠反复失误去猜。
 */
function updateServeAid() {
  const info = game.serveInfo;
  const serving = game.phase === 'setup' || game.phase === 'toss' || game.servePending;
  if (game.over || !serving) {
    scene.setServeBox(null);
    scene.setServeAim(null, false);
    return;
  }
  scene.setServeBox(serveBox(info.server, info.court));

  // 落点圈只画玩家自己发球：对手发球时玩家瞄的是「接发球」，画个圈反而误导。
  if (info.server !== 'player' || !lastPose) {
    scene.setServeAim(null, false);
    return;
  }
  // 和 `Duel.launchServe` 用的是同一组输入（击球区中心 + 法线 + 拍柄），所以屏幕上
  // 那圈就是球真正会落的地方——不是示意。`serveStrike` 把握点按锚点钳过，
  // `serveAim` 内部再把双面拍翻正、必要时改用拍框当准星，两边完全同一条路。
  const aim = serveAim(
    serveStrike(lastPose),
    vrot(lastPose.q, [0, 0, 1]),
    info.server,
    info.court,
    vrot(lastPose.q, [0, 1, 0])
  );
  scene.setServeAim(aim.point, aim.inBox);
}

/* ---------------- 主循环 ---------------- */

function loop() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  rig.step({
    dt,
    now,
    serveStanceX: game.playerServeStanceX,
    ball: game.ball,
    keys: held,
    sink: scene,
  });
  // 顺序不能换：先把球拍的平滑推进到这一刻并取位姿，再做击球判定，最后渲染球。
  // 反过来（先判定再平滑）判定拿到的是上一帧的姿态，快速挥拍时会偏几十度，
  // 表现就是「明明挥到了却判空」——而且是越用力越容易空，最难查的那种。
  lastPose = scene.syncRacket(now, dt);
  // 用**这一帧**的姿态估计握法偏移（自动走位下一帧用，滞后一帧对 0.4s 的低通无感）
  rig.trackPose(lastPose, dt);
  game.pushRacket(lastPose);
  // 对手的拍子画在它判定用的那个位姿上。顺序同样不能反：先定这一帧的位姿，
  // 再推进物理，最后渲染——否则屏幕上对手的拍子比判定晚一帧到位。
  scene.syncOpponent(game.machinePose(now));
  for (const e of game.update(dt, now)) handle(e);

  updateServeAid();
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

/* ---------------- 键位 ---------------- */

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  held.add(k);
  if (k === 'm') {
    if (mock.running) {
      mock.stop();
      panel.setNote('模拟控制器已关闭');
    } else {
      mock.start((p) => onPacket(p));
      panel.setNote('本地模拟控制器运行中（不经过网络）');
    }
  }
  if (k === 'r') {
    // 只清统计与峰值，**不动**时钟同步：连接还是同一条
    session.resetStats();
    // 顺带让手机重新锁一次姿态基准：发现拍子和手机歪了，按 R 就能回正
    link?.sendCtrl({ t: 'recal' });
    // 采集也跟着换段：重标定之后 `yawZero` 变了，跨段混算等于把漂移学成走位偏差
    recorder.nextSession();
    hud.flashHint('统计已重置 · 姿态重标定 · 采集换段');
  }
  if (k === 'l' && !e.repeat) recorder.toggle();
  if (k === 'k' && !e.repeat) void recorder.export();
  if (k === 'x') {
    sfx.unlock();
    sfx.setMuted(!sfx.isMuted);
    hud.flashHint(sfx.isMuted ? '静音' : '已开启声音');
  }
  if (k === 'c') game.reset();
  if (k === 'g') {
    rigOn = !rigOn;
    scene.setRigEnabled(rigOn);
    hud.flashHint(rigOn ? '挥拍枢轴：开（绕腰/肘）' : '挥拍枢轴：关（绕拍柄底部）');
  }
  if (k === 'z') {
    // 近景/全景：判断「球打在框上还是线上」要贴近，看整场要退开，一张图给不了两个答案
    const p = scene.toggleCamera();
    hud.flashHint(p === 'near' ? '近景 · 看得清拍面' : '全景 · 看得见来球');
  }
  if (k === 'f') {
    rig.autoMove = !rig.autoMove;
    hud.flashHint(rig.autoMove ? '自动走位已开：只要挥拍' : '自动走位已关：A/D 手动跑位');
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
  link?.close();
  recorder.beacon();
});

/* ---------------- 启动 ---------------- */

function hudState(): hud.HudState {
  return { game, session, fps, lastPose, lastSpeed, lastShot };
}

async function boot() {
  await panel.render();

  link = new Link(panel.room, 'host', {
    onState: (s, d) => panel.setState(s, d),
    onImu: (buf) => onPacket(decodePacket(buf)),
    onCtrl,
  });

  setInterval(() => link?.sendCtrl({ t: 'ping', t0: performance.now() }), 700);
  setInterval(() => hud.updateHud(hudState()), 200);
  setInterval(() => drawSpark(sparkEl, session.oneWay), 140);
  // 采集兜底：阈值是 8 条，但如果只打了三四球就停手，这 10 秒一到也照样落盘
  setInterval(() => void recorder.flush(), 10_000);
}

/**
 * 启动。由 `main.ts` 调用一次。
 *
 * 没有参数：11-15 删掉对墙打之后只剩一种模式。曾经这里吃一个 `SceneMode`，
 * 三个分支（场景 / 规则对象 / HUD 主数字）都要在那里分叉——现在都塌掉了。
 */
export function startPlay() {
  scene = new PlayScene(document.getElementById('scene') as HTMLCanvasElement);
  scene.setRigEnabled(rigOn);
  game = new Duel(liveStroke);

  document.title = '网球体感 P1 · 对打（脚本回球机）';
  const label = document.getElementById('s-label');
  if (label) label.textContent = '分';
  const subLabel = document.getElementById('s-sub-label');
  if (subLabel) subLabel.textContent = '局';

  // 尺寸与 resize 监听在 PlayScene 的构造函数里就装好了，这里不要重复挂。
  recorder.badge();
  void boot();
  loop();
}
