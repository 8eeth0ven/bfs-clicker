// cdpnet.js — 请求记账（与 logout 原生块共用 Network.enable，不启用 Fetch）
// requestWillBeSent 是浏览器推送，无逐请求 Node 往返，避免 ctx.route 的 goto 挂死。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STATIC_EXT = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|map|bmp)$/i;
const DROP_TYPES = new Set(['image', 'font', 'media', 'stylesheet', 'texttrack', 'manifest']);

/** 记账过滤：丢掉 data/blob、静态扩展名、图片/字体/媒体/样式。 */
export function interestingRequest(method, url, type) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return false;
  const t = String(type || '').toLowerCase();
  if (DROP_TYPES.has(t)) return false;
  try {
    if (STATIC_EXT.test(new URL(u).pathname)) return false;
  } catch { return false; }
  return true;
}

/** `METHOD url`，去掉 hash，便于和抓包条目对齐。 */
export function apiLine(method, url) {
  const m = method || 'GET';
  return `${m} ${canonUrl(url)}`;
}

function canonUrl(url) {
  try {
    const x = new URL(url);
    x.hash = '';
    return x.href;
  } catch {
    return String(url || '').split('#')[0];
  }
}

function cell(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ');
}

/** 查询串键值。空值保留键。同一键的每个值都留。 */
export function queryPairs(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const out = [];
  for (const [k, v] of u.searchParams) {
    if (k === '') continue;
    out.push([k, v]);
  }
  return out;
}

function scalar(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}

/** 请求体键值。只认 JSON 对象和表单。读不懂就不编造键。 */
export function bodyPairs(postData, contentType) {
  if (postData == null || postData === '') return [];
  const raw = String(postData);
  const ct = String(contentType || '').toLowerCase();
  const asJson = () => {
    try {
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      return Object.entries(v).filter(([k]) => k !== '').map(([k, val]) => [k, scalar(val)]);
    } catch { return null; }
  };
  const asForm = () => {
    if (raw.startsWith('--') || /content-disposition/i.test(raw.slice(0, 240))) return null;
    const params = new URLSearchParams(raw);
    const out = [];
    for (const [k, v] of params) {
      if (k === '') continue;
      out.push([k, v]);
    }
    return out.length ? out : null;
  };
  if (ct.includes('json') || (!ct && raw.trim().startsWith('{'))) {
    const parsed = asJson();
    if (parsed) return parsed;
  }
  if (ct.includes('application/x-www-form-urlencoded') || (!ct && raw.includes('='))) {
    const parsed = asForm();
    if (parsed) return parsed;
  }
  return [];
}

export function createApiLedger(saved = []) {
  const records = new Map();
  for (const rec of saved) {
    const restored = { ...rec, samples: rec.samples || [], categories: rec.categories || [], query: new Map(Object.entries(rec.query || {}).map(([k,v]) => [k,new Set(v)])), body: new Map(Object.entries(rec.body || {}).map(([k,v]) => [k,new Set(v)])) };
    records.set(`${rec.method} ${rec.url}`, restored);
  }
  return {
    records,
    get size() { return records.size; },
  };
}

function sourceKey(src) {
  if (!src) return '';
  if (src.kind === 'document') return `document\t${src.document || ''}`;
  return `page\t${src.page || ''}\t${src.control || ''}`;
}

function addSource(rec, src) {
  if (!src || !src.kind) return;
  let page = src.page || '';
  if (page.startsWith('about:')) page = '';
  if (src.kind === 'document') {
    if (!src.document) return;
  } else if (!page && !src.control) return;
  const norm = src.kind === 'document'
    ? { kind: 'document', document: src.document }
    : { kind: 'page', page, control: src.control || '' };
  const k = sourceKey(norm);
  if (rec.sources.some((s) => sourceKey(s) === k)) return;
  rec.sources.push(norm);
}

function addPairs(map, pairs) {
  for (const [k, v] of pairs) {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(v);
  }
}

/**
 * 方法加 URL 合并成一条。后来的来源和键值补进去，不覆盖已有的。
 * 正文来源只补查询串，不把调用方塞进来的请求体写成参数。
 */
export function observeApi(ledger, info) {
  if (!ledger || !ledger.records || !info) return null;
  const method = info.method || 'GET';
  const url = info.url || '';
  if (!interestingRequest(method, url, info.type || '')) return null;
  const href = canonUrl(url);
  const key = `${method} ${href}`;
  let rec = ledger.records.get(key);
  if (!rec) {
    rec = { method, url: href, sources: [], query: new Map(), body: new Map(), samples: [], categories: [] };
    ledger.records.set(key, rec);
  }
  addSource(rec, info.source);
  addPairs(rec.query, queryPairs(href));
  const fromDoc = info.source && info.source.kind === 'document';
  const category = info.category || (fromDoc ? 'static_candidate' : 'observed_request');
  if (!rec.categories.includes(category)) rec.categories.push(category);
  if (info.evidenceId || info.status != null || info.responseDigest || info.postData != null) {
    // Keep the originating action on the sample: ledger sources merge across actions,
    // so the per-request actionId is the only direct link back to the click path.
    const sample = { evidenceId: info.evidenceId || null, actionId: info.source?.actionId ?? null, stateId:info.source?.stateId??null,executionId:info.source?.executionId??null,method, url: info.url, query: queryPairs(info.url), postData: fromDoc ? null : info.postData ?? null,
      status: info.status ?? null, responseDigest: info.responseDigest || null, authEpoch: info.authEpoch ?? 0, operation: info.operation || null, category };
    if (rec.samples.length < (info.maxSamples || 20)) rec.samples.push(sample);
    else rec.samplesTruncated = (rec.samplesTruncated || 0) + 1;
  }
  if (!fromDoc && info.postData != null && info.postData !== '') {
    addPairs(rec.body, bodyPairs(info.postData, info.contentType));
  }
  return rec;
}

export function ledgerView(ledger) {
  const list = [...((ledger && ledger.records && ledger.records.values()) || [])];
  list.sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));
  return list.map((rec) => ({
    method: rec.method,
    url: rec.url,
    sources: rec.sources.map((s) => ({ ...s })),
    query: Object.fromEntries([...rec.query].map(([k, set]) => [k, [...set].sort()])),
    body: Object.fromEntries([...rec.body].map(([k, set]) => [k, [...set].sort()])),
    categories: rec.categories || [], samples: rec.samples || [], samplesTruncated: rec.samplesTruncated || 0,
  }));
}

function formatRecord(rec) {
  const head = `${rec.method} ${rec.url}\n`;
  const extras = [];
  const sources = [...rec.sources].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
  for (const s of sources) {
    if (s.kind === 'document') extras.push(`source\tdocument\t${cell(s.document)}\n`);
    else extras.push(`source\tpage\t${cell(s.page)}\t${cell(s.control)}\n`);
  }
  const dump = (kind, map) => {
    for (const k of [...map.keys()].sort()) {
      for (const v of [...map.get(k)].sort()) extras.push(`param\t${kind}\t${cell(k)}\t${cell(v)}\n`);
    }
  };
  dump('query', rec.query);
  dump('body', rec.body);
  if (!extras.length) return head;
  return head + extras.join('') + '\n';
}

/**
 * 在已经 Network.enable 的 CDP 会话上听 requestWillBeSent。
 * 查询串和请求体只用这条事件里已经带上的字段。不取响应体，不打开拦截域。
 * onLine(line, url, method, type, detail)
 */
export function bindCdpApiLedger(cdp, onLine) {
  if (!cdp || typeof cdp.on !== 'function') return;
  cdp.on('Network.requestWillBeSent', (ev) => {
    try {
      const req = (ev && ev.request) || {};
      const url = req.url || '';
      const method = req.method || 'GET';
      const type = (ev && ev.type) || '';
      if (!interestingRequest(method, url, type)) return;
      const headers = req.headers || {};
      let postData = req.postData;
      if ((postData == null || postData === '') && Array.isArray(req.postDataEntries) && req.postDataEntries.length) {
        postData = req.postDataEntries.map((e) => {
          if (!e || e.bytes == null) return '';
          try { return Buffer.from(e.bytes, 'base64').toString('utf8'); } catch { return ''; }
        }).join('');
      }
      onLine(apiLine(method, url), url, method, type, {
        postData,
        contentType: headers['Content-Type'] || headers['content-type'] || '',
        documentURL: (ev && ev.documentURL) || '',
      });
    } catch { /* 单条失败不拆会话 */ }
  });
}

/** 请求账本落盘。字符串列表仍是一行一个方法加 URL。带记录的账本写来源和键值。空的不写。 */
export function writeApiRoutes(dir, linesOrLedger) {
  const file = path.join(dir, 'api_routes.txt');
  if (linesOrLedger && linesOrLedger.records instanceof Map) {
    const records = [...linesOrLedger.records.values()];
    if (!records.length) return null;
    records.sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, records.map(formatRecord).join(''));
    return file;
  }
  const list = [...(linesOrLedger || [])].map(String).filter(Boolean).sort();
  if (!list.length) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, list.join('\n') + '\n');
  return file;
}
