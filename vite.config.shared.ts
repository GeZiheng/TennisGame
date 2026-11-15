import { defineConfig, type UserConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { lanDev } from './server/vite-plugin.ts';

/**
 * dev server 配置工厂：两个入口文件（`vite.config.ts` / `vite.config.https.ts`）共用。
 *
 * 端口表：
 *   5183 http      5184 https
 *
 * 为什么 http / https 是两个端口而不是一个：两条服务各自持有一张信令房间表
 * （`server/rooms.ts` 按房间号配对），同一端口切协议会互相踢。现在只剩一种模式，
 * 但这一层是「协议」不是「模式」，所以保留。
 *
 * https 是必须的：iOS / Android 都只在安全上下文里开放运动传感器。
 */

/** 证书优先用 scripts/make-cert.mjs 生成的（SAN 里带局域网 IP）。 */
const certDir = resolve(import.meta.dirname, '.cert');
const keyPath = resolve(certDir, 'dev-key.pem');
const certPath = resolve(certDir, 'dev-cert.pem');
const hasCert = existsSync(keyPath) && existsSync(certPath);

export function tennisConfig(opts: { port: number; https: boolean }): UserConfig {
  const secure = opts.https && hasCert;
  return defineConfig({
    plugins: [...(opts.https && !hasCert ? [basicSsl()] : []), lanDev()],
    server: {
      host: true,
      port: opts.port,
      ...(secure ? { https: { key: readFileSync(keyPath), cert: readFileSync(certPath) } } : {}),
    },
    build: {
      target: 'es2022',
      rollupOptions: {
        input: {
          // 大屏（对打）与手机控制器。曾经还有一个 index.html 给对墙打用，
          // 11-15 删模式之后 `/` 就是游戏本身。
          play: 'index.html',
          controller: 'controller.html',
        },
      },
    },
  });
}
