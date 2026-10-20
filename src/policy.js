import { DEFAULT_SKIP_TEXT_PATTERNS } from './skipwords.js';

export const LOGOUT_RE = /(?:^|[^a-z])(?:log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off)(?:[^a-z]|$)|(?:auth|oauth|token|session)s?[/_.-]*(?:revoke|revocation|delete|destroy|terminate|kill|invalidate)|\/(?:terminate|revoke)(?:[/?#]|$)/i;
const WRITE_RE = /(?:^|[^a-z])(?:delete|destroy|remove|create|save|submit|purchase|checkout|pay|payment|buy|upgrade|upload|invite|authorize|grant|revoke|unsubscribe|cancel[-_/ ]?(?:plan|subscription|trial))(?:[^a-z]|$)|删除|销毁|付款|支付|购买|提交|保存|创建|开通|授权|注销/i;
const READ_ACTION = /^(?:view|show|open|browse|search|query|filter|refresh|next|previous|back|home|details?|menu|expand|collapse|read|产品|全部功能|查看|显示|展开|收起|下一页|上一页|返回|首页|详情|菜单|查询|筛选|刷新|进入|跳转)(?:\b|\s|[\u4e00-\u9fff]|$)/i;
const STATIC_TYPES = new Set(['script','stylesheet','image','font','media','manifest']);
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

export function graphqlOperation(postData) {
  let data;
  try { data=JSON.parse(postData || '{}'); } catch { data={query:String(postData||'')}; }
  if (Array.isArray(data)) return {type:'unknown',operationName:null};
  const query=String(data.query||'').replace(/^\s*#[^\n]*\n/g,'').trim();
  const m=query.match(/^(query|mutation|subscription)\b\s*([\w]*)/);
  return {type:m?.[1] || (query.startsWith('{')?'query':'unknown'),operationName:data.operationName || m?.[2] || null};
}
export function createPolicy(config, emit = () => {}) {
  const nav=new Set(config.navigationOrigins); const network=new Set(config.requestOrigins); const credentials=new Set(config.credentialOrigins);
  const extra=config.includeUrlPattern ? new RegExp(config.includeUrlPattern) : null;
  const allowRule = (method,url,postData) => config.requestAllowlist.some(r => r.method===method && (r.url ? r.url===url : new RegExp(r.urlPattern).test(url)) && (!r.operationName || graphqlOperation(postData).operationName===r.operationName) && (!r.operationType || graphqlOperation(postData).type===r.operationType));
  const navigation = value => {
    let url; try { url=new URL(value); } catch { return {allow:false,reason:'invalid_url'}; }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return {allow:false,reason:'unsupported_protocol'};
    if (!nav.has(url.origin)) return {allow:false,reason:'navigation_origin_out_of_scope'};
    if (extra && !extra.test(url.href)) return {allow:false,reason:'include_pattern_excluded'};
    if (LOGOUT_RE.test(decodeURIComponentSafe(url.pathname+url.search))) return {allow:false,reason:'logout_endpoint'};
    if (WRITE_RE.test(decodeURIComponentSafe(url.pathname+url.search)) && !allowRule('GET',url.href,null)) return {allow:false,reason:'unsafe_get_endpoint'};
    return {allow:true,reason:'navigation_in_scope'};
  };
  const request = ({url:value,method='GET',type='',navigation:isNavigation=false,postData=null}) => {
    let url; try { url=new URL(value); } catch { return {allow:false,reason:'invalid_url'}; }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return {allow:false,reason:'unsupported_protocol'};
    if (LOGOUT_RE.test(decodeURIComponentSafe(url.pathname+url.search))) return {allow:false,reason:'logout_endpoint'};
    if (isNavigation) { const d=navigation(value); if (!d.allow) return d; }
    const inScope=network.has(url.origin);
    if (!inScope) {
      if (config.resourcePolicy==='flexible' && !isNavigation && method==='GET' && STATIC_TYPES.has(type.toLowerCase()) && !WRITE_RE.test(decodeURIComponentSafe(url.pathname+url.search))) return {allow:true,reason:'external_bootstrap_resource',stripCredentials:true};
      return {allow:false,reason:'request_origin_out_of_scope'};
    }
    const explicit=allowRule(method,url.href,postData);
    if(/\/(?:graphql|gql)(?:\/|$)/i.test(url.pathname)){
      const operation=graphqlOperation(postData||JSON.stringify({query:url.searchParams.get('query'),operationName:url.searchParams.get('operationName')}));
      if(operation.type!=='query'&&!(config.actionProfile==='forms'&&explicit))return {allow:false,reason:'graphql_operation_not_read_query'};
    }
    if (WRITE_RE.test(decodeURIComponentSafe(url.pathname+url.search)) && !explicit) return {allow:false,reason:'unsafe_endpoint'};
    if (!['GET','HEAD','OPTIONS'].includes(method) && !explicit) return {allow:false,reason:'unapproved_write_method'};
    return {allow:true,reason:explicit?'endpoint_allowlist':'request_in_scope',stripCredentials:!credentials.has(url.origin)};
  };
  const headers = (url, input, redirect=false) => {
    const origin=new URL(url).origin; const trusted=credentials.has(origin);
    const injected=new Set(Object.keys(config.authInject?.headers||{}).map(k=>k.toLowerCase()));
    const result=Object.fromEntries(Object.entries(input||{}).filter(([key]) => trusted || !SENSITIVE_HEADER.test(key)&&!injected.has(key.toLowerCase())));
    if (trusted && config.authInject && (!config.authInject.urlPattern || new RegExp(config.authInject.urlPattern).test(url))) {
      for (const [k,v] of Object.entries(config.authInject.headers)) {
        for (const key of Object.keys(result)) if (key.toLowerCase()===k.toLowerCase()) delete result[key];
        result[k]=v;
      }
    }
    // Chromium may synthesize Cookie after interception when it is omitted.
    // An explicit empty override in the CDP Fetch guard suppresses the cookie jar.
    if (!trusted) result.Cookie = '';
    return result;
  };
  const action = (el) => {
    if (el.excluded) return {allow:false,reason:'excluded_selector'};
    const text=[el.text,el.label,el.aria,el.title,el.href,el.formAction,el.contextText].filter(Boolean).join(' ');
    if ([...DEFAULT_SKIP_TEXT_PATTERNS,...config.skipTextPatterns].some(p => text.toLowerCase().includes(p.toLowerCase())) || LOGOUT_RE.test(text)) return {allow:false,reason:'dangerous_action'};
    if (WRITE_RE.test(text)) {
      const formAllowed=config.actionProfile==='forms' && config.actionAllowlist.includes(el.selector) && el.formAction && allowRule((el.formMethod||'GET').toUpperCase(),el.formAction,null);
      if (!formAllowed) return {allow:false,reason:'unsafe_action'};
    }
    if (el.href) { const d=navigation(el.href); if (!d.allow && el.href!=='#') return d; }
    if (el.kind==='scroll') return {allow:config.exploreScroll,reason:'bounded_scroll'};
    if (el.kind==='hover') return {allow:config.exploreHover && (['menuitem','tab','link'].includes(el.role) || el.hoverHint),reason:'bounded_hover'};
    if (config.actionAllowlist.includes(el.selector) || config.actionAllowlist.includes(el.label)) return {allow:true,reason:'action_allowlist'};
    if (config.actionProfile==='forms' && ['text','checkbox','radio','select'].includes(el.type)) return {allow:true,reason:'explicit_forms_profile'};
    if (el.formAction || ['reset','image'].includes(el.htmlType) || el.tag==='input'&&el.htmlType==='submit') return {allow:false,reason:'form_action_requires_allowlist'};
    if (el.type==='text') return {allow:false,reason:'form_fill_disabled'};
    if (['select','checkbox','radio'].includes(el.type)) return {allow:!el.formAction && (!!el.filterContext || config.clickEverything && !!el.aria),reason:'representative_filter_control'};
    if (!config.clickEverything && !el.href) return {allow:false,reason:'click_everything_disabled'};
    if (el.href || el.tag==='summary' || ['tab','menuitem','link'].includes(el.role) || READ_ACTION.test(el.label||'')) return {allow:true,reason:'read_or_navigation_action'};
    return {allow:false,reason:'unknown_action'};
  };
  return {navigation,request,headers,action,allowRule,record:(info,decision)=>{
    const actionId=config._runtime?.currentActionId||null;
    if(actionId&&!decision.allow)config._runtime.blockedRequests?.push({url:info.url,reason:decision.reason,navigation:info.navigation});
    return emit('policy',{...info,...decision,actionId});
  }};
}
function decodeURIComponentSafe(value) { try { return decodeURIComponent(value); } catch { return value; } }
