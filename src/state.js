// 进度文件：记录已导入的图片（按内容哈希）和每批结果，用于断点续传
import fs from 'node:fs';
import path from 'node:path';

export function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { uploaded: Array.isArray(s.uploaded) ? s.uploaded : [], batches: Array.isArray(s.batches) ? s.batches : [] };
  } catch {
    return { uploaded: [], batches: [] };
  }
}

// 先写临时文件再改名，中途被打断也不会留下写了一半的进度文件
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}
