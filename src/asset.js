import {normalizeVisualConfig} from './browser-visual.js';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SKIP_TEXT_PATTERNS } from './skipwords.js';

export const DEFAULTS = {
  actionProfile: 'safe', resourcePolicy: 'strict', order: 'bfs', headless: true, limitMode: 'default',
  browserType: 'chromium', useProxy: false, maxStates: 50, maxDepth: 3,
  maxDurationMs: 300000, maxRequests: 1500, maxTabs: 1, maxRetries: 1,
  maxActions: 500, maxStatesPerHost: 50, requestDelayMs: 50, retryMaxDelayMs: 5000,
  gotoTimeoutMs: 15000, actionTimeoutMs: 4000, drainTimeoutMs: 5000,
  captureTraffic: true, captureBinaryBodies: false, captureInitiators: true, harCapture: true, harPath: 'traffic.har',
  checkpointIntervalMs: 1000, reuseVerifiedState: true, seedInterleaveActions: 8,
  trafficMaxBodyBytes: 65536, trafficHarvestMaxBytes: 1048576, bodyTimeoutMs: 3000,
  maxBodyConcurrency: 2, maxPendingBodies: 32, maxApiSamples: 20,
  maxRequestBodyBytes: 65536,
  clickEverything: true, fillText: false, formExplore: false, jsClickFallback: false,
  autoAgreeConsent: false, exploreHover: true, exploreScroll: true,
  maxScrollSteps: 2, maxSelectOptions: 2, maxFrames: 12, maxInteractives: 300,
  jsEndpointHarvest: true, discoverySeeds: false, discoverySeedCap: 20,
  seedFiles: false, shotFormat: 'png', shotQuality: 65, ignoreHTTPSErrors: false,
  authMode: 'anonymous', authCheckIntervalMs: 30000,
  auth: {}, excludeSelectors: [], excludeTextPatterns: [], skipTextPatterns: [],
  actionAllowlist: [], writeActionAllowlist: [], requestAllowlist: [], seedRoutes: [], fingerprintNoisePatterns: [],
  fingerprintIgnoreSelectors: ['[data-bfs-noise]', '[role="timer"]'],
  modalSelectors: ['[role="dialog"]','.modal'], modalCheckboxSelectors: ['input[type="checkbox"]'],
  modalCloseSelectors: ['[aria-label="Close"]'], agreeKeywords: ['接受','同意','accept','agree'],
  consentKeywords: ['隐私','条款','协议','privacy','terms','consent'],
  stabilize: { quietMs: 80, timeoutMs: 1500, settleMs: 80 },
};
// null has one explicit meaning in persisted JSON: this exploration limit is off.
// Browser concurrency, operation timeouts and evidence buffers remain bounded.
export const EXPLORATION_LIMITS = ['maxStates','maxDepth','maxDurationMs','maxRequests','maxActions','maxStatesPerHost'];
export const limitReached = (config,key,count) => config[key] != null && count >= config[key];
// Old performance heuristics are retired, with a visible migration note; they cannot loosen policy.
// Accepted-but-ignored is not allowed: every retired key prints where the behavior moved.
const RETIRED_NOTES = {
  blockAssets:'blockAssets 已退役；静态资源由 resourcePolicy 与证据体量预算控制，不再单独屏蔽',
  consentFallback:'consentFallback 已退役；同意弹窗只受 autoAgreeConsent 控制',
  trafficIncludePattern:'trafficIncludePattern 已退役；证据范围由 origin/请求策略决定，不再支持 include 过滤',
  trafficExcludeExt:'trafficExcludeExt 已退役；静态资源由证据链按资源类型与扩展名自动跳过',
  trafficExcludeHost:'trafficExcludeHost 已退役；范围外主机由 requestOrigins/strict 策略阻断',
  trafficStripQueryParams:'trafficStripQueryParams 已退役；查询串键值按内置脱敏与样本规则保留',
  trafficKeepQueryParams:'trafficKeepQueryParams 已退役；查询串键值按内置脱敏与样本规则保留',
};
const RETIRED = new Set(['rootPool','rootPoolSize','overviewBatchSize','overviewMinInteractives',
  'overviewSettleTimeoutMs','surfaceSettleTimeoutMs','rootMinInteractives','rootWaitMaxMs',
  'rootStableRounds','rootZeroStableRounds','expansionMinDelta','expansionMinRatio',
  'ctxRebuildEvery','nativeLogoutBlock','routeTabCap','routeHandlerTimeoutMs','rediscoverOnReturn',
  'retryPasses','dedupeByUrl','clickSkipAfterFails','elementFailNoCircuit','shieldBailSec','perfFlags',
  'memPausePercent','claimFreeTrial','consentRequireOverlay','crawlRetryMax','crossOriginGotoTimeoutMs',
  'urlShapeDedup','pageSimDedup','pageSimThreshold','relocateRetries','loginPageRe','discoverySeedBatch',
  ...Object.keys(RETIRED_NOTES)]);
const OPTIONAL = ['startUrl','outputDir','storageState','persistentProfile','channel','extraLaunchArgs',
  'userAgent','proxy','authInject','credentialOrigins','navigationOrigins','requestOrigins','includeUrlPattern',
  'authProfileId','sessionWritebackTo','loginUrl','loginPageRe','loginLoggedInUrlContains',
  'loginTimeoutMs','gotoRetries','relocateRetries','circuitBreakerMax','urlShapeDedup',
  'pageSimDedup','pageSimThreshold','discoverySeedBatch','formValues','fillTextValue', 'authEpoch','visual'];
const POSITIVE = ['maxStates','maxDurationMs','maxRequests','maxTabs','maxActions','maxStatesPerHost',
  'gotoTimeoutMs','actionTimeoutMs','drainTimeoutMs','trafficMaxBodyBytes','trafficHarvestMaxBytes',
  'bodyTimeoutMs','maxBodyConcurrency','maxPendingBodies','maxApiSamples','maxFrames','maxInteractives',
  'authCheckIntervalMs','loginTimeoutMs','retryMaxDelayMs','maxRequestBodyBytes','checkpointIntervalMs','seedInterleaveActions'];
const NONNEGATIVE = ['maxDepth','maxRetries','requestDelayMs','maxScrollSteps','maxSelectOptions',
  'discoverySeedCap','gotoRetries','relocateRetries','circuitBreakerMax','discoverySeedBatch','authEpoch'];
const ARRAYS = ['excludeSelectors','excludeTextPatterns','skipTextPatterns','actionAllowlist','writeActionAllowlist',
  'seedRoutes','fingerprintNoisePatterns','fingerprintIgnoreSelectors','modalSelectors','modalCheckboxSelectors',
  'modalCloseSelectors','agreeKeywords','consentKeywords','extraLaunchArgs'];

export function canonicalAsset(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('asset 必须是完整 HTTP(S) URL'); }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('asset 只接受无内嵌账号密码的 HTTP(S) URL');
  }
  return url.href;
}
function origins(value, fallback, label) {
  const items = value ?? fallback;
  if (!Array.isArray(items) || !items.length) throw new Error(`${label} 必须是非空 origin 数组`);
  return [...new Set(items.map(v => {
    const url = new URL(canonicalAsset(v));
    if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${label} 只接受 origin，不接受路径或通配符`);
    return url.origin;
  }))].sort();
}
export function readSession(file) {
  if (!existsSync(file)) throw new Error(`session 不存在: ${file}`);
  let state;
  try { state = JSON.parse(readFileSync(file,'utf8')); } catch { throw new Error('session 不是有效 JSON'); }
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('session 必须包含 cookies 和 origins 数组');
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') throw new Error('session cookie 格式错误');
  }
  for (const item of state.origins) {
    if (!item || typeof item.origin !== 'string' || !Array.isArray(item.localStorage)) throw new Error('session origins 格式错误');
    origins([item.origin],[], 'session origin');
    if (item.localStorage.some(v => typeof v?.name !== 'string' || typeof v?.value !== 'string')) throw new Error('session localStorage 格式错误');
  }
  return state;
}
export function normalizeConfig(input, { baseDir = process.cwd(), legacy = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('config 必须是 JSON 对象');
  if(input.auth!=null&&(typeof input.auth!=='object'||Array.isArray(input.auth)))throw new Error('auth 必须是对象');
  if(input.stabilize!=null&&(typeof input.stabilize!=='object'||Array.isArray(input.stabilize)))throw new Error('stabilize 必须是对象');
  const allowed = new Set([...Object.keys(DEFAULTS),...OPTIONAL,...RETIRED]);
  for (const key of Object.keys(input)) {
    if (!['_configPath','_legacy','_migration','_policy','_runtime','_recoveredFromPrevious','sessionId','runId'].includes(key) && !allowed.has(key)) throw new Error(`未知配置项: ${key}`);
  }
  const cfg = { ...DEFAULTS,...input, auth: {...DEFAULTS.auth,...input.auth}, stabilize: {...DEFAULTS.stabilize,...input.stabilize} };
  cfg.visual = normalizeVisualConfig(cfg.visual);
  cfg.startUrl = canonicalAsset(cfg.startUrl);
  cfg._migration = [...(input._migration||[]),...Object.keys(input).filter(k => RETIRED.has(k)).map(k => RETIRED_NOTES[k] || `${k} 已退役；统一调度器串行探索，安全守卫始终启用`)];
  for (const k of RETIRED) delete cfg[k];
  if (!input.limitMode && EXPLORATION_LIMITS.some(key => Object.hasOwn(input,key))) cfg.limitMode='custom';
  if (legacy && (input.maxStates === 0 || input.maxStates === Infinity) && cfg.limitMode!=='unlimited') { cfg.maxStates = DEFAULTS.maxStates; cfg._migration.push('旧 maxStates=0 已改为默认 50；不限预算请显式设置 limitMode=unlimited'); }
  if (cfg.limitMode==='unlimited') for (const key of EXPLORATION_LIMITS) cfg[key]=null;
  for (const key of EXPLORATION_LIMITS) if (cfg.limitMode!=='unlimited' && cfg[key]==null) throw new Error(`${key} 只能在 limitMode=unlimited 时为空`);
  if (cfg.gotoRetries != null) cfg.maxRetries = cfg.gotoRetries;
  delete cfg.gotoRetries;
  if (cfg.loginLoggedInUrlContains && !cfg.auth.loggedInUrlPattern) cfg.auth.loggedInUrlPattern = cfg.loginLoggedInUrlContains.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for (const k of POSITIVE) {
    if(cfg.limitMode==='unlimited'&&EXPLORATION_LIMITS.includes(k))continue;
    if(cfg[k]==null&&!Object.hasOwn(DEFAULTS,k)&&!Object.hasOwn(input,k))continue;
    if(!Number.isSafeInteger(cfg[k])||cfg[k]<=0)throw new Error(`${k} 必须是正整数`);
  }
  for (const k of NONNEGATIVE) {
    if(cfg.limitMode==='unlimited'&&EXPLORATION_LIMITS.includes(k))continue;
    if(cfg[k]==null&&!Object.hasOwn(DEFAULTS,k)&&!Object.hasOwn(input,k))continue;
    if(!Number.isSafeInteger(cfg[k])||cfg[k]<0)throw new Error(`${k} 必须是非负整数`);
  }
  for (const [k,v] of Object.entries(DEFAULTS)) if (typeof v === 'boolean' && typeof cfg[k] !== 'boolean') throw new Error(`${k} 必须是 boolean`);
  for (const k of ARRAYS) if (cfg[k] != null && (!Array.isArray(cfg[k]) || cfg[k].some(v => typeof v !== 'string'))) throw new Error(`${k} 必须是字符串数组`);
  for (const [k, choices] of Object.entries({ limitMode:['default','custom','unlimited'], actionProfile:['safe','forms'], resourcePolicy:['strict','flexible'], order:['bfs','dfs'], browserType:['chromium','firefox','webkit'], authMode:['anonymous','session','browser-profile','manual'], shotFormat:['png','jpeg','jpg','none'] })) {
    if (!choices.includes(cfg[k])) throw new Error(`${k} 可选 ${choices.join('|')}`);
  }
  const origin = new URL(cfg.startUrl).origin;
  cfg.navigationOrigins = origins(cfg.navigationOrigins,[origin],'navigationOrigins');
  cfg.requestOrigins = origins(cfg.requestOrigins,cfg.navigationOrigins,'requestOrigins');
  if(cfg.credentialOrigins!=null&&!Array.isArray(cfg.credentialOrigins))throw new Error('credentialOrigins 必须是 origin 数组');
  cfg.credentialOrigins = cfg.credentialOrigins==null?[origin]:cfg.credentialOrigins.length?origins(cfg.credentialOrigins,[],'credentialOrigins'):[];
  if (!cfg.navigationOrigins.includes(origin) || cfg.navigationOrigins.some(v => !cfg.requestOrigins.includes(v))) throw new Error('入口和 navigationOrigins 必须包含在 requestOrigins 中');
  if (cfg.credentialOrigins.some(v => !cfg.requestOrigins.includes(v))) throw new Error('credentialOrigins 必须显式包含在 requestOrigins 中');
  for (const p of [cfg.includeUrlPattern,...cfg.fingerprintNoisePatterns].filter(Boolean)) try { new RegExp(p); } catch { throw new Error(`无效正则: ${p}`); }
  if (cfg.includeUrlPattern && !new RegExp(cfg.includeUrlPattern).test(cfg.startUrl)) throw new Error('includeUrlPattern 未覆盖入口 URL');
  if (!Array.isArray(cfg.requestAllowlist)) throw new Error('requestAllowlist 必须是数组');
  for (const rule of cfg.requestAllowlist) {
    if (!rule || Object.keys(rule).some(k=>!['method','url','urlPattern','operationName','operationType'].includes(k)) || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(rule.method||'')) throw new Error('requestAllowlist 每项需要明确 method 和 url/urlPattern');
    if ((!rule.url && !rule.urlPattern) || (rule.url && rule.urlPattern)) throw new Error('requestAllowlist 只设置一个 url 或 urlPattern');
    if (rule.url) canonicalAsset(rule.url);
    if (rule.urlPattern) { if (!rule.urlPattern.startsWith('^') || !rule.urlPattern.endsWith('$')) throw new Error('requestAllowlist urlPattern 必须用 ^ 和 $ 锚定'); new RegExp(rule.urlPattern); }
    if(rule.operationType&&!['query','mutation','subscription'].includes(rule.operationType))throw new Error('operationType 必须是 query/mutation/subscription');
  }
  if (cfg.authInject) {
    if (typeof cfg.authInject !== 'object' || !cfg.authInject.headers || Array.isArray(cfg.authInject.headers) || Object.keys(cfg.authInject).some(k => !['headers','urlPattern'].includes(k))) throw new Error('authInject 需要 headers 对象');
    for (const [name,value] of Object.entries(cfg.authInject.headers)) if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('authInject header 格式错误');
    if (cfg.authInject.urlPattern) new RegExp(cfg.authInject.urlPattern);
  }
  const authKeys = ['loggedInSelector','loggedInUrlPattern','loggedOutSelector','loggedOutUrlPattern','probeUrl','probeStatus','probeJson','required','localStorageKey'];
  if (!cfg.auth || typeof cfg.auth !== 'object' || Array.isArray(cfg.auth) || Object.keys(cfg.auth).some(k=>!authKeys.includes(k))) throw new Error('未知或无效 auth 配置');
  for (const k of ['loggedInUrlPattern','loggedOutUrlPattern']) if (cfg.auth[k]) new RegExp(cfg.auth[k]);
  for(const k of ['loggedInSelector','loggedOutSelector','loggedInUrlPattern','loggedOutUrlPattern','localStorageKey','probeUrl'])if(cfg.auth[k]!=null&&typeof cfg.auth[k]!=='string')throw new Error(`auth.${k} 必须是字符串`);
  if(cfg.auth.required!=null&&typeof cfg.auth.required!=='boolean')throw new Error('auth.required 必须是 boolean');
  if(cfg.auth.probeStatus!=null&&(!Number.isInteger(cfg.auth.probeStatus)||cfg.auth.probeStatus<100||cfg.auth.probeStatus>599))throw new Error('auth.probeStatus 无效');
  if(cfg.auth.probeJson!=null&&(typeof cfg.auth.probeJson!=='object'||Array.isArray(cfg.auth.probeJson)))throw new Error('auth.probeJson 必须是对象');
  if (cfg.auth.probeUrl) { const p=new URL(canonicalAsset(cfg.auth.probeUrl)); if (!cfg.requestOrigins.includes(p.origin)) throw new Error('auth probe 必须在 requestOrigins 内'); }
  for (const [k,v] of Object.entries(cfg.stabilize)) if (!['quietMs','timeoutMs','settleMs'].includes(k) || !Number.isSafeInteger(v) || v<0) throw new Error('stabilize 只接受非负 quietMs/timeoutMs/settleMs');
  if (!Number.isInteger(cfg.shotQuality) || cfg.shotQuality<1 || cfg.shotQuality>100) throw new Error('shotQuality 必须在 1–100');
  if (cfg.harPath !== path.basename(cfg.harPath) || !cfg.harPath.endsWith('.har')) throw new Error('harPath 必须是输出目录中的 .har 文件名');
  if (cfg.useProxy && (!cfg.proxy?.server || !/^(https?|socks5):\/\//.test(cfg.proxy.server))) throw new Error('启用代理需要 proxy.server');
  if(cfg.proxy&&Object.keys(cfg.proxy).some(k=>!['server','bypass','username','password'].includes(k)))throw new Error('proxy 未知选项');
  if(cfg.formValues&&(typeof cfg.formValues!=='object'||Array.isArray(cfg.formValues)||Object.values(cfg.formValues).some(v=>typeof v!=='string')))throw new Error('formValues 必须为 selector 到字符串的对象');
  for (const k of ['outputDir','storageState','persistentProfile','sessionWritebackTo']) if (cfg[k]) cfg[k] = path.resolve(baseDir,cfg[k]);
  if (cfg.storageState && cfg.persistentProfile) throw new Error('session 和 browser-profile 不能同时使用');
  if (cfg.storageState && cfg.authMode!=='manual') { cfg.authMode='session'; readSession(cfg.storageState); }
  if (cfg.persistentProfile) cfg.authMode='browser-profile';
  if (cfg.authMode==='session' && !cfg.storageState) throw new Error('session 模式需要 storageState');
  if (cfg.authMode==='browser-profile' && !cfg.persistentProfile) throw new Error('browser-profile 模式需要独立目录');
  if (cfg.authMode==='manual') { cfg.headless=false; if (!cfg.storageState) cfg.storageState=path.join(baseDir,'output','session.json'); }
  if (cfg.actionProfile==='safe' && (cfg.fillText || cfg.formExplore)) throw new Error('填表需要 --profile forms 和明确 requestAllowlist');
  if (cfg.actionProfile==='forms' && !cfg.requestAllowlist.length) throw new Error('forms 策略需要明确 requestAllowlist');
  if (cfg.writeActionAllowlist.length && (cfg.actionProfile!=='forms' || !cfg.requestAllowlist.length || cfg.writeActionAllowlist.length>100 || cfg.writeActionAllowlist.some(selector=>!selector || selector.length>2048 || !cfg.actionAllowlist.includes(selector)))) throw new Error('writeActionAllowlist 需要 forms、明确 requestAllowlist，且固定 selector 必须属于 actionAllowlist');
  if (cfg.fillText && !cfg.formValues && !cfg.fillTextValue) throw new Error('填表需要 formValues 或 fillTextValue');
  cfg.runId = cfg.runId || `${randomUUID()}_${new URL(cfg.startUrl).host}`;
  cfg.sessionId = cfg.runId;
  cfg.outputDir ||= path.resolve(baseDir,'output-runs',cfg.runId.replace(/[^\w.-]/g,'_'));
  cfg.authProfileId ||= `${cfg.authMode}:${cfg.storageState || cfg.persistentProfile || (cfg.authInject?'header-injection':'anonymous')}`;
  return cfg;
}
