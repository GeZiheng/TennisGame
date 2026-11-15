/**
 * 核心逻辑测试跑手。
 *
 * 为什么不用 vitest：这几块逻辑（二进制协议、姿态积分、分位数、时钟同步）
 * 一个 DOM 都不需要，用 tsc 编成 CommonJS 直接跑最省事，也不用多装一套测试框架。
 *
 * 编哪些文件由 `scripts/core.mjs` 的 `CORE_FILES` 决定，**这里不再自己抄一份**。
 * 单测和探针唯一的区别是产物目录：`.tmp-test/` 与 `.tmp-duel/`。历史上这两份
 * tsc 参数各写一份，于是「新增 core 模块要改两处，漏了会在运行时静默加载不到」
 * 变成一个必须靠记忆遵守的约定（`docs/testing.md` 8.1）。现在漏加会直接编译失败。
 *
 *   node scripts/test.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCore } from './core.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '.tmp-test');

// 注意：这里刻意不删目录。环境里的删除拦截器会挡住递归删除，
// 而 tsc 会直接覆盖同名产物，留着旧文件没有副作用。
mkdirSync(out, { recursive: true });

console.log('编译核心模块…');
buildCore({ outDir: out });

copyFileSync(resolve(root, 'tests/core.test.cjs'), resolve(out, 'run.cjs'));

console.log('');
execFileSync(process.execPath, [resolve(out, 'run.cjs')], { cwd: out, stdio: 'inherit' });
