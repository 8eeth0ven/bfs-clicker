import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { webRunInventory } from '../src/web-adapter.js';
import { createGatewayServices } from '../src/services.js';
import { loadConfig } from '../src/config.js';
import { loadManifest, endpointId } from '../src/manifest.js';
// Use the crawler's actual serializer: its aggregate arrays differ from wire query arrays.
import { createApiLedger, observeApi, ledgerView } from '../../src/cdpnet.js';

async function fixture(t: any, rows: any[] = [], traffic?: any[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'run'); await mkdir(path.join(runDir, 'private'), { recursive: true });
  await writeFile(path.join(runDir, 'private/apis.json'), JSON.stringify(rows));
  if (traffic) await writeFile(path.join(runDir, 'private/traffic.jsonl'), traffic.map(row => JSON.stringify(row)).join('\n') + (traffic.length ? '\n' : ''));
  return { root, runDir, async convert(sourceId = 'web_demo') { return webRunInventory({ runDir, sourceId }); } };
}
function ledger(observations: any[]) {
  const result = createApiLedger();
  for (const item of observations) observeApi(result, { maxSamples: 20, ...item });
  return ledgerView(result);
}
const observed = (url: string, extra: any = {}) => ({ method: 'GET', url, type: 'fetch', source: { kind: 'page', page: 'https://site.test/', stateId: 1, actionId: '#load' },
  category: 'observed_request', evidenceId: 'ev-response-1', status: 200, ...extra });
const traffic = (url: string, extra: any = {}) => ({ evidenceId: 'ev-response-1', requestEvidenceId: 'ev-request-1', ts: 1, session_id: 'run-fixture', authEpoch: 1,
  method: 'GET', url, status: 200, contentType: 'application/json', resourceType: 'fetch', reqHeaders: {}, postData: null, respHeaders: {}, source: { stateId: 1, actionId: '#load' }, body: '{"secret":"response-value"}', ...extra });

async function normalized(f: Awaited<ReturnType<typeof fixture>>, manifest: any) {
  const file = path.join(f.root, 'manifest.json'); await writeFile(file, JSON.stringify(manifest));
  const cfg = path.join(f.root, 'gateway.json');
  await writeFile(cfg, JSON.stringify({ manifest_roots: [f.root], state_dir: path.join(f.root, 'state'), sources: [{ id: 'web_demo', kind: 'web', manifest: file, public: true }] }));
  const config = await loadConfig(cfg);
  return loadManifest(config.sources[0], config);
}

test('actual Web ledger serializer converts response evidence and repeat-key query without retaining values', async t => {
  const url = 'https://api.test/items?tag=red&tag=blue&token=private-query-value';
  const f = await fixture(t, ledger([observed(url)]), [traffic(url, { reqHeaders: { Authorization: 'Bearer private-header-value', Cookie: 'sid=private-cookie-value' } })]);
  const before = await readFile(path.join(f.runDir, 'private/apis.json'));
  const result = await f.convert();
  assert.equal(result.manifest.endpoints.length, 1);
  const row = result.manifest.endpoints[0];
  assert.equal(row.url, 'https://api.test/items'); assert.equal(row.method, 'GET');
  assert.deepEqual(row.categories, ['observed']); assert.deepEqual(row.evidence_ids, ['ev-response-1']);
  assert.equal(row.query_shape.properties.tag.type, 'array'); assert.equal(row.query_shape.properties.token.type, 'string');
  assert.doesNotMatch(JSON.stringify(result), /private-query-value|private-header-value|private-cookie-value|response-value|red|blue/);
  assert.deepEqual(await readFile(path.join(f.runDir, 'private/apis.json')), before);
  const source = await normalized(f, result.manifest); assert.equal(source.endpoints[0].operations.GET!.allowed, true);
  assert.equal(source.endpoints[0].operations.GET!.params_schema.properties.query.properties.tag.anyOf[0].type, 'array');
});

test('aggregated ledger value samples never become repeated query wire parameters', async t => {
  const rows = ledger([observed('https://api.test/items?page=one'), observed('https://api.test/items?page=two', { evidenceId: 'ev-2' })]);
  const f = await fixture(t, rows), result = await f.convert();
  assert.ok(result.manifest.endpoints.every(row => row.query_shape.properties.page.type === 'string'));
  assert.doesNotMatch(JSON.stringify(result), /"one"|"two"/);
});

test('JSON bodies retain nested numeric/boolean/null/array shapes but no samples or inferred requiredness', async t => {
  const url = 'https://api.test/search';
  const body = JSON.stringify({ count: 2, active: true, tags: ['private-tag'], nullable: null, nested: { note: 'private-note' } });
  const f = await fixture(t, ledger([observed(url, { method: 'POST', postData: body })]), [traffic(url, { method: 'POST', postData: body, reqHeaders: { 'Content-Type': 'application/json; charset=utf-8' } })]);
  const result = await f.convert(), row = result.manifest.endpoints[0];
  assert.equal(row.body_capture, 'shape_only'); assert.equal(row.body_shape.properties.count.type, 'number');
  assert.equal(row.body_shape.properties.active.type, 'boolean'); assert.equal(row.body_shape.properties.nullable.type, 'null');
  assert.equal(row.body_shape.properties.tags.type, 'array'); assert.equal(row.body_shape.required, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-tag|private-note|charset/);
  const source = await normalized(f, result.manifest), op = source.endpoints[0].operations.POST!;
  assert.equal(op.body_encoding, 'json'); assert.equal(op.allowed, false);
  assert.equal(op.params_schema.properties.body.properties.nested.properties.note.type, 'string');
});

test('traffic request Content-Type resolves form encoding; response JSON type is not mistaken for request encoding', async t => {
  const url = 'https://api.test/form', body = 'tag=a&tag=b&name=private-name';
  const f = await fixture(t, ledger([observed(url, { method: 'POST', postData: body })]), [traffic(url, { method: 'POST', postData: body, reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' } })]);
  const result = await f.convert(), source = await normalized(f, result.manifest), op = source.endpoints[0].operations.POST!;
  assert.equal(result.manifest.endpoints.length, 1); assert.equal(op.body_encoding, 'form');
  assert.equal(op.params_schema.properties.body.properties.tag.type, 'array');
  assert.doesNotMatch(JSON.stringify(result), /private-name/);
  assert.ok(!result.gaps.some(gap => gap.reason === 'request_body_encoding_unknown'));
});

test('unknown static method stays unresolved; attempted, blocked and failed requests do not become observed operations', async t => {
  const rows = ledger([
    { method: 'unknown', url: 'https://api.test/static?q=secret-static-value', source: { kind: 'document', document: 'https://site.test/app.js?token=secret-source-value' }, category: 'static_candidate', evidenceId: 'ev-static' },
    observed('https://api.test/attempt', { category: 'attempted_request', status: null, evidenceId: 'ev-attempt' }),
    observed('https://api.test/blocked', { category: 'blocked_request', status: 0, evidenceId: 'ev-blocked' }),
  ]);
  const f = await fixture(t, rows, [traffic('https://api.test/failed', { status: 0, failed: 'net::ERR_CONNECTION_CLOSED' })]);
  const result = await f.convert(); assert.equal(result.manifest.endpoints.length, 1);
  assert.equal(result.manifest.endpoints[0].method, null); assert.deepEqual(result.manifest.endpoints[0].categories, ['static_candidate']);
  assert.doesNotMatch(JSON.stringify(result), /secret-static-value|secret-source-value/);
  for (const reason of ['attempted_request_not_observed', 'blocked_request_not_observed', 'failed_request_not_observed']) assert.ok(result.gaps.some(gap => gap.reason === reason));
  const source = await normalized(f, result.manifest); assert.deepEqual(source.endpoints[0].methods, []);
});

test('real HTTP 404/500 are observed responses; navigation/static resources are not API operations', async t => {
  const f = await fixture(t, ledger([observed('https://site.test/', { type: 'document' })]), [
    traffic('https://site.test/', { resourceType: 'document', contentType: 'text/html' }),
    traffic('https://site.test/app.js', { resourceType: 'script' }),
    traffic('https://api.test/missing', { status: 404 }), traffic('https://api.test/error', { status: 500, evidenceId: 'ev-500' }),
  ]);
  const result = await f.convert(); assert.deepEqual(result.manifest.endpoints.map(row => row.url), ['https://api.test/error', 'https://api.test/missing']);
  assert.ok(result.manifest.endpoints.every(row => row.categories.includes('observed')));
});

test('captureTraffic-disabled ledger fallback keeps observed category and reports missing sampled response evidence', async t => {
  const f = await fixture(t, [{ method: 'GET', url: 'https://api.test/items', categories: ['attempted_request', 'observed_request'], sources: [], samples: [], query: { q: ['redacted'] }, body: {} }]);
  const result = await f.convert(); assert.equal(result.manifest.endpoints[0].observation_basis, 'ledger_category');
  assert.ok(result.gaps.some(gap => gap.reason === 'response_evidence_not_sampled'));
  assert.doesNotMatch(JSON.stringify(result), /"redacted"/);
});

test('traffic-only saved run recovers a response without requiring an exported ledger', async t => {
  const f = await fixture(t, [], [traffic('https://api.test/only?tag=a&tag=b')]);
  await rm(path.join(f.runDir, 'private/apis.json'));
  const result = await f.convert(); assert.equal(result.manifest.endpoints.length, 1);
  assert.equal(result.manifest.endpoints[0].query_shape.properties.tag.type, 'array');
});

test('truncated/malformed JSONL tail remains unchanged and yields an honest gap', async t => {
  const f = await fixture(t, []), file = path.join(f.runDir, 'private/traffic.jsonl');
  const bytes = JSON.stringify(traffic('https://api.test/valid')) + '\n{"url":'; await writeFile(file, bytes);
  const result = await f.convert(); assert.equal(result.manifest.endpoints.length, 1);
  assert.ok(result.gaps.some(gap => gap.reason === 'traffic_missing_final_newline'));
  assert.ok(result.gaps.some(gap => gap.reason === 'traffic_malformed_line'));
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('private evidence symlink escape, invalid identity and malformed ledger reject without modification', async t => {
  const f = await fixture(t), file = path.join(f.runDir, 'private/apis.json'), outside = path.join(f.root, 'outside.json');
  await writeFile(outside, '[]'); await rm(file); await symlink(outside, file);
  await assert.rejects(f.convert(), { code: 'WEB_EVIDENCE_PATH_BLOCKED' });
  await assert.rejects(f.convert('../bad'), { code: 'SOURCE_INVALID' });
  await rm(file); await writeFile(file, '{}'); await assert.rejects(f.convert(), { code: 'WEB_LEDGER_INVALID' });
});

test('bounded evidence samples and oversized line do not prevent later complete response recovery', async t => {
  const f = await fixture(t, []), file = path.join(f.runDir, 'private/traffic.jsonl');
  const rows = Array.from({ length: 80 }, (_, n) => JSON.stringify(traffic('https://api.test/items', { evidenceId: 'ev-' + n })));
  await writeFile(file, 'x'.repeat(2 * 1024 * 1024 + 1) + '\n' + rows.join('\n') + '\n');
  const result = await f.convert(), row = result.manifest.endpoints[0];
  assert.equal(row.evidence_ids.length, 64); assert.equal(row.evidence_ids_truncated, true);
  assert.ok(result.gaps.some(gap => gap.reason === 'traffic_line_budget'));
});

test('service layer calls generated Web inventory and a mobile manifest, preserves schemas/revisions/health/secrets', async t => {
  const received: any[] = [];
  const http = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    received.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { http.closeAllConnections(); http.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(http.address() as any).port}`;
  const f = await fixture(t, ledger([observed(origin + '/items?page=sample')]), [traffic(origin + '/items?page=sample')]);
  const generated = await f.convert(), manifest = path.join(f.root, 'web.json'); await writeFile(manifest, JSON.stringify(generated.manifest));
  const mobile = path.join(f.root, 'mobile'); await mkdir(mobile);
  await writeFile(path.join(mobile, 'source.json'), JSON.stringify({ format: 'endpoint-inventory', schema_version: '1.1', source_id: 'mobile_demo', kind: 'apk', inventory: 'endpoints.static.json', app: { package_name: 'com.example.demo' } }));
  await writeFile(path.join(mobile, 'endpoints.static.json'), JSON.stringify([{ method: 'GET', url: origin + '/mobile', headers: {}, query: {}, body: null, categories: ['static_candidate'], source: 'dex' }]));
  await writeFile(path.join(f.root, 'credentials.yaml'), 'mode: token\ntoken: private-runtime-credential\n');
  const config = path.join(f.root, 'gateway.json');
  await writeFile(config, JSON.stringify({ manifest_roots: [f.root], state_dir: path.join(f.root, 'state'), success_threshold: 1, sources: [
    { id: 'web_demo', manifest, kind: 'web', credentials: './credentials.yaml', credential_origins: [origin], allowed_origins: [origin] },
    { id: 'mobile_demo', manifest: mobile, kind: 'apk', public: true, allowed_origins: [origin] },
  ] }));
  const services = await createGatewayServices(config);
  const ep = services.registry.get('web_demo').endpoints[0], revision = services.registry.get('web_demo').revision;
  await assert.rejects(services.callEndpoint({ source: 'web_demo', endpoint_id: ep.id, params: { query: { page: { invalid: true } as any } } }), { code: 'PARAMS_INVALID' });
  assert.equal(received.length, 0);
  const result = await services.callEndpoint({ source: 'web_demo', endpoint_id: ep.id, expected_revision: revision, params: { query: { page: '2' } } });
  assert.equal(result.ok, true); assert.equal(result.data.health.state, 'http_verified'); assert.equal(received[0].url, '/items?page=2');
  assert.equal(received[0].authorization, 'Bearer private-runtime-credential'); assert.doesNotMatch(JSON.stringify(result), /private-runtime-credential/);
  const mobileEp = services.registry.get('mobile_demo').endpoints[0];
  const mobileResult = await services.callEndpoint({ source: 'mobile_demo', endpoint_id: mobileEp.id });
  assert.equal(mobileResult.ok, true); assert.deepEqual(mobileResult.data.provenance, ['static_candidate']);
  generated.manifest.endpoints.push({ method: 'GET', url: origin + '/new', headers: {}, query: {}, body: null, categories: ['static_candidate'] });
  await writeFile(manifest, JSON.stringify(generated.manifest));
  assert.equal((await services.addSource(manifest)).data!.action, 'reloaded');
  await assert.rejects(services.callEndpoint({ source: 'web_demo', endpoint_id: ep.id, expected_revision: revision }), { code: 'SOURCE_CHANGED' });
  assert.equal(endpointId('web_demo', origin, '/items'), ep.id);
});
