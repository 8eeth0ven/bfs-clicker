// Redaction is for shareable views. Checkpoints and raw evidence remain private.
const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|session[-_]?id|csrf|refresh|credential)/i;
export function redactText(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[^\s<>"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[-_]?key|sessionid|authorization)[\w-]*\s*[=:]\s*)[^\s&<>"']+/gi, '$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b1[3-9]\d{9}\b/g, '[PHONE]');
}
export function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    for (const key of new Set(url.searchParams.keys())) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    // Hash routers may carry their own query string.
    url.hash = redactText(url.hash);
    return redactText(url.href);
  } catch { return redactText(value); }
}
export function redact(value, key = '') {
  if(['credentialOrigins','session_id'].includes(key))return value;
  if (['postData','body','text','query'].includes(key) && typeof value === 'string') {
    try { const parsed=JSON.parse(value); if(parsed&&typeof parsed==='object')return JSON.stringify(redact(parsed)); } catch { /* plain text */ }
  }
  if (['headers','reqHeaders','respHeaders'].includes(key) && Array.isArray(value)) return value.map(h => ({...h,value:SECRET_KEY.test(h.name||'')?'[REDACTED]':redact(h.value)}));
  if (['query','queryString'].includes(key) && Array.isArray(value)) return value.map(item=>{
    if(Array.isArray(item)&&item.length===2)return [item[0],SECRET_KEY.test(String(item[0]))?'[REDACTED]':redact(item[1])];
    if(item&&typeof item==='object'&&typeof item.name==='string')return {...item,value:SECRET_KEY.test(item.name)?'[REDACTED]':redact(item.value)};
    return redact(item);
  });
  if (SECRET_KEY.test(key) && value != null && typeof value !== 'boolean') return '[REDACTED]';
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]));
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? redactUrl(value) : redactText(value);
  return value;
}
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const REPORT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
