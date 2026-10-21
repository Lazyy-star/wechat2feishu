// 微信侧：调用第三方工具 wxemoticon 导出「收藏的表情」
// - 不随仓库分发 wxemoticon，运行时从作者的 GitHub Release 下载固定版本并校验 SHA256
// - wxemoticon 只读微信进程内存拿数据库密钥；密钥文件用完立即删除
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WXEMOTICON = {
  repo: 'liusheng22/export-wechat-emoji',
  version: 'v0.3.0',
  asset: 'wxemoticon-x86_64-windows.zip',
  sha256: 'ceb10c0b2052716cc493e5446d3cb59d1b3090d2b64014ad6ddc7b3b28a033d0',
};

// 用 Windows 自带的 curl / tar，避免被 Git Bash 等环境里的同名程序替换
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const CURL = path.join(SYS32, 'curl.exe');
const TAR = path.join(SYS32, 'tar.exe');

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n');
    throw new Error(`${path.basename(cmd)} 运行失败（退出码 ${r.status}）\n${msg}`);
  }
  return r.stdout || '';
}

// 确保 vendor/ 下有校验通过的 wxemoticon.exe，返回其路径
export function ensureWxemoticon(vendorDir, log) {
  const { repo, version, asset, sha256 } = WXEMOTICON;
  const zip = path.join(vendorDir, asset);
  fs.mkdirSync(vendorDir, { recursive: true });
  if (!fs.existsSync(zip) || sha256File(zip) !== sha256) {
    const url = `https://github.com/${repo}/releases/download/${version}/${asset}`;
    log(`   下载 wxemoticon ${version}：${url}`);
    const r = spawnSync(CURL, ['-fsSL', '--retry', '4', '--retry-all-errors', '--retry-delay', '3', '--ssl-no-revoke', '-o', zip, url], { stdio: 'inherit' });
    if (r.status !== 0 || !fs.existsSync(zip)) {
      throw new Error(`下载 wxemoticon 失败。可以手动下载 ${url}\n放到 ${vendorDir} 后重新运行（如需代理，先设置 HTTPS_PROXY 环境变量）`);
    }
  }
  const actual = sha256File(zip);
  if (actual !== sha256) {
    fs.rmSync(zip, { force: true });
    throw new Error(`wxemoticon 安装包校验失败（SHA256 不一致），已删除。\n期望 ${sha256}\n实际 ${actual}`);
  }
  // 每次都从校验过的 zip 重新解压，保证用的就是作者原版
  run(TAR, ['-xf', zip, '-C', vendorDir]);
  const exe = path.join(vendorDir, 'wxemoticon.exe');
  if (!fs.existsSync(exe)) throw new Error(`解压后没找到 ${exe}`);
  return exe;
}

export function isWechatRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return (r.stdout || '').includes('"Weixin.exe"');
}

// 删除 wxemoticon 留下的数据库密钥（它能解密微信数据库，不能留在磁盘上）
export function deleteKeyFiles(keyFile) {
  fs.rmSync(keyFile, { force: true });
  const cache = path.join(process.env.LOCALAPPDATA || '', 'wxemoticon');
  if (!fs.existsSync(cache)) return;
  for (const f of fs.readdirSync(cache)) {
    if (/^emoticon_dbkey/.test(f)) fs.rmSync(path.join(cache, f), { force: true });
  }
}

export function listAccounts(exe) {
  return run(exe, ['urls', '--list-accounts', '--no-interactive'])
    .split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]+$/.test(s));
}

// 导出收藏表情到 outDir（已存在的跳过），返回 wxemoticon 的统计
export function exportStickers({ exe, wxid, outDir, workDir, log }) {
  if (!isWechatRunning()) {
    // 微信没开时 wxemoticon 会自己拉起再强制结束一个微信进程——我们不让它这么做
    throw new Error('没有检测到正在运行的微信（Weixin.exe）。请先打开微信电脑版并登录，再重新运行');
  }
  const accounts = listAccounts(exe);
  const id = wxid || (accounts.length === 1 ? accounts[0] : null);
  if (!id) {
    throw new Error(accounts.length
      ? `检测到多个微信账号，请用 --wxid 指定其中一个：\n  ${accounts.join('\n  ')}`
      : '没找到微信数据目录（默认在 %USERPROFILE%\\xwechat_files）');
  }
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const keyFile = path.join(workDir, 'emoticon_dbkey.txt');
  const urlsFile = path.join(workDir, 'emoticon_urls.txt');
  log('   读取微信表情数据库（只读，不会改动微信）……');
  try {
    run(exe, ['urls', '--wxid', id, '--no-interactive', '--timeout', '120', '--key-file', keyFile, '--out', urlsFile, '--log', path.join(workDir, 'urls.log')]);
  } finally {
    deleteKeyFiles(keyFile);
  }
  log('   从微信服务器下载表情原图……');
  const out = run(exe, ['export', '--urls-file', urlsFile, '--out-dir', outDir, '--flat', '--skip-existing', '--no-interactive', '--json']);
  const line = out.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop();
  return line ? JSON.parse(line) : { total: 0, ok: 0, skipped: 0, failed: 0 };
}
