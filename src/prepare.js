// 本地整理：按文件头识别真实格式、挑出无法识别的文件、生成上传队列
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 飞书「添加表情」接受的格式（上传框 accept=.jpg,.jpeg,.png,.gif,.bmp,.webp）
export function detectType(buf) {
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 2 && buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

// 扫描目录（不递归），返回可上传的图片和无法识别的文件
export function scanStickers(dir) {
  const ok = [];
  const bad = [];
  if (!fs.existsSync(dir)) return { ok, bad };
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    if (!st.isFile()) continue;
    const buf = fs.readFileSync(file);
    const type = detectType(buf);
    if (!type) { bad.push(name); continue; }
    // 用内容哈希做身份：同一张图换了文件名也不会重复导入
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    ok.push({ name, path: file, size: st.size, type, id });
  }
  return { ok, bad };
}

// 把无法识别的文件移到 qDir，避免下次再扫到
export function quarantine(dir, names, qDir) {
  if (!names.length) return;
  fs.mkdirSync(qDir, { recursive: true });
  for (const n of names) fs.renameSync(path.join(dir, n), path.join(qDir, n));
}

// 去掉已导入的、按文件从小到大排（越大越可能撞到飞书的大小限制，放最后），可选截取前 limit 张
export function buildQueue(items, uploadedIds, limit) {
  const seen = new Set();
  const q = items
    .filter(it => !uploadedIds.has(it.id) && !seen.has(it.id) && seen.add(it.id))
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  return Number.isInteger(limit) && limit > 0 ? q.slice(0, limit) : q;
}
