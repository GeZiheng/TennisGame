/**
 * 把核心模块编成 CommonJS，落到 `.tmp-duel/`。
 *
 * 为什么需要这一层：`scripts/` 下的模拟和探针都要 `require` 编译产物，而项目本身是
 * `"type": "module"`——产物目录里必须放一个 `{"type":"commonjs"}` 的 package.json，
 * 否则 `require` 会当成 ESM 直接失败。
 *
 * 为什么单独一个文件：`duel-sim.mjs` 和每一条探针都要同一份编译参数。以前 `sim.mjs`
 * 和 `duel-sim.mjs` 各抄了一份（编译到 `.tmp-sim` / `.tmp-duel` 两个目录），于是
 * 「探针量的是哪一份产物」变成一个要靠记忆回答的问题——`docs/testing.md` 8.3 那条
 * 「别在探针里再抄一份」说的就是这类事。现在只留一个目录、一份文件清单。
 *
 *   node scripts/core.mjs          # 只编译
 *   import { buildCore } from './core.mjs'
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const OUT = resolve(root, '.tmp-duel');

/**
 * 编译哪些文件。
 *
 * 只列 `src/core/` 里**不碰 DOM**的那些：整条规则链（duel / match / serve /
 * machine）、物理与判定、以及玩家侧唯一能被单测的决策逻辑（auto-move / swing-rig）。
 * `src/play/` 一律不进来——它 import `three` 和 `document`，Node 里跑不起来。
 */
export const CORE_FILES = [
  'protocol',
  'imu',
  'attitude',
  'vec',
  'court',
  'gyro',
  'swing',
  'racket',
  'physics',
  'machine',
  'match',
  'serve',
  'duel',
  'auto-move',
  'swing-rig',
].map((n) => `src/core/${n}.ts`);

export function buildCore() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'package.json'), '{"type":"commonjs"}');
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      ...CORE_FILES,
      '--outDir',
      OUT,
      '--rootDir',
      'src',
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--skipLibCheck',
      '--noEmit',
      'false',
    ],
    { cwd: root, stdio: 'inherit' }
  );
}

// 直接 `node scripts/core.mjs` 时编译；被 import 时只导出。
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  buildCore();
}
