import test from 'node:test';
import assert from 'node:assert/strict';
import { urlShape, extractEndpoints, extractApiSurface } from '../src/urlshape.js';
import { createApiLedger, observeApi, ledgerView } from '../src/cdpnet.js';

test('URL templates retain meaningful paths while collapsing numeric, UUID and hex IDs', () => {
  for (const [input, expected] of [
    ['/api/users/123', '/api/users/{n}'], ['/api/users/123?tab=info', '/api/users/{n}?tab'],
    ['/item-7/list', '/item/list'], ['/order/550e8400-e29b-41d4-a716-446655440000', '/order/{uuid}'],
    ['/api/v2/', '/api/v2'], ['/a/b#section', '/a/b'], ['/f/deadbeefdeadbeefdeadbeef', '/f/{hex}'],
    ['/settings/profile', '/settings/profile'],
  ]) assert.equal(urlShape('https://example.com' + input), 'https://example.com' + expected);
});

test('static API extraction retains routes and excludes image and bundle noise', () => {
  const source = `fetch('/api/v2/users/list'); const endpoint='/graphql'; const route='/admin/settings/export'; img.src='/static/logo.png'; import('/chunks/app-abc123.js');`;
  const endpoints = extractEndpoints(source);
  for (const endpoint of ['/api/v2/users/list', '/graphql', '/admin/settings/export']) assert(endpoints.includes(endpoint));
  for (const noise of ['logo.png', 'app-abc123.js']) assert(!endpoints.some(v => v.includes(noise)));
  assert(extractApiSurface('<a href="/reports">查看报表</a>', 'https://example.com/').all.includes('/reports'));
});

test('API samples preserve response changes, duplicate query values and separate static from observed', () => {
  const ledger = createApiLedger(), url = 'https://example.com/api/items?tag=a&tag=b&note=';
  observeApi(ledger, { method: 'GET', url, source: { kind: 'page', page: 'https://example.com/', actionId: 'a1' }, category: 'observed_request', evidenceId: 'r1', responseDigest: 'one', status: 200 });
  observeApi(ledger, { method: 'GET', url, source: { kind: 'page', page: 'https://example.com/', actionId: 'a2' }, category: 'observed_request', evidenceId: 'r2', responseDigest: 'two', status: 200 });
  observeApi(ledger, { method: 'unknown', url, source: { kind: 'document', document: 'https://example.com/app.js' }, category: 'static_candidate', evidenceId: 's1' });
  const view = ledgerView(ledger), observed = view.find(r => r.method === 'GET');
  assert.equal(view.length, 2);
  assert.deepEqual(observed.query.tag, ['a', 'b']);
  assert.deepEqual(observed.query.note, ['']);
  assert.deepEqual(observed.samples.map(s => s.actionId), ['a1', 'a2']);
  assert.deepEqual(observed.samples.map(s => s.responseDigest), ['one', 'two']);
  assert.deepEqual(view.find(r => r.method === 'unknown').categories, ['static_candidate']);
});
