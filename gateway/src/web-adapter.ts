import { createReadStream } from 'node:fs';
import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GatewayError, METHODS, type Method, type Schema } from './types.js';
import { within } from './files.js';

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_TRAFFIC_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_ENDPOINTS = 100000;
const MAX_EVIDENCE = 64;
const MAX_GAPS = 100;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const nameOK = (name: string) => name.length > 0 && name.length <= 256 && !BAD_KEYS.has(name) && !/[\u0000-\u001f]/.test(name);
const emptyShape = (): Schema => ({ type: 'object', properties: Object.create(null), additionalProperties: false });
const knownMethod = (value: unknown): Method | null => typeof value === 'string' && METHODS.includes(value.toUpperCase() as Method) ? value.toUpperCase() as Method : null;

export interface WebInventoryGap {
  reason: string; count: number; method?: string; url?: string; evidence_ids?: string[];
}
export interface WebRunInventoryResult {
  manifest: { schema_version: '1.1'; source_id: string; kind: 'web'; endpoints: Record<string, any>[] };
  source: { id: string; kind: 'web'; origins: string[] };
  warnings: string[];
  gaps: WebInventoryGap[];
}

function endpointURL(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 16384 || /[\r\n\0]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}
const cleanURL = (url: URL) => url.origin + url.pathname;

/** Merge evidence shapes, never values, defaults, enums or inferred requiredness. */
function mergeShape(a: Schema | undefined, b: Schema): Schema {
  if (!a) return b;
  if (!Object.keys(a).length || !Object.keys(b).length) return {};
  if (a.type === 'object' && b.type === 'object') {
    const properties: Record<string, Schema> = { ...a.properties };
    for (const [key, value] of Object.entries(b.properties || {})) properties[key] = mergeShape(properties[key], value as Schema);
    return { type: 'object', properties, additionalProperties: false };
  }
  if (a.type === 'array' && b.type === 'array') return { type: 'array', items: mergeShape(a.items, b.items) };
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const variants = new Map<string, Schema>();
  for (const variant of [...(a.anyOf || [a]), ...(b.anyOf || [b])]) variants.set(JSON.stringify(variant), variant);
  // Shape unions are bounded; {} honestly leaves an unresolved type unconstrained.
  return variants.size <= 16 ? { anyOf: [...variants.values()] } : {};
}

interface Group {
  record: Record<string, any>;
  evidence: Set<string>;
  query: Schema;
  body?: Schema;
}

/** Convert saved Web evidence to the existing endpoint-inventory contract. No network or writes. */
export async function webRunInventory({ runDir, sourceId }: { runDir: string; sourceId: string }): Promise<WebRunInventoryResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sourceId)) throw new GatewayError('SOURCE_INVALID', 'sourceId 格式无效');
  let root: string;
  try { root = await realpath(runDir); if (!(await stat(root)).isDirectory()) throw new Error(); }
  catch { throw new GatewayError('WEB_RUN_INVALID', 'Web 任务目录不可读取'); }
  const warnings = new Set<string>();
  const gaps: WebInventoryGap[] = [];
  const gapIndex = new Map<string, WebInventoryGap>();
  let omittedGaps = 0;
  function gap(reason: string, details: Omit<WebInventoryGap, 'reason' | 'count'> = {}) {
    const key = JSON.stringify([reason, details.method, details.url]);
    const old = gapIndex.get(key);
    if (old) { old.count++; return; }
    if (gaps.length >= MAX_GAPS) { omittedGaps++; return; }
    const row = { reason, count: 1, ...details };
    gaps.push(row); gapIndex.set(key, row);
  }
  async function localFile(relative: string): Promise<string | null> {
    const target = path.join(root, relative);
    let resolved: string;
    try { resolved = await realpath(target); }
    catch (error: any) { if (error?.code === 'ENOENT') return null; throw new GatewayError('WEB_EVIDENCE_INVALID', 'Web 证据路径不可读取'); }
    if (!within(root, resolved)) throw new GatewayError('WEB_EVIDENCE_PATH_BLOCKED', 'Web 证据不允许通过符号链接离开任务目录');
    if (!(await stat(resolved)).isFile()) throw new GatewayError('WEB_EVIDENCE_INVALID', 'Web 证据必须是普通文件');
    return resolved;
  }
  const privateLedger = await localFile('private/apis.json');
  const ledgerFile = privateLedger || await localFile('apis.json');
  const trafficFile = await localFile('private/traffic.jsonl');
  if (!ledgerFile && !trafficFile) throw new GatewayError('WEB_EVIDENCE_NOT_FOUND', 'Web 任务没有 API 账本或原始流量证据');
  if (ledgerFile && !privateLedger) { warnings.add('WEB_PUBLIC_LEDGER_FALLBACK'); gap('public_ledger_may_be_redacted'); }
  if (!trafficFile) { warnings.add('WEB_TRAFFIC_UNAVAILABLE'); gap('traffic_unavailable_using_ledger'); }
  const groups = new Map<string, Group>();
  const trafficGroups = new Map<string, Set<Group>>();
  const excludedTrafficOperations = new Set<string>();
  const operationKey = (url: URL, method: Method | null) => JSON.stringify([cleanURL(url), method]);

  function addEvidence(group: Group, id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 256 || /[\r\n\0]/.test(id)) return;
    if (group.evidence.has(id)) return;
    if (group.evidence.size < MAX_EVIDENCE) group.evidence.add(id);
    else group.record.evidence_ids_truncated = true;
  }
  function shapeOf(value: any, depth = 0, budget = { nodes: 0 }): Schema {
    if (++budget.nodes > 4000 || depth > 8) { gap('parameter_shape_budget'); return {}; }
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) {
      let items: Schema | undefined;
      for (const item of value.slice(0, 100)) items = mergeShape(items, shapeOf(item, depth + 1, budget));
      if (value.length > 100) gap('parameter_array_sample_limit');
      return { type: 'array', items: items || {} };
    }
    if (object(value)) {
      const result = emptyShape(), keys = Object.keys(value);
      if (keys.length > 500) gap('parameter_field_limit');
      for (const key of keys.slice(0, 500)) {
        if (!nameOK(key)) { gap('invalid_parameter_name'); continue; }
        result.properties[key] = shapeOf(value[key], depth + 1, budget);
      }
      return result;
    }
    return { type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string' };
  }
  function queryShape(pairs: Iterable<[string, unknown]>): Schema {
    const shape = emptyShape(), values = new Map<string, unknown[]>();
    for (const [key, value] of pairs) {
      if (!nameOK(key)) { gap('invalid_parameter_name'); continue; }
      if (!values.has(key) && values.size >= 500) { gap('parameter_field_limit'); continue; }
      const list = values.get(key) || []; list.push(value); values.set(key, list);
    }
    for (const [key, list] of values) shape.properties[key] = list.length > 1 ? { type: 'array', items: { type: 'string' } } : { type: 'string' };
    return shape;
  }
  function groupFor(url: URL, method: Method | null, provenance: 'observed' | 'static_candidate', encoding = ''): Group | null {
    const key = JSON.stringify([cleanURL(url), method, provenance, encoding]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= MAX_ENDPOINTS) { gap('endpoint_limit'); return null; }
      const headers = encoding ? { 'Content-Type': encoding } : {};
      group = {
        record: { method, url: cleanURL(url), headers, query: {}, body: null, categories: [provenance],
          source: provenance === 'observed' ? 'network' : 'asset', body_capture: 'absent', evidence_ids: [] },
        evidence: new Set(), query: emptyShape(),
      };
      groups.set(key, group);
    }
    return group;
  }
  function bodyShape(raw: unknown, contentType: string, truncated: boolean): { shape?: Schema; capture: string } {
    if (raw === null || raw === undefined || raw === '') return { capture: 'absent' };
    if (truncated || typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_LINE_BYTES) { gap('request_body_incomplete'); return { capture: 'unknown' }; }
    if (/multipart\/|octet-stream|protobuf/.test(contentType)) { gap('unsupported_body_encoding'); return { capture: 'unknown' }; }
    if (/json/.test(contentType) || !contentType) {
      try { return { shape: shapeOf(JSON.parse(raw)), capture: 'shape_only' }; }
      catch { if (/json/.test(contentType)) { gap('request_body_unparseable'); return { capture: 'unknown' }; } }
    }
    if (/x-www-form-urlencoded/.test(contentType)) return { shape: queryShape(new URLSearchParams(raw)), capture: 'shape_only' };
    if (/^text\//.test(contentType)) return { shape: { type: 'string' }, capture: 'shape_only' };
    if (contentType || !trafficFile) gap('request_body_encoding_unknown');
    return { capture: 'unknown' };
  }
  function requestContentType(row: Record<string, any>): string {
    const headers = object(row.reqHeaders) ? row.reqHeaders : {};
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type');
    const raw = typeof entry?.[1] === 'string' ? entry[1] : '';
    const type = raw.split(';', 1)[0].trim().toLowerCase();
    if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return type;
    return '';
  }
  function observe(url: URL, method: Method | null, provenance: 'observed' | 'static_candidate', sample: Record<string, any> = {}, contentType = '') {
    const encoding = method !== 'GET' && method !== 'HEAD' ? contentType : '';
    const group = groupFor(url, method, provenance, encoding);
    if (!group) return;
    group.query = mergeShape(group.query, queryShape(url.searchParams));
    if (Array.isArray(sample.query)) {
      const pairs = sample.query.filter((pair: unknown) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string');
      if (pairs.length) group.query = mergeShape(group.query, queryShape(pairs));
    }
    if (method !== 'GET' && method !== 'HEAD' && method !== null) {
      const result = bodyShape(sample.postData, contentType, sample.requestBodyTruncated === true);
      if (result.shape) group.body = mergeShape(group.body, result.shape);
      if (result.capture !== 'absent') group.record.body_capture = group.body ? 'shape_only' : result.capture;
    }
    addEvidence(group, sample.evidenceId);
    if (typeof sample.observation_basis === 'string') group.record.observation_basis = sample.observation_basis;
    if (sample.observation_basis === 'traffic_response') {
      const key = operationKey(url, method);
      if (!trafficGroups.has(key)) trafficGroups.set(key, new Set());
      trafficGroups.get(key)!.add(group);
    }
  }
  function unobserved(url: URL, method: Method | null, category: string, id?: unknown) {
    const evidence = typeof id === 'string' && id.length <= 256 ? [id] : [];
    gap(category === 'blocked_request' ? 'blocked_request_not_observed' : category === 'failed_request' ? 'failed_request_not_observed' : 'attempted_request_not_observed',
      { url: cleanURL(url), ...(method ? { method } : {}), ...(evidence.length ? { evidence_ids: evidence } : {}) });
  }
  if (ledgerFile) {
    let rows: any;
    try {
      if ((await stat(ledgerFile)).size > MAX_JSON_BYTES) throw new Error();
      const bytes = await readFile(ledgerFile); if (bytes.length > MAX_JSON_BYTES) throw new Error();
      rows = JSON.parse(bytes.toString('utf8'));
      if (!Array.isArray(rows)) throw new Error();
    } catch { throw new GatewayError('WEB_LEDGER_INVALID', 'Web API 账本不是预算内的 JSON 数组'); }
    if (rows.length > MAX_ENDPOINTS) gap('ledger_record_limit');
    for (const row of rows.slice(0, MAX_ENDPOINTS)) {
      if (!object(row)) { gap('invalid_ledger_record'); continue; }
      const url = endpointURL(row.url); if (!url) { gap('invalid_endpoint_url'); continue; }
      const method = knownMethod(row.method), categories = Array.isArray(row.categories) ? row.categories : [];
      const samples = Array.isArray(row.samples) ? row.samples.filter(object).slice(0, 100) : [];
      if (categories.includes('static_candidate')) {
        observe(url, method, 'static_candidate');
        const group = groupFor(url, method, 'static_candidate');
        if (group) {
          for (const sample of samples.filter((item: any) => item.category === 'static_candidate')) addEvidence(group, sample.evidenceId);
          const documents = Array.isArray(row.sources) ? row.sources.filter(object).filter((item: any) => item.kind === 'document').map((item: any) => endpointURL(item.document)).filter((item: URL | null): item is URL => item !== null) : [];
          group.record.locations = [...new Set(documents.map((item: URL) => cleanURL(item)))].slice(0, 32);
        }
      }
      const responded = samples.filter((sample: any) => sample.category === 'observed_request' && Number.isInteger(sample.status) && sample.status >= 100 && sample.status <= 599);
      if (method && categories.includes('observed_request')) {
        if (responded.length) for (const sample of responded) observe(endpointURL(sample.url) || url, method, 'observed', { ...sample, observation_basis: 'ledger_response_sample' });
        else {
          observe(url, method, 'observed', { observation_basis: 'ledger_category' });
          gap('response_evidence_not_sampled', { url: cleanURL(url), method });
        }
      }
      if (!method && categories.includes('observed_request')) gap('response_method_unresolved', { url: cleanURL(url) });
      if (!categories.includes('observed_request')) {
        for (const category of ['attempted_request', 'blocked_request', 'failed_request']) {
          if (categories.includes(category)) unobserved(url, method, category, samples.find((sample: any) => sample.category === category)?.evidenceId);
        }
      }
      // A ledger's value arrays aggregate samples; they do not prove repeat-key wire encoding.
      const keys = object(row.query) ? Object.keys(row.query).filter(nameOK).slice(0, 500) : [];
      for (const provenance of ['observed', 'static_candidate'] as const) {
        if (provenance === 'observed' ? !categories.includes('observed_request') || !method : !categories.includes('static_candidate')) continue;
        const group = groupFor(url, method, provenance);
        if (group) for (const name of keys) if (!group.query.properties[name]) group.query.properties[name] = { type: 'string' };
      }
    }
  }
  if (trafficFile) {
    let line = Buffer.alloc(0), dropping = false, bytesRead = 0, stopped = false;
    function parseLine(bytes: Buffer) {
      if (!bytes.toString('utf8').trim()) return;
      let row: any;
      try { row = JSON.parse(bytes.toString('utf8')); } catch { gap('traffic_malformed_line'); return; }
      if (!object(row)) { gap('invalid_traffic_record'); return; }
      const url = endpointURL(row.url); if (!url) { gap('invalid_endpoint_url'); return; }
      const type = String(row.resourceType || row.type || '').toLowerCase();
      const method = knownMethod(row.method);
      if (['document', 'script', 'image', 'font', 'media', 'stylesheet', 'texttrack', 'manifest'].includes(type)) {
        excludedTrafficOperations.add(operationKey(url, method)); return;
      }
      if (!method) { gap('response_method_unresolved', { url: cleanURL(url) }); return; }
      if (row.failed || !Number.isInteger(row.status) || row.status < 100 || row.status > 599) {
        unobserved(url, method, /BLOCKED_BY_CLIENT|aborted/i.test(String(row.failed || '')) ? 'blocked_request' : 'failed_request', row.evidenceId); return;
      }
      observe(url, method, 'observed', { ...row, observation_basis: 'traffic_response' }, requestContentType(row));
    }
    try {
      for await (const rawChunk of createReadStream(trafficFile)) {
        const chunk = Buffer.from(rawChunk); bytesRead += chunk.length;
        if (bytesRead > MAX_TRAFFIC_BYTES) { gap('traffic_read_budget'); stopped = true; break; }
        let start = 0;
        for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
          const piece = chunk.subarray(start, i);
          if (!dropping && line.length + piece.length <= MAX_LINE_BYTES) parseLine(Buffer.concat([line, piece]));
          else if (!dropping) gap('traffic_line_budget');
          line = Buffer.alloc(0); dropping = false; start = i + 1;
        }
        const tail = chunk.subarray(start);
        if (!dropping && line.length + tail.length <= MAX_LINE_BYTES) line = Buffer.concat([line, tail]);
        else if (!dropping) { gap('traffic_line_budget'); dropping = true; line = Buffer.alloc(0); }
      }
      if (!stopped && !dropping && line.length) { gap('traffic_missing_final_newline'); parseLine(line); }
    } catch { gap('traffic_read_failed'); warnings.add('WEB_TRAFFIC_PARTIAL'); }
  }
  if (omittedGaps) gaps.push({ reason: 'additional_gaps_omitted', count: omittedGaps });
  const selected = [...groups.values()].filter(group => {
    if (!group.record.categories.includes('observed') || group.record.observation_basis === 'traffic_response') return true;
    const key = operationKey(new URL(group.record.url), group.record.method);
    const authoritative = trafficGroups.get(key);
    if (!authoritative?.size) return !excludedTrafficOperations.has(key);
    // The ledger omits request Content-Type and coalesces value samples. Prefer actual
    // traffic shapes/encoding; retain its missing parameter names and evidence links.
    for (const target of authoritative) {
      for (const [name, shape] of Object.entries(group.query.properties))
        if (!target.query.properties[name]) target.query.properties[name] = shape;
      for (const evidenceId of group.evidence) addEvidence(target, evidenceId);
      if (group.record.evidence_ids_truncated) target.record.evidence_ids_truncated = true;
    }
    return false;
  });
  const endpoints = selected.map<Record<string, any>>(group => ({
    ...group.record,
    query_shape: group.query,
    ...(group.body ? { body_shape: group.body } : {}),
    evidence_ids: [...group.evidence].sort(),
  })).sort((a, b) => a.url.localeCompare(b.url) || String(a.method).localeCompare(String(b.method)) || JSON.stringify(a.categories).localeCompare(JSON.stringify(b.categories)) || JSON.stringify(a.headers).localeCompare(JSON.stringify(b.headers)));
  return {
    manifest: { schema_version: '1.1', source_id: sourceId, kind: 'web', endpoints },
    source: { id: sourceId, kind: 'web', origins: [...new Set(endpoints.map(record => new URL(record.url).origin))].sort() },
    warnings: [...warnings].sort(), gaps,
  };
}
