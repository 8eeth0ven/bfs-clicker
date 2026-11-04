import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { connectedGraph } from './fixtures/graph-v2-data.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let browser, server, origin, data;
before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'");
    const name = req.url.split('?')[0].split('/').at(-1);
    if (name === 'graph.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
    else if (['graph.html', 'graph.js', 'graph.css'].includes(name)) { res.writeHead(200, { 'content-type': name.endsWith('html') ? 'text/html' : name.endsWith('js') ? 'text/javascript' : 'text/css' }); res.end(readFileSync(path.join(root, 'view', name))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function open(t, graph) {
  data = graph; const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } }); t.after(() => context.close()); const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/graph.html'); await page.waitForFunction(() => document.querySelector('#state-count').textContent !== '—');
  return { page, errors };
}

test('connected 5000-node graph stays bounded and selection reuses SVG without moving the viewport', async t => {
  const graph = connectedGraph(); assert.equal(graph.nodes.length, 5000); assert(graph.edges.length > 7000);
  const { page, errors } = await open(t, graph); await page.locator('#mode-calls').click();
  assert.equal(await page.locator('.node').count(), 120); assert((await page.locator('.edge-path').count()) > 30, 'first page must contain real relationships, not only exported state inventory');
  assert((await page.locator('.edge-path').count()) <= 260);
  await page.locator('#zoom-in').click();
  const result = await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll('.node')], frame = document.querySelector('.graph-frame'), world = document.querySelector('#graph-world');
    const transform = world.getAttribute('transform'); let replacements = 0;
    const observer = new MutationObserver(records => { replacements += records.filter(record => record.type === 'childList').length; }); observer.observe(world, { childList: true, subtree: true });
    const started = performance.now(); for (let i = 0; i < 30; i++) nodes[i % Math.min(12, nodes.length)].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve(); observer.disconnect();
    return { ms: performance.now() - started, sameNodes: nodes.every(node => node.isConnected), sameFrame: frame === document.querySelector('.graph-frame'), sameTransform: transform === world.getAttribute('transform'), replacements };
  });
  assert.equal(result.sameNodes, true); assert.equal(result.sameFrame, true); assert.equal(result.sameTransform, true); assert.equal(result.replacements, 0);
  await page.locator('#next-page').click(); assert.match(await page.locator('#omission-note').textContent(), /跨页关系未在画布连线/);
  const knownEdges = new Set(graph.edges.map(edge => edge.id)); for (const id of await page.locator('.edge').evaluateAll(nodes => nodes.map(node => node.dataset.edgeId))) assert(knownEdges.has(id));
  assert.deepEqual(errors, []);
});

test('parallel edges and self loops have distinct visible routes, and context stays outside confirmed paths', async t => {
  const { page, errors } = await open(t, connectedGraph(10)); await page.locator('#mode-calls').click();
  const parallel = await page.locator('[data-edge-id^="request-0-"] .edge-path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
  assert.equal(parallel.length, 3); assert.equal(new Set(parallel).size, 3);
  const loops = await page.locator('[data-geometry="loop"]').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.edgeId, d: node.querySelector('path').getAttribute('d'), height: node.querySelector('path').getBBox().height })));
  assert.equal(loops.length, 2); assert.notEqual(loops[0].d, loops[1].d); assert(loops.every(loop => loop.height > 30));
  await page.evaluate(() => document.querySelector('[data-node-id="api-0"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.match(await page.locator('#path-note').textContent(), /没有足够/); assert.equal(await page.locator('#known-path li').count(), 0); assert.equal(await page.locator('.edge-context.on-path').count(), 0);
  await page.locator('#mode-all').click(); assert((await page.locator('[data-geometry="return"]').count()) > 0);
  await page.evaluate(()=>document.querySelector('[data-node-id="s-3"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(await page.locator('.edge.on-path').count(),4);assert.equal(await page.locator('.edge-context.on-path').count(),0);
  assert.deepEqual(errors, []);
});

test('filter and pagination caches retain frames, and known path highlights never create cross-page links', async t => {
  const { page, errors } = await open(t, connectedGraph()); await page.locator('#mode-calls').click();
  await page.evaluate(() => { window.originalGraphFrame = document.querySelector('.graph-frame'); });
  await page.locator('#show-observed').uncheck(); assert.equal(await page.locator('.node').count(), 0);
  await page.locator('#show-observed').check(); assert.equal(await page.evaluate(() => window.originalGraphFrame === document.querySelector('.graph-frame')), true);
  await page.locator('#graph-search').fill('页面 00999'); await page.waitForFunction(() => document.querySelector('#render-summary').textContent.includes('匹配 1 个'));
  await page.evaluate(() => document.querySelector('[data-node-id="s-999"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert((await page.locator('#known-path li').count()) > 10, 'details must retain known path beyond the filtered canvas');
  const visible = new Set(await page.locator('.node').evaluateAll(nodes => nodes.map(node => node.dataset.nodeId)));
  const edges = await page.locator('.edge').evaluateAll(nodes => nodes.map(node => node.dataset.edgeId));
  for (const id of edges) { const edge = data.edges.find(edge => edge.id === id); assert(visible.has(edge.source)); assert(visible.has(edge.target)); }
  assert.equal(await page.locator('.edge-context.on-path').count(), 0);
  await page.locator('#known-path button').first().evaluate(node=>node.click());assert.match(await page.locator('#edge-note').textContent(),/不在当前画布/);
  await page.locator('#focus-node').click();assert.equal(await page.locator('#graph-search').inputValue(),'');assert((await page.locator('.node').count())>0);
  assert.deepEqual(errors, []);
});
