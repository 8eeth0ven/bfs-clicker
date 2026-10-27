const SECRET_KEY = /^(?:authorization|proxy.authorization|cookie|set.cookie|password|passwd|pwd|secret|client.secret|token|access.token|refresh.token|id.token|api.key|apikey|session|sessionid|session.id|csrf.token|xsrf.token)$/i;
const KEY_PATTERN = '(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|pwd|secret|client[_-]?secret|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|api[_-]?key|session(?:[_-]?id)?|[cx]srf[_-]?token)';
type Span = [number, number];
export function truncateUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.subarray(0, limit), {stream: true});
}

/** All callers must use the same redactor for JSON, text, resources and errors. */
export class Redactor {
  private secrets = new Set<string>();
  constructor(values: string[] = []) { this.addSecrets(values); }
  addSecrets(values: string[]): void {
    for (const value of values) {
      if (!value || value.length > 65536) continue;
      this.secrets.add(value);
      this.secrets.add(JSON.stringify(value).slice(1, -1));
      this.secrets.add(encodeURIComponent(value));
      this.secrets.add(encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, x => x.toLowerCase()));
    }
  }
  get maxLookaheadBytes(): number {
    return Math.max(1, ...Array.from(this.secrets, s => Buffer.byteLength(s, 'utf8')));
  }
  private spans(text: string, minimumSecretLength=0): Span[] {
    const spans: Span[] = [];
    const protectedMarkers:Span[]=[];
    let markerAt=0;
    while((markerAt=text.indexOf('[REDACTED]',markerAt))>=0){protectedMarkers.push([markerAt,markerAt+10]);markerAt+=10;}
    for (const secret of this.secrets) {
      if(secret.length<minimumSecretLength)continue;
      let at = 0;
      while ((at = text.indexOf(secret, at)) >= 0) { if(!protectedMarkers.some(([a,b])=>at>=a&&at+secret.length<=b))spans.push([at, at + secret.length]); at += secret.length; }
    }
    const regex = new RegExp('(?:^|[^a-zA-Z0-9_])(?:["\']?)(' + KEY_PATTERN + ')(?:["\']?)\\s*[:=]\\s*', 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      const start = regex.lastIndex;
      let end = start;
      const quote = text[start];
      if (text.startsWith('[REDACTED]',start)) {
        end = start + '[REDACTED]'.length;
      } else if (quote === '"' || quote === "'") {
        end++;
        let escaped = false;
        for (; end < text.length; end++) {
          const ch = text[end];
          if (!escaped && ch === quote) { end++; break; }
          if (!escaped && ch === '\\') escaped = true; else escaped = false;
        }
      } else {
        const auth = /authorization|cookie/i.test(match[1]);
        for (; end < text.length; end++) {
          if ((auth ? /[\r\n<>",}&]/ : /[\s,;&<>}\]]/).test(text[end])) break;
        }
      }
      if (end > start) spans.push([start, end]);
    }
    const inputs = /<input\b[^>]*>/gi;
    while ((match = inputs.exec(text))) {
      const tag = match[0];
      const name = /\b(?:name|id)\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!name || !SECRET_KEY.test(name[1])) continue;
      const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(tag);
      if (value) {
        const at = match.index + value.index + value[0].indexOf(value[2]);
        spans.push([at, at + value[2].length]);
      }
    }
    spans.sort((a,b) => a[0] - b[0] || b[1] - a[1]);
    const merged: Span[] = [];
    for (const span of spans) {
      const last = merged[merged.length-1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    return merged;
  }
  private render(text: string, end: number, minimumSecretLength=0): string {
    let result = '', offset = 0;
    for (const [start, stop] of this.spans(text,minimumSecretLength)) {
      if (start >= end) break;
      result += text.slice(offset, start) + '[REDACTED]';
      offset = Math.min(stop, end);
    }
    return result + text.slice(offset, end);
  }
  text(text: string): string { return this.render(text, text.length); }
  /** Detect spans using the lookahead, but emit only the ORIGINAL raw prefix. */
  prefix(bytes: Uint8Array, outputLimit: number): string {
    const text = new TextDecoder().decode(bytes);
    const rawHead = new TextDecoder().decode(bytes.subarray(0, outputLimit), {stream:true});
    const rendered = this.render(text, rawHead.length);
    const clipped = truncateUtf8(rendered, outputLimit);
    const marker = '[REDACTED]', at = clipped.lastIndexOf('[');
    if (at >= 0 && marker.startsWith(clipped.slice(at)) && clipped.slice(at) !== marker && rendered.startsWith(marker, at)) {
      return outputLimit >= marker.length ? truncateUtf8(clipped.slice(0,at), outputLimit-marker.length)+marker : '';
    }
    return clipped;
  }
  catalogValue<T>(value: T): T { return this.transform(value,true); }
  result<T>(value: T): T {
    const clean:any=this.catalogValue(value);
    const original:any=value;
    if(original?.data?.response?.body && clean?.data?.response?.body){
      const body=clean.data.response.body;
      body.value=this.value(original.data.response.body.value);
      // A concurrent request may register a new credential while learning is
      // persisted. Final redaction must still honor the original body budget.
      if(body.value!==null && ['json','text'].includes(body.format)){
        let serialized=body.format==='json'?JSON.stringify(body.value):String(body.value);
        if(Number.isInteger(body.limit_bytes)&&body.limit_bytes>=0&&Buffer.byteLength(serialized)>body.limit_bytes){
          body.value=this.prefix(Buffer.from(serialized),body.limit_bytes);body.format='text';body.truncated=true;
          serialized=String(body.value);
        }
        body.returned_bytes=Buffer.byteLength(serialized);
      }
    }
    return clean;
  }
  value<T>(value: T): T { return this.transform(value,false); }
  private transform<T>(value: T, catalog: boolean): T {
    const publicFields=new Set(['id','endpoint_id','source','source_revision','revision','snapshot_id','resource_uri','apk_sha256','method','methods','matched_methods','provenance','state','format','schema_version','contract_revision','evidence_scope','kind','type']);
    // Schema property names are field declarations, not captured secret values.
    // Keep only schema keywords; never publish captured defaults or examples.
    const schemaWalk = (schema: any, depth: number, secretField = false): any => {
      if (typeof schema === 'boolean') return schema;
      if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 48) return {};
      const result: Record<string, any> = Object.create(null);
      const scalars = new Set(['type','title','description','format','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','minItems','maxItems','uniqueItems','minProperties','maxProperties','pattern','const','enum','required']);
      for (const [key,item] of Object.entries(schema)) {
        if (key === 'properties' && item && typeof item === 'object' && !Array.isArray(item)) {
          result.properties = Object.create(null);
          for (const [name,child] of Object.entries(item)) result.properties[name] = schemaWalk(child, depth+1, SECRET_KEY.test(name));
        } else if (['items','additionalProperties','not','contains','if','then','else'].includes(key)) result[key] = schemaWalk(item,depth+1,secretField);
        else if (['anyOf','oneOf','allOf','prefixItems'].includes(key) && Array.isArray(item)) result[key] = item.map(child=>schemaWalk(child,depth+1,secretField));
        else if (scalars.has(key) && !(secretField && ['enum','const','pattern'].includes(key))) result[key] = ['type','required','format'].includes(key) ? structuredClone(item) : walk(item,depth+1);
      }
      return result;
    };
    const walk = (item: any, depth: number): any => {
      if (depth > 64) return '[DEPTH_LIMIT]';
      if (typeof item === 'string') return catalog?this.render(item,item.length,6):this.text(item);
      if (Array.isArray(item)) return item.map(v => walk(v, depth + 1));
      if (item && typeof item === 'object') {
        const out: Record<string, any> = Object.create(null);
        for (const [key, val] of Object.entries(item)) {
          const isSchema = ['params_schema','body_shape','body_schema'].includes(key) && val && typeof val === 'object' && !Array.isArray(val) && (Object.hasOwn(val,'type') || Object.hasOwn(val,'properties') || Object.hasOwn(val,'anyOf'));
          out[catalog?key:this.text(key)] = isSchema ? schemaWalk(val,depth+1) : SECRET_KEY.test(key) ? '[REDACTED]' : catalog&&publicFields.has(key) ? structuredClone(val) : walk(val, depth + 1);
        }
        return out;
      }
      return item;
    };
    return walk(value, 0);
  }
}
