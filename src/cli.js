#!/usr/bin/env node
// wechat2feishu：把微信电脑版「收藏的表情」批量导入飞书「添加的单个表情」
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWxemoticon, exportStickers } from './wxemoticon.js';
import { scanStickers, quarantine, buildQueue } from './prepare.js';
import { loadState, saveState } from './state.js';
import { launch, waitLogin, openSelfChat, StickerPanel, watchToasts, takeToasts } from './feishu.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const log = (...a) => console.log(...a);

const HELP = `用法: npm start -- [选项]

  --limit N         本次最多导入 N 张（先小批量试用）
  --batch N         每批张数，默认 25
  --pause A-B       批间随机停顿秒数，默认 30-60
  --wxid ID         电脑上登录过多个微信时，指定账号
  --from DIR        跳过微信导出，直接导入 DIR 里的图片
  --skip-export     跳过微信导出，用上次已下载的图片
  --browser NAME    msedge（默认）或 chrome
  --dry-run         只导出和整理，不打开飞书
  -h, --help        显示帮助
`;

const { values: opt } = parseArgs({
  options: {
    limit: { type: 'string' }, batch: { type: 'string', default: '25' }, pause: { type: 'string', default: '30-60' },
    wxid: { type: 'string' }, from: { type: 'string' }, 'skip-export': { type: 'boolean' },
    browser: { type: 'string', default: 'msedge' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
if (opt.help) { log(HELP); process.exit(0); }

const limit = opt.limit ? Number(opt.limit) : undefined;
const batchSize = Number(opt.batch);
const [pMin, pMax] = opt.pause.split('-').map(Number);
if ((limit !== undefined && !(limit > 0)) || !(batchSize > 0 && batchSize <= 50) || !(pMin >= 0 && pMax >= pMin)) {
  console.error('参数不对：--limit 要是正整数，--batch 在 1-50 之间，--pause 形如 30-60\n'); log(HELP); process.exit(2);
}
if (process.platform !== 'win32') { console.error('目前只支持 Windows（微信 4.x 电脑版）'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const stickersDir = opt.from ? path.resolve(opt.from) : path.join(DATA, 'stickers');
  const stateFile = path.join(DATA, 'state.json');

  // ① 微信导出
  if (!opt.from && !opt['skip-export']) {
    log('① 从微信导出收藏的表情');
    const exe = ensureWxemoticon(path.join(ROOT, 'vendor'), log);
    const r = exportStickers({ exe, wxid: opt.wxid, outDir: stickersDir, workDir: path.join(DATA, 'work'), log });
    log(`   共 ${r.total} 张：新下载 ${r.ok}，已存在跳过 ${r.skipped}，失败 ${r.failed}`);
  }

  // ② 本地整理
  log('② 整理本地图片');
  const { ok, bad } = scanStickers(stickersDir);
  if (bad.length) {
    const q = path.join(DATA, 'unrecognized');
    quarantine(stickersDir, bad, q);
    log(`   ${bad.length} 个文件不是有效图片（通常是没解开的加密文件），已移到 ${q}`);
  }
  const state = loadState(stateFile);
  const queue = buildQueue(ok, new Set(state.uploaded), limit);
  log(`   可导入 ${ok.length} 张，之前已导入 ${state.uploaded.length} 张，本次要导入 ${queue.length} 张`);
  if (opt['dry-run'] || !queue.length) { log(queue.length ? '   --dry-run：到此为止' : '   没有需要导入的图片'); return; }

  // ③ 飞书导入
  log('③ 导入飞书');
  const { ctx, page } = await launch({ profileDir: path.join(DATA, 'browser-profile'), channel: opt.browser });
  let added = 0, sent = 0, stopReason = null;
  try {
    await waitLogin(page, log);
    await openSelfChat(page, log, path.join(DATA, 'debug-selfchat.png'));
    await watchToasts(page);
    const panel = new StickerPanel(page);
    let before = await panel.count();
    log(`   飞书里现有 ${before} 张，开始分批导入（每批 ${batchSize} 张）`);
    for (let i = 0; i < queue.length; i += batchSize) {
      const batch = queue.slice(i, i + batchSize);
      await panel.upload(batch.map(b => b.path));
      const after = await panel.waitForCount(before + batch.length);
      const delta = after - before;
      const toasts = await takeToasts(page);
      sent += batch.length;
      state.batches.push({ at: new Date().toISOString(), files: batch.length, added: delta, toasts });
      if (delta > 0) {
        // 少于本批张数时多半是飞书把重复图片去掉了，没法知道是哪一张，整批都算处理过
        state.uploaded.push(...batch.map(b => b.id));
        added += delta;
      }
      saveState(stateFile, state);
      log(`   第 ${i / batchSize + 1} 批：选了 ${batch.length} 张，飞书新增 ${delta} 张（累计 ${after}）${delta < batch.length ? ' ⚠ 少了，可能是重复图片被飞书去重' : ''}`);
      if (toasts.length) log(`   飞书提示：${toasts.join(' | ')}`);
      if (delta <= 0) { stopReason = '这一批一张都没加上（可能到了飞书的数量上限，或上传失败）'; break; }
      if (toasts.some(t => /上限|失败|超过|不支持|错误|频繁/.test(t))) { stopReason = `飞书提示：${toasts.join(' | ')}`; break; }
      before = after;
      if (i + batchSize < queue.length) await sleep((pMin + Math.random() * (pMax - pMin)) * 1000);
    }
  } finally {
    await ctx.close();
  }
  log(`\n完成：本次选了 ${sent} 张，飞书新增 ${added} 张。进度已保存，重新运行会从断点继续。`);
  if (stopReason) { log(`已提前停止：${stopReason}`); process.exitCode = 1; }
}

main().catch(e => { console.error(`\n出错了：${e.message}`); process.exit(1); });
