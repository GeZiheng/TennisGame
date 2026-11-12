/**
 * 端到端模拟跑手：把核心模块编成 CommonJS，再喂给模拟脚本。
 *
 * 和 scripts/test.mjs 用同一套编译参数，区别只是入口不同。
 * 单独拆一个文件是因为 sim-e2e.cjs 需要 require 编译产物，
 * 而项目本身是 "type": "module"，产物目录里必须放一个 commonjs 的 package.json。
 *
 *   node scripts/sim.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.tmp-sim');

mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'package.json'), '{"type":"commonjs"}');

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
    // 自动走位：`scripts/sim-e2e.cjs` 用 MOVE=auto 对比「自动走位 vs 人站着不动」
    'src/core/auto-move.ts',
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
  ],
  { cwd: root, stdio: 'inherit' }
);

execFileSync(process.execPath, [resolve(root, 'scripts/sim-e2e.cjs')], { cwd: root, stdio: 'inherit' });
