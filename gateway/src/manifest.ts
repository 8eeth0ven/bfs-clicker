import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import path from 'node:path';
import { checkedPath, isDirectory, readJsonLimited, readJsonWithDigest, within } from './files.js';
import { GatewayError, METHODS, SOURCE_KINDS, EXTRACTION_SOURCES, type AppMetadata, type SourceKind, type Endpoint, type GatewayConfig, type Method, type Operation, type Schema, type SourceBinding, type SourceSnapshot } from './types.js';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const endpointId = (source: string, origin: string, pathname: string): string => 'ep_' + digest(['endpoint-v1', source, origin, pathname]);
const cap = (v: unknown, n = 2000) => typeof v === 'string' ? v.slice(0, n) : '';
const unique = <T>(v: T[]) => [...new Set(v)];
const scalar = (v: unknown): string => v === null ? 'null' : typeof v === 'number' && Number.isFinite(v) ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
const emptyObj = (): Schema => ({ type: 'object', properties: {}, additionalProperties: false });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
function safeName(name: string): void {
  if (forbiddenKeys.has(name) || name.length > 256 || /[\u0000-\u001f]/.test(name)) throw new GatewayError('MANIFEST_INVALID', '参数名无效');
}
function sampleSchema(value: unknown, depth = 0): Schema {
  if (depth > 8) return {};
  if (Array.isArray(value)) {
    let items: Schema | undefined;
    for (const v of value.slice(0, 100)) items = mergeSchema(items, sampleSchema(v, depth + 1));
    return { type: 'array', items: items || {} };
  }
  if (isObject(value)) {
    if (Object.keys(value).length > 500) throw new GatewayError('SCHEMA_TOO_LARGE', '请求体样例字段过多');
    const properties: Record<string, Schema> = Object.create(null);
    for (const [k, v] of Object.entries(value)) { safeName(k); properties[k] = sampleSchema(v, depth + 1); }
    return { type: 'object', properties, additionalProperties: false };
  }
  return { type: scalar(value) };
}
function mergeSchema(a: Schema | undefined, b: Schema): Schema {
  if (!a || !Object.keys(a).length) return b;
  if (!Object.keys(b).length) return a;
  if (a.type === 'object' && b.type === 'object') {
    const properties = { ...a.properties };
    for (const [k, v] of Object.entries(b.properties || {})) properties[k] = mergeSchema(properties[k], v as Schema);
    return { type: 'object', properties, additionalProperties: false };
  }
  if (a.type === 'array' && b.type === 'array') return { type: 'array', items: mergeSchema(a.items, b.items) };
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const variants = unique([...(a.anyOf || [a]), ...(b.anyOf || [b])].map((x: any) => JSON.stringify(x))).map(x => JSON.parse(x));
  return { anyOf: variants };
}
function queryValueSchema(value: any): Schema {
  const type = Array.isArray(value) ? 'array' : scalar(value);
  if (type === 'array') {
    const types = unique(value.map(scalar).filter((x: string) => x !== 'null'));
    return { anyOf: [{ type: 'array', items: { type: types.length ? types : ['string','number','boolean'] } }, { type: 'null' }] };
  }
  return { type: unique([type, 'null']) };
}
function queryValues(raw: any, url: URL): Record<string, any> {
  const values: Record<string, any> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    safeName(key);
    if (Object.hasOwn(values, key)) values[key] = [...(Array.isArray(values[key]) ? values[key] : [values[key]]), value];
    else values[key] = value;
  }
  if (raw !== undefined && raw !== null && !isObject(raw)) throw new GatewayError('MANIFEST_INVALID', 'query 必须为对象');
  for (const [k, v] of Object.entries(raw || {})) {
    safeName(k);
    if ((isObject(v)) || (Array.isArray(v) && v.some(x => isObject(x) || Array.isArray(x)))) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING', '嵌套 query 必须显式配置编码');
    values[k] = v;
  }
  return values;
}
function shapeSchema(value: unknown, depth = 0): Schema {
  if (!isObject(value) || depth > 12) throw new GatewayError('MANIFEST_INVALID', 'body_shape 必须为受限 JSON schema');
  const out: Schema = {};
  const allowed = ['string','number','integer','boolean','null','object','array'];
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || types.some(t => !allowed.includes(t))) throw new GatewayError('MANIFEST_INVALID', 'body_shape type 无效');
    out.type = Array.isArray(value.type) ? unique(types) : value.type;
  }
  if (value.properties !== undefined) {
    if (!isObject(value.properties) || Object.keys(value.properties).length > 500) throw new GatewayError('SCHEMA_TOO_LARGE', 'body_shape properties 无效或过大');
    out.properties = Object.create(null);
    for (const [name,spec] of Object.entries(value.properties)) { safeName(name); out.properties[name] = shapeSchema(spec,depth+1); }
    out.additionalProperties = value.additionalProperties === true;
  }
  if (value.items !== undefined) out.items = shapeSchema(value.items,depth+1);
  if (value.anyOf !== undefined) {
    if (!Array.isArray(value.anyOf) || value.anyOf.length > 16) throw new GatewayError('SCHEMA_TOO_LARGE', 'body_shape anyOf 无效或过大');
    out.anyOf = value.anyOf.map((x:any) => shapeSchema(x,depth+1));
  }
  // Samples describe observed shapes, never global required/default/enum constraints or external refs.
  if (!Object.keys(out).length && Object.keys(value).some(k=>!['required','description','title','additionalProperties'].includes(k))) throw new GatewayError('MANIFEST_INVALID', 'body_shape 包含不支持的约束');
  return out;
}
function declaredNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 500) throw new GatewayError('SCHEMA_TOO_LARGE', '参数声明过多');
  return unique(value.map(x=>typeof x==='string'?x:isObject(x)?x.name:null).filter((x):x is string=>typeof x==='string').map(x=>{safeName(x);return x;}));
}
function withoutNull(schema:Schema):Schema|undefined {
  if (schema.anyOf) {const variants=schema.anyOf.map(withoutNull).filter(Boolean);return variants.length?{anyOf:variants}:undefined;}
  if (schema.type==='null')return undefined;
  if (Array.isArray(schema.type)) {const types=schema.type.filter((x:string)=>x!=='null');return types.length?{...schema,type:types}:undefined;}
  return schema;
}
function variants(record:any):Record<string,any>[] {return Array.isArray(record.parameter_variants)?record.parameter_variants.slice(0,16).filter(isObject):[];}
function mergeQueryVariants(record:any,querySchema:Schema):void {
  // These are evidence shapes; values are consumed only to infer types and never retained.
  for(const variant of variants(record)){
    for(const [name,value]of Object.entries(queryValues(variant.query,new URL('https://inventory.invalid/'))))querySchema.properties[name]=mergeSchema(querySchema.properties[name],queryValueSchema(value));
    if(variant.query_shape){const shape=shapeSchema(variant.query_shape);for(const [name,spec]of Object.entries(shape.properties||{})){safeName(name);querySchema.properties[name]=mergeSchema(querySchema.properties[name],mergeSchema(spec as Schema,{type:'null'}));}}
  }
}
function normalizeURL(raw: string, base?: string): {url: URL; pathname: string} {
  // Templates are allowed only in path/query, never in authority.
  if (raw.length > 16384 || /[\r\n\u0000]/.test(raw)) throw new GatewayError('MANIFEST_INVALID', 'URL 无效');
  let u: URL;
  try { u = new URL(raw, base); } catch { throw new GatewayError('MANIFEST_INVALID', '接口必须是完整 URL 或有可信 base_url'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || /[{}]/.test(u.host) || u.hash) throw new GatewayError('MANIFEST_INVALID', '接口 URL 不允许该协议、凭据或 fragment');
  let pathname = u.pathname.replace(/%7B([A-Za-z_][A-Za-z0-9_]*)%7D/gi, '{$1}');
  pathname = pathname.replace(/(^|\/):([A-Za-z_][A-Za-z0-9_]*)(?=\/|$)/g, '$1{$2}');
  if (/[{}]/.test(pathname.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''))) throw new GatewayError('MANIFEST_INVALID', '路径模板语法不支持');
  return { url: u, pathname };
}
function isAllowed(config: GatewayConfig, source: string, id: string, method: Method, encoding: string): boolean {
  if (encoding === 'unsupported') return false;
  return method === 'GET' || (config.methods.allow_non_get && config.methods.allow.some(x => x.source === source && x.endpoint_id === id && x.method === method));
}
function bodyEncoding(raw: any, binding: SourceBinding): Operation['body_encoding'] {
  const entries = Object.entries({ ...(raw.headers || {}), ...(binding.static_headers || {}) });
  const content = String(entries.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '').toLowerCase();
  if (content.includes('multipart/') || content.includes('octet-stream') || content.includes('protobuf')) return 'unsupported';
  if (content.includes('x-www-form-urlencoded')) return 'form';
  if (content.startsWith('text/')) return 'text';
  return 'json';
}
function provenance(raw: any): string[] {
  const category = Array.isArray(raw.categories) ? raw.categories.filter((x: unknown) => typeof x === 'string') : [];
  const values = unique([...(Array.isArray(raw.provenance) ? raw.provenance : typeof raw.provenance === 'string' ? [raw.provenance] : []), ...category, raw.source].filter(x => x === 'static_candidate' || x === 'observed'));
  if (!values.length) throw new GatewayError('MANIFEST_INVALID', '端点缺少 static_candidate/observed 来源分类');
  return values;
}
function unresolvedCandidate(record:any,url:URL,pathname:string,p:string[],channel:string,location:string,reason:string):any {
  const schema:Schema={type:'object',properties:{path:emptyObj(),query:emptyObj()},additionalProperties:false};
  const pathSchema=schema.properties.path,querySchema=schema.properties.query;
  const pathNames=unique([...pathname.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match=>match[1]));
  for(const name of pathNames){safeName(name);pathSchema.properties[name]={type:['string','number']};}
  if(pathNames.length){pathSchema.required=pathNames;schema.required=['path'];}
  for(const [name,value] of Object.entries(queryValues(record.query,url))){
    querySchema.properties[name]=queryValueSchema(value);
    if(typeof value==='string'&&/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)){
      querySchema.required=unique([...(querySchema.required||[]),name]);schema.required=unique([...(schema.required||[]),'query']);
    }
  }
  for(const name of declaredNames(record.parameters?.query))if(!querySchema.properties[name])querySchema.properties[name]={anyOf:[{type:['string','number','boolean','null']},{type:'array',items:{type:['string','number','boolean']}}]};
  if(record.query_shape){const shape=shapeSchema(record.query_shape);for(const [name,spec]of Object.entries(shape.properties||{})){safeName(name);querySchema.properties[name]=mergeSchema(querySchema.properties[name],mergeSchema(spec as Schema,{type:'null'}));}}
  mergeQueryVariants(record,querySchema);
  for(const name of querySchema.required||[])querySchema.properties[name]=withoutNull(querySchema.properties[name])||{};
  const parameter_summary:any[]=[];
  for(const place of ['path','query'])for(const [name,spec]of Object.entries(schema.properties[place].properties))parameter_summary.push({in:place,name,type:(spec as Schema).type||'union',required:!!schema.properties[place].required?.includes(name)});
  for(const name of declaredNames(record.parameters?.headers))parameter_summary.push({in:'header',name,type:'string',required:false,managed:true});
  const extraction_sources=unique([...(channel?[channel]:[]),...(Array.isArray(record.extraction_sources)?record.extraction_sources.filter((x:any)=>(EXTRACTION_SOURCES as readonly string[]).includes(x)):[])]);
  const locations=unique([...(location?[location]:[]),...(Array.isArray(record.locations)?record.locations.filter((x:any)=>typeof x==='string').map((x:string)=>cap(x)):[])]).slice(0,100);
  return {provenance:p,extraction_source:channel||null,location:location||null,reason,description:cap(record.description||record.summary),categories:Array.isArray(record.categories)?unique(record.categories.filter((x:any)=>typeof x==='string').map((x:string)=>x.slice(0,128))):[],extraction_sources,locations,parameter_summary,params_schema:schema};
}

function appMetadata(raw: unknown, kind: SourceKind): AppMetadata | undefined {
  if (!isObject(raw)) {
    if (kind === 'ios') throw new GatewayError('MANIFEST_INVALID', 'iOS 来源必须有应用身份');
    return undefined;
  }
  const packageName=cap(raw.package_name || (kind==='ios' ? raw.bundle_id : undefined));
  const app:AppMetadata={package_name:packageName,version_name:cap(raw.version_name)};
  if(kind==='ios'){
    const bundleId=cap(raw.bundle_id || packageName);
    if(!bundleId || bundleId!==packageName)throw new GatewayError('SOURCE_CONFLICT','iOS bundle_id 与 package_name 身份不一致');
    app.bundle_id=bundleId;
  }
  for(const field of ['artifact_sha256','ipa_sha256','apk_sha256'] as const){
    if(raw[field]===undefined || (kind==='ios' && field==='apk_sha256'))continue;
    if(typeof raw[field]!=='string'||!/^[a-f0-9]{64}$/.test(raw[field]))throw new GatewayError('MANIFEST_INVALID','应用产物指纹必须为 SHA256');
    app[field]=raw[field];
  }
  if(raw.artifact_type!==undefined){
    if(!['ipa','app','apk'].includes(raw.artifact_type) || (kind==='ios' && raw.artifact_type==='apk') || (kind==='apk' && raw.artifact_type!=='apk'))throw new GatewayError('MANIFEST_INVALID','应用产物类型与来源不一致');
    app.artifact_type=raw.artifact_type;
  }
  if(kind==='ios' && app.ipa_sha256 && app.artifact_sha256 && app.ipa_sha256!==app.artifact_sha256)throw new GatewayError('MANIFEST_INVALID','IPA 指纹与通用产物指纹不一致');
  if(kind==='ios' && app.artifact_type==='app' && app.ipa_sha256)throw new GatewayError('MANIFEST_INVALID','App bundle 不得伪造 IPA 指纹');
  return app;
}

export async function loadManifest(binding: SourceBinding, config: GatewayConfig): Promise<SourceSnapshot> {
  const schemaValidator=new Ajv2020({strict:false,allowUnionTypes:true,validateFormats:false});
  const canonical = await checkedPath(binding.manifest, config.manifest_roots);
  const dir = await isDirectory(canonical);
  let raw = await readJsonLimited(dir ? await checkedPath(path.join(canonical, 'source.json'), [canonical]) : canonical);
  let kind: SourceKind = binding.kind || 'web'; let app: AppMetadata | undefined;
  let sourceBase: string | undefined;
  if (isObject(raw) && raw.format === 'endpoint-inventory') {
    const root = dir ? canonical : path.dirname(canonical);
    if (!['1', '1.0', '1.1'].includes(String(raw.schema_version)) || !(SOURCE_KINDS as readonly string[]).includes(raw.kind) || typeof raw.inventory !== 'string') throw new GatewayError('MANIFEST_INVALID', 'source.json 格式或版本不支持');
    if (raw.source_id !== binding.id) throw new GatewayError('SOURCE_CONFLICT', '清单 source_id 与可信绑定不一致');
    if (binding.kind && binding.kind !== raw.kind) throw new GatewayError('SOURCE_CONFLICT', '清单类型与绑定不一致');
    if (path.isAbsolute(raw.inventory) || !within(root, path.resolve(root, raw.inventory))) throw new GatewayError('MANIFEST_PATH_BLOCKED', 'inventory 引用必须位于产物目录内');
    const inventory = await checkedPath(path.join(root, raw.inventory), [root]);
    kind = raw.kind; app = appMetadata(raw.app, kind);
    const document=await readJsonWithDigest(inventory);
    if(raw.inventory_sha256!==undefined&&(!/^[a-f0-9]{64}$/.test(raw.inventory_sha256)||raw.inventory_sha256!==document.sha256))throw new GatewayError('INVENTORY_CHANGED','源描述与库存指纹不一致，请重试加载');
    raw = document.data;
  } else if (dir) throw new GatewayError('MANIFEST_INVALID', '目录必须含有效 source.json');
  if (isObject(raw) && Array.isArray(raw.endpoints)) {
    if (raw.source_id && raw.source_id !== binding.id) throw new GatewayError('SOURCE_CONFLICT', 'source_id 与绑定不一致');
    sourceBase = binding.base_url; // Never trust an inventory-provided base URL.
    raw = raw.endpoints;
  }
  if (!Array.isArray(raw) || raw.length > 100000) throw new GatewayError('MANIFEST_INVALID', '接口清单必须为预算内的端点数组');
  const groups = new Map<string, Endpoint>();
  const warnings: string[] = [];
  for (const record of raw) {
    if (!isObject(record) || typeof record.url !== 'string') throw new GatewayError('MANIFEST_INVALID', '端点必须包含 url');
    const p = provenance(record);
    const {url, pathname} = normalizeURL(record.url, binding.base_url || sourceBase);
    const id = endpointId(binding.id, url.origin, pathname);
    if (!groups.has(id)) groups.set(id, { id, source: binding.id, source_revision: '', origin: url.origin, path: pathname, methods: [], operations: {}, unresolved_candidates: [] });
    const group = groups.get(id)!;
    const channel = (EXTRACTION_SOURCES as readonly string[]).includes(record.source) ? record.source : '';
    const location = cap(record.package);
    if (record.method === null || record.method === undefined) {
      group.unresolved_candidates.push(unresolvedCandidate(record,url,pathname,p,channel,location,'METHOD_UNRESOLVED'));
      continue;
    }
    const method = String(record.method).toUpperCase() as Method;
    if (!METHODS.includes(method)) { group.unresolved_candidates.push(unresolvedCandidate(record,url,pathname,p,channel,location,'UNSUPPORTED_HTTP_METHOD')); warnings.push('UNSUPPORTED_HTTP_METHOD'); continue; }
    // GET/HEAD never send captured bodies; their request encoding is irrelevant.
    const encoding = method==='GET'||method==='HEAD'?'json':bodyEncoding(record, binding);
    let op = group.operations[method];
    if (!op) {
      op = { method, provenance: [], categories: [], description: '', extraction_sources: [], locations: [], parameter_summary: [], params_schema: {type: 'object', properties: {path: emptyObj(), query: emptyObj()}, additionalProperties: false}, body_encoding: encoding, allowed: true, contract_revision: '' };
      group.operations[method] = op; group.methods.push(method);
    }
    op.provenance = unique([...op.provenance, ...p]);
    op.categories = unique([...op.categories, ...(Array.isArray(record.categories) ? record.categories.filter((x: any) => typeof x === 'string').map((x: string) => x.slice(0, 128)) : [])]);
    const channels=Array.isArray(record.extraction_sources)?record.extraction_sources.filter((x:any)=>(EXTRACTION_SOURCES as readonly string[]).includes(x)):[];
    const locations=Array.isArray(record.locations)?record.locations.filter((x:any)=>typeof x==='string').map((x:string)=>cap(x)):[];
    op.extraction_sources = unique([...op.extraction_sources, ...(channel ? [channel] : []), ...channels]);
    op.locations = unique([...op.locations, ...(location ? [location] : []), ...locations]).slice(0, 100);
    if (!op.description) op.description = cap(record.description || record.summary);
    if (op.body_encoding !== encoding) { op.body_encoding = 'unsupported'; warnings.push('BODY_ENCODING_CONFLICT'); }
    const schema = op.params_schema;
    const pathSchema = schema.properties.path;
    const pathNames = [...pathname.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1]);
    for (const name of pathNames) { safeName(name); pathSchema.properties[name] = { type: ['string', 'number'] }; }
    if (pathNames.length) { pathSchema.required = unique(pathNames); schema.required = unique([...(schema.required || []), 'path']); }
    const query = queryValues(record.query, url);
    const querySchema = schema.properties.query;
    for (const [name, value] of Object.entries(query)) {
      querySchema.properties[name] = mergeSchema(querySchema.properties[name], queryValueSchema(value));
      if (typeof value === 'string' && /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
        querySchema.required = unique([...(querySchema.required || []), name]);
        schema.required = unique([...(schema.required || []), 'query']);
      }
    }
    for (const name of declaredNames(record.parameters?.query)) {
      if (!querySchema.properties[name]) querySchema.properties[name] = {anyOf:[{type:['string','number','boolean','null']},{type:'array',items:{type:['string','number','boolean']}}]};
    }
    if(record.query_shape){
      const declaredQuery=shapeSchema(record.query_shape);
      for(const [name,spec] of Object.entries(declaredQuery.properties || {})){
        safeName(name);
        querySchema.properties[name]=mergeSchema(querySchema.properties[name],mergeSchema(spec as Schema,{type:'null'}));
      }
    }
    mergeQueryVariants(record,querySchema);
    const declaredHeaders = declaredNames(record.parameters?.headers);
    for (const name of declaredHeaders) if (!op.parameter_summary.some(p=>p.in==='header'&&p.name===name)) op.parameter_summary.push({in:'header',name,type:'string',required:false,managed:true});
    const declaredBody = record.body_shape || record.body_schema || record.parameter_variants?.find((x:any)=>x?.body_shape)?.body_shape;
    if(method!=='GET'&&method!=='HEAD'){
      if (declaredBody && !['absent','truncated'].includes(record.body_capture)) schema.properties.body = mergeSchema(schema.properties.body, shapeSchema(declaredBody));
      else if (Object.hasOwn(record, 'body') && record.body !== null && !['unknown','absent','truncated','shape_only'].includes(record.body_capture)) schema.properties.body = mergeSchema(schema.properties.body, sampleSchema(record.body));
      for(const variant of variants(record))if(variant.body_shape||variant.body_schema)schema.properties.body=mergeSchema(schema.properties.body,shapeSchema(variant.body_shape||variant.body_schema));
    }
    // An unknown body can still be supplied only for a declared write operation; no sample is replayed.
    if (method !== 'GET' && method !== 'HEAD' && !schema.properties.body) schema.properties.body = {};
  }
  const endpoints = [...groups.values()].sort((a, b) => a.origin.localeCompare(b.origin) || a.path.localeCompare(b.path));
  for (const ep of endpoints) {
    ep.methods.sort();
    for (const method of ep.methods) {
      const op = ep.operations[method]!;
      const inferredQuery=op.params_schema.properties.query;
      for(const required of inferredQuery.required || []) inferredQuery.properties[required]=withoutNull(inferredQuery.properties[required])||{};
      const override = binding.schema_overrides?.[`${ep.id}:${method}`];
      if (override) op.params_schema = structuredClone(override);
      try{schemaValidator.compile(op.params_schema);}catch{throw new GatewayError('ENDPOINT_SCHEMA_INVALID','来源中的端点参数 schema 无法编译');}
      for (const place of ['path','query','body']) {
        const section = op.params_schema.properties?.[place];
        if (section?.properties) for (const [name, spec] of Object.entries(section.properties)) op.parameter_summary.push({in: place, name, type: (spec as any).type || 'union', required: !!section.required?.includes(name)});
        else if (section && place === 'body') op.parameter_summary.push({in: 'body', name: '$', type: section.type || 'json', required: !!op.params_schema.required?.includes('body')});
      }
      op.allowed = isAllowed(config, binding.id, ep.id, method, op.body_encoding) && (!binding.allowed_origins || binding.allowed_origins.includes(ep.origin));
      if (!op.allowed) op.blocked_reason = op.body_encoding === 'unsupported' ? 'UNSUPPORTED_BODY_ENCODING' : binding.allowed_origins && !binding.allowed_origins.includes(ep.origin) ? 'ORIGIN_BLOCKED' : 'METHOD_BLOCKED';
      op.contract_revision = digest([kind, app, ep.origin, ep.path, method, op.params_schema, op.body_encoding, binding.defaults?.[ep.id], binding.static_headers, binding.credential_origins]);
    }
  }
  // Fingerprint the trusted invocation contract as well as discovery metadata. Never include credential-file values.
  const revision = digest([binding.id, kind, app, endpoints, binding.allowed_origins, binding.credential_origins, binding.static_headers, binding.defaults, config.methods]);
  for (const ep of endpoints) ep.source_revision = revision;
  return { id: binding.id, kind, revision, binding: structuredClone(binding), manifest_path: canonical, endpoints, origins: unique(endpoints.map(x => x.origin)), app, warnings: unique(warnings) };
}
