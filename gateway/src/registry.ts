import path from 'node:path';
import { checkedPath, isDirectory } from './files.js';
import { loadManifest } from './manifest.js';
import { GatewayError, type GatewayConfig, type SourceSnapshot } from './types.js';

export class Registry {
  private snapshots = new Map<string, SourceSnapshot>();
  constructor(public readonly config: GatewayConfig) {}
  all(): SourceSnapshot[] { return [...this.snapshots.values()].sort((a,b) => a.id.localeCompare(b.id)); }
  get(id: string): SourceSnapshot {
    const s = this.snapshots.get(id);
    if (!s) throw new GatewayError('SOURCE_NOT_FOUND', '未知 source');
    return s;
  }
  async initialize(): Promise<void> {
    const ready = await Promise.all(this.config.sources.map(x => loadManifest(x, this.config)));
    this.snapshots = new Map(ready.map(s => [s.id, s]));
  }
  async addSource(requested: string, refreshed = this.config, beforeCommit?: (candidate:SourceSnapshot)=>Promise<void>): Promise<{source: SourceSnapshot; action: 'added'|'reloaded'|'unchanged'}> {
    const full = path.resolve(this.config.config_dir, requested);
    const canonical = await checkedPath(full, this.config.manifest_roots);
    const inputDirectory = await isDirectory(canonical);
    const key = inputDirectory ? path.join(canonical, 'source.json') : canonical;
    const matches = [];
    for (const binding of refreshed.sources) {
      let bound: string;
      try { bound = await checkedPath(binding.manifest, this.config.manifest_roots); }
      catch { continue; }
      const boundKey = await isDirectory(bound) ? path.join(bound, 'source.json') : bound;
      if (key === boundKey) matches.push(binding);
    }
    if (matches.length !== 1) throw new GatewayError('SOURCE_BINDING_REQUIRED', '清单路径必须有唯一的可信 source 绑定');
    const binding = matches[0];
    // Runtime additions may refresh source bindings; global limits/roots/method policy remain startup settings.
    const candidate = await loadManifest(binding, { ...this.config, sources: refreshed.sources });
    const old = this.snapshots.get(candidate.id);
    if (old && old.manifest_path !== candidate.manifest_path) throw new GatewayError('SOURCE_CONFLICT', '不能用其他目录覆盖已注册 source');
    if (old && old.app?.package_name !== candidate.app?.package_name) throw new GatewayError('SOURCE_CONFLICT', '不能替换 source 的应用身份');
    const action = !old ? 'added' : old.revision === candidate.revision ? 'unchanged' : 'reloaded';
    await beforeCommit?.(candidate);
    this.snapshots.set(candidate.id, candidate);
    return {source: candidate, action};
  }
}
