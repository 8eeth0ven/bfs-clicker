// urlshape.js — URL 形状归一（端点模板聚类）+ JS 端点提取
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// 借鉴: katana -fsu (URL-shape dedup) / -jc (js-crawl) 思路, 本仓自研实现
// 默认关闭: config.urlShapeDedup / config.jsEndpointHarvest 未设 = 零行为变化

// ── URL 形状: 把 ID 型 path 段替换占位符 → /users/123 与 /users/456 同形 ──
const ID_PATTERNS = [
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '{uuid}'],
  [/^\d+$/, '{n}'],                       // 纯数字
  [/^[0-9a-f]{16,}$/i, '{hex}'],          // 长 hex（哈希类）
  [/^[A-Za-z0-9_-]{22}$/, '{b64ish}'],    // firebase/pushid 形态
  [/^[A-Za-z0-9+/_=-]{28,}={0,2}$/, '{b64}'], // base64 blob
];
const NUMERIC_TAIL = /[._-]\d{1,4}$|^\d{1,4}$/; // file.1 / item-2 / 3 短序号

function segmentShape(seg) {
  for (const [re, sub] of ID_PATTERNS) if (re.test(seg)) return sub;
  if (NUMERIC_TAIL.test(seg)) return seg.replace(/[._-]?\d{1,4}$/, ''); // 保词干去尾号
  return seg;
}

function urlShape(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    const segs = x.pathname.replace(/\/+$/, '').split('/').map(segmentShape);
    const qs = [...x.searchParams.keys()].sort(); // 形状层 query 只留参数名
    return x.origin + segs.join('/') + (qs.length ? '?' + qs.join('&') : '');
  } catch { return u; }
}

// ── JS 文本端点提取（静态分析，katana -jc 同源思路）──
const EP_RE = /["'`](\/(api|v[1-9]|rest|graphql|gql|service|gateway)\/[A-Za-z0-9_\-./{}$]{2,80})["'`]/g;
const EP_RE2 = /["'`](\/[A-Za-z][A-Za-z0-9_\-]{1,30}(?:\/[A-Za-z0-9_\-.$:{}]{1,40}){0,5})["'`]/g;
const NOISE = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|mp4|map)(\?|$)/i;
const NOISE_SEG = /^(api|v[0-9]|rest|graphql|gql|service|gateway|static|assets?|public|dist|_next|static|cdn|i?img|fonts?|icons?|css|js)$/i;
const NON_PATH = /\.(js|css|png|jpe?g|svg|woff2?|ico)(\b|$)/i;

function extractEndpoints(jsText) {
  const out = new Set();
  for (const re of [EP_RE, EP_RE2]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(jsText)) !== null) {
      const ep = m[1].replace(/\/+$/, '');
      if (ep.length < 4 || ep.length > 90) continue;
      if (NOISE.test(ep)) continue;
      const segs = ep.split('/').filter(Boolean);
      if (segs.length > 6) continue;
      if (segs.length > 1 && segs.filter(s => NOISE_SEG.test(s)).length === segs.length) continue; // 多段全前缀词=噪声；单段保留(graphql/gql 类即端点)
      if (segs.length > 1 && !/\/[a-zA-Z]/.test(ep)) continue;
      out.add(ep);
      if (out.size >= 500) return [...out]; // 上限防巨型 bundle 卡死
    }
  }
  return [...out];
}

// ── 抓包面对齐的 API/路由表面（与 extractEndpoints 分开，旧 500 上限不变）──
// 多收：绝对 URL、query、JSON 转义斜杠、同一模板配 "id" 字段展开的具体同类项。
const API_HINT = /\/(?:api|graphql|gql|rest|services?|gateway|rpc|v\d+)(?:\/|$|\?)/i;
const SURFACE_STATIC = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|map)$/i;
const SURFACE_EXPLICIT_CAP = 3000;
const SURFACE_ID_CAP = 40;
const SURFACE_TPL_CAP = 30;

export function isApiPath(p) {
  return API_HINT.test(String(p || ''));
}

function unwrapSurface(text) {
  return String(text || '').replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
}

function isRouteLike(norm) {
  if (/^https?:\/\//i.test(norm)) {
    try {
      const u = new URL(norm);
      return isRouteLike(u.pathname + u.search);
    } catch { return false; }
  }
  if (!norm.startsWith('/') || norm === '/') return false;
  return /[A-Za-z]/.test(norm);
}

/** 归一成清单条目：同源只留 path+search，跨源留完整 href。模板（含 ${} {id} :id）返回 null。 */
function canonicalSurface(raw, base) {
  let s = String(raw || '').trim().replace(/[)\]}.,;]+$/, '');
  if (!s || s.length > 300) return null;
  if (s.includes('${') || s.includes('{') || /\/:[A-Za-z_]/.test(s)) return null;
  const protoRel = s.startsWith('//');
  let u;
  try { u = new URL(protoRel ? `https:${s}` : s, base || 'http://surface.invalid/'); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (SURFACE_STATIC.test(u.pathname)) return null;
  u.hash = '';
  let baseHost = '';
  try { if (base) baseHost = new URL(base).host; } catch { /* 无基址则跨源一律留全链 */ }
  if (baseHost === 'surface.invalid') baseHost = '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const rel = (path === '/' ? '/' : path) + u.search;
  if (rel.length < 2 || rel.length > 240) return null;
  const absolute = protoRel || /^https?:\/\//i.test(s);
  if (!absolute) return s.startsWith('/') ? rel : null;
  if (baseHost && u.host === baseHost) return rel;
  return u.origin + rel;
}

function rememberSurface(norm, apis, routes) {
  if (!norm || apis.has(norm) || routes.has(norm)) return false;
  if (isApiPath(norm)) { apis.add(norm); return true; }
  if (isRouteLike(norm)) { routes.add(norm); return true; }
  return false;
}

/**
 * 从 JS/JSON/HTML 文本收 API 与可导航路由。
 * 返回 { apis, routes, all }。显式 URL 上限 3000；每个模板最多展开 40 个 "id"。
 */
export function extractApiSurface(text, base) {
  const src = unwrapSurface(text);
  const apis = new Set();
  const routes = new Set();
  let explicit = 0;
  const put = (norm) => {
    if (explicit >= SURFACE_EXPLICIT_CAP) return;
    if (rememberSurface(norm, apis, routes)) explicit++;
  };
  const ABS_RE = /https?:\/\/[^\s"'`<>\\]{4,300}/g;
  const PATH_RE = /["'`](\/[A-Za-z0-9_$.:@%~-][A-Za-z0-9_$.:@%~/-]{0,160}(?:\?[A-Za-z0-9_$.:@%&=~+-]{0,120})?)["'`]/g;
  let m;
  while ((m = ABS_RE.exec(src)) !== null) {
    if (explicit >= SURFACE_EXPLICIT_CAP) break;
    put(canonicalSurface(m[0], base));
  }
  while ((m = PATH_RE.exec(src)) !== null) {
    if (explicit >= SURFACE_EXPLICIT_CAP) break;
    put(canonicalSurface(m[1], base));
  }

  const ids = [];
  const seenId = new Set();
  const ID_RE = /["']id["']\s*:\s*(?:"([^"\\]{1,40})"|'([^'\\]{1,40})'|(-?\d{1,16}))/g;
  while ((m = ID_RE.exec(src)) !== null && ids.length < SURFACE_ID_CAP) {
    const id = m[1] || m[2] || m[3];
    if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || seenId.has(id)) continue;
    seenId.add(id);
    ids.push(id);
  }
  const tpls = [];
  const seenTpl = new Set();
  const addTpl = (p) => {
    if (!p || tpls.length >= SURFACE_TPL_CAP) return;
    const n = String(p)
      .replace(/\$\{[^}]+\}/g, '{id}')
      .replace(/\{[A-Za-z0-9_]+\}/g, '{id}')
      .replace(/\/:[A-Za-z_][A-Za-z0-9_]*/g, '/{id}')
      .replace(/\/+$/, '');
    if (!n.includes('{id}') || seenTpl.has(n) || SURFACE_STATIC.test(n.split('?')[0])) return;
    if (!/[A-Za-z]{2,}/.test(n)) return;
    seenTpl.add(n);
    tpls.push(n);
  };
  const TPL_RE = /["'`](\/[A-Za-z0-9_${}/:?.=-]{3,160})["'`]/g;
  while ((m = TPL_RE.exec(src)) !== null && tpls.length < SURFACE_TPL_CAP) {
    const p = m[1];
    if (p.includes('${') || p.includes('{') || /\/:[A-Za-z_]/.test(p)) addTpl(p);
  }
  const CONCAT_RE = /["'`](\/[A-Za-z0-9_\-./]{1,100})["'`]\s*\+\s*[A-Za-z_$][\w$]*(?:\s*\+\s*["'`](\/?[A-Za-z0-9_\-./]{0,80})["'`])?/g;
  while ((m = CONCAT_RE.exec(src)) !== null && tpls.length < SURFACE_TPL_CAP) {
    if (!/[A-Za-z]{2,}/.test(m[1])) continue;
    const pre = m[1].endsWith('/') ? m[1] : `${m[1]}/`;
    const suf = m[2] || '';
    addTpl(pre + '{id}' + (suf === '' || suf.startsWith('/') ? suf : `/${suf}`));
  }
  for (const tpl of tpls) {
    rememberSurface(tpl, apis, routes);
    for (const id of ids) rememberSurface(tpl.split('{id}').join(id), apis, routes);
  }
  return { apis: [...apis], routes: [...routes], all: [...apis, ...routes] };
}

export { urlShape, segmentShape, extractEndpoints };

/** 端点清单落盘。空集不写。checkpoint 与收尾共用，强杀时不丢已扫到的端点。 */
export function writeEndpointList(dir, endpoints) {
  const list = [...(endpoints || [])].map(String).filter(Boolean).sort();
  if (!list.length) return null;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'js_endpoints.txt');
  writeFileSync(file, list.join('\n') + '\n');
  return file;
}

/**
 * 发现回灌本批该尝试的 URL。cap 按尝试次数计（失败也占预算），避免只在开爬前注入一批。
 * pending 按传入顺序取前 n 条；cap<=0 或已达上限返回空。
 */
export function discoveryBatch(pending, attempted, opts = {}) {
  const cap = Number(opts.cap ?? 40);
  const batch = Number(opts.batch ?? 8);
  const maxStates = opts.maxStates ?? Infinity;
  const stateCount = opts.stateCount ?? 0;
  if (!pending || !pending.length) return [];
  if (stateCount >= maxStates) return [];
  if (!(cap > 0) || attempted >= cap) return [];
  const n = Math.min(batch, cap - attempted);
  if (!(n > 0)) return [];
  return pending.slice(0, n);
}

// ── [seedfiles] robots.txt / sitemap.xml 路由收割（katana -kf 同源思路）──
// 输入 origin，返回 { robots: [...], sitemap: [...] } 中的同源路径；失败返回空（不阻塞主流程）
export async function harvestSeedFiles(origin, fetchImpl = fetch) {
  const sameOriginPaths = (xmlUrl, text, tag) => {
    const out = new Set();
    try {
      const base = new URL(origin);
      if (tag === 'robots') {
        for (const line of text.split('\n')) {
          const m = line.match(/^\s*(?:allow|disallow|sitemap)\s*:\s*(\S+)/i);
          if (!m) continue;
          let u = m[1];
          if (u.startsWith('http')) { try { u = new URL(u).pathname; } catch { continue; } }
          if (u.includes('*') || u.includes('$')) u = u.replace(/[*$].*$/, '');
          if (u && u !== '/' && u.startsWith('/')) out.add(u.replace(/\/+$/, ''));
        }
      } else {
        for (const m of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          try {
            const x = new URL(m[1]);
            if (x.host === base.host && !/\.(jpe?g|png|gif|svg|pdf|mp4)$/i.test(x.pathname)) {
              out.add(x.pathname.replace(/\/+$/, ''));
            }
          } catch { /* 非 URL 行跳过 */ }
        }
      }
    } catch { /* 解析失败静默 */ }
    return [...out];
  };
  const result = { robots: [], sitemap: [] };
  const grab = async (path, tag, ct) => {
    try {
      const r = await fetchImpl(origin + path, { redirect: 'follow' });
      if (!r.ok) return;
      const text = await r.text();
      if (tag === 'sitemap' && !/<(urlset|sitemapindex)/i.test(text.slice(0, 400))) return;
      result[tag] = sameOriginPaths(origin + path, text, tag).slice(0, 300); // 上限防巨型 sitemap
    } catch { /* 网络失败静默 */ }
  };
  await Promise.all([grab('/robots.txt', 'robots'), grab('/sitemap.xml', 'sitemap')]);
  return result;
}

// ── [pagesim] 轻量 simhash：64 位指纹 + 海明距离（日历/分页陷阱近重复页判定）──
// 文本规范化：剥 script/style/数字/空白 → 分词 shingles → 64 位 FNV 加权合并
function fnv1a(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    h1 ^= str.charCodeAt(i);
    h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + str.charCodeAt(i) * (i + 7)) >>> 0;
  }
  return (BigInt(h1 >>> 0) << 32n) | BigInt(h2 >>> 0);
}

export function simhash64(text) {
  const clean = String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\d+/g, ' ')            // 数字全剥：日历/分页/时间戳差异消失
    .toLowerCase();
  const tokens = clean.split(/\s+/).filter(w => w.length > 2);
  if (!tokens.length) return 0n;
  const v = new Array(64).fill(0);
  const shingles = tokens.length > 3
    ? tokens.map((_, i) => tokens.slice(i, i + 3).join(' ')).slice(0, -2)
    : tokens;
  for (const sh of shingles) {
    const h = fnv1a(sh);
    for (let b = 0; b < 64; b++) {
      if ((h >> BigInt(b)) & 1n) v[b] += 1; else v[b] -= 1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= (1n << BigInt(b));
  return out;
}

export function hamming(a, b) {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

export class PageSim {
  constructor(threshold = 6) { this.threshold = threshold; this.prints = []; }
  /** true=与已见页近重复（应跳过）；false=新页（登记指纹） */
  isDup(text) {
    const p = simhash64(text);
    for (const q of this.prints) {
      if (hamming(p, q) <= this.threshold) return true;
    }
    this.prints.push(p);
    if (this.prints.length > 500) this.prints.splice(0, 100); // 滚动窗防无限增长
    return false;
  }
}

// ── [hrefseed] HTML 被动 href 收割（katana/gau link-parse 语义；流量体已有=零额外请求）──
const HREF_RE = /href\s*=\s*["']([^"'#\s]{2,300})["']/gi;
const ASSET_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|map)(\?|$)/i;

export function extractHrefs(htmlText, origin) {
  const out = new Set();
  try {
    const base = new URL(origin);
    let m;
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(String(htmlText))) !== null) {
      let u;
      try { u = new URL(m[1], base); } catch { continue; }
      if (u.host !== base.host) continue;               // 同源
      if (ASSET_EXT.test(u.pathname)) continue;          // 资产扩展名
      const p = u.pathname.replace(/\/+$/, '') + (u.search || '');
      if (p.length < 2 || p.length > 200) continue;
      out.add(p);
      if (out.size >= 300) break;                        // 单页上限
    }
  } catch { /* 解析失败静默 */ }
  return [...out];
}
