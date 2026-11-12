import { defineConfig, type UserConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { lanDev } from './server/vite-plugin.ts';

/**
 * 两种模式各起一个服务的配置工厂。
 *
 * 为什么不共用端口：两种模式的**信令房间名空间是同一个**（`server/rooms.ts` 按
 * 房间号配对），共用端口时同时开两个大屏窗口会互相抢手机。分开端口之后
 * 每条服务有自己的房间表，一台机器上可以同时开两个窗口分别打。
 *
 * 端口表：
 *   5173 对墙打 http      5174 对墙打 https
 *   5183 对打   http      5184 对打   https
 *
 * https 是必须的：iOS / Android 都只在安全上下文里开放运动传感器。
 */

/** 证书优先用 scripts/make-cert.mjs 生成的（SAN 里带局域网 IP）。 */
const certDir = resolve(import.meta.dirname, '.cert');
const keyPath = resolve(certDir, 'dev-key.pem');
const certPath = resolve(certDir, 'dev-cert.pem');
const hasCert = existsSync(keyPath) && existsSync(certPath);

/**
 * 把 `/` 指向某个页面。
 *
 * 对打服务如果照旧返回 `index.html`，打开根地址会进到墙打——这不是小问题：
 * 玩家会以为「对打模式没生效」，而其实只是看错了入口。
 *
 * 在 `configureServer` 里直接 `use` 的中间件排在 vite 内部中间件**之前**，
 * 所以改写能生效；写成返回值就是「后置」，那时候静态文件已经发出去了。
 */
function homePage(page: string) {
  return {
    name: 'home-page',
    configureServer(server: any) {
      if (page === 'index.html') return;
      server.middlewares.use((req: any, _res: any, next: any) => {
        if (req.url === '/' || req.url === '/index.html') req.url = `/${page}`;
        next();
      });
    },
  };
}

export function tennisConfig(opts: {
  port: number;
  https: boolean;
  /** 根地址打开的页面。对打服务指向 duel.html。 */
  home?: string;
}): UserConfig {
  const secure = opts.https && hasCert;
  return defineConfig({
    plugins: [
      homePage(opts.home ?? 'index.html'),
      ...(opts.https && !hasCert ? [basicSsl()] : []),
      lanDev(),
    ],
    server: {
      host: true,
      port: opts.port,
      ...(secure ? { https: { key: readFileSync(keyPath), cert: readFileSync(certPath) } } : {}),
    },
    build: {
      target: 'es2022',
      rollupOptions: {
        input: {
          play: 'index.html',
          duel: 'duel.html',
          controller: 'controller.html',
        },
      },
    },
  });
}
