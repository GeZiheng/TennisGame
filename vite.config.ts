import { tennisConfig } from './vite.config.shared.ts';

/** 对墙打（默认）。启动：npm run dev → :5173 */
export default tennisConfig({ port: 5173, https: false });
