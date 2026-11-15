import { tennisConfig } from './vite.config.shared.ts';

/** 对打（唯一模式）。启动：npm run dev → :5183 */
export default tennisConfig({ port: 5183, https: false });
