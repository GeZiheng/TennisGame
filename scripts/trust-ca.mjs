/**
 * 把本地根证书装进当前用户的受信任根证书库。
 *
 * 只装到「当前用户」范围，不需要管理员权限，也不会影响系统的其他部分。
 * 想撤销：certmgr.msc → 受信任的根证书颁发机构 → 找到 Tennis P0 Local CA → 删除。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ca = resolve(import.meta.dirname, '../.cert/ca.pem');

if (!existsSync(ca)) {
  console.error('还没生成根证书，先运行：npm run cert');
  process.exit(1);
}

try {
  if (process.platform === 'win32') {
    execFileSync('certutil', ['-f', '-addstore', '-user', 'Root', ca], { stdio: 'inherit' });
    console.log('\n已加入「当前用户 → 受信任的根证书颁发机构」。');
    console.log('完全重启浏览器后生效（不是刷新，是关掉所有窗口再打开）。');
  } else if (process.platform === 'darwin') {
    const keychain = `${process.env.HOME}/Library/Keychains/login.keychain-db`;
    execFileSync('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, ca], {
      stdio: 'inherit',
    });
    console.log('\n已加入登录钥匙串并设为信任。重启浏览器后生效。');
  } else {
    console.log('Linux 请手动把 .cert/ca.pem 复制到 /usr/local/share/ca-certificates/ 后执行 update-ca-certificates');
  }
} catch (e) {
  console.error('安装失败：', e instanceof Error ? e.message : e);
  console.error('也可以手动双击 .cert/ca.pem →「安装证书」→ 受信任的根证书颁发机构。');
  process.exitCode = 1;
}
