/**
 * 挂载仓库自带的 git hook。
 *
 * `.git/hooks/` 不进版本库，所以改用 `core.hooksPath` 指向仓库内的
 * `scripts/hooks/`。由 package.json 的 `prepare` 在 npm install 时自动执行；
 * 也可手动 `node scripts/install-hooks.mjs`。非 git 工作树（源码包）静默跳过。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOOK = resolve(ROOT, 'scripts/hooks/pre-commit');

if (!existsSync(HOOK)) {
  console.error('缺少 scripts/hooks/pre-commit');
  process.exit(1);
}

const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
  cwd: ROOT,
  encoding: 'utf8',
});

if (probe.error || probe.status !== 0 || probe.stdout.trim() !== 'true') {
  console.log('不在 git 工作树里，跳过 hook 挂载。');
} else {
  const set = spawnSync('git', ['config', 'core.hooksPath', 'scripts/hooks'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (set.error || set.status !== 0) {
    console.error(`设置 core.hooksPath 失败：${set.stderr || set.error?.message}`);
    process.exit(1);
  }
  // Git for Windows 不依赖可执行位，但给 Unix 补上；失败不影响挂载结果。
  try { chmodSync(HOOK, 0o755); } catch { /* 某些文件系统不支持 */ }
  console.log('git hook 已挂载：core.hooksPath = scripts/hooks（pre-commit 跑快检）');
}
