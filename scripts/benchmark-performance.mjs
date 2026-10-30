// Local browser benchmark. Both implementations receive the same URLs, defaults
// and budgets; speed is accepted only if state and observed API coverage match.
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { baseline: { type: 'string' }, repeats: { type: 'string', default: '3' }, output: { type: 'string' }, suite: { type: 'string', default: 'tree,chain,delayed' } }, strict: true });
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be 1..20');
const suites = values.suite.split(',');
if (suites.some(v => !['tree', 'chain', 'delayed'].includes(v))) throw new Error('--suite must contain tree,chain,delayed');
const output = path.resolve(values.output || path.join(root, 'output-performance', String(Date.now())));
mkdirSync(output, { recursive: true, mode: 0o700 });
const implementations = { optimized: (await import('../src/runner.js')).runAsset };
if (values.baseline) implementations.baseline = (await import(pathToFileURL(path.resolve(values.baseline)))).runAsset;
let requests = [];
const html = (title, body, script, api) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head><body><h1>${title}</h1>${body}<script>fetch(${JSON.stringify(api)});${script || ''}</script></body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost'); requests.push(url.pathname);
  let body, type = 'text/html; charset=utf-8';
  const parts = url.pathname.split('/').filter(Boolean), [suite, kind, index] = parts;
  if (suite === 'api') { type = 'application/json'; body = '{"ok":true}'; }
  else if (suite === 'tree') {
    const links = !kind ? [1, 2, 3].map(n => `<a href="/tree/group/${n}">进入分组 ${n}</a>`).join('')
      : kind === 'group' ? `<a href="/tree/detail/${index}">查看详情 ${index}</a>` : '<a href="/tree/">返回首页</a>';
    body = html('树 ' + (kind || '入口') + ' ' + (index || ''), links, '', '/api' + url.pathname);
  } else if (suite === 'chain') {
    const depth = Number(kind || 0);
    body = html('层 ' + depth, depth < 6 ? `<a href="/chain/${depth + 1}">进入层 ${depth + 1}</a>` : '<p>末层</p>', '', '/api/chain/' + depth);
  } else if (suite === 'delayed') {
    body = kind === 'detail' ? html('详情', '<p>详情内容</p>', '', '/api/delayed/detail')
      : html('延迟展开', '<button id="open">展开详情</button><div id="slot"></div>', `document.querySelector('#open').onclick=()=>setTimeout(()=>{document.querySelector('#slot').innerHTML='<a href="/delayed/detail">查看详情</a>'},120);`, '/api/delayed/root');
  } else { res.writeHead(404, { 'content-length': 0 }); res.end(); return; }
  res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body) }); res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const sourceDigest = dir => Object.fromEntries(readdirSync(dir).filter(n => n.endsWith('.js')).sort().map(name =>
  [name, createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex')]));
const result = { environment: { date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length,
  playwright: JSON.parse(readFileSync(path.join(root, 'node_modules/playwright/package.json'))).version, baselineModule: values.baseline || null, repeats,
  sourceDigests: { optimized: sourceDigest(path.join(root, 'src')), ...(values.baseline ? { baseline: sourceDigest(path.dirname(path.resolve(values.baseline))) } : {}) },
  options: 'Default screenshot PNG, requestDelayMs=50, safe profile and guards enabled for both; includes browser startup/finalize' }, runs: [], summary: [] };
const publish = () => writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
try {
  const warm = await chromium.launch({ headless: true }); result.environment.chromium = warm.version();
  const page = await warm.newPage(); await page.goto(origin + '/tree/'); await page.screenshot(); await warm.close();
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const order = Object.keys(implementations); if (repeat % 2) order.reverse();
    for (const suite of suites) for (const name of order) {
      requests = [];
      const outputDir = path.join(output, `${repeat}-${suite}-${name}`), started = performance.now();
      const meta = await implementations[name]({ startUrl: origin + '/' + suite + '/', outputDir, limitMode: 'custom', maxStates: 100, maxDepth: 10,
        maxStatesPerHost: 100, maxDurationMs: 120000, maxRequests: 2500, maxActions: 2000 }, { log() {} });
      const elapsedMs = performance.now() - started;
      const cp = JSON.parse(readFileSync(path.join(outputDir, 'private/checkpoint.json')));
      const apis = JSON.parse(readFileSync(path.join(outputDir, 'private/apis.json')));
      const graph = existsSync(path.join(outputDir, 'graph.json')) ? JSON.parse(readFileSync(path.join(outputDir, 'graph.json'))) : null;
      const events = readFileSync(path.join(outputDir, 'private/events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      const row = { repeat, suite, implementation: name, elapsedMs, states: cp.states.length, statesPerSecond: cp.states.length * 1000 / elapsedMs,
        requests: meta.counts.requests, serverRequests: requests.length, actions: meta.counts.actions,
        replays: events.filter(e => e.kind === 'action_replay').length, succeeded: cp.states.flatMap(s => s.interactives).filter(a => a.status === 'succeeded').length,
        status: meta.status, stopReason: meta.stopReason, coverage: cp.states.map(s => ({ url: new URL(s.url).pathname, fp: s.fp })).sort((a, b) => a.url.localeCompare(b.url) || a.fp.localeCompare(b.fp)),
        observedApis: apis.filter(a => a.categories.includes('observed_request') && new URL(a.url).pathname.startsWith('/api/')).map(a => new URL(a.url).pathname).sort(),
        performance: meta.performance || null,
        graph: graph ? { status: graph.run.status, nodes: graph.nodes.length, edges: graph.edges.length,
          states: graph.nodes.filter(n => n.type === 'state').length,
          observedApis: graph.nodes.filter(n => n.type === 'api' && n.responseObserved).map(n => new URL(n.url).pathname).sort() } : null };
      result.runs.push(row); publish(); console.log(JSON.stringify({ ...row, coverage: undefined }));
      if (meta.status !== 'completed') throw new Error(`${suite}/${name} did not complete: ${meta.stopReason}`);
      if (name === 'optimized' && (!meta.graph?.available || row.graph?.states !== row.states || row.graph.status !== meta.status || JSON.stringify(row.graph.observedApis) !== JSON.stringify(row.observedApis))) throw new Error(`${suite}: generated graph coverage differs from raw crawl evidence`);
    }
  }
  for (const suite of suites) {
    const selected = result.runs.filter(r => r.suite === suite), signature = row => JSON.stringify({ coverage: row.coverage, apis: row.observedApis, actions: row.succeeded });
    const coverageMatches = selected.every(r => signature(r) === signature(selected[0]));
    const mean = name => { const rows = selected.filter(r => r.implementation === name); return rows.length ? rows.reduce((n, r) => n + r.elapsedMs, 0) / rows.length : null; };
    const baselineMs = mean('baseline'), optimizedMs = mean('optimized');
    result.summary.push({ suite, coverageMatches, baselineMs, optimizedMs, speedup: baselineMs ? baselineMs / optimizedMs : null });
    if (!coverageMatches) { publish(); throw new Error(`${suite}: coverage differs across implementations/repeats`); }
  }
  publish(); console.log(JSON.stringify({ output, summary: result.summary }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
