// 流量瘦身工具：对已生成的 traffic.jsonl 全量重去重（用 traffic.js 的归一化 URL + size + status + body 指纹键），
// 覆盖写回 traffic.jsonl（可选保留备份），并按需重新生成精简 traffic.har。
// 适用场景：爬虫用旧去重策略跑过后，历史条目里混着大量 "同一接口带 ?t=时间戳" 的冗余。
// 用法: node scripts/dedup-traffic.mjs [--out traffic.dedup.jsonl] [--har] [--keep-backup]
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { trafficNormalizeQuery, hashPostData } from '../src/traffic.js';
import { buildHarFromTraffic } from '../src/har.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const config = loadConfig('crawl');
const srcFile = argv.includes('--in') ? argv[argv.indexOf('--in') + 1] : path.join(config.outputDir, 'traffic.jsonl');
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const doHar = argv.includes('--har');
const keepBackup = argv.includes('--keep-backup');
if (argv.includes('--out') && !outFile) { console.error('--out 需要路径'); process.exit(2); }

if (!existsSync(srcFile)) { console.error(`找不到 ${srcFile}`); process.exit(1); }

const stripParams = config.trafficStripQueryParams;
const keepParams = config.trafficKeepQueryParams || [];

const lines = readFileSync(srcFile, 'utf8').trim().split('\n').filter(Boolean);
if (!lines.length) { console.log('输入 0 条，不改写'); process.exit(0); }
const seen = new Set();
const out = [];
let duped = 0, bad = 0;
for (const l of lines) {
  let e;
  try { e = JSON.parse(l); } catch { bad++; continue; }
  const normUrl = trafficNormalizeQuery(e.url, { stripParams, keepParams });
  const bh = hashPostData(e.postData);
  const size = e.respBytes ?? e.contentLength ?? 0;
  const key = `${e.method}|${normUrl}|${size}|${e.status ?? 0}|${bh}|${e.responseDigest || ''}`;
  if (seen.has(key)) { duped++; continue; }
  seen.add(key);
  if (!e.normUrl) e.normUrl = normUrl; // 老条目补上归一化 URL 字段，便于核对
  out.push(e);
}
console.log(`输入 ${lines.length} 条 → 输出 ${out.length} 条（去重 ${duped} 条，坏行 ${bad} 条），削减 ${((1 - out.length / lines.length) * 100).toFixed(1)}%`);

const dest = outFile || srcFile;
if (!outFile && keepBackup) { renameSync(srcFile, srcFile + '.bak'); console.log(`原文件备份: ${srcFile}.bak`); }
writeFileSync(dest, out.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`${outFile ? '已写出' : '已写回'} ${dest}（${(out.length / 1000).toFixed(1)}k 条）`);

if (doHar) {
  const harFile = path.join(config.outputDir, config.harPath || 'traffic.har');
  const n = await buildHarFromTraffic(dest, harFile);
  console.log(`已重新生成精简 HAR: ${harFile}（${n} 条）`);
}
