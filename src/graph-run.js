import { existsSync } from 'node:fs';
import path from 'node:path';
import { acquireLock, readAtomic, atomicJson, identity } from './store.js';
import { openCheckpointJournal } from './checkpoint.js';
import { buildSiteGraph } from './graph.js';
import { writeSiteGraph } from './graph-export.js';
import { redact } from './redact.js';

// Build from authoritative local evidence without navigating the target, running
// browser code, changing attempts or repairing the source checkpoint/journal.
export async function buildGraphForRun(directory) {
  const dir = path.resolve(directory);
  if (!existsSync(dir)) throw new Error('运行目录不存在: ' + dir);
  const release = acquireLock(path.join(dir, '.run.lock'), { task: 'graph_export' });
  try {
    const privateDir = path.join(dir, 'private');
    const metaFile = existsSync(path.join(privateDir, 'run.json')) ? path.join(privateDir, 'run.json') : path.join(dir, 'run.json');
    const meta = readAtomic(metaFile);
    const config = existsSync(path.join(privateDir, 'config.json')) ? readAtomic(path.join(privateDir, 'config.json'))
      : { startUrl: meta.asset, ...(meta.policy || {}), outputDir: dir };
    const checkpointFile = existsSync(path.join(privateDir, 'checkpoint.json')) || existsSync(path.join(privateDir, 'checkpoint.json.previous'))
      ? path.join(privateDir, 'checkpoint.json') : path.join(dir, 'checkpoint.json');
    const base = readAtomic(checkpointFile);
    if (!meta.identity || base.identity && Object.entries(meta.identity).some(([key, value]) => base.identity[key] !== value)) throw new Error('graph 不兼容: checkpoint identity 与任务不一致');
    if (existsSync(path.join(privateDir, 'config.json')) && Object.entries(identity(config)).some(([key, value]) => meta.identity[key] !== value)) throw new Error('graph 不兼容: config identity 与任务不一致');
    const recovered = openCheckpointJournal({ file: path.join(privateDir, 'checkpoint.journal.jsonl'), checkpointFile,
      checkpoint: base, identity: meta.identity, runId: meta.runId, readOnly: true });
    const checkpoint = recovered.checkpoint;
    const viewRun = { ...meta, ...(meta.status === 'running' ? { status: 'partial', stopReason: 'worker_interrupted' } : {}),
      coverageGaps: [...(meta.coverageGaps || []), ...recovered.notices.map(n => ({ reason: n.reason }))] };
    const graph = await buildSiteGraph({ states: checkpoint.states || [], backEdges: checkpoint.backEdges || [], run: viewRun, config,
      eventsFile: path.join(privateDir, 'events.jsonl'), trafficFile: path.join(privateDir, 'traffic.jsonl'), apis: checkpoint.apis || [] });
    const graphInfo = writeSiteGraph(graph, dir);
    const updated = { ...meta, graph: graphInfo };
    if (metaFile !== path.join(dir, 'run.json')) atomicJson(metaFile, updated);
    atomicJson(path.join(dir, 'run.json'), redact(updated));
    return { outputDir: dir, status: graph.run.status, ...graphInfo };
  } finally { release(); }
}
