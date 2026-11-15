/**
 * 大屏入口：玩家 vs 脚本回球机。
 *
 * 全部实现在 `app.ts`，规则在 `core/duel.ts`，对手在 `core/machine.ts`。
 * 这一层只负责起循环——网络、时钟同步、姿态连续性、渲染管线都在下面那三个文件里，
 * 入口越薄越好。
 *
 * 启动：`npm run dev`（:5183；真机走 `npm run dev:https`，:5184）
 */
import { startPlay } from './app';

startPlay();
