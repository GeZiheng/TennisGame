/**
 * 把核心模块编成 CommonJS，落到 `.tmp-duel/`。
 *
 * 为什么需要这一层：`scripts/` 下的模拟和探针都要 `require` 编译产物，而项目本身是
 * `"type": "module"`——产物目录里必须放一个 `{"type":"commonjs"}` 的 package.json，
 * 否则 `require` 会当成 ESM 直接失败。
 *
 * **这里是「core 有哪些文件」的唯一一份清单。** `scripts/test.mjs` 曾经自己抄了一份
 * 几乎相同的 tsc 参数，于是「新增 core 模块要改两处」变成一个只能靠记忆遵守的约定
 * （`docs/testing.md` 8.1 原话：「两处编译输入都要加」）。现在 `buildCore()` 收
 * `outDir` 参数，单测只是换一个产物目录调用它——清单只有一处，漏加会在编译期
 * 立刻炸，而不是等到运行时才发现某个模块加载不到。
 *
 * 历史上 `sim.mjs` / `duel-sim.mjs` 各抄过一份、编译到两个目录，于是「探针量的是
 * 哪一份产物」变成一个要靠记忆回答的问题（`docs/testing.md` 8.3）。同一类问题
 * 现在只剩这一处入口。
 *
 *   node scripts/core.mjs          # 只编译
 *   import { buildCore, CORE_FILES } from './core.mjs'
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
 *
 * `stats` 原住在 `play/` 下，但它零 DOM、还被单测直接 require，为它在清单外开
 * 特例（「test.mjs 那份多一个 play/stats」）并不划算——移到 core 之后
 * 「core 就是可单测的那一层」这条规则没有例外。
 */
export const CORE_FILES = [
  'protocol',
  'quat',
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
  'stats',
  // 击球采集：`duel.ts` 发 `contact` 事件时用到它的类型，probe / duel-sim 也要编
  'contact-log',
].map((n) => `src/core/${n}.ts`);

/**
 * 编译 core 到指定目录。
 *
 * @param {object} [opts]
 * @param {string} [opts.outDir]  产物目录，默认 `.tmp-duel/`
 * @param {string[]} [opts.extra] 额外要编的文件（相对 root 或绝对路径）
 */
export function buildCore(opts = {}) {
  const outDir = opts.outDir ?? OUT;
  const extra = opts.extra ?? [];
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'package.json'), '{"type":"commonjs"}');
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      ...CORE_FILES,
      ...extra,
      '--outDir',
      outDir,
      // 不写 rootDir 的话，tsc 会按「输入文件的公共父目录」推导，
      // 一旦只编译 core 下的文件，产物就从 core/ 里掉到顶层，require 路径全错。
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
