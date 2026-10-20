// 流量去重记录器（Playwright 原生捕获，无需 Burp/代理）
// 去重键 = method + 归一化URL + 响应大小 + status + POST body 指纹
//   - 归一化URL：剥掉 noise 参数（t/_/random/sessionId/reqSeqId 等时间戳与随机数），
//     query 参数排序 → 同一接口（带 ?t= 时间戳）的每次调用不再被当成不同条目
//   - 响应大小：有 Content-Length 头 → 用它做快速去重（命中则不读 body，省内存）
//     无 Content-Length（chunked）→ 读 body 用实际字节数作为大小键
//   - status 进键：同 URL 同大小但状态不同（200/401/403）不会误合并
//   - POST body 指纹：同 URL 同大小但 POST body 不同（不同 Action 参数）不会被误合并
// 记录范围 = 爬虫看到的全部响应（含静态资源，同样去重），可选 include/exclude/excludeHost 过滤。
// 每条存完整请求/响应包：请求头、postData、响应头、响应体（文本 utf8 / 二进制 base64，超上限截断）。
// 输出 output/traffic.jsonl（每行一条 JSON，追加写，内存只留去重键 → 长时间跑不爆内存）。

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 默认噪声参数：时间戳/随机数/会话ID/遥测字段等。全部小写，匹配时忽略大小写。
// 若某项被误伤（如 token 想在键里保留），可用 trafficKeepQueryParams 白名单覆盖。
const DEFAULT_STRIP_PARAMS = [
  't', '_', '_t', '_dc', 'random', 'rand', 'rnd', 'nonce', 'timestamp', 'ts',
  'sessionid', 'reqseqid', 'seqid', 'seq', 'expvalue', 'expkey', 'fst', 'contextkey',
  'guid', 'callback', 'traceid', 'requestid', 'uuid',
  'visitid', 'landingpage', 'pagetitle', '_ga', 'fromsource', 'lastlogintype',
  'ul', 'vp', 'sr', 'nettype', '_pn', 'lifeid', 'originfrom', 'tag_exp', 'rcb', 'tiba',
  'dnslookup', 'tcp', 'ssl', 'ttfb', 'contentdownload', 'domparse', 'resourcedownload', 'firstscreentiming',
  'aid', 'gtm', 'ext1', 'e', 'mc_gtk', 'attaid',
  'u_w', 'u_h', 'uab', 'uafvl', 'uamb', 'uap', 'uapv', 'uaw', 'uaa',
];

// 归一化 URL：剥掉噪声参数、排序剩余参数，得到稳定的去重 URL。
// - stripParams: 剥掉的参数名（小写集合）；keepParams: 白名单，命中则即使在被剥列表也保留
// 请求体指纹：两个不同种子的 32 位 FNV-1a 组合 ≈ 64 位，防同 URL 同大小但 body 不同被误合并
export function hashPostData(s) {
  if (!s) return '';
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 ^ str.charCodeAt(i), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

export function trafficNormalizeQuery(url, { stripParams = DEFAULT_STRIP_PARAMS, keepParams = [] } = {}) {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const base = url.slice(0, q);
  const strip = new Set((stripParams || []).map((s) => String(s).toLowerCase()));
  const keep = new Set((keepParams || []).map((s) => String(s).toLowerCase()));
  const kept = [];
  for (const pair of url.slice(q + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const kl = k.toLowerCase();
    if (!keep.has(kl) && strip.has(kl)) continue;
    kept.push(pair);
  }
  if (!kept.length) return base;
  kept.sort();
  return `${base}?${kept.join('&')}`;
}

export function makeTraffic(config, log, onJsText) {
  const seen = new Set();
  const pending = new Set();
  const file = path.join(config.outputDir, 'traffic.jsonl');
  // 会话标记：每行注入 session_id = 启动时间戳 + 目标 host（跨会话共享/追加写同一
  // traffic.jsonl 时混流问题（NOTES 2026-09-26 a target site/a target site/another session 多轮），
  // 读取端用 scripts/traffic_filter.mjs <jsonl> <session_id子串> 按字段过滤切割）
  const startHost = safe(() => new URL(config.startUrl).host) || 'nohost';
  // 与 loadConfig 的 sessionId 对齐，manifest / 启动断言 / jsonl 才能对上同一轮实验
  const sessionId = config.sessionId
    || `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}_${startHost}`;
  const maxBody = config.trafficMaxBodyBytes ?? 65536;
  const includeRe = (config.trafficIncludePattern || []).map((p) => new RegExp(p));
  const excludeRe = (config.trafficExcludeExt || []).map((p) => new RegExp(`\\.${p}(\\?|$)`, 'i'));
  const excludeHostRe = (config.trafficExcludeHost || []).map((p) => new RegExp(p));
  const stripParams = config.trafficStripQueryParams ?? DEFAULT_STRIP_PARAMS;
  const keepParams = config.trafficKeepQueryParams || [];

  // 默认全记录；配置了 include 则只记录匹配 host，excludeExt 跳过对应扩展名，excludeHost 跳过对应域名
  function shouldCapture(url) {
    // [urlshape] jsEndpointHarvest 开启时 JS 响应最先放行（跨域 CDN JS 也要收——acronis 类 0 端点根因；
    // 仅进回调聚合，仍受既有去重约束）
    if (onJsText && /\.(js|mjs)(\?|$)/i.test(url)) return true;
    if (includeRe.length && !includeRe.some((re) => re.test(url))) return false;
    if (excludeRe.some((re) => re.test(url))) return false;
    if (excludeHostRe.length) {
      try {
        const host = new URL(url).host;
        if (excludeHostRe.some((re) => re.test(host))) return false;
      } catch { /* 无效 URL → 不按 host 排除 */ }
    }
    return true;
  }

  const isText = (ct = '') =>
    /text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|application\/.*\+json/i.test(ct);

  async function onResponse(resp) {
    try {
      const req = resp.request();
      const url = req.url();
      const method = req.method();
      // record=false 仍可能要收割：.js 在排除表里不进 jsonl，但包体里的接口抓包看得到。
      // 没有收割回调时维持旧行为，排除扩展名直接丢掉。
      const record = shouldCapture(url);
      const minerPre = onJsText || config.onBodyText;
      if (!record && !minerPre) return;
      // 去重命中会直接 return、不再读 body。请求账本要在那之前记第一眼，
      // 非 chromium 没有 CDP requestWillBeSent 时靠这条补齐。排除掉的脚本不进账本。
      if (record && typeof config.onApiUrl === 'function') {
        try {
          const rt = safe(() => (typeof req.resourceType === 'function' ? req.resourceType() : ''));
          const headers = safe(() => req.headers()) || {};
          const pageUrl = safe(() => {
            const frame = typeof req.frame === 'function' ? req.frame() : null;
            return frame && typeof frame.url === 'function' ? frame.url() : '';
          });
          config.onApiUrl(method, url, rt || '', {
            postData: safe(() => req.postData()),
            contentType: headers['content-type'] || headers['Content-Type'] || '',
            source: { kind: 'page', page: pageUrl || '', control: '' },
          });
        } catch { /* 记账失败不挡存档 */ }
      }
      const headers = resp.headers();
      const cl = /^\d+$/.test(headers['content-length'] || '') ? parseInt(headers['content-length'], 10) : null;
      const status = resp.status();
      const normUrl = trafficNormalizeQuery(url, { stripParams, keepParams });
      const postData = safe(() => req.postData());
      const bh = hashPostData(postData);

      // 快速去重：同 归一化URL + Content-Length + status + body指纹 → 判定为同一响应，跳过（不读 body）
      // Response length does not identify contents; dedup only after a digest is available.

      // 存档只留 ≤ maxBody 的包。端点收割另算：业务 JS bundle 常 > 64KB，
      // 若跟存档同一上限，js_endpoints 会把大包静默丢掉（论文端点清单偏少）。
      // 收割上限 trafficHarvestMaxBytes 缺省 4MB；超过则不读，避免把误标的大媒体拉进内存。
      const ctHeader = headers['content-type'] || '';
      const harvestMax = Number(config.trafficHarvestMaxBytes ?? 4 * 1024 * 1024);
      const miner = minerPre;
      // JS 大包：有收割回调就读到 4MB。排除表只决定进不进 jsonl，不决定挖不挖包体。
      // HTML 大包仍只在 js 端点收割开启时深读，避免每个文档都拉满。
      // JSON：正文里的 next/href/id 默认深读；jsonl 仍按 maxBody 省略正文。
      const deepJs = !!(miner && (/javascript|ecmascript/i.test(ctHeader) || /\.(js|mjs)(\?|$)/i.test(url)));
      const deepHtml = !!(onJsText && (/html/i.test(ctHeader) || /\.html?(\?|$)/i.test(url)));
      const jsonHarvest = !!(miner && (/json|graphql/i.test(ctHeader) || /\.json(\?|$)/i.test(url)));
      const harvestable = deepJs || deepHtml || jsonHarvest;
      if (!record && !harvestable) return;
      if (!record && seen.has(`mine|${method}|${normUrl}`)) return;
      const readCap = harvestable ? Math.max(maxBody, harvestMax) : maxBody;
      let buf = null;
      if ((cl === null || cl <= readCap) && (cl === null || cl <= maxBody || harvestable)) {
        try { buf = await resp.body(); } catch { /* 读取失败（中断/已消费）→ 只存元数据 */ }
      }
      const actualSize = buf ? buf.length : cl;
      if (!record) {
        // 排除表里的脚本/样式：只把正文交给收割，不进 jsonl，也不占流量去重键。
        const mineKey = `mine|${method}|${normUrl}`;
        if (buf && miner && !seen.has(mineKey)) {
          seen.add(mineKey);
          try {
            const slice = buf.length > harvestMax ? buf.subarray(0, harvestMax) : buf;
            miner(normUrl, slice.toString('utf8'), ctHeader);
          } catch { /* 提取失败静默 */ }
        }
        return;
      }
      if (actualSize === null) return; // 既无 CL 也读不到 body，无法确定大小 → 跳过
      const key = `${method}|${normUrl}|${actualSize}|${status}|${bh}`;
      const responseDigest = buf ? createHash('sha256').update(buf).digest('hex') : null;
      const contentKey = responseDigest ? `${key}|${responseDigest}` : null;
      if (contentKey && seen.has(contentKey)) return;

      const text = isText(ctHeader);
      // 超过存档上限的大包：读过只为收割，jsonl 仍不落正文
      const storeBody = !!(buf && buf.length <= maxBody);
      let body;
      let bodyTruncated = false;
      if (storeBody) {
        body = text ? buf.toString('utf8') : buf.toString('base64');
      }
      const mineable = !!(miner && buf && (harvestable
        || /javascript|ecmascript|html|json|graphql/i.test(ctHeader)
        || /\.(js|mjs|html?|json)(\?|$)/i.test(url)));
      if (mineable) {
        try {
          const slice = buf.length > harvestMax ? buf.subarray(0, harvestMax) : buf;
          miner(normUrl, slice.toString('utf8'), ctHeader);
        } catch { /* 提取失败静默 */ }
      }
      const entry = {
        ts: Date.now(),
        session_id: sessionId,           // 会话标记（读取端按此字段切割/过滤跨会话混流）
        method,
        url,                             // 保留原始 URL（HAR/人工分析用原始参数）
        normUrl,                         // 去重用的归一化 URL（便于核对去重逻辑）
        status,
        contentType: ctHeader || null,
        contentLength: cl,               // 原始 Content-Length（无则为 null）
        respBytes: actualSize,           // 去重用的大小键
        reqHeaders: req.headers(),
        postData,
        respHeaders: headers,
        body,
        bodyEncoding: storeBody ? (text ? 'utf8' : 'base64') : undefined,
        bodyTruncated,
        bodyOmitted: !storeBody,        // 超存档上限或读不到 → 只存元数据（收割仍可能已读过大包）
        responseDigest,
      };
      appendFileSync(file, JSON.stringify(entry) + '\n');
      if (contentKey) seen.add(contentKey);
    } catch (e) {
      log && log(`  [traffic] 记录失败: ${String(e.message || e).slice(0, 80)}`);
    }
  }

  function safe(fn) {
    try { return fn(); } catch { return null; }
  }

  return {
    attach(ctx) { log && log(`[traffic] session_id=${sessionId}`); ctx.on('response', resp => { const task=onResponse(resp); pending.add(task); task.finally(()=>pending.delete(task)); return task; }); },
    async drain() { await Promise.allSettled([...pending]); },
    get stats() { return { entries: seen.size, file }; },
  };
}

export function ensureTrafficDir(config) {
  mkdirSync(config.outputDir, { recursive: true });
}
