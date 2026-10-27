import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GatewayConfig, Health, Operation } from './types.js';

const initial = (): Health => ({ state: 'unverified', success_streak: 0, missing_streak: 0, last_status: null, evidence_scope: 'request_observations' });
interface Entry { contract_revision: string; health: Health }
export class LearningStore {
  private entries: Record<string, Entry> = Object.create(null);
  private queue: Promise<void> = Promise.resolve();
  private readonly filename: string;
  private loadWarning = false;
  constructor(private readonly config: GatewayConfig) { this.filename = path.join(config.state_dir, 'health.json'); }
  async initialize(): Promise<void> {
    try {
      const text = await readFile(this.filename, 'utf8');
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error();
      const raw = JSON.parse(text);
      if (raw.schema_version !== 1 || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error();
      for (const [k,v] of Object.entries(raw.entries) as [string, any][]) {
        const h = v?.health;
        if (!/^[A-Za-z0-9_.-]+:ep_[a-f0-9]{64}:(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(k) || typeof v.contract_revision !== 'string' || !h || !['unverified','http_verified','not_found_suspected'].includes(h.state) || !Number.isInteger(h.success_streak) || !Number.isInteger(h.missing_streak) || h.success_streak < 0 || h.missing_streak < 0) throw new Error();
        this.entries[k] = {contract_revision: v.contract_revision, health: {state:h.state,success_streak:h.success_streak,missing_streak:h.missing_streak,last_status: typeof h.last_status === 'number' ? h.last_status : null,evidence_scope:'request_observations',updated_at:typeof h.updated_at === 'string' ? h.updated_at : undefined}};
      }
    } catch (e: any) {
      this.entries = Object.create(null);
      if (e?.code !== 'ENOENT') this.loadWarning = true;
    }
  }
  get(source: string, id: string, op: Operation): Health {
    const existing = this.entries[`${source}:${id}:${op.method}`];
    return existing?.contract_revision === op.contract_revision ? structuredClone(existing.health) : initial();
  }
  async observe(source: string, id: string, op: Operation, status: number | null): Promise<{health:Health; persisted:boolean; warnings:string[]}> {
    let result!: {health:Health; persisted:boolean; warnings:string[]};
    const task = this.queue.then(async () => {
      const health = this.get(source,id,op);
      health.last_status = status;
      health.updated_at = new Date().toISOString();
      health.success_streak = status !== null && status >= 200 && status < 300 ? health.success_streak + 1 : 0;
      health.missing_streak = status === 404 || status === 410 ? health.missing_streak + 1 : 0;
      if (health.success_streak >= this.config.success_threshold) health.state = 'http_verified';
      if (health.missing_streak >= this.config.missing_threshold) health.state = 'not_found_suspected';
      this.entries[`${source}:${id}:${op.method}`] = {contract_revision:op.contract_revision, health};
      let persisted = true;
      const temporary = this.filename + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(this.config.state_dir,{recursive:true,mode:0o700});
        await writeFile(temporary,JSON.stringify({schema_version:1,entries:this.entries}),{mode:0o600});
        await rename(temporary,this.filename);
      } catch { persisted = false; }
      result = {health: structuredClone(health), persisted, warnings:[...(this.loadWarning ? ['LEARNING_STATE_INVALID'] : []), ...(!persisted ? ['LEARNING_PERSIST_FAILED'] : [])]};
    });
    this.queue = task.catch(() => {});
    await task;
    return result;
  }
}
