/**
 * 程序生成的击球音效。
 *
 * 为什么不用音频文件：击球音是爽感的一半，但它必须随力度变化——
 * 轻碰和全力抽的声音差别要足够明显，否则玩家感受不到自己的力度。
 * 采样文件做这件事要么很假（同一段声音调音量），要么要录几十个变体。
 * Web Audio 直接合成，力度映射到滤波器频率和包络，一个函数解决。
 *
 * 三层的合成思路（照着真实击球声做的）：
 *   1. 高频噪声 burst  —— 拍线绷紧的「啪」，决定清脆度
 *   2. 中频共振         —— 拍框腔体，决定「厚」不「厚」
 *   3. 低频 thump       —— 冲击力，决定「重」不「重」
 * 三者按力度分配权重：轻碰几乎只有噪声，重击低频明显。
 */

type Ctor = typeof AudioContext;

export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private muted = false;

  /** 浏览器要求用户手势之后才能出声，所以延迟到第一次交互再建。 */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC: Ctor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
    this.master = master;

    // 1 秒白噪声，所有噪声类音效共用，靠滤波器塑形
    const len = Math.floor(ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.85;
  }

  get isMuted() {
    return this.muted;
  }

  /**
   * 击球声。
   * charge 0..1 表示发力程度，直接决定音高、长度和低频占比。
   */
  hit(charge: number, clean = true) {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise || this.muted) return;

    const t = ctx.currentTime;
    const c = Math.max(0, Math.min(1, charge));

    // 拍线：带通噪声，力度越大频率越高、衰减越短
    const burst = ctx.createBufferSource();
    burst.buffer = this.noise;
    burst.playbackRate.value = 1 + c * 0.4;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1600 + c * 2600;
    bp.Q.value = 0.9;

    const g = ctx.createGain();
    const peak = 0.22 + c * 0.5;
    const dur = 0.075 - c * 0.03;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);

    burst.connect(bp).connect(g).connect(master);
    burst.start(t);
    burst.stop(t + dur + 0.02);

    // 拍框腔体：一个短促的中频共振
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(240 + c * 120, t);
    body.frequency.exponentialRampToValueAtTime(120 + c * 60, t + 0.07);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.14 + c * 0.12, t);
    bg.gain.exponentialRampToValueAtTime(0.0005, t + 0.1);
    body.connect(bg).connect(master);
    body.start(t);
    body.stop(t + 0.12);

    // 冲击低频，只有重击才明显
    if (c > 0.35) {
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(95, t);
      thump.frequency.exponentialRampToValueAtTime(48, t + 0.11);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime((c - 0.35) * 0.55, t);
      tg.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
      thump.connect(tg).connect(master);
      thump.start(t);
      thump.stop(t + 0.18);
    }

    // 拍面没打开时给一个闷响，让「打歪了」听得出
    if (!clean) {
      const dull = ctx.createBufferSource();
      dull.buffer = this.noise;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.3, t);
      dg.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
      dull.connect(lp).connect(dg).connect(master);
      dull.start(t);
      dull.stop(t + 0.14);
    }
  }

  /** 落地声：比击球闷，速度决定音量。 */
  bounce(speed: number) {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise || this.muted) return;

    const v = Math.min(1, speed / 12);
    const t = ctx.currentTime;

    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 480 + v * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06 + v * 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.1);
    s.connect(lp).connect(g).connect(master);
    s.start(t);
    s.stop(t + 0.12);
  }

  /** 撞墙：沉闷的「咚」。 */
  wall(speed: number) {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    const v = Math.min(1, speed / 20);
    const t = ctx.currentTime;

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.1 + v * 0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.2);
  }

  /** 下网：拍线擦网的高频「唰」。 */
  net() {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise || this.muted) return;

    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.22);
    s.connect(hp).connect(g).connect(master);
    s.start(t);
    s.stop(t + 0.24);
  }

  /** 断球：一个下行的两声提示，不刺耳。 */
  end() {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    const t = ctx.currentTime;
    [0, 0.13].forEach((off, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = i === 0 ? 520 : 390;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + off);
      g.gain.linearRampToValueAtTime(0.09, t + off + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0004, t + off + 0.16);
      o.connect(g).connect(master);
      o.start(t + off);
      o.stop(t + off + 0.18);
    });
  }
}
