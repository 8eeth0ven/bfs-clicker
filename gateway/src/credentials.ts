import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {GatewayError, type SourceBinding} from './types.js';
import {Redactor} from './redact.js';

const FORBIDDEN = /^(?:host|:authority|origin|referer|connection|transfer-encoding|content-length|proxy-.+)$/i;
export interface CredentialContext {
  headersFor(url: URL): Record<string,string>;
  redactor: Redactor;
  warnings: string[];
}
export class CredentialProvider {
  readonly redactor = new Redactor();
  async load(binding: SourceBinding): Promise<CredentialContext> {
    if (!binding.credentials) {
      if (!binding.public) throw new GatewayError('CREDENTIALS_REQUIRED', '来源需要凭据配置，或显式设置 public: true');
      return {headersFor: () => ({}), redactor: this.redactor, warnings: []};
    }
    let document: any;
    try {
      const info = await stat(binding.credentials);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('size');
      document = parse(await readFile(binding.credentials,'utf8'), {maxAliasCount: 0});
    } catch { throw new GatewayError('CREDENTIALS_INVALID', '凭据文件无法读取或格式不正确'); }
    if (!document || typeof document !== 'object') throw new GatewayError('CREDENTIALS_INVALID','凭据应为对象');
    const mode = document.mode ?? document.kind;
    const selected = ['headers','cookie','token','storageState'].filter(k => document[k] !== undefined || document[k + '_env'] !== undefined);
    if (selected.length !== 1 || selected[0] !== mode) throw new GatewayError('CREDENTIALS_INVALID','凭据模式必须恰好选择一种');
    const origins = new Set<string>();
    try {
      for (const raw of binding.credential_origins ?? []) {
        const url = new URL(raw);
        if (url.origin !== raw || !/^https?:$/.test(url.protocol)) throw new Error('origin');
        origins.add(raw);
      }
    } catch { throw new GatewayError('CREDENTIALS_INVALID','credential_origins 必须是明确的 origin'); }
    if (!origins.size) throw new GatewayError('CREDENTIALS_INVALID','带凭据的来源必须显式绑定 credential_origins');
    const secrets: string[] = [];
    const warnings: string[] = [];
    const resolve = (key: string): any => {
      if (document[key + '_env'] !== undefined) {
        const env = document[key + '_env'];
        if (typeof env !== 'string' || !process.env[env]) throw new GatewayError('CREDENTIALS_INVALID','凭据环境变量缺失');
        return process.env[env];
      }
      return document[key];
    };
    const checkedHeader = (name: string, value: unknown): string => {
      if (FORBIDDEN.test(name) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || !value.trim() || /^Bearer\s*$/i.test(value) || /[\r\n\0]/.test(value) || value.length > 65536)
        throw new GatewayError('CREDENTIALS_INVALID','凭据包含不允许的请求头或值');
      secrets.push(value);
      if (/^Bearer\s+/i.test(value)) secrets.push(value.replace(/^Bearer\s+/i,''));
      if (/^cookie$/i.test(name)) for(const item of value.split(';')){const at=item.indexOf('=');if(at>=0)secrets.push(item.slice(at+1).trim().replace(/^"|"$/g,''));}
      return value;
    };
    let fixed: Record<string,string> = {}, cookies: any[] = [];
    if (mode === 'headers') {
      let headers = resolve('headers');
      if (typeof headers === 'string') { try { headers = JSON.parse(headers); } catch { throw new GatewayError('CREDENTIALS_INVALID','headers_env 应包含 JSON 对象'); } }
      if (!headers || Array.isArray(headers) || typeof headers !== 'object' || !Object.keys(headers).length) throw new GatewayError('CREDENTIALS_INVALID','headers 必须为非空对象');
      for (const [key,val] of Object.entries(headers)) fixed[key] = checkedHeader(key,val);
    } else if (mode === 'token') {
      const token = resolve('token');
      if (typeof token !== 'string' || !token.trim()) throw new GatewayError('CREDENTIALS_INVALID','token 缺失');
      secrets.push(token);
      fixed[document.header ?? 'Authorization'] = checkedHeader(document.header ?? 'Authorization', (document.prefix ?? 'Bearer ') + token);
    } else if (mode === 'cookie') {
      fixed.Cookie = checkedHeader('Cookie',resolve('cookie'));
      for (const item of fixed.Cookie.split(';')) { const at=item.indexOf('='); if(at>=0) secrets.push(item.slice(at+1).trim().replace(/^"|"$/g,'')); }
    } else if (mode === 'storageState') {
      const file = resolve('storageState');
      if (typeof file !== 'string') throw new GatewayError('CREDENTIALS_INVALID','storageState 必须为路径');
      try {
        const storagePath = path.resolve(path.dirname(binding.credentials),file);
        const info=await stat(storagePath);
        if(!info.isFile() || info.size>2*1024*1024) throw new Error('size');
        const storage=JSON.parse(await readFile(storagePath,'utf8'));
        if(!Array.isArray(storage.cookies)) throw new Error('cookies');
        for(const cookie of storage.cookies){
          if(typeof cookie.name!=='string'||typeof cookie.value!=='string'||typeof cookie.domain!=='string'||typeof cookie.path!=='string'||typeof cookie.expires!=='number'||!Number.isFinite(cookie.expires)||typeof cookie.secure!=='boolean'||/[\r\n;\0=]/.test(cookie.name)||/[\r\n;\0]/.test(cookie.value)||cookie.value.length>65536) throw new Error('cookie');
          secrets.push(cookie.value);
          if(cookie.partitionKey){warnings.push('PARTITIONED_COOKIE_SKIPPED'); continue;}
          cookies.push(cookie);
        }
      } catch { throw new GatewayError('CREDENTIALS_INVALID','storageState 无法读取或 cookies 格式错误'); }
    } else throw new GatewayError('CREDENTIALS_INVALID','未知凭据模式');
    this.redactor.addSecrets(secrets);
    return {redactor:this.redactor,warnings:[...new Set(warnings)],headersFor:(url:URL)=>{
      if(!origins.has(url.origin)) throw new GatewayError('CREDENTIAL_ORIGIN_BLOCKED','目标 origin 不在凭据作用域内');
      if(mode!=='storageState') return {...fixed};
      const now=Date.now()/1000;
      const selectedCookies=cookies.filter(c=>{
        const host=url.hostname.toLowerCase(), domain=c.domain.toLowerCase();
        const hostOK=domain.startsWith('.') ? host===domain.slice(1)||host.endsWith(domain) : host===domain;
        const pathOK=url.pathname===c.path || (url.pathname.startsWith(c.path)&&(c.path.endsWith('/')||url.pathname[c.path.length]==='/'));
        return hostOK&&pathOK&&(!c.secure||url.protocol==='https:')&&(c.expires===-1||c.expires>now);
      }).sort((a,b)=>b.path.length-a.path.length);
      return selectedCookies.length ? {Cookie:selectedCookies.map(c=>`${c.name}=${c.value}`).join('; ')} : {};
    }};
  }
}
