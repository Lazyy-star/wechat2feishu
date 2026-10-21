// 飞书侧：只通过飞书网页版的官方界面操作，不调用任何内部接口
// 流程：打开「与自己的会话」→ 表情面板 → 「添加的单个表情」→ 点「+」→ 系统文件选择框多选
// 安全约束：只会点 头像 / 个人名片 / 名片里的「消息」/ 表情按钮 / 面板 tab / 「+」，
//          绝不点表情格子（点了会直接发送），也不往输入框打字
import { chromium } from 'playwright-core';

const MESSENGER = 'https://www.feishu.cn/messenger/';
const SEL = {
  avatar: '.navHeader_avatar',       // 左上角自己的头像（外层 span，里面的 img 点不到）
  toolbarBtn: '.lark__editor--toolbar .ud__button',
  placeholder: '.editor__custom--placeholder-content',
  panel: '.emoji.lark__editor--new',
  panelTab: '.emoji.lark__editor--new .scroller-item button',
  addBtn: '.emoji.lark__editor--new .customized-sticker-item.add-sticker-btn',
  scroller: '.emoji.lark__editor--new .scroller.ud__scrollArea',
};

export async function launch({ profileDir, channel }) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel,                       // 用电脑上已装的 Edge / Chrome，不额外下载浏览器
    headless: false,
    viewport: { width: 1360, height: 820 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

// 打开飞书并等用户扫码登录（已登录过会直接通过）
export async function waitLogin(page, log, timeoutMs = 300000) {
  await page.goto(MESSENGER, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let hinted = false;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.locator(SEL.avatar).first().isVisible().catch(() => false)) return;
    // 已登录时页面加载也要几秒，过一会儿还没好再提示扫码
    if (!hinted && Date.now() - t0 > 8000) { log('   请在弹出的浏览器窗口里用飞书 App 扫码登录（只需第一次）……'); hinted = true; }
    await page.waitForTimeout(2000);
  }
  throw new Error('等待飞书登录超时（5 分钟）');
}

async function tooltipText(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('[class*=tooltip],[role=tooltip]')]
      .filter(e => e.getBoundingClientRect().width > 0 && (e.innerText || '').trim()).pop();
    return el ? el.innerText.trim() : null;
  });
}

async function isSelfChat(page) {
  const t = await page.locator(SEL.placeholder).first().innerText({ timeout: 1500 }).catch(() => '');
  return t.includes('自己');
}

// 头像 → 我的个人名片 → 消息，打开与自己的会话。失败时把截图存到 debugShot 方便排查
export async function openSelfChat(page, log, debugShot) {
  if (await isSelfChat(page)) return;
  await page.locator(SEL.avatar).first().click();
  await page.getByText('我的个人名片', { exact: true }).click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  const pos = await page.evaluate(() => {
    // 名片里的「消息」是一条宽按钮；左侧导航栏也有个「消息」，要排除掉
    const els = [...document.querySelectorAll('*')].filter(e => (e.innerText || '').trim() === '消息' && getComputedStyle(e).cursor === 'pointer' && !e.closest('[class*=navbar],[class*=Navbar]'));
    const r = els.map(e => e.getBoundingClientRect()).filter(r => r.width > 100).sort((a, b) => b.left - a.left)[0];
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  if (pos) await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(2500);
  if (await isSelfChat(page)) return;
  if (debugShot) await page.screenshot({ path: debugShot }).catch(() => {});
  // 兜底：让用户自己点开（比如输入框里有草稿、界面不是中文时）
  log('   没能自动打开「与自己的会话」。请在浏览器里手动点开它，并清空输入框……');
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (await isSelfChat(page)) return;
    await page.waitForTimeout(2000);
  }
  throw new Error('3 分钟内没有进入「与自己的会话」。为避免把表情误发给别人，已停止');
}

export class StickerPanel {
  constructor(page) { this.page = page; this.emojiIdx = null; this.favIdx = null; }

  async findEmojiButton() {
    if (this.emojiIdx != null) return this.page.locator(SEL.toolbarBtn).nth(this.emojiIdx);
    const btns = this.page.locator(SEL.toolbarBtn);
    const n = await btns.count();
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible())) continue;
      await b.hover(); await this.page.waitForTimeout(500);
      if ((await tooltipText(this.page)) === '表情') { this.emojiIdx = i; return b; }
    }
    throw new Error('没找到输入框上的「表情」按钮（飞书界面可能改版了）');
  }

  // 确保面板打开并停在「添加的单个表情」页
  async openFav() {
    const page = this.page;
    if (!(await isSelfChat(page))) throw new Error('当前不在「与自己的会话」，已停止');
    if (await page.locator(SEL.addBtn).first().isVisible().catch(() => false)) return;
    if (!(await page.locator(SEL.panel).first().isVisible().catch(() => false))) {
      await (await this.findEmojiButton()).click();
      await page.locator(SEL.panel).first().waitFor({ state: 'visible', timeout: 5000 });
    }
    const tabs = page.locator(SEL.panelTab);
    if (this.favIdx == null) {
      const n = await tabs.count();
      for (let i = 0; i < n; i++) {
        await tabs.nth(i).hover(); await page.waitForTimeout(500);
        if (((await tooltipText(page)) || '').includes('添加的单个表情')) { this.favIdx = i; break; }
      }
      if (this.favIdx == null) throw new Error('表情面板里没找到「添加的单个表情」（飞书界面可能改版了）');
    }
    await tabs.nth(this.favIdx).click();
    await page.locator(SEL.addBtn).first().waitFor({ state: 'visible', timeout: 5000 });
  }

  // 当前「添加的单个表情」张数。面板是虚拟列表，只渲染可见的几行：
  // 每行是绝对定位的 .sticker-item-section（translateY 等间距），滚到底读最后一行的位置和格子数即可精确算出
  async count() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.openFav();
      const n = await this.page.evaluate(async (sel) => {
        const sc = document.querySelector(sel.scroller);
        if (!sc) return null;
        const rowY = s => { const m = /translate\(\s*[-\d.]+px,\s*([-\d.]+)px\)/.exec(s.getAttribute('style') || ''); return m ? Number(m[1]) : null; };
        const rows = () => [...sc.querySelectorAll('.sticker-item-section')].map(s => ({ y: rowY(s), n: s.querySelectorAll('.customized-sticker-item').length })).filter(r => r.y != null).sort((a, b) => a.y - b.y);
        const top = rows();
        if (!top.length) return null;
        const perRow = top[0].n;                                   // 第一行一定是满的（含「+」）
        const step = top.length > 1 ? top[1].y - top[0].y : 0;
        sc.scrollTop = sc.scrollHeight; await new Promise(r => setTimeout(r, 600));
        const last = rows().pop();
        sc.scrollTop = 0;
        const idx = step ? Math.round(last.y / step) : 0;
        return idx * perRow + last.n - 2;                         // 减去「+」和「−」两个按钮
      }, SEL);
      if (Number.isInteger(n) && n >= 0) return n;
      await this.page.keyboard.press('Escape'); await this.page.waitForTimeout(800);
    }
    throw new Error('数不出当前表情张数（飞书界面可能改版了）');
  }

  // 点「+」，在系统文件选择框里一次选中 files
  async upload(files) {
    await this.openFav();
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 10000 }),
      this.page.locator(SEL.addBtn).first().click(),
    ]);
    await chooser.setFiles(files);
  }

  // 等张数到 target；超时或连续 20 秒不变就返回当前值
  async waitForCount(target, timeoutMs = 120000) {
    const t0 = Date.now();
    let n = await this.count(), last = n, since = Date.now();
    while (n < target && Date.now() - t0 < timeoutMs) {
      await this.page.waitForTimeout(4000);
      n = await this.count();
      if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since > 20000) break;
    }
    return n;
  }
}

// 记录页面上新出现的提示条（toast），用来发现「已达上限」「上传失败」之类的提示
export async function watchToasts(page) {
  await page.evaluate(() => {
    if (window.__w2fToasts) return;
    window.__w2fToasts = [];
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const c = (n.className || '').toString();
        if (/toast|Toast|notice|Notice/.test(c)) {
          const t = (n.innerText || '').trim();
          if (t) window.__w2fToasts.push(t.slice(0, 200));
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

export async function takeToasts(page) {
  return page.evaluate(() => { const t = window.__w2fToasts || []; window.__w2fToasts = []; return t; });
}
