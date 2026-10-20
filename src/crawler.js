// Compatibility helpers for existing endpoint extraction users.
import { extractEndpoints, extractApiSurface, extractHrefs, isApiPath } from './urlshape.js';
import { interestingRequest, observeApi } from './cdpnet.js';
import { runAsset } from './runner.js';
const safeHost=u=>{try{return new URL(u).host}catch{return ''}};
export const LOGOUT_API_RE=new RegExp('(?:^|[^a-z])(?:log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off)(?:[^a-z]|$)|(?:auth|oauth|token|session)s?[/_.-]*(?:revoke|revocation|delete|destroy|terminate|kill|invalidate)|/(?:terminate|revoke)(?:[/?#]|$)','i');
const SENSITIVE_URL_RE=/(?:^|[/?#=&._-])(?:sessions?|auth(?:entication|orization)?s?|oauth2?|tokens?|sign-?in|log-?ins?|refresh(?:[-_]?tokens?)?|log-?outs?|sign-?outs?)(?=$|[/?#=&._-])/;
export const isSessionSensitiveUrl=u=>SENSITIVE_URL_RE.test(String(u||'').toLowerCase());
function rememberLedgerEndpoint(apiLedger,ep,base){
  if(!apiLedger||!ep||ep.includes('$'+'{')||ep.includes('{'))return;
  let abs;try{abs=new URL(ep,base)}catch{return}
  if(!['http:','https:'].includes(abs.protocol))return;abs.hash='';
  if(!interestingRequest('unknown',abs.href,'')||LOGOUT_API_RE.test(abs.href)||isSessionSensitiveUrl(abs.href))return;
  observeApi(apiLedger,{method:'unknown',url:abs.href,source:{kind:'document',document:base||''},category:'static_candidate'});
}

export function absorbBodyText(url, txt, ct, bag) {
  const jsEndpoints = bag && bag.jsEndpoints;
  const pendingSeeds = bag && bag.pendingSeeds;
  const discoveryOn = !!(bag && bag.discoveryOn);
  const startUrl = (bag && bag.startUrl) || url || 'http://localhost/';
  if (!jsEndpoints || !txt) return;
  const ctStr = ct || '';
  const isJs = /javascript|ecmascript/i.test(ctStr) || /\.(?:js|mjs)(?:\?|$)/i.test(url || '');
  const isHtml = /html/i.test(ctStr);
  const isJson = /json|graphql/i.test(ctStr) || /\.json(?:\?|$)/i.test(url || '');
  const queueSeed = (raw) => {
    if (!discoveryOn || !pendingSeeds) return;
    if (!raw || raw.includes('${') || raw.includes('{')) return;
    let abs;
    try { abs = new URL(raw, startUrl); } catch { return; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    const host = safeHost(startUrl);
    if (host && abs.host !== host) return;
    const p = abs.pathname.replace(/\/+$/, '') || '/';
    if (p === '/') return;
    if (isApiPath(p + abs.search) || isApiPath(abs.href)) return;
    if (isSessionSensitiveUrl(abs.href) || LOGOUT_API_RE.test(abs.href)) return;
    if (abs.pathname.split('/').some((s) => s.startsWith(':'))) return;
    pendingSeeds.add(abs.href);
  };
  if (isJs) {
    for (const ep of extractEndpoints(txt)) {
      jsEndpoints.add(ep);
      queueSeed(ep);
    }
  }
  if (isJs || isJson || isHtml) {
    const surface = extractApiSurface(txt, url || startUrl);
    for (const ep of surface.apis) if (ep && !ep.includes('${')) {
      jsEndpoints.add(ep);
      rememberLedgerEndpoint(bag.apiLines, ep, url || startUrl);
    }
    for (const ep of surface.routes) {
      if (!ep || ep.includes('${')) continue;
      jsEndpoints.add(ep);
      rememberLedgerEndpoint(bag.apiLines, ep, url || startUrl);
      queueSeed(ep);
    }
  }
  if (isHtml && discoveryOn) {
    const targetHost = safeHost(startUrl);
    for (const h of extractHrefs(txt, url || startUrl)) {
      try { if (new URL(h, url || startUrl).host !== targetHost) continue; } catch { continue; }
      queueSeed(h);
    }
  }
}

// All public entry points share the guarded task service.
export async function crawl({ config, log = console.log, resume = false }) {
  return runAsset(config, { log, resume });
}
