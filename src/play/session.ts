/**
 * 一次连接的会话状态：时钟、丢包、延迟、序号、峰值。
 *
 * ## 为什么单独一个文件
 *
 * `app.ts` 原本是**唯一**持有「一次连接」全部状态的地方：`resetSession()` 里手工
 * 清 `clock` / `swing` / `packets` / `latency` / `endToEnd` / `game` / `targetHold` /
 * `scene.resetRig` / 姿态偏移 / 采集段，一共 7 个模块 + 15 个标量。加一个新状态就
 * 要记得回去补一行——而 `docs/history.md` 4.12 里「重连之后每球都打不到」的根因，
 * 正是漏清了一个（`ClockSync` 的 offset 停在旧时钟差上）。
 *
 * 现在「什么属于一次连接」由**持有这些字段的对象自己回答**：这里管时钟与统计，
 * `PlayerRig` 管手感状态，`ContactRecorder` 管采集段，`Duel.reset()` 管规则。
 * 调用方只负责通知它们「新会话开始了」，不需要知道里面有哪些字段。
 *
 * 判断标准很简单：**换一台手机、手机重新扫一次码之后，这个数还该不该保留？**
 * 不该保留的进这个文件（或同级三个对象），该保留的留在 `app.ts`（比如
 * `scene.smoothQ` 姿态平滑——新会话第一包到了 22ms 内就收敛了）。
 */

import { ClockSync, LatencyWindow, PacketStats } from '../core/stats';
import type { ImuPacket } from '../core/protocol';

/**
 * 包序号回退多少算「新会话」。
 *
 * imu 通道是 `ordered: false`（为了不被重传拖慢），正常乱序只差几包；
 * 回退 240 包（≈4s @60Hz）只可能是对端页面重载。原来写的 1000 包要求上一次
 * 连接至少打满 16.7 秒，短会话重连会全量丢包。
 */
const SEQ_REWIND = 240;

export class Session {
  /** 两端时钟偏移（ping-pong 估计） */
  readonly clock = new ClockSync();
  /** 包序号 / 丢包率 / 帧率 */
  readonly packets = new PacketStats();
  /** 单向延迟：手机发出 → 大屏处理 */
  readonly oneWay = new LatencyWindow();
  /** 端到端：手机采样 → 大屏处理。比单向多出采样等待与发包排队 */
  readonly endToEnd = new LatencyWindow();

  /**
   * 最近处理过的包序号。
   *
   * 落后于已处理序号的包直接丢弃，姿态只往前走——WiFi 抖动时旧包后到会让球拍
   * 「往回跳一下」，玩家未必读成丢包，但一定会读成「不跟手」。
   */
  lastSeq = -1;

  /** 本会话见过的峰值加速度（g）与峰值角速度（rad/s），HUD 用 */
  peakG = 0;
  peakW = 0;

  /**
   * 收一包：做序号判定、延迟统计、峰值，返回「这一包该不该用」。
   *
   * 放在一起而不是让调用方分四步做，是因为这四步共享同一个前提：**它们是
   * 同一个会话内的连续观测**。乱序包既不该进统计也不该更新峰值。
   */
  ingest(pkt: ImuPacket, now: number): boolean {
    this.packets.mark(pkt.seq, now);

    // 兜底：万一没收到 `ready`（信令层重连），也要认出新会话的 seq 从 0 重来
    if (this.lastSeq > SEQ_REWIND && pkt.seq + SEQ_REWIND < this.lastSeq) this.lastSeq = -1;
    if (pkt.seq <= this.lastSeq) return false;
    this.lastSeq = pkt.seq;

    if (this.clock.isValid) {
      const oneWay = now - this.clock.toLocal(pkt.tSend);
      // 时钟同步还没收敛时会出现负值，直接丢掉，别污染分位数
      if (oneWay >= 0 && oneWay < 800) this.oneWay.add(oneWay);

      const e2e = now - this.clock.toLocal(pkt.tSample);
      if (e2e >= 0 && e2e < 800) this.endToEnd.add(e2e);
    }

    if (pkt.peakG > this.peakG) this.peakG = pkt.peakG;
    if (pkt.peakW > this.peakW) this.peakW = pkt.peakW;
    return true;
  }

  /**
   * `R` 键：清统计与峰值，但**不动**时钟同步与包序号——连接还是同一条，
   * 只是「这一轮的数不值得看了」。重连才走 `reset()`。
   */
  resetStats() {
    this.packets.reset();
    this.oneWay.clear();
    this.endToEnd.clear();
    this.peakG = 0;
    this.peakW = 0;
  }

  /** 换了一段连接：全部作废，重新收敛。 */
  reset() {
    this.clock.reset();
    this.packets.reset();
    this.oneWay.clear();
    this.endToEnd.clear();
    this.lastSeq = -1;
    this.peakG = 0;
    this.peakW = 0;
  }
}
