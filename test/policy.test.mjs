import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/asset.js';
import { createPolicy, graphqlOperation } from '../src/policy.js';
import { redact } from '../src/redact.js';

test('performance options validate without changing exploration budgets or safety defaults', () => {
  const c = normalizeConfig({ startUrl: 'http://localhost:3100/' });
  assert.equal(c.requestDelayMs, 50);
  assert.equal(c.shotFormat, 'png');
  assert.equal(c.captureBinaryBodies, false);
  assert.equal(c.reuseVerifiedState, true);
  assert.equal(c.maxActions, 500);
  for (const key of ['checkpointIntervalMs', 'seedInterleaveActions']) {
    for (const value of [0, -1, 1.5, null]) assert.throws(() => normalizeConfig({ startUrl: c.startUrl, [key]: value }));
  }
  assert.throws(() => normalizeConfig({ startUrl: c.startUrl, captureBinaryBodies: 'true' }));
  assert.throws(() => normalizeConfig({ startUrl: c.startUrl, reuseVerifiedState: 1 }));
});

test('scope and credential policy still distinguishes scheme, hostname and port', () => {
  const c = normalizeConfig({ startUrl: 'http://localhost:3100/', resourcePolicy: 'flexible' });
  const p = createPolicy(c);
  assert(p.navigation(c.startUrl).allow);
  for (const url of ['http://localhost:3101/', 'https://localhost:3100/', 'http://sub.localhost:3100/', 'file:///tmp/x']) assert(!p.navigation(url).allow);
  assert(!p.request({ url: 'http://localhost:3101/api/data', method: 'GET', type: 'fetch' }).allow);
  assert(p.request({ url: 'http://localhost:3101/app.js', method: 'GET', type: 'script' }).allow);
  const h = p.headers('http://localhost:3101/app.js', { Authorization: 'secret', Cookie: 'secret', Accept: '*/*' });
  assert.equal(h.Cookie, ''); assert(!h.Authorization); assert.equal(h.Accept, '*/*');
});

test('logout, write endpoints, GraphQL mutations, and live exclusions remain blocked', () => {
  const c = normalizeConfig({ startUrl: 'http://localhost:3100/' }), p = createPolicy(c);
  for (const pathname of ['/logout', '/auth/revoke', '/api/delete', '/api/save']) assert(!p.request({ url: new URL(pathname, c.startUrl).href, method: 'GET' }).allow);
  assert(!p.request({ url: c.startUrl + 'api/query', method: 'POST' }).allow);
  assert(!p.request({ url: c.startUrl + 'graphql', method: 'GET', postData: '{"query":"mutation { deleteUser }"}' }).allow);
  assert(!p.action({ excluded: true, label: '查看', tag: 'button' }).allow);
  assert.equal(graphqlOperation('{"query":"query Items { items { id } }"}').type, 'query');
});

test('shareable outputs redact secrets nested in journal-derived API and state samples', () => {
  const value = { reqHeaders: { Authorization: 'Bearer my-secret', Cookie: 'session=x' },
    source: { page: 'https://example.com/?token=hidden', control: 'user@example.com' },
    postData: '{"password":"pass-value","q":"ok"}' };
  const text = JSON.stringify(redact(value));
  for (const secret of ['my-secret', 'session=x', 'hidden', 'user@example.com', 'pass-value']) assert(!text.includes(secret));
  assert(text.includes('ok'));
});
