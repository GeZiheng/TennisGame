/**
 * 对打模拟跑手：编核心模块（`scripts/core.mjs`），再跑 scripts/duel-sim.cjs。
 *
 *   node scripts/duel-sim.mjs
 *   node scripts/duel-sim.mjs --seconds 90 --level 3
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildCore } from './core.mjs';

const root = resolve(import.meta.dirname, '..');

buildCore();
execFileSync(process.execPath, [resolve(root, 'scripts/duel-sim.cjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
