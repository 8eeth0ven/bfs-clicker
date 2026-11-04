import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redact } from './redact.js';

function atomicText(file, data) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try { writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function graphDot(graph) {
  const colors = { state: '#1d4ed8', action: '#7c3aed', api: '#047857', route: '#b45309', script: '#475569' };
  const rows = ['digraph website {', 'rankdir=LR;', 'node [shape=box,style="rounded",fontname="sans-serif"];'];
  for (const node of graph.nodes || []) rows.push(`${JSON.stringify(node.id)} [label=${JSON.stringify(`${node.type}: ${node.label || node.id}`)},color=${JSON.stringify(colors[node.type] || '#475569')}];`);
  for (const edge of graph.edges || []) rows.push(`${JSON.stringify(edge.source)} -> ${JSON.stringify(edge.target)} [label=${JSON.stringify(edge.label || edge.type)},style=${JSON.stringify(edge.observed&&edge.confidence==='observed' ? 'solid' : 'dashed')}];`);
  return rows.join('\n') + '\n}\n';
}
export function updateGraphRun(graph, run) {
  graph.run = { ...graph.run, status: run.status, stopReason: run.stopReason, finishedAt: run.finishedAt, elapsedMs: run.elapsedMs };
  graph.coverage = { ...graph.coverage, status: run.status, stopReason: run.stopReason, counts: run.counts, pending: run.pending };
  return graph;
}
export function writeSiteGraph(graph, directory, { assets = true } = {}) {
  mkdirSync(directory, { recursive: true });
  const view = redact(graph);
  try {
    if (assets) for (const name of ['graph.html', 'graph.js', 'graph.css']) {
      atomicText(path.join(directory, name), readFileSync(new URL('../view/' + name, import.meta.url)));
    }
    // The primary JSON is the commit marker and is published after auxiliary
    // files. A partial export must never leave a newly completed graph behind.
    atomicText(path.join(directory, 'graph.dot'), graphDot(view));
    atomicText(path.join(directory, 'graph.json'), JSON.stringify(view, null, 2) + '\n');
  } catch (error) {
    const failed = { ...view, run: { ...view.run }, coverage: { ...view.coverage, gaps: [...(view.coverage?.gaps || []), { reason: 'graph_export_failed' }] } };
    if (failed.run.status === 'completed') { failed.run.status = 'partial'; failed.run.stopReason = 'graph_export_failed'; }
    failed.coverage.status = failed.run.status; failed.coverage.stopReason = failed.run.stopReason;
    try { atomicText(path.join(directory, 'graph.json'), JSON.stringify(failed, null, 2) + '\n'); } catch { /* primary path may be unwritable too */ }
    throw error;
  }
  return { available: true, nodes: view.nodes?.length || 0, edges: view.edges?.length || 0, schemaVersion: view.schemaVersion };
}
