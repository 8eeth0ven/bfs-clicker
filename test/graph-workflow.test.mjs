import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { runAsset } from '../src/runner.js';
import { serveRunFile } from '../view/files.js';
import { temp, fixture, document, config, readRun, json } from './helpers.mjs';

test('real crawl exports same-URL states, flows, cycles, API responses, static candidates and call sites', { timeout: 40000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname.startsWith('/api/')) return { type: 'application/json', body: '{"ok":true}' };
    if (url.pathname === '/detail') return { body: document('详情', '<a href="/">返回首页</a>') };
    return { body: document('入口', '<button id="open" onclick="document.querySelector(\'#panel\').hidden=false">展开模块</button><section id="panel" hidden><button id="view" onclick="loadItems()">查看项目</button><button id="blocked" onclick="fetch(\'/api/delete\')">查看阻断</button><a href="/detail">查看详情</a></section>', "function loadItems(){return fetch('/api/items')}const never='/api/not-called';fetch('/api/bootstrap');") };
  });
  const result = await runAsset(config(site.origin, dir), { log() {} });
  const graph = json(path.join(dir, 'graph.json')), data = readRun(dir);
  assert.equal(result.status, 'completed'); assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.run.status, result.status); assert.equal(result.graph.available, true);
  assert.equal(graph.nodes.filter(n => n.type === 'state').length, data.cp.states.length);
  assert(graph.nodes.filter(n => n.type === 'state' && n.url === site.origin + '/').length >= 2, 'menu state must not merge only by URL');
  const api = graph.nodes.find(n => n.type === 'api' && n.method === 'GET' && n.url === site.origin + '/api/items');
  assert(api?.responseObserved);
  const requestEdge = graph.edges.find(e => e.target === api.id && e.type === 'request' && e.observed);
  assert(requestEdge); assert(requestEdge.evidenceIds.length);
  const sourceAction = graph.nodes.find(n => n.id === requestEdge.source);
  assert.equal(sourceAction.type, 'action'); assert.equal(sourceAction.label, '查看项目');
  const candidate = graph.nodes.find(n => n.type === 'api' && n.method === 'unknown' && n.url === site.origin + '/api/not-called');
  assert(candidate && !candidate.responseObserved);
  assert(graph.edges.some(e => e.type === 'candidate' && e.target === candidate.id && !e.observed));
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/not-called').length, 0);
  const blocked = graph.nodes.find(n => n.type === 'api' && n.method === 'GET' && n.url === site.origin + '/api/delete');
  assert(blocked && !blocked.responseObserved); assert.equal(site.requests.filter(r => r.url.pathname === '/api/delete').length, 0);
  const background = graph.nodes.find(n => n.type === 'api' && n.method === 'GET' && n.url === site.origin + '/api/bootstrap');
  assert(graph.edges.some(e => e.target === background.id && graph.nodes.find(n => n.id === e.source)?.type === 'route'));
  assert(graph.edges.some(e => e.type === 'transition' && (e.loop || e.merged)));
  const detailState = graph.nodes.find(n => n.type === 'state' && n.url === site.origin + '/detail');
  assert(graph.flows.find(f => String(f.stateId) === String(detailState.stateId)).steps.length >= 2);
  assert(graph.edges.some(e => e.type === 'initiates' && e.callFrames?.some(frame => frame.functionName === 'loadItems')));
  const html = readFileSync(path.join(dir, 'report.html'), 'utf8'); assert(html.includes('graph.html'));
  assert(readFileSync(path.join(dir, 'graph.dot'), 'utf8').startsWith('digraph website'));
  assert(!JSON.stringify(graph).includes('reqHeaders'));
});

test('graph export failure remains partial, preserves the text report, and recovers on resume', { timeout: 30000 }, async t => {
  const dir = temp(t), blockedOutput = path.join(dir, 'graph.json'); mkdirSync(blockedOutput);
  const site = await fixture(t, () => ({ body: document('入口', '<p>空页面</p>') }));
  const input = config(site.origin, dir), first = await runAsset(input, { log() {} });
  assert.equal(first.status, 'partial'); assert.equal(first.stopReason, 'graph_export_failed'); assert.equal(first.graph.available, false);
  assert.equal(json(path.join(dir, 'manifest.json')).status, 'partial');
  assert(!readFileSync(path.join(dir, 'report.html'), 'utf8').includes('href="graph.html"'));
  rmSync(blockedOutput, { recursive: true });
  const second = await runAsset(input, { resume: true, log() {} });
  assert.equal(second.status, 'completed'); assert(second.graph.available);
  assert.equal(json(path.join(dir, 'graph.json')).run.status, 'completed');
});

test('viewer assets get their own CSP while ordinary reports stay inert and private symlinks stay blocked', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, () => ({ body: document('入口', '<p>内容</p>') }));
  await runAsset(config(site.origin, dir), { log() {} });
  const server = createServer((req, res) => serveRunFile(req, res, dir, req.url.slice(1)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const viewer = await fetch(base + '/graph.html'), script = await fetch(base + '/graph.js'), report = await fetch(base + '/report.html');
  assert.equal(viewer.status, 200); assert.equal(script.status, 200);
  assert.match(viewer.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(report.headers.get('content-security-policy'), /script-src 'none'/);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  assert.equal((await fetch(base + '/private/config.json')).status, 404);
  if (process.platform !== 'win32') {
    rmSync(path.join(dir, 'graph.json')); symlinkSync(path.join(dir, 'private/config.json'), path.join(dir, 'graph.json'));
    assert.equal((await fetch(base + '/graph.json')).status, 403);
  }
});
