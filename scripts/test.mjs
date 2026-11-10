/**
 * 核心逻辑测试跑手。
 *
 * 为什么不用 vitest：这几块逻辑（二进制协议、姿态积分、分位数、时钟同步）
 * 一个 DOM 都不需要，用 tsc 编成 CommonJS 直接跑最省事，也不用多装一套测试框架。
 *
 *   node scripts/test.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.tmp-test');

// 注意：这里刻意不删目录。环境里的删除拦截器会挡住递归删除，
// 而 tsc 会直接覆盖同名产物，留着旧文件没有副作用。
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'package.json'), '{"type":"commonjs"}');

console.log('编译核心模块…');
// 直接调本地的 tsc，避免在 Windows 上拉起 npx.cmd 时的 shell 问题
execFileSync(
  process.execPath,
  [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig',
    'src/core/protocol.ts',
    'src/core/imu.ts',
    'src/core/attitude.ts',
    'src/core/vec.ts',
    'src/core/court.ts',
    'src/core/gyro.ts',
    'src/core/swing.ts',
    'src/core/racket.ts',
    'src/core/physics.ts',
    'src/core/rally.ts',
    'src/play/stats.ts',
    'src/play/vision-math.ts',
    '--outDir',
    out,
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

copyFileSync(resolve(root, 'tests/core.test.cjs'), resolve(out, 'run.cjs'));

console.log('');
execFileSync(process.execPath, [resolve(out, 'run.cjs')], { cwd: out, stdio: 'inherit' });
