export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const SOURCE_KINDS = ['web', 'apk', 'ios'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const EXTRACTION_SOURCES = ['manifest','strings','hermes','dex','asset','network','native','plist'] as const;
export interface AppMetadata {
  package_name: string; version_name: string; apk_sha256?: string;
  bundle_id?: string; artifact_sha256?: string; ipa_sha256?: string; artifact_type?: 'ipa' | 'app' | 'apk';
}
export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type Schema = Record<string, any>;
export interface Health {
  state: 'unverified' | 'http_verified' | 'not_found_suspected';
  success_streak: number; missing_streak: number; last_status: number | null;
  evidence_scope: 'request_observations'; updated_at?: string;
}
export interface Operation {
  method: Method; provenance: string[]; categories: string[]; description: string;
  extraction_sources: string[]; locations: string[]; parameter_summary: any[];
  params_schema: Schema; body_encoding: 'json' | 'form' | 'text' | 'unsupported';
  allowed: boolean; blocked_reason?: string; contract_revision: string;
}
export interface Endpoint {
  id: string; source: string; source_revision: string; origin: string; path: string;
  methods: Method[]; operations: Partial<Record<Method, Operation>>;
  unresolved_candidates: any[];
}
export interface SourceBinding {
  id: string; manifest: string; credentials?: string;
  allowed_origins?: string[]; credential_origins?: string[];
  base_url?: string; static_headers?: Record<string, string>;
  defaults?: Record<string, any>; schema_overrides?: Record<string, Schema>;
  public?: boolean; kind?: SourceKind;
}
export interface GatewayConfig {
  config_dir: string; manifest_roots: string[]; state_dir: string;
  sources: SourceBinding[];
  timeout_ms: number; max_body_bytes: number; max_catalog_bytes: number;
  success_threshold: number; missing_threshold: number;
  methods: { allow_non_get: boolean; allow: {source: string; endpoint_id: string; method: Method}[] };
}
export interface SourceSnapshot {
  id: string; kind: SourceKind; revision: string; binding: SourceBinding;
  manifest_path: string; endpoints: Endpoint[]; origins: string[]; app?: AppMetadata;
  warnings: string[];
}
export interface CallParams {
  method?: Method; path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null | (string | number | boolean)[]>;
  body?: Json;
}
export interface GatewayResult<T = any> {
  ok: boolean; data: T | null;
  error: {code: string; message: string; details?: any} | null; warnings: string[];
}
export class GatewayError extends Error {
  constructor(public code: string, message: string, public details?: any) { super(message); }
}
export const METHODS: Method[] = ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'];
