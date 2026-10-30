import {GatewayError, type QuerySerialization} from './types.js';

const plain = (value:any):value is Record<string,any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const scalar = (value:any) => value === null || ['string','boolean','number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
const encoded = (value:any) => {try{return encodeURIComponent(String(value)).replace(/[!'()*]/g, char => '%'+char.charCodeAt(0).toString(16).toUpperCase());}catch{throw new GatewayError('PARAMS_INVALID','查询参数包含无效Unicode');}};

export function queryRules(value:any):Record<string,QuerySerialization> {
  if (!plain(value) || Object.keys(value).length > 500) throw new GatewayError('QUERY_CONTRACT_INVALID','query_serialization 必须是预算内的对象');
  const rules:Record<string,QuerySerialization> = Object.create(null);
  for (const [name,rule] of Object.entries(value)) {
    if (!name || name.length > 256 || /[\x00-\x1f]/.test(name) || forbidden.has(name) || !plain(rule) || Object.keys(rule).some(key => !['style','explode','kind'].includes(key)) || typeof rule.explode !== 'boolean' || !['scalar','array','object'].includes(rule.kind)) throw new GatewayError('QUERY_CONTRACT_INVALID','查询参数编码声明无效');
    if (!(rule.style === 'form' || rule.style === 'deepObject' && rule.kind === 'object' && rule.explode || ['spaceDelimited','pipeDelimited','tabDelimited'].includes(rule.style) && rule.kind !== 'scalar' && !rule.explode) || rule.kind === 'scalar' && rule.style !== 'form') throw new GatewayError('QUERY_CONTRACT_INVALID','不支持此查询参数编码组合');
    rules[name] = {style:rule.style, explode:rule.kind === 'scalar' ? true : rule.explode, kind:rule.kind};
  }
  return rules;
}

/** Fixed source contracts select encoding; call arguments cannot choose styles. */
export function serializeQuery(query:Record<string,any>, rules:Record<string,QuerySerialization> = {},{maxBytes=65536}={}):string {
  const pairs:string[] = [], owners = new Map<string,string>();let bytes = 0;
  const append = (name:string, value:string, owner:string) => {
    if (owners.has(name) && owners.get(name) !== owner) throw new GatewayError('QUERY_NAME_COLLISION','展开后的查询参数名称冲突');
    owners.set(name,owner);
    const pair=encoded(name)+'='+value;bytes+=Buffer.byteLength(pair)+1;
    if (pairs.length>=1000 || bytes>maxBytes) throw new GatewayError('REQUEST_TOO_LARGE','请求参数超过条目或字节上限');
    pairs.push(pair);
  };
  const atom = (value:any) => {if (!scalar(value)) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','查询参数值必须为有限标量');if (Buffer.byteLength(String(value))>maxBytes) throw new GatewayError('REQUEST_TOO_LARGE','请求参数值超过字节上限');return encoded(value === null ? '' : value);};
  if (!plain(query) || Object.keys(query).length>500) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','查询参数必须是预算内的对象');
  for (const [name,value] of Object.entries(query)) {
    const rule = Object.hasOwn(rules,name) ? rules[name] : undefined;
    if (value === null) continue;
    if (!rule) {
      // Observed inventories retain repeated-array behavior without inventing a
      // formal style for objects that were never described.
      const values = Array.isArray(value) ? value : [value];
      if (values.length>1000) throw new GatewayError('REQUEST_TOO_LARGE','查询数组超过1000项');
      for (const item of values) {if (item===null) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','未声明编码的查询数组不支持null');append(name,atom(item),name);}
      continue;
    }
    if (rule.kind === 'scalar') {append(name,atom(value),name);continue;}
    if (rule.kind === 'array' && !Array.isArray(value) || rule.kind === 'object' && !plain(value)) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','查询参数类型与固定编码声明不一致');
    const entries = rule.kind === 'array' ? value : Object.entries(value);
    if (entries.length>1000) throw new GatewayError('REQUEST_TOO_LARGE','查询集合超过1000项');
    if (!entries.length) continue; // RFC6570 considers empty collections undefined.
    if (rule.style === 'deepObject') {
      if (/[\[\]]/.test(name)) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','deepObject名称不能包含方括号');
      for (const [key,item] of entries) {
        if (forbidden.has(key) || /[\[\]\x00-\x1f]/.test(key)) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','deepObject属性名无效');
        append(name+'['+key+']',atom(item),name);
      }
    } else if (rule.style === 'form' && rule.explode) {
      if (rule.kind === 'array') for (const item of entries) append(name,atom(item),name);
      else for (const [key,item] of entries) {if (forbidden.has(key)) throw new GatewayError('UNSUPPORTED_QUERY_ENCODING','对象查询属性名无效');append(key,atom(item),name);}
    } else {
      const delimiter = rule.style === 'spaceDelimited' ? ' ' : rule.style === 'pipeDelimited' ? '|' : rule.style === 'tabDelimited' ? '\t' : ',';
      const values = rule.kind === 'array' ? entries : entries.flat();
      // Non-RFC6570 delimiters must themselves be encoded. The standard does
      // not define an escape that distinguishes the same character in data.
      if (delimiter !== ',' && values.some((item:any) => String(item).includes(delimiter))) throw new GatewayError('AMBIGUOUS_QUERY_VALUE','数据包含该编码的分隔符；无法无歧义序列化');
      append(name,values.map(atom).join(delimiter === ',' ? ',' : encoded(delimiter)),name);
    }
  }
  return pairs.join('&');
}
