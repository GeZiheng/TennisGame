import type { Plugin } from 'vite';
import type { WebSocketServer as WSS } from 'ws';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { attachSignaling } from './rooms.ts';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws') as { WebSocketServer: typeof WSS };

/** 找出本机所有可用的局域网 IPv4，排除回环和虚拟网卡。 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    if (/loopback|vmware|virtualbox|vethernet|docker|wsl|tailscale|utun|tap/i.test(name)) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      out.push(info.address);
    }
  }
  // 家用/办公网段优先，虚拟网卡靠后
  const score = (ip: string) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
  return out.sort((a, b) => score(a) - score(b));
}

/**
 * 开发期用的局域网插件，做两件事：
 * 1. 把信令服务挂在 Vite 的 HTTP 服务上（同源，不用额外端口）
 * 2. 提供 /__lanip 让大屏端知道该把哪个地址编进二维码 ——
 *    否则用户从 localhost 打开大屏，二维码里就是 localhost，手机扫了必然打不开。
 */
export function lanDev(): Plugin {
  const hook = (httpServer: any) => {
    if (!httpServer) return;
    const wss = new WebSocketServer({ noServer: true });
    attachSignaling(wss);
    httpServer.on('upgrade', (req: any, socket: any, head: any) => {
      if (req.url?.startsWith('/signal')) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      }
    });
  };

  // 返回的 protocol 必须是「这个服务实际跑的协议」，不能从请求头猜。
  // 否则 https 模式下二维码还会编成 http，手机扫了就白屏。
  const lanip = (req: any, res: any) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        ips: lanAddresses(),
        protocol: req.socket?.encrypted ? 'https' : 'http',
        port: req.socket?.localPort ?? null,
      })
    );
  };

  // 把根证书挂出来，手机下载一次就能形成完整的信任链，地址栏不再是红锁
  const serveCa = (rootDir: string) => (_req: any, res: any) => {
    const caPath = resolve(rootDir, '.cert/ca.pem');
    if (!existsSync(caPath)) {
      res.statusCode = 404;
      res.end('还没有根证书，先运行 npm run cert');
      return;
    }
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="tennis-p0-ca.crt"');
    res.end(readFileSync(caPath));
  };

  return {
    name: 'lan-dev',
    configureServer(server) {
      hook(server.httpServer);
      server.middlewares.use('/__lanip', lanip);
      server.middlewares.use('/ca.crt', serveCa(server.config.root));
    },
    configurePreviewServer(server) {
      hook(server.httpServer);
      server.middlewares.use('/__lanip', lanip);
      server.middlewares.use('/ca.crt', serveCa(server.config.root));
    },
  };
}
