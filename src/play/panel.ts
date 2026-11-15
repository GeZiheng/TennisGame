/**
 * 连接面板：房间号、控制端 URL、二维码、连接状态文案。
 *
 * 从 `app.ts` 搬出来的原因很直接：这块全是 DOM 和二维码绘制（约 100 行），
 * 只在**开局前**有意义，和主循环没有任何交集。它唯一需要向外通知的是两件事：
 * 「配对成功，该重置会话了」和「用户给了手势，可以解锁声音」。
 */

import QRCode from 'qrcode';
import { randomRoom, type LinkState } from '../net/link';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface PanelHooks {
  /**
   * `ready` = 信令确认「房间里 host 和 peer 都在」，也就是一次新的配对。
   *
   * 手机重新扫码会重载 controller.html，时钟和包序号都从头开始，而大屏页面一直是
   * 同一个——必须在数据到达前把上一段连接的状态清干净。清理逻辑不在这里，
   * 这里只负责发出「新会话」这个信号。
   */
  onPairReady(): void;
  /** 连上了：浏览器要求用户手势之后才能出声，这里是个自然的手势时机 */
  onUnlock(): void;
}

export class ConnectPanel {
  /** 房间号。扫码 URL 里带的就是它，`Link` 也用同一个 */
  readonly room: string;

  constructor(private readonly hooks: PanelHooks) {
    const qs = new URLSearchParams(location.search);
    this.room = (qs.get('room') ?? randomRoom()).toUpperCase().slice(0, 4);
  }

  /** 生成控制端地址、画二维码、接上「复制」按钮。开局前调用一次。 */
  async render() {
    const roomEl = $<HTMLElement>('room-code');
    const urlEl = $<HTMLElement>('ctrl-url');
    roomEl.textContent = this.room;

    const { url, insecure } = await this.resolveControllerUrl();
    urlEl.textContent = url.replace(/^https?:\/\//, '');
    urlEl.title = url;

    const warn = $<HTMLParagraphElement>('proto-warn');
    if (insecure) {
      warn.hidden = false;
      warn.textContent =
        `当前是 HTTP 模式，手机浏览器不会把传感器交给网页。真机测试请改用 npm run dev:https，` +
        `并在 https://localhost:${location.port ? Number(location.port) + 1 : 5184} 打开本页。`;
    }

    const qrEl = $<HTMLCanvasElement>('qr');
    await QRCode.toCanvas(qrEl, url, {
      width: 336,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1c1c1a', light: '#ffffff' },
    });
    qrEl.style.width = '168px';
    qrEl.style.height = '168px';

    const copyBtn = $<HTMLButtonElement>('copy-url');
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        copyBtn.textContent = '已复制';
        setTimeout(() => (copyBtn.textContent = '复制'), 1200);
      } catch {
        /* 非安全上下文拿不到剪贴板权限，忽略 */
      }
    };
  }

  setState(state: LinkState, detail?: string) {
    if (state === 'ready') this.hooks.onPairReady();

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
    const linkStateEl = $<HTMLParagraphElement>('link-state');
    linkStateEl.textContent = text;
    linkStateEl.className = `link-state ${cls}`;

    const connected = state === 'connected';
    $<HTMLDivElement>('connect-panel').style.display = connected ? 'none' : 'block';
    document.body.classList.toggle('playing', connected);
    if (connected) {
      this.hooks.onUnlock();
      $<HTMLElement>('game-hud').hidden = false;
    }
  }

  /**
   * 连接状态之外的一句旁白（「本地模拟控制器运行中」这种）。
   *
   * 不改变面板的显隐，也不碰 body 的 `playing`——它只是覆盖那一行文字。
   */
  setNote(text: string) {
    $<HTMLParagraphElement>('link-state').textContent = text;
  }

  /**
   * 手机该打开的地址。
   *
   * host 用服务端报的局域网 IP、协议用服务端实际跑的：`location` 在 https 模式下
   * 就是 https，但哪天做了反代这两者会不一致，以服务端为准更可靠。
   */
  private async resolveControllerUrl(): Promise<{ url: string; insecure: boolean }> {
    const port = location.port ? `:${location.port}` : '';
    let host = location.hostname;
    let protocol = location.protocol.replace(':', '');
    try {
      const res = await fetch('/__lanip');
      const data = (await res.json()) as { ips?: string[]; protocol?: string };
      if (data.ips?.length) host = data.ips[0];
      if (data.protocol) protocol = data.protocol;
    } catch {
      /* 非 dev server 环境（比如直接预览构建产物）就只能用当前 host */
    }
    return {
      url: `${protocol}://${host}${port}/controller.html?room=${this.room}`,
      insecure: protocol === 'http',
    };
  }
}
