// 表单/下拉自助。只在 config.formExplore 时被调用；关掉时点击路径与以前一样。

const SENSITIVE = /支付|购买|充值|银行卡|身份证|密码|password|cvv|销毁|退款/;

export function isSearchField(el) {
  const h = `${el.htmlType || ''} ${el.label || ''} ${el.placeholder || ''}`.toLowerCase();
  return el.htmlType === 'search' || /搜索|search/.test(h);
}

export function isDropdownTrigger(el) {
  const s = `${el.role || ''} ${el.selector || ''} ${el.fallbackSelector || ''}`;
  return el.role === 'combobox' || el.role === 'listbox'
    || /tea-dropdown|tea-select|ant-select-selector/.test(s);
}

export function isFormAction(el) {
  const t = `${el.label || ''} ${el.text || ''}`;
  return /立即体验|免费体验|立即使用|免费使用|立即领取|开始使用|创建|新建|提交|保存|下一步|申请/.test(t);
}

// 填不了（密码/支付/搜索）返回 null，调用方不要输入。
export function fillValueFor(el, config) {
  const hint = `${el.htmlType || ''} ${el.label || ''} ${el.placeholder || ''}`.toLowerCase();
  if (SENSITIVE.test(hint) || el.htmlType === 'password') return null;
  if (isSearchField(el)) return null;
  if (/mail|邮箱/.test(hint) || el.htmlType === 'email') return 'user@example.com';
  if (/手机|电话|tel|phone/.test(hint) || el.htmlType === 'tel') return '13800138000';
  if (el.htmlType === 'number' || /数量|端口/.test(hint)) return '1';
  if (/url|网址|域名/.test(hint) || el.htmlType === 'url') return 'example.com';
  return config.fillTextValue || 'test';
}

// Playwright locators pierce open shadow roots, but matches/closest do not cross the
// host boundary. Walk getRootNode().host so bulk helpers honor excluded ancestors
// exactly like discovery and checkLiveAction. A failed evaluation counts as excluded.
const crossHostExcluded = (locator, selectors = []) => locator.evaluate((el, sels) => {
  let cur = el;
  while (cur) {
    if (sels.some(s => { try { return cur.matches(s) || cur.closest(s); } catch { return false; } })) return true;
    cur = cur.getRootNode()?.host || null;
  }
  return false;
}, selectors).catch(() => true);

export async function pickOpenOption(page, log, config = {}) {
  const loc = page.locator('[role="option"], .tea-list__item, .ant-select-item-option');
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 30); i++) {
    const item = loc.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = ((await item.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (!text || /请选择|加载中/.test(text)) continue;
    if (SENSITIVE.test(text)) continue;
    if (await crossHostExcluded(item, config.excludeSelectors)) continue;
    if (config._policy && !config._policy.action({ label: text, role: 'option', selector: '[role="option"]' }).allow) continue;
    try {
      // Prefer a real, actionability-checked click; force is only the fallback.
      try { await item.click({ timeout: 4000 }); }
      catch { await item.click({ force: true, timeout: 4000 }); }
      log(`  [下拉] 选中「${text.slice(0, 40)}」`);
      return true;
    } catch { /* 下一个选项 */ }
  }
  return false;
}

export async function prepareForm(page, config, log) {
  const fields = page.locator('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="url"], input:not([type]), textarea');
  const n = await fields.count().catch(() => 0);
  let filled = 0;
  for (let i = 0; i < Math.min(n, 12); i++) {
    const loc = fields.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (await crossHostExcluded(loc, config.excludeSelectors)) continue;
    const meta = await loc.evaluate((el) => ({
      type: (el.type || '').toLowerCase(),
      ph: el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      aria: el.getAttribute('aria-label') || '',
      val: el.value || '',
    })).catch(() => null);
    if (!meta || meta.val) continue;
    // Same live-policy standard as checkLiveAction: an excluded or write-looking
    // field is never filled, even when it sits inside an open shadow host.
    if (config._policy && !config._policy.action({ type: 'text', htmlType: meta.type, label: meta.aria || meta.name, placeholder: meta.ph, aria: meta.aria, selector: '' }).allow) continue;
    const el = { htmlType: meta.type, label: meta.aria || meta.name, placeholder: meta.ph };
    // Explicit test data wins over heuristics, matching the fillText click path.
    let v = null;
    if (config.formValues) {
      const matched = await loc.evaluate((node, selectors) => selectors.find(s => { try { return node.matches(s); } catch { return false; } }),
        Object.keys(config.formValues)).catch(() => null);
      if (matched) v = config.formValues[matched];
    }
    if (!v) v = fillValueFor(el, config);
    if (!v) continue;
    try { await loc.fill(v); filled++; } catch { /* 这个框填不了就跳过 */ }
  }
  const selects = page.locator('select');
  const ns = await selects.count().catch(() => 0);
  for (let i = 0; i < Math.min(ns, 8); i++) {
    const loc = selects.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (await crossHostExcluded(loc, config.excludeSelectors)) continue;
    if (config._policy && !config._policy.action({ type: 'select', label: '', selector: '' }).allow) continue;
    if ((await loc.locator('option').count().catch(() => 0)) > 1) {
      try { await loc.selectOption({ index: 1 }); } catch { /* 保持原样 */ }
    }
  }
  if (filled) log(`  [表单] 已填 ${filled} 个空字段`);
}
