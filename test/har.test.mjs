import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildHarFromTraffic } from '../src/har.js';
import { temp, json } from './helpers.mjs';

test('HAR preserves body omission reason, source action and digest without leaking public bodies or credentials', async t => {
  const dir = temp(t), traffic = path.join(dir, 'traffic.jsonl');
  const entries = [{ method: 'GET', url: 'https://example.com/image', status: 200, contentType: 'image/png', respBytes: 100,
    bodyOmitted: true, bodyReason: 'binary_body_not_captured', source: { kind: 'page', page: 'https://example.com/', actionId: 'a1' }, evidenceId: 'r1', requestEvidenceId: 'q1' },
  { method: 'GET', url: 'https://example.com/api/data', status: 200, contentType: 'application/json', respBytes: 10,
    body: '{"secret":"private-body"}', bodyOmitted: false, responseDigest: 'sha256', reqHeaders: { Authorization: 'Bearer test-secret' }, evidenceId: 'r2' }];
  writeFileSync(traffic, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const privateFile = path.join(dir, 'private.har'), publicFile = path.join(dir, 'public.har');
  assert.equal(await buildHarFromTraffic(traffic, privateFile), 2);
  assert.equal(await buildHarFromTraffic(traffic, publicFile, { redacted: true }), 2);
  const own = json(privateFile).log.entries, shared = json(publicFile).log.entries;
  assert.equal(own[0].response.content._bodyReason, 'binary_body_not_captured');
  assert.equal(own[0]._source.actionId, 'a1'); assert.equal(own[0]._requestEvidenceId, 'q1');
  assert.equal(own[1]._responseDigest, 'sha256'); assert(own[1].response.content.text.includes('private-body'));
  const text = JSON.stringify(shared); assert(!text.includes('private-body')); assert(!text.includes('test-secret'));
  assert(shared.every(e => e.response.content._bodyOmittedForSharing));
});

test('streaming HAR keeps valid records around malformed lines and reports the bad line', async t => {
  const dir = temp(t), traffic = path.join(dir, 'traffic.jsonl'), errors = [];
  writeFileSync(traffic, '{"method":"GET","url":"https://example.com/","status":200}\n{broken\n{"method":"GET","url":"https://example.com/api","status":204}\n');
  const output = path.join(dir, 'out.har');
  assert.equal(await buildHarFromTraffic(traffic, output, { onError: (error, line) => errors.push(line) }), 2);
  assert.deepEqual(errors, [2]); assert.equal(json(output).log.entries.length, 2);
});
