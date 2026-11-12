/**
 * 对打模式的入口：玩家 vs 脚本回球机。
 *
 * 启动：`npm run dev:duel`（:5183；https 版 `dev:duel:https` 是 :5184）。
 * 不要和墙打共用一个端口——
 * 两条信令各自独立，同一台机器上可以同时开着两个窗口分别打。
 *
 * 规则在 `core/duel.ts`，对手在 `core/machine.ts`。和墙打共用 `app.ts`，
 * 差异只有三处（场景、规则对象、HUD 主数字），见 app.ts 顶部说明。
 */
import { startPlay } from './app';

startPlay('duel');
