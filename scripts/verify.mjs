/**
 * 迭代验证流水线：把「改完必跑三件事」固化成一条命令。
 *
 *   node scripts/verify.mjs            # 全套：test ×3 → sim → build
 *   node scripts/verify.mjs --fast     # 快检：test ×1 → build（pre-commit 用）
 *
 * 步骤一律通过 `npm run <script>` 调用，命令定义只存在于 package.json，
 * 这里只定义顺序、重复次数与失败语义，避免两份真相漂移。
 * 任一步失败立即停止，并以非零码退出。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FAST = process.argv.includes('--fast');
const WIN = process.platform === 'win32';

// Windows 上 npm 是 npm.cmd，必须经 shell 才能拉起；参数用数组传，不拼字符串。
const NPM = WIN ? 'npm.cmd' : 'npm';
const RUN = { cwd: ROOT, stdio: 'inherit', shell: WIN };

function run(label, script, times = 1) {
  for (let i = 1; i <= times; i++) {
    const tag = times > 1 ? ` (${i}/${times})` : '';
    console.log(`\n── ${label}${tag} ──`);
    const r = spawnSync(NPM, ['run', script], RUN);
    if (r.error) {
      console.error(`无法启动 ${NPM}：${r.error.message}`);
      return false;
    }
    if (r.status !== 0) {
      console.error(`\n✗ ${label}${tag} 失败（exit ${r.status}）`);
      return false;
    }
  }
  return true;
}

function probeHints() {
  const files = new Set();
  for (const args of [['diff', '--name-only', 'HEAD'], ['diff', '--cached', '--name-only']]) {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.error || r.status !== 0 || !r.stdout) continue;
    for (const f of r.stdout.trim().split('\n')) if (f.trim()) files.add(f.trim());
  }
  const list = [...files];
  const hits = (...keys) => list.some((f) => keys.some((k) => f.includes(k)));
  const hints = [];
  if (hits('physics', 'court', 'feed')) {
    hints.push('  涉及喂球 / 弹道 → node scripts/probe-feed.cjs、node scripts/probe-feed-scan2.cjs');
  }
  if (hits('racket', 'swing', 'rally')) {
    hints.push('  涉及挥拍 / 判定 → node scripts/probe-swing.cjs、node scripts/probe-geom.cjs');
  }
  return hints;
}

const steps = FAST
  ? [['npm test', 'test', 1], ['npm run build', 'build', 1]]
  : [
      ['npm test', 'test', 3],
      ['npm run sim', 'sim', 1],
      ['npm run duel-sim', 'duel-sim', 1],
      ['npm run build', 'build', 1],
    ];

console.log(FAST ? '验证 · 快检（test ×1 → build）' : '验证 · 全套（test ×3 → sim → duel-sim → build）');

for (const [label, script, times] of steps) {
  if (!run(label, script, times)) {
    console.error('\n验证未通过。修复后重跑，不要为了变绿而放宽断言。');
    process.exit(1);
  }
}

console.log('\n✓ 验证通过');

if (!FAST) {
  // sim 刚跑完，.tmp-sim 的编译产物已就绪，probe 现在可以直接 require。
  console.log('\nprobe 提示（.tmp-sim 产物已就绪，可直接跑）：');
  const hints = probeHints();
  if (hints.length) {
    for (const h of hints) console.log(h);
  } else {
    console.log('  未检测到 core 改动；按改动类型自行选择。');
  }
  console.log('  完整清单见 AGENTS.md 第 3 节（probe 依赖 .tmp-sim，必须排在 sim 之后）。');
}
