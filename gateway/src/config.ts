import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { GatewayError, METHODS, type GatewayConfig } from './types.js';

const origin = z.string().transform((value, ctx) => {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error();
    return u.origin;
  } catch { ctx.addIssue({ code: 'custom', message: '必须为完整 HTTP(S) origin' }); return z.NEVER; }
});
const bindingSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  manifest: z.string().min(1), credentials: z.string().min(1).optional(),
  allowed_origins: z.array(origin).optional(), credential_origins: z.array(origin).optional(),
  base_url: z.string().url().optional(), static_headers: z.record(z.string(), z.string()).optional(),
  defaults: z.record(z.string(), z.any()).optional(), schema_overrides: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  public: z.boolean().default(false), kind: z.enum(['web', 'apk']).optional()
}).strict();
const schema = z.object({
  manifest_roots: z.array(z.string()).min(1), state_dir: z.string().default('./state'),
  sources: z.array(bindingSchema),
  timeout_ms: z.number().int().min(100).max(300000).default(10000),
  max_body_bytes: z.number().int().min(64).max(8 * 1024 * 1024).default(32768),
  max_catalog_bytes: z.number().int().min(1024).max(8 * 1024 * 1024).default(131072),
  success_threshold: z.number().int().min(1).max(100).default(3),
  missing_threshold: z.number().int().min(1).max(100).default(3),
  methods: z.object({
    allow_non_get: z.boolean().default(false),
    allow: z.array(z.object({ source: z.string(), endpoint_id: z.string().regex(/^ep_[a-f0-9]{64}$/), method: z.enum(METHODS) }).strict()).default([])
  }).strict().default({ allow_non_get: false, allow: [] })
}).strict();

export async function loadConfig(filename: string): Promise<GatewayConfig> {
  let raw: unknown;
  const absolute = path.resolve(filename);
  try { raw = parse(await readFile(absolute, 'utf8')); }
  catch { throw new GatewayError('CONFIG_INVALID', '无法读取或解析网关配置'); }
  const checked = schema.safeParse(raw);
  if (!checked.success) throw new GatewayError('CONFIG_INVALID', '网关配置不符合 schema', { fields: checked.error.issues.map(x => x.path.join('.')) });
  const c = checked.data;
  const ids = new Set(c.sources.map(x => x.id));
  if (ids.size !== c.sources.length) throw new GatewayError('CONFIG_INVALID', 'source id 重复');
  for (const s of c.sources) {
    if (s.credentials && s.public) throw new GatewayError('CONFIG_INVALID', '同一 source 不能同时 public 和绑定凭据');
    if (s.credentials && !s.credential_origins?.length) throw new GatewayError('CONFIG_INVALID', '绑定凭据时必须声明 credential_origins');
    if (!s.credentials && !s.public) throw new GatewayError('CONFIG_INVALID', '无凭据的来源必须显式 public: true');
    if (Object.keys(s.static_headers || {}).some(name => /(?:^|[-_])(?:authorization|cookie|set[-_]?cookie|token|(?:access|refresh|auth|csrf|xsrf)[-_]?token|api[-_]?key|session(?:[-_]?id)?|jwt|secret|password)(?:$|[-_])/i.test(name)))
      throw new GatewayError('CONFIG_INVALID', '认证请求头必须放入独立 credentials 配置，不能使用 static_headers');
  }
  const config_dir = path.dirname(absolute);
  return {
    ...c, config_dir,
    manifest_roots: c.manifest_roots.map(x => path.resolve(config_dir, x)),
    state_dir: path.resolve(config_dir, c.state_dir),
    sources: c.sources.map(x => ({ ...x, manifest: path.resolve(config_dir, x.manifest), credentials: x.credentials ? path.resolve(config_dir, x.credentials) : undefined }))
  };
}
