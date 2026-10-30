import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { runAsset } from '../src/runner.js';
import { temp, fixture, document, config, readRun } from './helpers.mjs';
const run = input => runAsset(input, { log() {} });

test('request guard blocks logout, write methods, redirects, popup and worker escape before server receipt', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const outside = await fixture(t, () => ({ body: document('外域', '<p>不应到达</p>') }));
  const site = await fixture(t, ({ url }) => {
    if (url.pathname === '/redirect') return { status: 302, headers: { location: outside.origin + '/redirected' } };
    if (url.pathname === '/worker.js') return { type: 'text/javascript', body: `fetch(${JSON.stringify(outside.origin + '/worker')}).catch(()=>{});fetch('/logout').catch(()=>{});` };
    if (url.pathname !== '/') return { type: 'application/json', body: '{}' };
    return { body: document('守卫', '<a href="/logout">退出</a><button onclick="fetch(\'/api/delete\')">删除</button>', `
      fetch('/logout').catch(()=>{});
      fetch('/api/delete').catch(()=>{});
      fetch('/api/write',{method:'POST',body:'x'}).catch(()=>{});
      fetch(${JSON.stringify(outside.origin + '/api')}).catch(()=>{});
      fetch('/redirect').catch(()=>{});
      window.open(${JSON.stringify(outside.origin + '/popup')});
      new Worker('/worker.js');
    `) };
  });
  const result = await run(config(site.origin, dir, { maxTabs: 2 }));
  assert.equal(result.status, 'completed');
  assert.equal(outside.requests.length, 0);
  for (const pathname of ['/logout', '/api/delete', '/api/write']) assert.equal(site.requests.filter(r => r.url.pathname === pathname).length, 0);
  const data = readRun(dir);
  assert(data.events.some(e => e.kind === 'policy' && e.reason === 'logout_endpoint'));
  assert(data.events.some(e => e.kind === 'policy' && e.reason === 'unapproved_write_method'));
  assert(data.cp.states[0].interactives.every(a => a.status === 'skipped'));
});

test('flexible external bootstrap resource strips same-host cross-port cookies and injected headers', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const outside = await fixture(t, () => ({ type: 'text/javascript', body: 'window.bootstrapLoaded=true;' }));
  const site = await fixture(t, ({ url }) => url.pathname === '/api/check'
    ? { type: 'application/json', body: '{}' }
    : { body: document('凭证', `<script src="${outside.origin}/bootstrap.js"></script>`, `fetch('/api/check')`) });
  const stateFile = path.join(dir, 'session.json');
  writeFileSync(stateFile, JSON.stringify({ cookies: [{ name: 'session', value: 'fixture-secret', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  const result = await run(config(site.origin, path.join(dir, 'run'), { resourcePolicy: 'flexible', storageState: stateFile,
    authInject: { headers: { Authorization: 'Bearer fixture-token', 'X-Crawler-Secret': 'private-value' } } }));
  assert.equal(result.status, 'completed');
  assert.equal(outside.requests.length, 1);
  const external = outside.requests[0].headers;
  assert(!external.cookie);
  assert(!external.authorization);
  assert(!external['x-crawler-secret']);
  const own = site.requests.find(r => r.url.pathname === '/api/check').headers;
  assert.match(own.cookie, /session=fixture-secret/);
  assert.equal(own.authorization, 'Bearer fixture-token');
  assert.equal(own['x-crawler-secret'], 'private-value');
});

test('request ceiling remains strict under a concurrent fetch burst', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => url.pathname.startsWith('/api/')
    ? { type: 'application/json', body: '{}' }
    : { body: document('预算', '<p>并发请求</p>', `for(let n=0;n<30;n++)fetch('/api/q/'+n).catch(()=>{});`) });
  const result = await run(config(site.origin, dir, { maxRequests: 4 }));
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'max_requests');
  assert.equal(result.counts.requests, 4);
  assert(site.requests.length <= 4);
});

test('429 Retry-After is applied before the next chained request', { timeout: 30000 }, async t => {
  const dir = temp(t); let limitedAt, followAt;
  const site = await fixture(t, ({ url }) => {
    if (url.pathname === '/api/limited') { limitedAt = Date.now(); return { status: 429, type: 'application/json', body: '{}', headers: { 'retry-after': '1' } }; }
    if (url.pathname === '/api/follow') { followAt = Date.now(); return { type: 'application/json', body: '{}' }; }
    return { body: document('退避', '<p>请求</p>', `fetch('/api/limited').then(()=>fetch('/api/follow')).catch(()=>{});`) };
  });
  const result = await run(config(site.origin, dir));
  assert.equal(result.status, 'completed');
  assert(followAt - limitedAt >= 950, `backoff was only ${followAt - limitedAt}ms`);
  assert(readRun(dir).events.some(e => e.kind === 'rate_limit' && e.delayMs === 1000));
});

test('native confirmation stays rejected during optimized page reuse', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => url.pathname === '/api/confirmed'
    ? { type: 'application/json', body: '{}' }
    : { body: document('确认', `<button id="confirm" onclick="window.mode='changed';if(confirm('确认查看?'))fetch('/api/confirmed')">查看确认</button><button id="query" onclick="fetch('/api/mode/'+window.mode)">查询模式</button>`, "window.mode='clean';") });
  const result = await run(config(site.origin, dir));
  const data = readRun(dir);
  assert.equal(result.status, 'completed');
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/confirmed').length, 0);
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/mode/changed').length, 0);
  assert.equal(site.requests.filter(r => r.url.pathname === '/api/mode/clean').length, 1);
  assert.equal(data.cp.states[0].interactives[0].reason, 'native_confirmation_rejected');
  assert(data.events.some(e => e.kind === 'native_dialog' && e.decision === 'dismiss'));
});
