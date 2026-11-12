import { tennisConfig } from './vite.config.shared.ts';

/**
 * 对墙打 · HTTPS。真机必须走这个，传感器只在安全上下文里开放。
 * 启动：npm run dev:https → :5174
 */
export default tennisConfig({ port: 5174, https: true });
