import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runAsset } from '../src/runner.js';
import { chromium } from 'playwright';
import { openStore } from '../src/store.js';
import { normalizeConfig } from '../src/asset.js';
import { temp, fixture, document, config, readRun, lines, until, root } from './helpers.mjs';
const run = input => runAsset(input, { log() {} });

test('verified resident state eliminates deep-chain replay without losing routes or API provenance', { timeout: 60000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname.startsWith('/api/')) return { type: 'application/json', body: '{"ok":true}' };
    const n = Number(url.pathname.split('/').at(-1));
    return { body: document('层 ' + n, n < 4 ? `<a href="/chain/${n + 1}">进入层 ${n + 1}</a>` : '<p>末层</p>', `fetch('/api/depth/${n}')`) };
  });
  const optimizedDir = path.join(dir, 'optimized');
  const optimized = await run(config(site.origin, optimizedDir, { startUrl: site.origin + '/chain/0' }));
  const a = readRun(optimizedDir);
  assert.equal(optimized.status, 'completed');
  assert.equal(a.cp.states.length, 5);
  assert.equal(a.events.filter(e => e.kind === 'action_replay').length, 0);
  assert.equal(optimized.counts.actions, 4);
  assert.equal(optimized.performance.stateReuses, 4);
  for (let n = 0; n <= 4; n++) assert(a.apis.some(api => api.url === site.origin + '/api/depth/' + n && api.categories.includes('observed_request')));
  const fallbackDir = path.join(dir, 'fallback');
  const fallback = await run(config(site.origin, fallbackDir, { startUrl: site.origin + '/chain/0', reuseVerifiedState: false }));
  const b = readRun(fallbackDir);
  assert.equal(fallback.status, 'completed');
  assert.deepEqual(a.cp.states.map(s => s.url).sort(), b.cp.states.map(s => s.url).sort());
  assert.equal(b.events.filter(e => e.kind === 'action_replay').length, 6);
  assert.equal(fallback.counts.actions, 10);
  assert(optimized.counts.requests < fallback.counts.requests);
});

test('same-state API actions reset the page and retain the exact action source', { timeout: 30000 }, async t => {
  const dir = temp(t), count = 6;
  const site = await fixture(t, ({ url }) => url.pathname.startsWith('/api/')
    ? { type: 'application/json', body: '{"result":1}' }
    : { body: document('查询', Array.from({ length: count }, (_, n) => `<button id="q${n}" onclick="fetch('/api/q/${n}')">查看 ${n}</button>`).join('')) });
  const result = await run(config(site.origin, dir));
  const data = readRun(dir);
  assert.equal(result.status, 'completed');
  assert.equal(data.cp.states.length, 1);
  assert.equal(site.requests.filter(r => r.url.pathname === '/').length, count);
  assert.equal(result.counts.actions, count);
  assert.equal(result.performance.stateReuses, 1);
  for (let n = 0; n < count; n++) {
    const entry = data.traffic.find(r => new URL(r.url).pathname === '/api/q/' + n);
    assert(entry);
    assert(entry.source.actionId.includes('#q' + n));
    assert.equal(site.requests.filter(r => r.url.pathname === '/api/q/' + n).length, 1);
  }
});

test('equal DOM cannot reuse hidden JavaScript state left behind by a previous action', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => url.pathname.startsWith('/api/')
    ? { type: 'application/json', body: '{}' }
    : { body: document('隐式状态', `<button id="a" onclick="window.mode='changed'">查看模式</button><button id="b" onclick="fetch('/api/mode/'+window.mode)">查询模式</button>`, "window.mode='clean';") });
  const result = await run(config(site.origin, dir));
  assert.equal(result.status, 'completed');
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/mode/changed').length, 0);
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/mode/clean').length, 1);
});

test('default wait observes a link inserted 120ms after click and preserves real click handlers', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname === '/detail') return { body: document('详情', '<p>内容</p>') };
    if (url.pathname === '/wrong') throw new Error('href fast path bypassed a custom handler');
    return { body: document('展开', '<a id="open" href="/wrong">展开详情</a><div id="slot"></div>', `document.querySelector('#open').onclick=e=>{e.preventDefault();setTimeout(()=>{document.querySelector('#slot').innerHTML='<a href="/detail">查看详情</a>'},120)}`) };
  });
  const result = await run(config(site.origin, dir));
  const data = readRun(dir);
  assert.equal(result.status, 'completed');
  assert(data.cp.states.some(s => s.url === site.origin + '/detail'));
  assert.equal(site.requests.filter(r => r.url.pathname === '/wrong').length, 0);
  assert(!result.coverageGaps.some(g => g.reason === 'replay_state_changed'));
});

test('manual seeds run before a large UI frontier can spend the action budget', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname === '/hidden') return { body: document('隐藏页面', '<p>种子内容</p>') };
    if (url.pathname.startsWith('/api/')) return { type: 'application/json', body: '{}' };
    return { body: document('入口', Array.from({ length: 10 }, (_, n) => `<button onclick="fetch('/api/${n}')">查看 ${n}</button>`).join('')) };
  });
  const result = await run(config(site.origin, dir, { seedRoutes: ['/hidden'], maxActions: 2 }));
  const data = readRun(dir);
  assert.equal(result.stopReason, 'max_actions');
  assert(data.cp.states.some(s => s.url === site.origin + '/hidden'));
  assert.equal(site.requests.filter(r => r.url.pathname === '/hidden').length, 1);
});

test('discovered seeds interleave into a non-root state then safely replay the UI path', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname === '/') return { body: document('入口', '<a href="/group">进入分组</a>') };
    if (url.pathname === '/hidden') return { body: document('隐藏种子', '<p>未出现在可见交互面</p>') };
    if (url.pathname.startsWith('/api/')) return { type: 'application/json', body: '{}' };
    return { body: document('分组', '<a hidden href="/hidden">查看隐藏</a>' + Array.from({ length: 4 }, (_, n) => `<button id="q${n}" onclick="fetch('/api/group/${n}')">查询 ${n}</button>`).join('')) };
  });
  const result = await run(config(site.origin, dir, { discoverySeeds: true, seedInterleaveActions: 2 }));
  const data = readRun(dir);
  assert.equal(result.status, 'completed');
  assert(data.cp.states.some(s => s.url === site.origin + '/hidden'));
  for (let n = 0; n < 4; n++) assert.equal(site.requests.filter(r => r.url.pathname === '/api/group/' + n).length, 1);
  assert(site.requests.findIndex(r => r.url.pathname === '/hidden') < site.requests.findIndex(r => r.url.pathname === '/api/group/3'));
  assert(!result.coverageGaps.some(g => g.reason === 'replay_state_changed'));
});

test('a failed discovery seed records a gap but does not abandon the remaining UI actions', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }, req) => {
    if (url.pathname === '/broken') { req.socket.destroy(); return { body: '' }; }
    if (url.pathname === '/api/ok') return { type: 'application/json', body: '{}' };
    return { body: document('入口', '<button onclick="fetch(\'/api/ok\')">查询接口</button>') };
  });
  const result = await run(config(site.origin, dir, { seedRoutes: ['/broken'], maxRetries: 0 }));
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'unresolved_coverage_errors', JSON.stringify(readRun(dir).cp.states.map(s => s.failed)));
  assert(result.coverageGaps.some(g => g.reason === 'seed_navigation_failed'));
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/ok').length, 1);
});

test('budget stop and resume preserve completed actions, evidence counts, and unique event IDs', { timeout: 40000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => url.pathname.startsWith('/api/')
    ? { type: 'application/json', body: '{"ok":true}' }
    : { body: document('查询', Array.from({ length: 6 }, (_, n) => `<button id="q${n}" onclick="fetch('/api/q/${n}')">查看 ${n}</button>`).join('')) });
  const input = config(site.origin, dir, { maxActions: 2, checkpointIntervalMs: 100000 });
  const first = await run(input);
  assert.equal(first.stopReason, 'max_actions');
  assert.equal(first.counts.actions, 2);
  const second = await runAsset({ ...input, maxActions: 20 }, { resume: true, log() {} });
  assert.equal(second.status, 'completed');
  assert.equal(second.counts.actions, 4);
  assert.equal(second.counts.totalActions, 6);
  const data = readRun(dir);
  assert.equal(data.meta.attempts, 2);
  assert.equal(new Set(data.events.map(e => e.evidenceId)).size, data.events.length);
  for (let n = 0; n < 6; n++) assert.equal(site.requests.filter(r => r.url.pathname === '/api/q/' + n).length, 1);
  assert(!existsSync(path.join(dir, '.run.lock')));
});

test('SIGKILL between compactions restores journaled completed actions and post-checkpoint API evidence', { timeout: 60000 }, async t => {
  const dir = temp(t), outputDir = path.join(dir, 'run');
  const site = await fixture(t, ({ url }) => url.pathname.startsWith('/api/')
    ? { type: 'application/json', body: '{"ok":true}' }
    : { body: document('查询', Array.from({ length: 15 }, (_, n) => `<button id="q${n}" onclick="fetch('/api/q/${n}')">查看 ${n}</button>`).join('')) });
  const input = config(site.origin, outputDir, { checkpointIntervalMs: 100000 });
  const configFile = path.join(dir, 'config.json'); writeFileSync(configFile, JSON.stringify(input));
  const child = spawn(process.execPath, ['src/index.js', 'run', '--config', configFile], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
  const eventsFile = path.join(outputDir, 'private/events.jsonl');
  await until(() => {
    try { return lines(eventsFile).filter(e => e.kind === 'action_finished' && e.status === 'succeeded').length >= 2; } catch { return false; }
  });
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  const before = lines(eventsFile).filter(e => e.kind === 'action_finished' && e.status === 'succeeded');
  assert(before.length >= 2 && before.length < 15, output);
  const completedSelectors = before.map(e => e.actionId.split('|')[1]);
  const result = await runAsset(input, { resume: true, log() {} });
  assert.equal(result.status, 'completed', output);
  const data = readRun(outputDir);
  for (const selector of completedSelectors) {
    const n = selector.slice(2);
    assert.equal(site.requests.filter(r => r.url.pathname === '/api/q/' + n).length, 1, 'completed action must not be rerun after SIGKILL');
    assert(data.apis.some(api => api.url === site.origin + '/api/q/' + n && api.categories.includes('observed_request')), 'post-checkpoint evidence must survive');
  }
  assert.equal(data.cp.states[0].interactives.filter(a => a.status === 'succeeded').length, 15);
  assert.equal(new Set(data.events.map(e => e.evidenceId)).size, data.events.length);
});

test('post-insertion collection failure journals both parent and child before previous-snapshot recovery', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => ({ body: url.pathname === '/' ? document('入口', '<a href="/child">查看子页</a>') : document('子页', '<p>内容</p>') }));
  const input = config(site.origin, dir, { checkpointIntervalMs: 100000 });
  const original = chromium.launchPersistentContext.bind(chromium);
  let injected = false;
  chromium.launchPersistentContext = async (...args) => {
    const context = await original(...args);
    context.on('page', page => {
      const evaluate = page.evaluate.bind(page);
      page.evaluate = async (fn, arg) => {
        if (!injected && page.url().endsWith('/child') && String(fn).includes('document.documentElement.outerHTML')) { injected = true; throw new Error('injected collection failure'); }
        return evaluate(fn, arg);
      };
    });
    return context;
  };
  let result;
  try { result = await run(input); } finally { chromium.launchPersistentContext = original; }
  assert(injected);
  assert.equal(result.status, 'partial');
  writeFileSync(path.join(dir, 'private/checkpoint.json'), '{corrupt latest');
  const store = openStore(normalizeConfig(input), true);
  try {
    assert.equal(store.checkpoint.states.length, 2);
    const byId = new Map(store.checkpoint.states.map(s => [s.id, s]));
    for (const state of byId.values()) for (const child of state.children) assert(byId.has(child), 'journal must not contain a dangling child');
  } finally { store.release(); }
});

test('report export failure stays partial and can be resumed after the output is repaired', { timeout: 30000 }, async t => {
  const dir = temp(t), report = path.join(dir, 'report.html'); mkdirSync(report);
  const site = await fixture(t, () => ({ body: document('空页', '<p>内容</p>') }));
  const input = config(site.origin, dir), first = await run(input);
  assert.equal(first.status, 'partial'); assert.equal(first.stopReason, 'report_export_failed');
  assert.equal(JSON.parse((await import('node:fs')).readFileSync(path.join(dir, 'manifest.json'))).status, 'partial');
  assert(!existsSync(path.join(dir, '.run.lock')));
  rmSync(report, { recursive: true });
  const second = await runAsset(input, { resume: true, log() {} });
  assert.equal(second.status, 'completed'); assert(existsSync(report));
});
