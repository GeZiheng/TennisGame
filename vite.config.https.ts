import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { lanDev } from './server/vite-plugin.ts';

/**
 * iOS / Android 都只在安全上下文里开放运动传感器，真机调试必须用这个配置。
 *
 * 证书优先用 scripts/make-cert.mjs 生成的（SAN 里带局域网 IP），
 * 没有就退回 plugin-basic-ssl 的默认证书（CN 只有 localhost，手机按 IP 访问
 * 会多一道名称不匹配的提示，但也能点过去）。
 */

const dir = resolve(import.meta.dirname, '.cert');
const keyPath = resolve(dir, 'dev-key.pem');
const certPath = resolve(dir, 'dev-cert.pem');
const hasCert = existsSync(keyPath) && existsSync(certPath);

export default defineConfig({
  plugins: hasCert ? [lanDev()] : [basicSsl(), lanDev()],
  server: {
    host: true,
    port: 5174,
    ...(hasCert
      ? { https: { key: readFileSync(keyPath), cert: readFileSync(certPath) } }
      : {}),
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        play: 'index.html',
        controller: 'controller.html',
      },
    },
  },
});
