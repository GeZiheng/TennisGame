/** 延迟与丢包统计。P0 的验收就看这里出来的数字。 */

const WINDOW = 240;

export class LatencyWindow {
  private buf: number[] = [];
  private sorted: number[] = [];
  private dirty = true;

  add(v: number) {
    this.buf.push(v);
    if (this.buf.length > WINDOW) this.buf.shift();
    this.dirty = true;
  }

  clear() {
    this.buf = [];
    this.dirty = true;
  }

  get count() {
    return this.buf.length;
  }

  get values(): readonly number[] {
    return this.buf;
  }

  private ensure() {
    if (!this.dirty) return;
    this.sorted = [...this.buf].sort((a, b) => a - b);
    this.dirty = false;
  }

  pct(p: number): number {
    this.ensure();
    if (this.sorted.length === 0) return NaN;
    // 最近秩法：p95 就是「第 95 百分位那一档」，不会像插值那样把尾巴估高
    const n = this.sorted.length;
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
    return this.sorted[idx];
  }

  get p50() {
    return this.pct(50);
  }

  get p95() {
    return this.pct(95);
  }

  get mean() {
    if (this.buf.length === 0) return NaN;
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }

  /** 抖动 = p95 − p50，比标准差更贴合体感：它直接告诉你最差的那 5% 有多糟。 */
  get jitter() {
    return this.p95 - this.p50;
  }
}

export class PacketStats {
  private firstSeq = -1;
  private maxSeq = -1;
  private received = 0;
  private arrival: number[] = [];

  reset() {
    this.firstSeq = -1;
    this.maxSeq = -1;
    this.received = 0;
    this.arrival = [];
  }

  mark(seq: number, now: number) {
    if (this.firstSeq < 0) this.firstSeq = seq;
    // 处理 uint32 回绕（60Hz 下大约两年才会碰到，但便宜）
    if (this.maxSeq >= 0 && seq < this.maxSeq - 0x7fffffff) this.firstSeq = seq;
    if (seq > this.maxSeq) this.maxSeq = seq;
    this.received++;
    this.arrival.push(now);
    while (this.arrival.length > 0 && now - this.arrival[0] > 1000) this.arrival.shift();
  }

  get hz() {
    return this.arrival.length;
  }

  get lossRate() {
    const expected = this.maxSeq - this.firstSeq + 1;
    if (expected <= 0) return 0;
    return Math.max(0, 1 - this.received / expected);
  }
}

/**
 * 用 ping-pong 估算两端时钟偏移。取 RTT 最小的一次，因为它的测量误差最小。
 *
 * 但「只认最优样本」有个前提：两端的时钟基准在整段连接里不变。手机重新扫码会
 * 重新加载页面，`performance.now()` 从 0 开始，时钟差会整段跳变；这时 bestRtt
 * 已经收敛到历史最小值且单调不增，`rtt < bestRtt * 0.9` 几乎不可能再成立，
 * 估计就永久停在上一段连接上。挥拍时刻因此被换算到几万毫秒之外，±150ms 的
 * 击球窗口一条都匹配不上——表现是「重连之后每一球都打不到」。见 `reset()` 与
 * `ingest()` 里的突变重锚。
 */
const REANCHOR_MS = 1000;

export class ClockSync {
  /** 球拍端时钟比大屏端快多少毫秒（remote − local） */
  private offset = 0;
  private bestRtt = Infinity;
  private ready = false;

  get isValid() {
    return this.ready;
  }

  get lastRtt() {
    return this.bestRtt === Infinity ? NaN : this.bestRtt;
  }

  /** 换了一段连接就全部作废，重新等 ping-pong 收敛。 */
  reset() {
    this.offset = 0;
    this.bestRtt = Infinity;
    this.ready = false;
  }

  ingest(t0: number, t1: number, t2: number, t3: number) {
    // t0 大屏发出（大屏时钟），t1 球拍收到（球拍时钟）
    // t2 球拍回发（球拍时钟），t3 大屏收到（大屏时钟）
    const rtt = t3 - t0 - (t2 - t1);
    if (rtt < 0) return;
    const offset = (t1 - t0 + (t2 - t3)) / 2;

    // 时钟基准突变（对端页面重载 / 换了一台手机）：不能再等「更优 RTT」，
    // 那个门限在收敛后形同锁死。直接重锚，并把 bestRtt 放回本次样本，
    // 让新会话有机会重新收敛。也作为连接层没来得及调用 reset() 时的兜底。
    if (!this.ready || Math.abs(offset - this.offset) > REANCHOR_MS) {
      this.offset = offset;
      this.bestRtt = rtt;
      this.ready = true;
      return;
    }

    // 只有明显更优的样本才替换，避免抖动把估计带偏
    if (rtt < this.bestRtt * 0.9) {
      this.offset = offset;
      this.bestRtt = Math.min(this.bestRtt, rtt);
    }
  }

  /** 把球拍端时间戳换算到大屏端时钟。注意是减：offset 是「球拍比大屏快多少」。 */
  toLocal(remoteTime: number) {
    return remoteTime - this.offset;
  }

  get offsetMs() {
    return this.offset;
  }
}
