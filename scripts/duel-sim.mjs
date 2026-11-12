/**
 * 对打模拟跑手：把核心模块编成 CommonJS，再跑 scripts/duel-sim.cjs。
 *
 * 和 scripts/sim.mjs 同一套编译参数，只是多编了 machine.ts / duel.ts，
 * 产物落在 .tmp-duel/（`.tmp-*` 已在 .gitignore）。
 *
 *   node scripts/duel-sim.mjs
 *   node scripts/duel-sim.mjs --seconds 90 --level 3
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.tmp-duel');

const FILES = [
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
  'duel',
  // 玩家侧的走位决策：probe / 模拟脚本要和真机用同一份代码
  'auto-move',
].map((n) => 'src/core/' + n + '.ts');

mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'package.json'), '{"type":"commonjs"}');

const TSC_ARGS = [
  resolve(root, 'node_modules/typescript/bin/tsc'),
  '--ignoreConfig',
  ...FILES,
  '--outDir',
  out,
  '--rootDir',
  'src',
  '--module',
  'commonjs',
  '--target',
  'es2022',
  '--skipLibCheck',
  '--noEmit',
  'false',
];

execFileSync(process.execPath, TSC_ARGS, { cwd: root, stdio: 'inherit' });

const RUN = [resolve(root, 'scripts/duel-sim.cjs'), ...process.argv.slice(2)];
execFileSync(process.execPath, RUN, { cwd: root, stdio: 'inherit' });
