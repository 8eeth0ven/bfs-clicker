import { loadConfig } from './config.js';
import { Registry } from './registry.js';
import { Discovery } from './discovery.js';
import { LearningStore } from './learning.js';
import { CredentialProvider } from './credentials.js';
import { Executor } from './executor.js';
import { GatewayError, type CallParams, type GatewayResult, type Method } from './types.js';

export interface CallEndpointInput {
  source: string;
  endpoint_id: string;
  expected_revision?: string;
  params?: CallParams;
}

/** The invocation/catalog layer is independent of any MCP SDK or transport. */
export async function createGatewayServices(configPath: string) {
  const config = await loadConfig(configPath);
  const credentials = new CredentialProvider();
  // Load secrets before any catalog projection, including hot-added sources.
  for (const binding of config.sources) await credentials.load(binding);
  const registry = new Registry(config);
  await registry.initialize();
  const learning = new LearningStore(config);
  await learning.initialize();
  const discovery = new Discovery(registry, learning, config, credentials.redactor);
  const executor = new Executor(config, credentials);

  async function callEndpoint(args: CallEndpointInput, signal?: AbortSignal): Promise<GatewayResult> {
    const source = registry.get(args.source);
    if (args.expected_revision && source.revision !== args.expected_revision)
      throw new GatewayError('SOURCE_CHANGED', '清单版本已变化，请重新发现参数');
    const endpoint = source.endpoints.find(item => item.id === args.endpoint_id);
    if (!endpoint) throw new GatewayError('ENDPOINT_NOT_FOUND', '当前清单中无此端点');
    if (!endpoint.methods.length) throw new GatewayError('METHOD_UNRESOLVED', '静态候选的 HTTP 方法尚未解析');
    const method = args.params?.method || (endpoint.methods.length === 1 ? endpoint.methods[0] : undefined);
    if (!method) throw new GatewayError('METHOD_REQUIRED', '多方法端点必须显式 params.method', { methods: endpoint.methods });
    const operation = endpoint.operations[method as Method];
    if (!operation) throw new GatewayError('METHOD_NOT_FOUND', '该端点没有指定方法', { methods: endpoint.methods });
    if (!operation.allowed)
      throw new GatewayError(operation.blocked_reason || 'METHOD_BLOCKED', '该操作被来源配置或beta能力护栏阻止');
    const result = await executor.execute(source, endpoint, operation, args.params || {}, signal);
    if (result.data) {
      const observed = await learning.observe(source.id, endpoint.id, operation, result.data.observation_status ?? null);
      result.data.health = observed.health;
      result.data.learning_persisted = observed.persisted;
      result.warnings.push(...observed.warnings);
      if (operation.provenance.includes('static_candidate') && !operation.provenance.includes('observed') && observed.health.state !== 'http_verified')
        result.warnings.push('未验证：此操作原始来源为静态候选');
      if (observed.health.state === 'not_found_suspected')
        result.warnings.push('连续404/410仅表示请求观察疑似失效，不证明路由已删除');
    }
    return credentials.redactor.result(result);
  }

  async function addSource(manifestPath: string): Promise<GatewayResult<{
    source: string; source_revision: string; endpoint_count: number;
    action: 'added' | 'reloaded' | 'unchanged'; resource_uri: string;
  }>> {
    const refreshed = await loadConfig(configPath);
    const result = await registry.addSource(manifestPath, refreshed, async candidate => {
      await credentials.load(candidate.binding);
    });
    return credentials.redactor.result({
      ok: true,
      data: {
        source: result.source.id,
        source_revision: result.source.revision,
        endpoint_count: result.source.endpoints.length,
        action: result.action,
        resource_uri: `inventory://sources/${encodeURIComponent(result.source.id)}/manifest.json`,
      },
      error: null,
      warnings: result.source.warnings,
    });
  }

  return { config, registry, discovery, learning, credentials, callEndpoint, addSource };
}
