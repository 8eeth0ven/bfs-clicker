import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsset } from '../src/runner.js';
import { temp, fixture, document, config, readRun } from './helpers.mjs';

test('real network records distinguish repeated selectors by state and occurrence, with browser call sites', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname.startsWith('/api/')) return { type: 'application/json', body: '{"ok":true}' };
    if (url.pathname === '/child') return { body: document('子页', '<button id="view" onclick="loadChild()">查看子项</button>', "function loadChild(){return fetch('/api/child')}fetch('/api/background-child');") };
    return { body: document('入口', '<button id="view" onclick="loadRoot()">查看根项</button><a href="/child">进入子页</a>', "function loadRoot(){return fetch('/api/root')}fetch('/api/background-root');") };
  });
  const result = await runAsset(config(site.origin, dir), { log() {} });
  const data = readRun(dir);
  assert.equal(result.status, 'completed');
  const requests = ['/api/root', '/api/child'].map(path => data.events.find(e => e.kind === 'request' && e.url === site.origin + path));
  assert(requests.every(Boolean));
  assert.equal(requests[0].source.actionId, requests[1].source.actionId);
  assert.notEqual(requests[0].source.stateId, requests[1].source.stateId);
  assert.notEqual(requests[0].source.executionId, requests[1].source.executionId);
  for (const request of requests) assert(data.events.some(e => e.kind === 'action_started' && e.evidenceId === request.source.executionId && e.stateId === request.source.stateId));
  const background = data.events.find(e => e.kind === 'request' && e.url === site.origin + '/api/background-root');
  assert.equal(background.source.actionId, null); assert.equal(background.source.executionId, null);
  const initiated = data.events.filter(e => e.kind === 'network_initiator' && ['/api/root', '/api/child'].some(path => e.url === site.origin + path));
  assert.equal(initiated.length, 2);
  for (const row of initiated) {
    assert.equal(row.initiator.type, 'script'); assert(row.source.executionId); assert.equal(row.confidence, 'context');
    assert(row.initiator.stack?.callFrames.some(frame => /loadRoot|loadChild/.test(frame.functionName)), 'test Chromium should provide its actual initiating call site');
  }
});

test('HTTP redirect hops retain direct protocol evidence without inventing a request match', { timeout: 30000 }, async t => {
  const dir = temp(t);
  const site = await fixture(t, ({ url }) => {
    if (url.pathname === '/redirect') return { status: 302, headers: { location: '/api/final' } };
    if (url.pathname === '/api/final') return { type: 'application/json', body: '{}' };
    return { body: document('入口', '<button onclick="fetch(\'/redirect\')">查看跳转</button>') };
  });
  const result = await runAsset(config(site.origin, dir), { log() {} });
  assert.equal(result.status, 'completed');
  const data = readRun(dir);
  const redirect = data.events.find(e => e.kind === 'network_redirect');
  assert.equal(redirect.fromUrl, site.origin + '/redirect'); assert.equal(redirect.toUrl, site.origin + '/api/final');
  assert.equal(redirect.status, 302); assert(redirect.source.executionId);
  const next = data.events.find(e => e.kind === 'request' && e.url === site.origin + '/api/final');
  assert.equal(next.redirectedFrom, site.origin + '/redirect');
});
