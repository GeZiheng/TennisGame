import { tennisConfig } from './vite.config.shared.ts';

/**
 * 对打 · HTTPS。真机调试用，端口和墙打的 https 错开，两条信令互不干扰。
 * 启动：npm run dev:duel:https → :5184
 */
export default tennisConfig({ port: 5184, https: true, home: 'duel.html' });
