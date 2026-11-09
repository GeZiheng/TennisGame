import type { WebSocket, WebSocketServer } from 'ws';

type Role = 'host' | 'peer';

interface Client {
  ws: WebSocket;
  room: string;
  role: Role;
}

/**
 * 极简房间式信令：只负责把 SDP / ICE 转给对方，不碰任何设备数据。
 * 配对成功后两端走 WebRTC 点对点直连，这个服务就不再参与。
 */
export function attachSignaling(wss: WebSocketServer): void {
  const rooms = new Map<string, Set<Client>>();

  const leave = (client: Client) => {
    const set = rooms.get(client.room);
    if (!set) return;
    set.delete(client);
    for (const other of set) {
      send(other.ws, { type: 'peer-left' });
    }
    if (set.size === 0) rooms.delete(client.room);
  };

  const send = (ws: WebSocket, payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  wss.on('connection', (ws: WebSocket) => {
    let client: Client | null = null;

    ws.on('message', (raw) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'join') {
        const room = String(msg.room || '').toUpperCase().slice(0, 6);
        const role: Role = msg.role === 'host' ? 'host' : 'peer';
        if (!room) return;

        if (client) leave(client);
        client = { ws, room, role };

        let set = rooms.get(room);
        if (!set) {
          set = new Set();
          rooms.set(room, set);
        }
        // 同角色重连时踢掉旧连接，避免手机刷新后卡住
        for (const existing of [...set]) {
          if (existing.role === role) {
            set.delete(existing);
            send(existing.ws, { type: 'evicted' });
            existing.ws.close();
          }
        }
        set.add(client);

        const host = [...set].find((c) => c.role === 'host');
        const peer = [...set].find((c) => c.role === 'peer');
        if (host && peer) {
          send(host.ws, { type: 'ready', initiator: true });
          send(peer.ws, { type: 'ready', initiator: false });
        } else {
          send(ws, { type: 'waiting', role });
        }
        return;
      }

      if (!client) return;
      if (msg.type === 'msg') {
        const set = rooms.get(client.room);
        if (!set) return;
        for (const other of set) {
          if (other.ws !== ws) send(other.ws, { type: 'msg', data: msg.data });
        }
        return;
      }
      if (msg.type === 'leave' && client) {
        leave(client);
        client = null;
      }
    });

    ws.on('close', () => {
      if (client) leave(client);
    });
  });
}
