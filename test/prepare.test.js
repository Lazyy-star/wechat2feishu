import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectType, scanStickers, quarantine, buildQueue } from '../src/prepare.js';
import { loadState, saveState } from '../src/state.js';

const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const ENCRYPTED = Buffer.from([0x71, 0x7d, 0xfb, 0x22, 0x8f, 0xdb, 0x24, 0xca]); // 真实遇到的加密文件开头

test('detectType 按文件头识别格式，加密文件返回 null', () => {
  assert.equal(detectType(GIF), 'gif');
  assert.equal(detectType(PNG), 'png');
  assert.equal(detectType(JPG), 'jpg');
  assert.equal(detectType(WEBP), 'webp');
  assert.equal(detectType(ENCRYPTED), null);
  assert.equal(detectType(Buffer.alloc(0)), null);
});

test('scanStickers 跳过子目录、分出无法识别的文件；quarantine 把它们移走', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2f-'));
  fs.writeFileSync(path.join(dir, 'a.gif'), GIF);
  fs.writeFileSync(path.join(dir, 'b.jpg'), PNG);          // 扩展名不对也按真实格式认
  fs.writeFileSync(path.join(dir, 'c.jpg'), ENCRYPTED);
  fs.mkdirSync(path.join(dir, '导出信息'));
  const { ok, bad } = scanStickers(dir);
  assert.deepEqual(ok.map(o => [o.name, o.type]).sort(), [['a.gif', 'gif'], ['b.jpg', 'png']]);
  assert.deepEqual(bad, ['c.jpg']);
  const q = path.join(dir, 'q');
  quarantine(dir, bad, q);
  assert.ok(fs.existsSync(path.join(q, 'c.jpg')));
  assert.ok(!fs.existsSync(path.join(dir, 'c.jpg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildQueue 去掉已导入和重复内容，按大小升序，支持 limit', () => {
  const items = [
    { name: 'big', size: 300, id: 'x' },
    { name: 'small', size: 100, id: 'y' },
    { name: 'done', size: 50, id: 'z' },
    { name: 'dup', size: 200, id: 'y' },                     // 与 small 内容相同
    { name: 'mid', size: 200, id: 'w' },
  ];
  assert.deepEqual(buildQueue(items, new Set(['z'])).map(i => i.name), ['small', 'mid', 'big']);
  assert.deepEqual(buildQueue(items, new Set(['z']), 2).map(i => i.name), ['small', 'mid']);
});

test('state 读写往返；文件不存在或损坏时返回空进度', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2f-'));
  const f = path.join(dir, 'sub', 'state.json');
  assert.deepEqual(loadState(f), { uploaded: [], batches: [] });
  saveState(f, { uploaded: ['a'], batches: [{ files: 1, added: 1 }] });
  assert.deepEqual(loadState(f), { uploaded: ['a'], batches: [{ files: 1, added: 1 }] });
  fs.writeFileSync(f, '{broken');
  assert.deepEqual(loadState(f), { uploaded: [], batches: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});
