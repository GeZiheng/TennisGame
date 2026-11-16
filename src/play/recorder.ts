/**
 * 击球样本的采集、落盘与导出。
 *
 * ## 它记的是什么
 *
 * **校准器的训练数据**，不是「命中率统计」。每条样本的标签是
 * `delta = (fc − 握点) − restOffset`，也就是「挥下去那一刻拍面中心比站着不动时
 * 多扫出去多少」。为什么这和「打没打中」分开记，见 `core/contact-log.ts`。
 *
 * ## 为什么从 app.ts 搬出来
 *
 * 这一块在原文件里占 250 行，而且有 6 个只属于它的状态（游标、路径、串行化标志、
 * 会话名、会话序号、上一次相遇时刻）。它们和游戏毫无关系，唯一的外部依赖是
 * 「命中时通知手感学习」和「写 HUD 角标」——两条回调就够了。
 *
 * ## 默认开、边打边落盘
 *
 * 200 球要打将近一小时，中途刷新一次就全丢的代价太高。落盘走 dev server 的
 * `/__contact`（见 `server/vite-plugin.ts`），写的是增量，写成功才推进游标。
 * 服务端不可用时退化成浏览器下载（`K`）。
 */

import {
  buildContactSample,
  ContactLog,
  samplesToJsonl,
  summarizeContacts,
  type ContactCapture,
} from '../core/contact-log';
import { AUTO_MOVE_DEFAULTS } from '../core/auto-move';
import type { V3 } from '../core/vec';

/**
 * 攒够几条就自动落盘。
 *
 * 8 条在真机上是**半分钟到一分钟**的量（一球几秒），丢也只丢这么点；再小就是每球
 * 一次 POST，收益不值。真正的兜底是 `K` 和那个 10 秒的定时器——所以这个阈值只是
 * 「让磁盘上的数据别太旧」。
 */
const FLUSH_EVERY = 8;

/** 记录点需要的全部外部输入。全部在 `learn()` **之前**取快照，见 `record()`。 */
export interface RecordSnapshot {
  /** 走位给的握点（`label.G`） */
  grip: V3;
  /** 站立时的握法偏移（快照，不是引用） */
  rest: V3;
  /** 相遇前的瞄准点（快照） */
  aim: V3;
  /** 当帧生效的目标保持半径 */
  holdR: number;
  /** 这一分打到第几拍 */
  rally: number;
}

export interface RecorderHooks {
  onHint(text: string, ms?: number): void;
  /**
   * 命中且挥出去了：把握点交给手感学习。
   *
   * 顺序很重要——`record()` 必须在 `onHit` **之前**把快照取完，否则记到的是
   * 「学完之后」的瞄准点，残差凭空变小，等于把要诊断的那个偏差自己抹掉。
   */
  onHit(fc: readonly number[]): void;
  /** 采集状态（条数 / 暂停）变了，写 HUD 角标 */
  onBadge(text: string, off: boolean): void;
}

export class ContactRecorder {
  private readonly log = new ContactLog();
  /** 本次页面生命周期的文件名 stem（`20261115-161230`） */
  private readonly runId: string;
  /** 已经写进文件的条数。`snapshot()` 只增不减，所以它就是一个游标 */
  private flushed = 0;
  /** 上一次落盘的文件路径，用于提示 */
  private path: string | null = null;
  /** 落盘串行化：两次 flush 重叠会让游标错位，宁可排队 */
  private flushing = false;

  /**
   * 会话名。`R`（姿态重标定）和重连都会换一个——姿态漂移是 30–60s 累积的慢变量，
   * 段与段之间的 `yawZero` 不同，混在一起训练等于把漂移学成「走位偏差」。
   */
  private sessionName = 's1';
  private sessionSeq = 0;
  /** 上一次记录的相遇时刻，用来算 `sincePrevHit`（节奏是校准器的输入之一） */
  private lastAt: number | null = null;
  /**
   * 姿态漂移读数，手机端 1Hz 报文里的那份（`app.ts` 的 `onCtrl` 转发进来）。
   *
   * 语义随 `comp` 变：补偿关是「此刻歪了多少」，补偿开是「已经扣掉了多少」。
   * 两个字段成对记进样本，理由见 `core/contact-log.ts` 的 `meta.driftDeg`。
   *
   * 初值 `deg: null` 表示**不知道**（还没收到报文 / 旧版手机页面），不是 0——
   * 记成 0 会让「漂移超标整段剔除」这一步把可疑数据全放过。
   */
  private drift: { deg: number | null; comp: boolean } = { deg: null, comp: false };

  constructor(private readonly hooks: RecorderHooks) {
    this.runId = stamp();
    // 默认就采：页面一加载就开始，`L` 暂停/恢复，`K` 立刻落盘
    this.log.start();
  }

  get count() {
    return this.log.count;
  }

  get recording() {
    return this.log.recording;
  }

  /**
   * 记一条相遇样本。
   *
   * 三种相遇都会走到这里（正常击球 / 碰到没挥 / 压根没碰到），**不按成败过滤**——
   * 只留命中的会造成截断偏置，见 `core/contact-log.ts`。
   *
   * `snap.rest` 取的是这一帧的值，不是「相遇前那一刻」的：两者差一帧，而它是个
   * τ=0.3s 的一阶低通，一帧的变化在噪声以下。
   */
  record(c: ContactCapture, snap: RecordSnapshot) {
    this.log.push(
      buildContactSample({
        t: c.t,
        grip: snap.grip,
        rest: snap.rest,
        planOffset: snap.aim,
        holdR: snap.holdR,
        deadband: AUTO_MOVE_DEFAULTS.deadband,
        deadbandY: AUTO_MOVE_DEFAULTS.deadbandY,
        capture: c,
        rally: snap.rally,
        sincePrevHit: this.lastAt === null ? null : c.t - this.lastAt,
        driftDeg: this.drift.deg,
        driftComp: this.drift.comp,
        session: this.sessionName,
      })
    );
    this.lastAt = c.t;

    // 命中的那一拍顺带喂现有的常量 EMA。校准器还没上，这条过渡路径不能断——
    // 否则「采集打开」反而让走位变差。判据和 `Duel` 里的一致：碰到 + 挥出去。
    if (c.hit && c.stroke) this.hooks.onHit(c.fc);

    // 攒够一批就写盘。不 await：击球那一帧不该等 IO
    this.badge();
    if (this.log.count - this.flushed >= FLUSH_EVERY) void this.flush();
  }

  /** 写 HUD 角标。文案在这里生成，DOM 归 `hud.ts`。 */
  badge() {
    const n = this.log.count;
    if (!this.log.recording) {
      this.hooks.onBadge(`采集暂停 · ${n} 条（L 恢复）`, true);
      return;
    }
    this.hooks.onBadge(n === 0 ? `采集 ${this.sessionName} · 等第一球` : `采集 ${this.sessionName} · ${n} 条`, false);
  }

  /** 换一个采集会话。`R` 和重连都调它——姿态漂移是慢变量，跨会话不能混算。 */
  nextSession() {
    this.sessionSeq++;
    this.sessionName = `s${this.sessionSeq}`;
    this.lastAt = null;
    // 漂移读数跟着换段失效：手机在 `R` / 重连时会把观测清零，下一段的第一条报文
    // 到来之前，手里这个数是上一段的累计值，记进新样本就是错的。置空而不是置 0。
    this.drift = { deg: null, comp: this.drift.comp };
    // 换段立刻落盘：`R` 之后立刻刷新页面是常见操作，别把上一段留在内存里
    void this.flush();
  }

  /**
   * 手机端 1Hz 漂移报文（`app.ts` 的 `onCtrl` 转发）。
   *
   * 不做平滑、不插值：样本要的是「相遇那一刻的读数」，而漂移是慢变量，
   * 1 秒的滞后远小于剔除门限。平滑反而会把握手瞬间的跳变糊掉。
   */
  setDrift(deg: number, comp: boolean) {
    this.drift = { deg, comp };
  }

  /** `L`：暂停 / 恢复。暂停即落盘——暂停的意图多半是「这一轮打完了」。 */
  toggle() {
    if (this.log.recording) {
      this.log.stop();
      void this.flush().then((p) => {
        this.badge();
        this.hooks.onHint(
          `采集已暂停 · 共 ${this.log.count} 条${p ? `（K 查看落盘位置，L 恢复）` : '（落盘失败，K 重试）'}`,
          2600
        );
      });
      return;
    }
    this.log.start();
    this.badge();
    this.hooks.onHint(`采集已恢复（${this.sessionName}）`, 2000);
  }

  /**
   * 把「还没落盘的增量」追加到 `data/contact/<runId>.jsonl`。
   *
   * 返回文件相对路径（没有新数据时返回已有的那个 / null）。**失败不抛**：网络错了
   * 就把游标留着，下一次 `K` 或定时器会重发同一批——服务端是 append + 客户端游标，
   * 重发最多重复写一次，比丢数据好；而游标只在成功后推进，正常情况下不会重复。
   */
  async flush(): Promise<string | null> {
    if (this.flushing) return this.path;
    const rows = this.log.snapshot();
    if (rows.length <= this.flushed) return this.path;

    this.flushing = true;
    const from = this.flushed;
    try {
      const text = samplesToJsonl(rows.slice(from));
      const res = await fetch(`/__contact?file=${this.runId}`, { method: 'POST', body: text });
      const data = (await res.json()) as { ok?: boolean; path?: string; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      this.flushed = rows.length;
      this.path = data.path ?? null;
      this.badge();
      return this.path;
    } catch (err) {
      console.warn('[contact] 落盘失败，样本留在内存里等下次重试', err);
      this.flushed = from;
      return null;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * `K`：先把增量落盘，再在控制台打一份分组读数。
   *
   * 落盘失败时退回浏览器下载——那种情况多半是 `npm run dev` 没在跑（比如直接开了
   * 打包产物 `dist/`），下载虽然麻烦但至少数据不丢。
   */
  async export() {
    const had = this.log.count;
    const path = await this.flush();
    if (path) {
      console.log(summarizeContacts(this.log.snapshot()));
      this.hooks.onHint(`已写入 ${path} · 共 ${had} 条 · 分组读数在控制台`, 3200);
      return;
    }
    if (had === 0) {
      this.hooks.onHint(this.log.recording ? '还没有采到样本：先打几球' : '采集已暂停（按 L 恢复）', 2400);
      return;
    }
    console.warn('[contact] 服务端落盘不可用，改用浏览器下载');
    this.download();
  }

  /**
   * 关页 / 刷新前的兜底。
   *
   * `sendBeacon` 是卸载时唯一保证送达的出口——`fetch` 会随页面一起被取消，
   * 所以这里不复用 `flush()`。
   */
  beacon() {
    const rows = this.log.snapshot();
    if (rows.length <= this.flushed) return;
    const text = samplesToJsonl(rows.slice(this.flushed));
    // 上限 64KB：正常情况下最多 8 条（约 3KB），超了说明前面一直在失败，交给下次启动
    if (text.length < 60_000) navigator.sendBeacon(`/__contact?file=${this.runId}`, text);
  }

  /** 服务端不可用时的降级出口：整份序列化后交给浏览器下载。 */
  private download() {
    const text = this.log.toJsonl();
    if (!text) return;
    const blob = new Blob([text], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contact-${this.runId}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
    this.hooks.onHint(`落盘失败，已改为下载 ${this.log.count} 条样本`, 3200);
  }
}

/**
 * 本次页面生命周期的文件名 stem。
 *
 * **每次刷新都是一个新文件**：万一中途刷新，前半段在旧文件里、后半段在新文件里，
 * 不会出现「同一份文件里混进两次会话」——那比丢数据更难查。
 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
