import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createControlPanel } from '../view/control.js';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { temp, fixture, document, until, json } from './helpers.mjs';

test('panel starts a bounded run, serves a safe report and resumes journal-backed progress', { timeout: 45000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => ({ body: url.pathname === '/'
    ? document('入口', '<a href="/one">查看一</a><a href="/two">查看二</a><a href="/three">查看三</a>')
    : document('详情 ' + url.pathname, '<p>内容</p>') }));
  const panel = createControlPanel({ outputRoot: dir, baseConfig: { shotFormat: 'none' } });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  t.after(() => panel.shutdown());
  const origin = 'http://127.0.0.1:' + panel.server.address().port;
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  const post = (endpoint, body, extra = {}) => fetch(origin + endpoint, { method: 'POST', headers: {
    origin, 'content-type': 'application/json', 'x-bfs-token': bootstrap.token, ...extra,
  }, body: JSON.stringify(body) });
  assert.equal((await post('/api/runs', {}, { origin: 'http://outside.test' })).status, 403);
  assert.equal((await post('/api/runs', {}, { 'x-bfs-token': 'wrong' })).status, 403);
  const response = await post('/api/runs', { asset: site.origin + '/', limitMode: 'custom', requestDelayMs: 0,
    limits: { maxStates: 2, maxDepth: 3, maxDurationMs: 30000, maxRequests: 100, maxActions: 30, maxStatesPerHost: 10 } });
  assert.equal(response.status, 202);
  const id = (await response.json()).run.id;
  const waitForEnd = () => until(async () => {
    const data = await (await fetch(origin + '/api/runs')).json();
    const job = data.runs.find(r => r.id === id); return job && !job.active && job.status !== 'starting' ? job : null;
  }, 30000);
  const first = await waitForEnd();
  assert.equal(first.status, 'partial'); assert.equal(first.stopReason, 'max_states');
  assert(first.graph?.endsWith('/graph.html'));
  assert.equal((await fetch(origin + first.graph)).status, 200);
  assert.equal((await fetch(origin + '/runs/' + id + '/private/config.json')).status, 404);
  const report = await fetch(origin + first.report);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-security-policy'), /script-src 'none'/);
  const resumed = await post('/api/runs/' + id + '/resume', { limitMode: 'unlimited' });
  assert.equal(resumed.status, 202);
  const second = await waitForEnd();
  assert.equal(second.status, 'completed'); assert.equal(second.counts.states, 4);
  const meta = json(path.join(dir, id, 'private/run.json'));
  assert.equal(meta.attempts, 2);
  assert(!existsSync(path.join(dir, id, '.run.lock')));
  assert(existsSync(path.join(dir, id, 'private/checkpoint.journal.jsonl')));
});

test('panel exposes an available graph even if the text report failed to export', { timeout: 20000 }, async t => {
  const dir = temp(t), runDir = path.join(dir, 'sample'); mkdirSync(runDir); mkdirSync(path.join(runDir, 'report.html'));
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'sample', identity: {}, asset: 'https://example.test/', status: 'partial', stopReason: 'report_export_failed', graph: { available: true } }));
  writeFileSync(path.join(runDir, 'graph.json'), JSON.stringify({ schemaVersion: 1, run: { status: 'partial' }, nodes: [], edges: [], flows: [], coverage: {} }));
  copyFileSync(new URL('../view/graph.html', import.meta.url), path.join(runDir, 'graph.html'));
  const panel = createControlPanel({ outputRoot: dir });
  await new Promise(resolve => panel.server.listen(0, '127.0.0.1', resolve));
  t.after(() => panel.shutdown());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), origin = 'http://127.0.0.1:' + panel.server.address().port;
  await page.goto(origin); await page.waitForFunction(() => !document.querySelector('#graph-link').hidden);
  assert.equal(await page.locator('#report-links').isVisible(), true);
  assert.equal(await page.locator('#report-link').isVisible(), false);
  assert.equal(await page.locator('#graph-link').getAttribute('href'), '/runs/sample/graph.html');
});
