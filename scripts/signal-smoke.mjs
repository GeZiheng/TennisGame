/**
 * 信令服务的冒烟测试：不启动浏览器，直接用两个 WebSocket 客户端验证
 * 「同房间配对 → ready 通告 → 消息转发 → 断线通知」这条链路。
 *
 *   node scripts/signal-smoke.mjs
 */
import { WebSocket } from 'ws';

const BASE = process.env.SIGNAL_URL ?? 'ws://127.0.0.1:5173/signal';
const ROOM = 'TST1';

const seen = { host: [], peer: [] };
const log = (who, m) => {
  seen[who].push(m.type);
  console.log(`[${who}] ${JSON.stringify(m)}`);
};

function client(role) {
  const ws = new WebSocket(BASE);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: ROOM, role })));
  ws.on('message', (d) => log(role, JSON.parse(d.toString())));
  ws.on('error', (e) => console.log(`[${role}] ERROR ${e.message}`));
  return ws;
}

const host = client('host');
await new Promise((r) => setTimeout(r, 300));

const peer = client('peer');
await new Promise((r) => setTimeout(r, 500));

host.send(JSON.stringify({ type: 'msg', data: { kind: 'offer', sdp: 'FAKE' } }));
await new Promise((r) => setTimeout(r, 400));

peer.close();
await new Promise((r) => setTimeout(r, 500));

host.close();
await new Promise((r) => setTimeout(r, 200));

const checks = [
  ['host 收到 waiting', seen.host.includes('waiting')],
  ['host 收到 ready', seen.host.includes('ready')],
  ['peer 收到 ready', seen.peer.includes('ready')],
  ['peer 收到转发消息', seen.peer.includes('msg')],
  ['host 收到对方离开', seen.host.includes('peer-left')],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}`);
  if (!pass) ok = false;
}
console.log(ok ? '\n信令链路正常' : '\n信令链路有问题');
process.exit(ok ? 0 : 1);
