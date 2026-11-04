import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { normalizeConfig } from '../src/asset.js';
import { openStore } from '../src/store.js';
import { buildGraphForRun } from '../src/graph-run.js';
import { temp, json } from './helpers.mjs';
import { writeSiteGraph, graphDot } from '../src/graph-export.js';

test('offline graph replays durable journal without crawling, incrementing attempts or repairing input bytes', async t => {
  const dir = temp(t), cfg = normalizeConfig({ startUrl: 'http://127.0.0.1:1/', outputDir: dir });
  const store = openStore(cfg);
  const first = { id: 1, url: cfg.startUrl, title: '入口', fp: 'one', children: [], path: [], interactives: [], depth: 0, parentId: null };
  store.save({ states: [first], counters: { totalActions: 0 }, backEdges: [] });
  store.journal({ upsertStates: [{ ...first, children: [2] }, { ...first, id: 2, title: '展开', fp: 'two', parentId: 1, depth: 1,
    path: [{ id: 'expand', label: '展开', kind: 'click', fromStateId: 1 }] }], set: { counters: { totalActions: 1 } } });
  store.emit('state', { stateId: 2, url: cfg.startUrl, fp: 'two', parentId: 1 }); store.release();
  const journal = path.join(dir, 'private/checkpoint.journal.jsonl'); appendFileSync(journal, '{truncated');
  const before = readFileSync(journal), beforeMeta = json(path.join(dir, 'private/run.json'));
  const result = await buildGraphForRun(dir);
  assert.equal(result.available, true); assert.equal(result.status, 'partial');
  assert.deepEqual(readFileSync(journal), before);
  const afterMeta = json(path.join(dir, 'private/run.json'));
  assert.equal(afterMeta.attempts, beforeMeta.attempts); assert.equal(afterMeta.status, beforeMeta.status);
  const graph = json(path.join(dir, 'graph.json'));
  assert.equal(graph.nodes.filter(n => n.type === 'state').length, 2);
  assert(graph.coverage.gaps.some(g => g.reason === 'checkpoint_journal_incomplete_tail'));
  assert(!existsSync(path.join(dir, '.run.lock')));
});

test('offline graph refuses a run held by a live worker and leaves its metadata unchanged', async t => {
  const dir = temp(t), cfg = normalizeConfig({ startUrl: 'http://127.0.0.1:1/', outputDir: dir }), store = openStore(cfg);
  try {
    const before = readFileSync(path.join(dir, 'private/run.json'));
    await assert.rejects(buildGraphForRun(dir), /正在被/);
    assert.deepEqual(readFileSync(path.join(dir, 'private/run.json')), before);
    assert(!existsSync(path.join(dir, 'graph.json')));
  } finally { store.release(); }
});

test('offline graph refuses a checkpoint from a different target identity', async t => {
  const dir = temp(t), cfg = normalizeConfig({ startUrl: 'http://127.0.0.1:1/', outputDir: dir }), store = openStore(cfg);
  store.save({ states: [], backEdges: [] }); store.release();
  const file = path.join(dir, 'private/checkpoint.json'), cp = json(file);
  cp.identity.canonicalTarget = 'https://foreign.example/';
  const { writeFileSync } = await import('node:fs'); writeFileSync(file, JSON.stringify(cp));
  await assert.rejects(buildGraphForRun(dir), /checkpoint identity/);
  assert(!existsSync(path.join(dir, 'graph.json')));
});

test('DOT export preserves contextual dashed semantics and an auxiliary failure cannot publish a completed graph', async t => {
  const dir = temp(t), graph = { schemaVersion: 1, run: { status: 'completed' }, nodes: [{ id: 'a', type: 'action', label: '查询' }, { id: 'b', type: 'api', label: 'GET /api' }],
    edges: [{ id: 'e', source: 'a', target: 'b', observed: true, confidence: 'context', type: 'request' }], coverage: { status: 'completed', gaps: [] } };
  assert(graphDot(graph).includes('style="dashed"'));
  const { mkdirSync } = await import('node:fs'); mkdirSync(path.join(dir, 'graph.dot'));
  assert.throws(() => writeSiteGraph(graph, dir));
  const output = json(path.join(dir, 'graph.json'));
  assert.equal(output.run.status, 'partial'); assert.equal(output.run.stopReason, 'graph_export_failed');
  assert(output.coverage.gaps.some(g => g.reason === 'graph_export_failed'));
});
