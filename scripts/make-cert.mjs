/**
 * 生成本地根证书（CA）+ 由它签发的服务器证书。
 *
 * 为什么不能只用一张自签名证书：浏览器只认「信任链」，一张没有签发者的证书
 * 永远显示红锁，手机上还会每次弹警告。做法和 mkcert 一样——自己当一个 CA，
 * 把 CA 装进系统的受信任根证书里，之后它签发的一切都是绿的。
 *
 *   .cert/ca.pem        根证书，装到电脑和手机上，只装一次
 *   .cert/ca-key.pem    根证书私钥，绝不外传（也绝不装到任何设备上）
 *   .cert/dev-cert.pem  服务器证书，SAN 里写满局域网 IP
 *   .cert/dev-key.pem   服务器私钥
 *
 * 局域网 IP 变了会自动重签服务器证书；CA 本身不动，所以不用重新在手机上装。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import selfsigned from 'selfsigned';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, '.cert');
const paths = {
  caCert: resolve(dir, 'ca.pem'),
  caKey: resolve(dir, 'ca-key.pem'),
  leafCert: resolve(dir, 'dev-cert.pem'),
  leafKey: resolve(dir, 'dev-key.pem'),
  meta: resolve(dir, 'meta.json'),
};

const CA_DAYS = 3650;
const LEAF_DAYS = 397; // 浏览器对服务器证书有效期的上限，超了直接拒
const MAX_LEAF_AGE = 300;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!list) continue;
    if (/loopback|vmware|virtualbox|vethernet|docker|wsl|tailscale|utun|tap/i.test(name)) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      out.push(info.address);
    }
  }
  const score = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
  return out.sort((a, b) => score(a) - score(b));
}

function readMeta() {
  try {
    return JSON.parse(readFileSync(paths.meta, 'utf8'));
  } catch {
    return {};
  }
}

function ageDays(p) {
  try {
    return (Date.now() - statSync(p).mtimeMs) / 86400000;
  } catch {
    return Infinity;
  }
}

mkdirSync(dir, { recursive: true });
const meta = readMeta();
const ips = lanAddresses();
const fingerprint = [...ips].sort().join(',');

/* ---------- 1. 根证书：没有、或者快过期了就重建 ---------- */

let caFresh = existsSync(paths.caCert) && existsSync(paths.caKey) && ageDays(paths.caCert) < CA_DAYS - 30;

if (!caFresh) {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Tennis P0 Local CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + CA_DAYS * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0 },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    ],
  });
  writeFileSync(paths.caKey, pems.private);
  writeFileSync(paths.caCert, pems.cert);
  console.log('已生成本地根证书（.cert/ca.pem）');

  // 换了 CA，旧服务器证书就失效了，必须重签
  for (const p of [paths.leafCert, paths.leafKey]) if (existsSync(p)) unlinkSync(p);
}

/* ---------- 2. 服务器证书：IP 变了或过期了就重签 ---------- */

const leafStale =
  !existsSync(paths.leafCert) ||
  !existsSync(paths.leafKey) ||
  meta.ips !== fingerprint ||
  ageDays(paths.leafCert) > MAX_LEAF_AGE;

if (leafStale) {
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'tennis-p0-dev' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + LEAF_DAYS * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
    ca: { key: readFileSync(paths.caKey, 'utf8'), cert: readFileSync(paths.caCert, 'utf8') },
  });

  writeFileSync(paths.leafKey, pems.private);
  writeFileSync(paths.leafCert, pems.cert);
  writeFileSync(paths.meta, JSON.stringify({ ips: fingerprint, createdAt: new Date().toISOString() }, null, 2));
  console.log(`已用本地 CA 签发服务器证书，包含 IP：${ips.join(', ') || '（没找到局域网 IP）'}`);
} else {
  console.log(`服务器证书仍然有效（IP 未变：${ips.join(', ') || '无'}）`);
}

console.log('');
console.log('电脑上装一次根证书（之后所有浏览器都是绿锁）：');
console.log('  npm run trust');
console.log('');
console.log('手机上装一次根证书：');
console.log('  1. 手机浏览器打开 https://<电脑IP>:5174/ca.crt 下载');
console.log('  2. iOS：设置 → 已下载描述文件 → 安装；再到 设置 → 通用 → 关于本机 →');
console.log('     证书信任设置 → 打开对「Tennis P0 Local CA」的完全信任');
console.log('     Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书');
console.log('');
for (const ip of ips) console.log(`  手机访问 → https://${ip}:5174/`);
