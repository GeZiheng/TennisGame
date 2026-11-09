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

/** 用 ping-pong 估算两端时钟偏移。取 RTT 最小的一次，因为它的测量误差最小。 */
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

  ingest(t0: number, t1: number, t2: number, t3: number) {
    // t0 大屏发出（大屏时钟），t1 球拍收到（球拍时钟）
    // t2 球拍回发（球拍时钟），t3 大屏收到（大屏时钟）
    const rtt = t3 - t0 - (t2 - t1);
    if (rtt < 0) return;
    // 只有明显更优的样本才替换，避免抖动把估计带偏
    if (!this.ready || rtt < this.bestRtt * 0.9) {
      this.offset = (t1 - t0 + (t2 - t3)) / 2;
      this.bestRtt = this.ready ? Math.min(this.bestRtt, rtt) : rtt;
      this.ready = true;
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
