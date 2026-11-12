import { tennisConfig } from './vite.config.shared.ts';

/** 对打（与脚本回球机）。启动：npm run dev:duel → :5183 */
export default tennisConfig({ port: 5183, https: false, home: 'duel.html' });
