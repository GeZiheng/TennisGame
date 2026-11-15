import type { Plugin } from 'vite';
import type { WebSocketServer as WSS } from 'ws';
import { createRequire } from 'node:module';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
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

/** 采集样本的落盘目录（相对项目根）。目录用 `data/contact/.gitkeep` 保留。 */
const CONTACT_DIR = 'data/contact';
/** 文件名白名单：只允许字母数字和连字符，从根上堵掉 `../` 路径穿越。 */
const SAFE_STEM = /^[a-z0-9][a-z0-9-]{0,63}$/i;
/** 单次 flush 的 body 上限。一次最多几十条、一条约 0.4KB，4MB 是防呆不是约束。 */
const MAX_BODY = 4 << 20;

function readBody(req: any): Promise<string> {
  return new Promise((ok, fail) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      buf += c;
      if (buf.length > MAX_BODY) {
        fail(new Error(`body 超过 ${MAX_BODY} 字节`));
        req.destroy();
      }
    });
    req.on('end', () => ok(buf));
    req.on('error', fail);
  });
}

/**
 * 击球采集的落盘接口：`POST /__contact?file=<stem>`，body 是 JSONL 增量。
 *
 * 为什么走服务端而不是浏览器下载：大屏和 dev server 就在同一台机器上，直接写文件
 * 既不用管浏览器的下载目录、也不会因为「下载被拦」丢数据；而且刷新页面后，已经
 * 写出去的那部分还留在磁盘上（浏览器内存里的会全丢）。
 *
 * 语义永远是 **append**，客户端只发「还没落盘的增量」，发成功才推进指针。所以重复
 * POST 不会重复写——幂等性靠客户端指针保证，服务端不需要去重或清空文件。
 *
 * 文件名由客户端给（一个启动时刻的 stem），**每次刷新页面换一个新 stem**，所以
 * 「同一份文件里混进两次会话」不可能发生，不需要在服务端做时间戳。
 */
function contactSink(rootDir: string) {
  return async (req: any, res: any) => {
    const reply = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

    // 不依赖 connect 剥前缀后的 `req.url` 形态，直接从原文里取 query
    const raw = String(req.url ?? '');
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    const stem = new URLSearchParams(q).get('file') ?? '';
    if (!SAFE_STEM.test(stem)) return reply(400, { ok: false, error: `文件名不合法: ${stem}` });

    let text: string;
    try {
      text = await readBody(req);
    } catch (err) {
      return reply(413, { ok: false, error: String(err) });
    }
    if (!text.trim()) return reply(400, { ok: false, error: 'body 为空' });

    // 补齐末尾换行：否则两次 append 会把两条样本粘成一行，整份文件就解析废了
    const payload = text.endsWith('\n') ? text : `${text}\n`;
    const rel = `${CONTACT_DIR}/${stem}.jsonl`;
    const abs = resolve(rootDir, rel);

    try {
      await mkdir(resolve(rootDir, CONTACT_DIR), { recursive: true });
      await appendFile(abs, payload, 'utf8');
    } catch (err) {
      return reply(500, { ok: false, error: String(err) });
    }

    // 行数读一遍文件反推：一次 flush 最多几十行，只在 flush 时发生，不必优化
    let total = 0;
    try {
      total = (await readFile(abs, 'utf8')).split('\n').filter(Boolean).length;
    } catch {
      /* 读失败不影响已写入的结果，行数只用于界面提示 */
    }

    reply(200, {
      ok: true,
      path: rel,
      wrote: payload.split('\n').filter(Boolean).length,
      total,
    });
  };
}

/**
 * 开发期用的局域网插件，做三件事：
 * 1. 把信令服务挂在 Vite 的 HTTP 服务上（同源，不用额外端口）
 * 2. 提供 /__lanip 让大屏端知道该把哪个地址编进二维码 ——
 *    否则用户从 localhost 打开大屏，二维码里就是 localhost，手机扫了必然打不开。
 * 3. 提供 /__contact 把击球采集样本落盘到 `data/contact/`（见 `contactSink`）
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
      const root = server.config.root;
      server.middlewares.use('/__lanip', lanip);
      server.middlewares.use('/ca.crt', serveCa(root));
      server.middlewares.use('/__contact', contactSink(root));
    },
    configurePreviewServer(server) {
      hook(server.httpServer);
      const root = server.config.root;
      server.middlewares.use('/__lanip', lanip);
      server.middlewares.use('/ca.crt', serveCa(root));
      server.middlewares.use('/__contact', contactSink(root));
    },
  };
}
