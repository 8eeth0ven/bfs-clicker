import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";
let server, browser, origin, currentGraph, requests = [];
const graph = () => ({
  schemaVersion: 1,
  run: { asset: 'https://console.example.test/', status: 'partial' },
  nodes: [
    { id: 's1', type: 'state', label: '控制台首页', stateId: 1, url: 'https://console.example.test/', status: 'observed', observed: true, confidence: 'observed', evidenceIds: ['ev:state:1'] },
    { id: 's2', type: 'state', label: '订单列表', stateId: 2, url: 'https://console.example.test/orders', status: 'pending', observed: true, confidence: 'observed', evidenceIds: ['ev:state:2'] },
    { id: 'a1', type: 'action', label: '查看订单', stateId: 1, actionId: 'hash-one', status: 'succeeded', observed: true, confidence: 'observed', evidenceIds: ['ev:action:1'] },
    { id: 'a2', type: 'action', label: '查询订单记录', stateId: 2, actionId: 'hash-two', status: 'succeeded', observed: true, confidence: 'observed', evidenceIds: ['ev:action:2'] },
    { id: 'api1', type: 'api', label: 'GET /api/orders', method: 'GET', url: 'https://console.example.test/api/orders', status: 'observed', observed: true, responseObserved: true, confidence: 'observed', evidenceIds: ['ev:response:1'] },
    { id: 'api2', type: 'api', label: 'GET /api/overview', method: 'GET', url: 'https://console.example.test/api/overview', status: 'observed', observed: true, responseObserved: true, confidence: 'observed', evidenceIds: ['ev:response:2'] },
    { id: 'source1', type: 'route', label: '页面后台请求', url: 'https://console.example.test/orders', status: 'request_source', observed: true, confidence: 'context', background: true },
    { id: 'script1', type: 'script', label: 'orders.js', url: 'https://console.example.test/assets/orders.js', status: 'context', observed: false, executionObserved: true, confidence: 'context', functions: [{ functionName: 'prepareOrders', url: 'https://console.example.test/assets/orders.js', lineNumber: 4, columnNumber: 0 }] },
    { id: 'candidate1', type: 'route', label: '待验证的报表入口', url: 'https://console.example.test/reports', status: 'candidate', observed: false, confidence: 'static' },
    { id: 'failed1', type: 'action', label: '未能打开帮助页', stateId: 1, status: 'failed', observed: true, confidence: 'observed' },
    { id: 'blocked1', type: 'api', label: 'POST /api/blocked', method: 'POST', url: 'https://console.example.test/api/blocked', status: 'blocked', observed: false, requestObserved: true, responseObserved: false, confidence: 'context' },
  ],
  edges: [
    { id: 'e1', source: 's1', target: 'a1', type: 'action', observed: true, confidence: 'observed', label: '执行操作', evidenceIds: ['ev:action:1'] },
    { id: 'e2', source: 'a1', target: 's2', type: 'transition', observed: true, confidence: 'observed', label: '进入列表' },
    { id: 'e3', source: 's2', target: 'a2', type: 'action', observed: true, confidence: 'observed', label: '执行查询' },
    { id: 'e4', source: 'a2', target: 'api1', type: 'request', observed: true, confidence: 'context', label: '请求发生时的操作', evidenceIds: ['ev:response:1'] },
    { id: 'e5', source: 'a1', target: 'api2', type: 'request', observed: true, confidence: 'observed', label: '已记录请求' },
    { id: 'e6', source: 'source1', target: 'api1', type: 'request', observed: true, confidence: 'context', label: '后台请求来源' },
    { id: 'e7', source: 'script1', target: 'api1', type: 'initiates', observed: false, confidence: 'context', label: '脚本发起记录', callFrames: [{ functionName: 'loadOrders', url: 'https://console.example.test/assets/orders.js', lineNumber: 23, columnNumber: 7 }], evidenceIds: ['ev:initiator:1'] },
    { id: 'unproven-context', source: 'script1', target: 'api2', type: 'initiates', observed: false, confidence: 'context', label: '没有独立证据的上下文', evidenceIds: [] },
    { id: 'e8', source: 's1', target: 'candidate1', type: 'candidate', observed: false, confidence: 'static', label: '静态入口线索' },
    { id: 'e9', source: 's1', target: 'failed1', type: 'action', observed: false, confidence: 'context' },
    { id: 'e10', source: 'a2', target: 'blocked1', type: 'request', observed: true, confidence: 'context', responseObserved: false },
    { id: 'broken', source: 's1', target: 'missing', type: 'transition', observed: true, confidence: 'observed' },
  ],
  flows: [{ stateId: 1, url: 'https://console.example.test/', steps: [], complete: true }, { stateId: 2, url: 'https://console.example.test/orders', steps: [{ stateId: 1, actionId: 'a1', label: '查看订单', kind: 'click' }], complete: true }],
  coverage: { status: 'partial', stopReason: 'max_actions', pending: { actions: 3, seeds: 1 }, gaps: [{ reason: 'closed_shadow_roots_unsupported' }], limits: { maxStates: 50, maxDepth: 3, maxActions: 500 } },
});
before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    const name = req.url.split('/').at(-1)?.split('?')[0];
    res.setHeader('content-security-policy', CSP); res.setHeader('x-content-type-options', 'nosniff');
    if (name === 'graph.json') { const body = JSON.stringify(currentGraph); res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }); res.end(body); }
    else if (['graph.html', 'graph.css', 'graph.js'].includes(name)) { const types = { html: 'text/html', css: 'text/css', js: 'text/javascript' }; res.writeHead(200, { 'content-type': types[name.split('.').at(-1)] + '; charset=utf-8' }); res.end(readFileSync(path.join(root, 'view', name))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function view(t, data = graph(), viewport = { width: 1440, height: 1120 }) {
  currentGraph = data; requests = [];
  const context = await browser.newContext({ viewport }); const page = await context.newPage();
  t.after(() => context.close());
  const external = [], errors = []; page.on('request', req => { if (!req.url().startsWith(origin)) external.push(req.url()); }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/run/graph.html'); await page.waitForFunction(() => document.querySelector('#state-count').textContent !== '—');
  return { page, external, errors };
}

test('graph viewer switches modes, filters candidates/failures, searches and shows known paths', async t => {
  const { page, external, errors } = await view(t);
  assert.equal(await page.locator('#state-count').textContent(), '2'); assert.equal(await page.locator('#api-count').textContent(), '2'); assert.equal(await page.locator('#pending-count').textContent(), '4');
  assert.match(await page.locator('#scope-note').textContent(), /不等于全站/);
  assert.equal(await page.locator('[data-node-id="api1"]').count(), 0);
  assert.equal(await page.locator('[data-node-id="candidate1"]').count(), 0);
  await page.locator('[data-node-id="s2"]').click();
  assert.equal(await page.locator('#known-path li').count(), 3); assert.match(await page.locator('#known-path').textContent(), /控制台首页.*查看订单.*订单列表/s);
  await page.locator('#mode-calls').click();
  assert.equal(await page.locator('[data-node-id="api1"]').count(), 1); assert.equal(await page.locator('[data-node-id="source1"]').count(), 1);
  assert.match(await page.locator('[data-node-id="source1"]').textContent(), /请求来源/);
  await page.locator('[data-node-id="api1"]').click();
  assert.match(await page.locator('#path-note').textContent(), /没有足够/); assert.equal(await page.locator('#known-path li').count(), 0);
  assert.match(await page.locator('#relations').textContent(), /loadOrders/); assert.match(await page.locator('#relations').textContent(), /orders\.js:24:8/);
  assert.equal(await page.locator('[data-node-id="script1"]').count(), 1);
  assert.equal(await page.locator('[data-edge-id="e7"].edge-context').count(),1);
  assert.notEqual(await page.locator('[data-edge-id="e7"] .edge-path').evaluate(node=>getComputedStyle(node).strokeDasharray),'none');
  assert.equal(await page.locator('[data-edge-id="unproven-context"]').count(),0);
  await page.locator('.evidence-section summary').click(); assert.match(await page.locator('#evidence-list').textContent(), /ev:response:1/);
  await page.locator('#graph-search').fill('/api/orders'); await page.waitForFunction(() => document.querySelector('#render-summary').textContent.includes('匹配 1 个'));
  assert.equal(await page.locator('[data-node-id="script1"]').count(),1); assert.equal(await page.locator('[data-edge-id="e7"]').count(),1);
  assert.match(await page.locator('#path-note').textContent(),/没有足够/); assert.equal(await page.locator('#known-path li').count(),0);
  await page.locator('#graph-search').fill('/api/overview'); await page.waitForFunction(() => document.querySelector('#render-summary').textContent.includes('匹配 1 个'));
  await page.waitForFunction(() => !document.querySelector('[data-node-id="script1"]'));
  await page.locator('[data-node-id="api2"]').click(); assert.equal(await page.locator('#known-path li').count(), 3);
  await page.locator('#graph-search').fill(''); await page.waitForFunction(() => !document.querySelector('#render-summary').textContent.includes('匹配'));
  await page.locator('[data-node-id="script1"]').click(); assert.match(await page.locator('#relations').textContent(), /prepareOrders/);
  await page.locator('#mode-all').click(); await page.locator('#show-inactive').check();
  assert.equal(await page.locator('[data-edge-id="e9"]').count(),1);
  await page.locator('#show-candidates').check();
  assert.equal(await page.locator('[data-node-id="candidate1"]').count(), 1); assert.equal(await page.locator('[data-node-id="failed1"]').count(), 1); assert.equal(await page.locator('[data-node-id="blocked1"]').count(), 1);
  await page.locator('#fit-view').click(); await page.locator('[data-node-id="failed1"]').click(); assert.match(await page.locator('#path-note').textContent(),/所选操作尚未完成/);
  await page.locator('[data-node-id="blocked1"]').click(); assert.match(await page.locator('#selected-meta').textContent(), /未证明到达服务器/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('graph viewer reports broken edges, keeps untrusted markup inert and hides credentials', async t => {
  const data = graph();
  const evil = '<img src="https://evil.example/pixel" onerror="window.graphXss=1">';
  data.nodes.push({ id: 'evil', type: 'action', stateId: 1, label: evil + ' token=label-secret', observed: true, status: 'succeeded', confidence: 'observed', url: 'https://private:password@evil.example/?access_token=url-secret', screenshot: 'https://evil.example/pixel' });
  data.run.asset = 'https://private:password@console.example.test/?token=asset-secret';
  const { page, external, errors } = await view(t, data);
  await page.locator('#mode-all').click(); await page.locator('[data-node-id="evil"]').click();
  assert.match(await page.locator('#selected-label').textContent(), /<img/); assert.equal(await page.locator('#selected-label img').count(), 0);
  assert.equal(await page.evaluate(() => window.graphXss), undefined); assert.equal(await page.locator('#selected-image img').count(), 0);
  const visible = await page.locator('body').innerText(); for (const secret of ['password', 'label-secret', 'url-secret', 'asset-secret']) assert(!visible.includes(secret), secret);
  assert.match(await page.locator('#coverage-summary').textContent(), /断开的关系/);
  await page.locator('#coverage-summary').click(); assert.match(await page.locator('#coverage-content').textContent(), /不会补造连接/);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('graph viewer bounds large graphs, paginates, focuses neighbors and supports zoom/pan', async t => {
  const data = graph(); data.nodes = Array.from({ length: 5000 }, (_, n) => ({ id: 'large-' + n, type: 'state', stateId: n, label: '大图页面 ' + String(n).padStart(5, '0'), observed: true, status: 'observed', confidence: 'observed' })); data.edges = []; data.flows = [];
  const { page, errors } = await view(t, data);
  assert.equal(await page.locator('.node').count(), 120); assert.match(await page.locator('#omission-note').textContent(), /省略 4,880 个节点/);
  await page.locator('#next-page').click(); assert.equal(await page.locator('#page-label').textContent(), '2 / 42');
  await page.locator('#graph-search').fill('04999'); await page.waitForFunction(() => document.querySelectorAll('.node').length === 1);
  await page.locator('[data-node-id="large-4999"]').click(); await page.locator('#focus-node').click(); assert.match(await page.locator('#map-title').textContent(), /局部关系/);
  const before = await page.locator('#graph-world').getAttribute('transform'); await page.locator('#zoom-in').click(); assert.notEqual(await page.locator('#graph-world').getAttribute('transform'), before);
  const canvas = await page.locator('#graph-map').boundingBox(); const prior = await page.locator('#graph-world').getAttribute('transform');
  await page.mouse.move(canvas.x + 20, canvas.y + canvas.height - 90); await page.mouse.down(); await page.mouse.move(canvas.x + 70, canvas.y + canvas.height - 60); await page.mouse.up(); assert.notEqual(await page.locator('#graph-world').getAttribute('transform'), prior);
  assert.deepEqual(errors, []);
});

test('graph viewer fits a mobile viewport without horizontal overflow and keeps nodes keyboard accessible', async t => {
  const { page, errors } = await view(t, graph(), { width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-node-id="s1"]').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('#selected-label').textContent(), '控制台首页');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#mode-calls').click(); await page.locator('#fit-view').click(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('graph viewer opens offline with a local JSON import when fetch is unavailable', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bfs-graph-offline-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['graph.html', 'graph.js', 'graph.css']) copyFileSync(path.join(root, 'view', name), path.join(dir, name));
  const file = path.join(dir, 'map.json'); writeFileSync(file, JSON.stringify(graph()));
  const context = await browser.newContext(); t.after(() => context.close()); const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(dir, 'graph.html')).href); await page.waitForFunction(() => document.querySelector('#load-message').textContent.includes('导入地图'));
  await page.locator('#graph-file').setInputFiles(file); await page.waitForFunction(() => document.querySelector('#state-count').textContent === '2');
  assert.match(await page.locator('#load-message').textContent(), /本机读取/);
});

test('graph viewer explicitly marks omitted long-path steps instead of inventing a direct connection', async t => {
  const data = graph(); data.flows[1].steps = Array.from({ length: 95 }, () => ({ stateId: 1, actionId: 'a1', label: '查看订单', kind: 'click' }));
  const { page, errors } = await view(t, data); await page.locator('[data-node-id="s2"]').click();
  assert.match(await page.locator('#path-note').textContent(), /中间步骤已明确省略/);
  assert.match(await page.locator('#known-path').textContent(), /15 步未展示；不是直接连接/);
  assert.deepEqual(errors, []);
});

test('graph viewer preview captures the local call map and detail panel', async t => {
  const { page, errors } = await view(t);
  await page.locator('#mode-calls').click(); await page.locator('[data-node-id="api1"]').click(); await page.locator('#fit-view').click();
  mkdirSync(path.join(root, 'output-performance-review'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output-performance-review/graph-preview.png'), fullPage: true });
  assert.deepEqual(errors, []);
});
