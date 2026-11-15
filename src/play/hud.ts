/**
 * HUD 与提示条：只读状态、只写 DOM。
 *
 * 从 `app.ts` 里搬出来的是 `updateHud` / `flashHint` / `flashPrimary` / 比分文案，
 * 一共约 160 行。它们**不持有任何游戏状态**——`lastSpeed` / `lastShot` 由调用方
 * 传进来，所以这个文件没有任何需要「重连时复位」的东西。这是刻意的：HUD 是纯输出，
 * 一旦它开始缓存状态，就会变成第 N 个「忘了清」的地方。
 *
 * HUD 的节点是固定的（`index.html` 里那一套 id），这里只换显示内容、不换 DOM 结构
 * ——多一套节点就多一份会跟主循环失去同步的缓存。
 */

import type { Duel } from '../core/duel';
import { HIT_WINDOW_MS } from '../core/court';
import { frontFace, type RacketPose } from '../core/racket';
import { ACCEL_FULL_SCALE_G, GYRO_FULL_SCALE_RAD } from '../core/protocol';
import type { Session } from './session';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface HudState {
  game: Duel;
  session: Session;
  fps: number;
  /** 最近一帧的球拍位姿。「拍面」读数用它 */
  lastPose: RacketPose | null;
  /** 最近一次玩家击球的球速（m/s） */
  lastSpeed: number;
  /** 最近一拍的标签：击球 / 发球 / 拍面没打开 / 出界 / 比赛结束 */
  lastShot: string;
}

/**
 * 主数字：**本局比分**（0 / 15 / 30 / 40 / AD，抢七是数字）。
 *
 * 一盘结束之后改成局分：那才是「这一场」的最终结果。
 */
export function primaryText(game: Duel): string {
  if (game.match.over) return `${game.match.games[0]}:${game.match.games[1]}`;
  return `${game.pointText('player')}:${game.pointText('machine')}`;
}

/** 副数字：**局分**。 */
export function secondaryText(game: Duel): string {
  return `${game.match.games[0]}:${game.match.games[1]}`;
}

function fmt(v: number, unit = 'ms', digits = 1) {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '—';
}

export function flashPrimary(game: Duel, strong: boolean) {
  const el = $<HTMLElement>('s-streak');
  el.textContent = primaryText(game);
  el.classList.remove('pop', 'pop-soft');
  void el.offsetWidth; // 强制重排，否则动画不会重播
  el.classList.add(strong ? 'pop' : 'pop-soft');
}

let hintTimer = 0;
/**
 * @param ms 显示时长。默认 1600ms（够读一句「出界了」），但「抢七」「这盘结束」
 *   这类要读两行、还要带操作提示的话，1.6 秒会一闪而过。
 */
export function flashHint(text: string, ms = 1600) {
  const el = $<HTMLElement>('s-hint');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

/**
 * 右下角那行采集状态。
 *
 * 默认就在采，所以必须常驻——不然「以为在采其实停了」。文案由 `ContactRecorder`
 * 决定（它知道条数和段名），这里只负责写进 DOM。
 */
export function setRecBadge(text: string, off: boolean) {
  const el = $<HTMLElement>('s-rec');
  if (!el) return;
  if (text) el.textContent = text;
  el.classList.toggle('off', off);
}

export function updateHud(s: HudState) {
  const el = (id: string) => $<HTMLElement>(id);
  const d = s.game.diag;
  const session = s.session;

  el('s-streak').textContent = primaryText(s.game);
  el('s-best').textContent = secondaryText(s.game);
  el('s-speed').textContent = s.lastSpeed > 0 ? `${Math.round(s.lastSpeed * 3.6)}` : '—';
  el('s-shot').textContent = s.lastShot;

  el('s-fps').textContent = String(s.fps);
  el('s-hz').textContent = `${session.packets.hz}`;

  /* ---- 击球诊断：打不到球的时候，这四个数就是答案 ---- */
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
  const faceEl = el('s-face');
  // 没收到手机的姿态包时球拍是待机姿态（法线背对球场，算出来正好 180°），
  // 那个数字没有意义，宁可显示空。
  if (!s.lastPose || session.packets.hz === 0) {
    faceEl.textContent = '—';
    faceEl.className = 'v';
  } else {
    const [qx, qy, qz, qw] = s.lastPose.q;
    // q 作用在 (0,0,1) 上：即设备屏幕法线在世界系里的方向。
    // 拍子是双面的，反手时这根法线指着身后——先翻成朝球场那一面再算偏角，
    // 否则反手位会一直读到「180°」，看着像握歪了，其实那是正常的背面。
    const [fx, fy, fz] = frontFace([
      2 * (qx * qz + qw * qy),
      2 * (qy * qz - qw * qx),
      1 - 2 * (qx * qx + qy * qy),
    ]);
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

  const loss = session.packets.lossRate * 100;
  const lossEl = el('s-loss');
  lossEl.textContent = session.packets.hz > 0 ? `${loss.toFixed(1)}%` : '—';
  lossEl.className = `v ${loss > 3 ? 'bad' : loss > 1 ? 'warn' : ''}`;

  el('s-p50').textContent = fmt(session.oneWay.p50);
  el('s-p95').textContent = fmt(session.oneWay.p95);

  // 端到端：从手机采到这一帧姿态，到它被大屏处理完。这是玩家真正感觉到的那段延迟。
  const e2eEl = el('s-e2e');
  const e2eP50 = session.endToEnd.p50;
  if (Number.isFinite(e2eP50)) {
    e2eEl.textContent = `${e2eP50.toFixed(0)}ms`;
    // 端到端 <50ms 基本无感，50–90 能察觉但玩得下去，>90 就是「球拍有惯性」了
    e2eEl.className = `v ${e2eP50 > 90 ? 'bad' : e2eP50 > 50 ? 'warn' : 'accent'}`;
  } else {
    e2eEl.textContent = '—';
    e2eEl.className = 'v accent';
  }

  const jit = session.oneWay.jitter;
  const jitEl = el('s-jit');
  jitEl.textContent = Number.isFinite(jit) ? `${jit.toFixed(0)}ms` : '—';
  jitEl.className = `v ${jit > 80 ? 'bad' : jit > 30 ? 'warn' : ''}`;

  const gEl = el('s-g');
  gEl.textContent = session.peakG > 0 ? `${session.peakG.toFixed(1)}g` : '—';
  gEl.className = `v ${session.peakG >= ACCEL_FULL_SCALE_G * 0.97 ? 'bad' : session.peakG >= 8 ? 'warn' : ''}`;

  const wEl = el('s-w');
  const wDps = (session.peakW * 180) / Math.PI;
  wEl.textContent = session.peakW > 0 ? `${wDps.toFixed(0)}` : '—';
  wEl.className = `v ${session.peakW >= GYRO_FULL_SCALE_RAD * 0.97 ? 'bad' : wDps >= 1200 ? 'warn' : ''}`;

  const verdict = !Number.isFinite(jit)
    ? ['—', '']
    : jit < 30
      ? ['抖动健康', 'good']
      : jit < 80
        ? ['偶尔会卡', 'warn']
        : ['环境不稳', 'bad'];
  const verdictEl = el('verdict');
  verdictEl.textContent = verdict[0];
  verdictEl.className = `verdict ${verdict[1]}`;
}
