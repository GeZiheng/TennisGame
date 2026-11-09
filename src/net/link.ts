import type { CtrlMsg } from '../core/protocol';

export type LinkState = 'idle' | 'waiting' | 'ready' | 'connecting' | 'connected' | 'closed' | 'error';

export interface LinkHandlers {
  onState: (state: LinkState, detail?: string) => void;
  onImu: (buf: ArrayBuffer) => void;
  onCtrl: (msg: CtrlMsg) => void;
}

export type Role = 'host' | 'peer';

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomRoom(len = 4): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return s;
}

function signalUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/signal`;
}

/**
 * 两端之间的链路。
 *
 * 信令只用来交换 SDP 和 ICE，配对完成后传感器数据走 WebRTC 点对点直连，
 * 完全不经过任何服务器，甚至不需要外网。
 *
 * 两条 DataChannel 分工明确：
 *   ctrl  可靠有序，用来做时钟同步和配置（丢一条就漏一次校准，不能忍）
 *   imu   不可靠无序，60Hz 高频数据（丢一帧无所谓，卡一下才致命）
 */
export class Link {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private ctrl: RTCDataChannel | null = null;
  private imu: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private closed = false;

  constructor(
    private readonly room: string,
    private readonly role: Role,
    private readonly handlers: LinkHandlers
  ) {
    this.connectSignal();
  }

  get isConnected(): boolean {
    return this.imu?.readyState === 'open' && this.ctrl?.readyState === 'open';
  }

  private connectSignal() {
    const ws = new WebSocket(signalUrl());
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room: this.room, role: this.role }));
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'waiting') {
        this.handlers.onState('waiting', '等待另一端加入');
      } else if (msg.type === 'ready') {
        this.handlers.onState('ready', '双方已找到');
        this.startPeer(msg.initiator === true);
      } else if (msg.type === 'peer-left') {
        this.handlers.onState('waiting', '对方已断开，等待重新接入');
        this.teardownPeer();
      } else if (msg.type === 'evicted') {
        this.handlers.onState('error', '同一房间有另一个同类连接，本连接已被替换');
      } else if (msg.type === 'msg') {
        this.onSignalData(msg.data);
      }
    };

    ws.onclose = () => {
      if (!this.closed && !this.isConnected) {
        this.handlers.onState('error', '信令服务断开');
      }
    };
    ws.onerror = () => this.handlers.onState('error', '信令连接失败');
  }

  private signal(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'msg', data: payload }));
    }
  }

  private startPeer(initiator: boolean) {
    this.teardownPeer();

    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.remoteSet = false;
    this.pendingCandidates = [];

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal({ kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') this.handlers.onState('connected');
      else if (s === 'connecting') this.handlers.onState('connecting', '建立点对点通道');
      else if (s === 'failed')
        this.handlers.onState(
          'error',
          'P2P 连接失败：多半是路由器开了 AP 隔离，或者手机连的是访客网络'
        );
      else if (s === 'disconnected') this.handlers.onState('closed', '链路中断');
    };

    if (initiator) {
      this.attachChannel(pc.createDataChannel('ctrl', { ordered: true }));
      this.attachChannel(
        pc.createDataChannel('imu', { ordered: false, maxRetransmits: 0 })
      );
      pc.onnegotiationneeded = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal({ kind: 'offer', sdp: pc.localDescription });
      };
    } else {
      pc.ondatachannel = (e) => this.attachChannel(e.channel);
    }
  }

  private attachChannel(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'ctrl') {
      this.ctrl = ch;
      ch.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        try {
          this.handlers.onCtrl(JSON.parse(e.data) as CtrlMsg);
        } catch {
          /* 忽略坏包 */
        }
      };
    } else if (ch.label === 'imu') {
      this.imu = ch;
      ch.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) this.handlers.onImu(e.data);
      };
    }
    ch.onclose = () => {
      if (!this.closed) this.handlers.onState('closed', '通道关闭');
    };
  }

  private async onSignalData(data: any) {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (data.kind === 'offer') {
        await pc.setRemoteDescription(data.sdp);
        this.remoteSet = true;
        await this.flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal({ kind: 'answer', sdp: pc.localDescription });
      } else if (data.kind === 'answer') {
        await pc.setRemoteDescription(data.sdp);
        this.remoteSet = true;
        await this.flushCandidates();
      } else if (data.kind === 'ice') {
        if (this.remoteSet) await pc.addIceCandidate(data.candidate);
        else this.pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      this.handlers.onState('error', `信令处理异常：${(err as Error).message}`);
    }
  }

  private async flushCandidates() {
    const pc = this.pc;
    if (!pc) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* 过期候选，忽略 */
      }
    }
  }

  sendCtrl(msg: CtrlMsg): void {
    if (this.ctrl?.readyState === 'open') this.ctrl.send(JSON.stringify(msg));
  }

  sendImu(buf: ArrayBuffer): void {
    if (this.imu?.readyState === 'open') {
      try {
        this.imu.send(buf);
      } catch {
        /* 缓冲溢出时丢弃，高频数据不需要重发 */
      }
    }
  }

  private teardownPeer() {
    this.imu?.close();
    this.ctrl?.close();
    this.pc?.close();
    this.imu = null;
    this.ctrl = null;
    this.pc = null;
  }

  close() {
    this.closed = true;
    this.teardownPeer();
    this.ws?.close();
  }
}
