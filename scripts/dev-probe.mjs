// 开发用（飞书改版后排查页面结构）：连到 9333 端口的调试浏览器，执行一段探测代码并打印结果。
// 先启动一个独立的调试 Edge 并在里面登录飞书：
//   msedge --user-data-dir=<某个目录> --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 https://www.feishu.cn/messenger/
// 用法：
//   node scripts/dev-probe.mjs <probe-file.mjs>
// probe 文件默认导出 async (page) => any。调试端口能控制这个浏览器，用完记得关掉它
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('feishu.cn')) || ctx.pages()[0];
const mod = await import(pathToFileURL(path.resolve(process.argv[2])).href);
try {
  const out = await mod.default(page);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
} catch (e) {
  console.error('PROBE ERROR:', e && e.stack || e);
} finally {
  // 不调用 browser.close()：直接退出进程只会断开 CDP 连接，用户的浏览器窗口和页面保持原样
  process.exit(0);
}
