import { tennisConfig } from './vite.config.shared.ts';

/**
 * 对打 · HTTPS。真机必须走这个，传感器只在安全上下文里开放。
 * 启动：`npm run dev:https` → :5184
 */
export default tennisConfig({ port: 5184, https: true });
