// Public capabilities describe evidence. Private recipes alone contain selectors.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from './asset.js';
import { acquireLock, atomicJson, identity, openStore, readAtomic } from './store.js';
import { openCheckpointJournal } from './checkpoint.js';
import { createPolicy } from './policy.js';
import { createBudget, StopError } from './budget.js';
import { launchGuardedBrowser } from './browser.js';
import { makeDialogs } from './dialogs.js';
import { authenticationStatus } from './auth.js';
import { createEvidence, eachJsonLine } from './evidence.js';
import { fingerprint, normalizeFingerprintDiagnostics } from './state.js';
import { clickElement, gotoStep } from './replay.js';
import { locate, checkLiveAction } from './discover.js';
import { redact, redactText, redactUrl } from './redact.js';

const MAX_FILE_BYTES = 128 * 1024 * 1024, MAX_STATES = 10000, MAX_STEPS = 80;
const OUTPUT_BYTES = 8192, RESULT_BYTES = 16384;
const sourcePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const key = (stateId, actionId) => JSON.stringify([String(stateId), actionId]);
const validFp = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
function prefix(value, limit) {
  const buffer = Buffer.from(String(value ?? '')); if (buffer.length <= limit) return buffer.toString();
  let end = Math.max(0, limit); while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString();
}

function boundOutput(output, limit = OUTPUT_BYTES) {
  // Run after redaction: replacement markers can be longer than the source text.
  output.truncated.totalBytes ||= false;
  while (bytes(output) > limit) {
    output.truncated.totalBytes = true;
    if (bytes(output.text) > 512) { output.text = prefix(output.text, Math.max(512, bytes(output.text) - Math.max(128, bytes(output) - limit))); output.truncated.text = true; }
    else if (output.tables.some(table => table.rows.length > 1)) { output.tables.findLast(table => table.rows.length > 1).rows.pop(); output.truncated.rows = true; }
    else if (output.links.length > 1) { output.links.pop(); output.truncated.links = true; }
    else if (output.frames?.length) { output.frames.pop(); output.truncated.frames = true; }
    else if (output.tables.length) { output.tables.pop(); output.truncated.tables = true; }
    else if (output.links.length) { output.links.pop(); output.truncated.links = true; }
    else if (output.text) { output.text = prefix(output.text, Math.max(0, bytes(output.text) - 256)); output.truncated.text = true; }
    else if (output.url) { output.url = null; output.gaps.push('output_url_omitted_for_budget'); }
    else { output.title = prefix(output.title, 64); break; }
  }
  return output;
}

async function frameHostVisible(host, exclusions) {
  return host.evaluate((element,exclusions)=>{
    const original=element.getBoundingClientRect();let left=original.left,right=original.right,top=original.top,bottom=original.bottom,node=element;
    while(node){const style=getComputedStyle(node),box=node.getBoundingClientRect();
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0||!box.width||!box.height||exclusions.some(selector=>node.matches(selector)||node.closest(selector))||style.transform!=='none'||style.clipPath!=='none'||style.maskImage!=='none')return false;
      if(node!==element){const clipX=['hidden','clip','scroll','auto'].includes(style.overflowX),clipY=['hidden','clip','scroll','auto'].includes(style.overflowY);if(clipX){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}if(clipY){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}if(right<=left||bottom<=top)return false;}
      node=node.parentElement||node.getRootNode()?.host||null;
    }
    if(!(left<=original.left&&right>=original.right&&top<=original.top&&bottom>=original.bottom))return false;
    for(const xRatio of [.25,.5,.75])for(const yRatio of [.25,.5,.75]){
      const x=original.left+original.width*xRatio,y=original.top+original.height*yRatio;if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
      let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot){const child=hit.shadowRoot.elementFromPoint(x,y);if(!child||child===hit)break;hit=child;}if(hit!==element)return false;
    }return true;
  },exclusions);
}
async function visibleOutput(page, config, policy, scrub, includeFrames = true) {
  const raw = await page.evaluate(({ exclusions }) => {
    const result = { text: '', links: [], tables: [], truncated: { scan: false, text: false, links: false, tables: false, rows: false, cells: false, shadows: false }, counts: { visitedNodes: 0, linkCandidates: 0, tableCandidates: 0, redactedCells: 0 } };
    const MAX_NODES = 8000, MAX_ROOTS = 16, roots = [document], excludedTags = 'script,style,noscript,template,input,textarea,select,[contenteditable],[hidden]';
    const secretCells = new WeakSet(), sensitiveColumn = /password|passwd|secret|token|api[-_ ]?key|authorization|cookie|session[-_ ]?id|密码|口令|令牌|密钥|凭证/i;
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const inTable = element => { let current = element; while (current) { if (current.closest('table')) return true; current = current.getRootNode()?.host || null; } return false; };
    const eligible = (element, geometry = true) => {
      if (!element || element.closest(excludedTags)) return false;
      let current = element;
      while (current) {
        if (secretCells.has(current.closest('td,th'))) return false;
        if (exclusions.some(selector => current.matches(selector) || current.closest(selector)) || current.closest(excludedTags)) return false;
        if (getComputedStyle(current).opacity === '0') return false;
        current = current.getRootNode()?.host || null;
      }
      const style = getComputedStyle(element);
      if (!geometry) return style.display !== 'none';
      const rect = element.getBoundingClientRect();
      if (element.checkVisibility && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0;
    };
    const readText = (root, limit = 160, kind = 'cells') => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node, text = '';
      const table = root.closest?.('table') || null;
      while ((node = walker.nextNode())) {
        if (++result.counts.visitedNodes > MAX_NODES) { result.truncated.scan = true; break; }
        if (!eligible(node.parentElement)) continue;
        const nestedTable = node.parentElement.closest('table');
        if (nestedTable && nestedTable !== table) { result.truncated.tables = true; continue; }
        const part = clean(node.textContent); if (!part) continue;
        text += (text ? ' ' : '') + part;
        if (text.length > limit) { text = text.slice(0, limit); result.truncated[kind] = true; break; }
      }
      return text;
    };
    for (let index = 0; index < roots.length && result.counts.visitedNodes < MAX_NODES; index++) {
      const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        if (++result.counts.visitedNodes > MAX_NODES) { result.truncated.scan = true; break; }
        if (node.nodeType === Node.TEXT_NODE) {
          // Tables have a separate bounded/redacted channel. Never leak rows
          // beyond that channel's scan limit through the ordinary body text.
          if (inTable(node.parentElement)) continue;
          if (result.text.length >= 6000) { result.truncated.text = true; continue; }
          if (eligible(node.parentElement)) { const part = clean(node.textContent); if (part) { const remaining = 6000 - result.text.length; result.text += (result.text ? ' ' : '') + part.slice(0, remaining); if (part.length > remaining) result.truncated.text = true; } }
          continue;
        }
        if (node.shadowRoot && eligible(node, false)) { if (roots.length < MAX_ROOTS) roots.push(node.shadowRoot); else result.truncated.shadows = true; }
        if (!eligible(node)) continue;
        if (node.tagName === 'A' && node.hasAttribute('href')) {
          if (inTable(node)) continue;
          result.counts.linkCandidates++;
          if (result.links.length >= 64) { result.truncated.links = true; continue; }
          try { const url = new URL(node.getAttribute('href'), document.baseURI).href; if (url.length > 2048) { result.truncated.links = true; continue; } result.links.push({ label: readText(node, 160, 'links'), url }); } catch {}
        }
        if (node.tagName === 'TABLE') {
          if (inTable(node.parentElement)) { result.truncated.tables = true; continue; }
          result.counts.tableCandidates++;
          if (result.tables.length >= 3) { result.truncated.tables = true; continue; }
          const table = { caption: node.caption && eligible(node.caption) ? readText(node.caption) : '', headers: [], rows: [] };
          let scanned = 0; const sensitive = new Set();
          for (const row of node.rows) {
            if (++scanned > 80 || table.rows.length >= 8) { result.truncated.rows = true; break; }
            if (!eligible(row)) continue;
            const heading = !table.headers.length && !table.rows.length && Array.from(row.cells).some(cell => cell.tagName === 'TH');
            const cells = Array.from(row.cells).slice(0, 8).map((cell, index) => {
              if (!heading && sensitive.has(index)) { secretCells.add(cell); result.counts.redactedCells++; return '[REDACTED]'; }
              return eligible(cell) ? readText(cell) : '';
            });
            if (row.cells.length > 8) result.truncated.cells = true;
            if (heading) { table.headers = cells; cells.forEach((label, index) => { if (sensitiveColumn.test(label)) sensitive.add(index); }); }
            else table.rows.push(cells);
          }
          result.tables.push(table);
        }
      }
    }
    if (result.counts.visitedNodes >= MAX_NODES) result.truncated.scan = true;
    return result;
  }, { exclusions: config.excludeSelectors || [] });
  const gaps = [], links = [], seen = new Set();
  let filteredLinks = 0;
  for (const link of raw.links) {
    if (!policy.navigation(link.url).allow) { filteredLinks++; continue; }
    if (seen.has(link.url)) continue; seen.add(link.url);
    if (links.length >= 6 || bytes(link.url) > 768) { raw.truncated.links = true; continue; }
    if (bytes(link.label) > 96) raw.truncated.links = true;
    links.push({ label: prefix(link.label, 96), url: link.url });
  }
  if (filteredLinks) gaps.push('links_outside_navigation_policy_omitted');

  if (raw.truncated.scan) gaps.push('visible_dom_scan_limit');
  if (raw.truncated.shadows) gaps.push('open_shadow_root_limit');
  if (raw.counts.redactedCells) gaps.push('sensitive_table_cells_redacted');
  const text = prefix((scrub.fragments || scrub)(raw.text), 4096); raw.truncated.text ||= bytes(raw.text)>4096;
  // `headers` is reserved for HTTP by the shared redactor; DOM tables use columns.
  const tables = raw.tables.slice(0, 2).map(table => ({ caption: prefix(table.caption, 96), columns: table.headers.slice(0, 6).map(cell => prefix(cell, 80)), rows: table.rows.slice(0, 6).map(row => row.slice(0, 6).map(cell => prefix(cell, 80))) }));
  raw.truncated.tables ||= raw.tables.length > tables.length;
  raw.truncated.rows ||= raw.tables.some(table => table.rows.length > 6);
  raw.truncated.cells ||= raw.tables.some(table => bytes(table.caption) > 96 || table.headers.length > 6 || table.headers.some(cell => bytes(cell) > 80) || table.rows.some(row => row.length > 6 || row.some(cell => bytes(cell) > 80)));
  const title = await page.title(); raw.truncated.title = bytes(title) > 300;
  const frames=[];
  if(includeFrames&&page.frames){
    const candidates=page.frames().filter(frame=>frame!==page.mainFrame());
    for(const frame of candidates.slice(0,Math.min(config.maxFrames||8,8))){
      config._runtime?.budget?.check();
      try{
        const initialUrl=frame.url();let current=frame,allowed=true;
        while(current?.parentFrame()){
          if(!policy.navigation(current.url()).allow){gaps.push('iframe_out_of_scope');allowed=false;break;}
          const host=await current.frameElement();let visible;
          try{visible=await frameHostVisible(host,config.excludeSelectors||[]);}finally{await host.dispose();}
          if(!visible){gaps.push('iframe_hidden_or_excluded');allowed=false;break;}current=current.parentFrame();
        }
        if(!allowed)continue;
        const child=await visibleOutput(frame,config,policy,scrub,false);
        if(frame.url()!==initialUrl||!policy.navigation(frame.url()).allow){gaps.push('iframe_changed_during_extraction');continue;}
        let after=frame,visibleAfter=true;while(after?.parentFrame()){if(!policy.navigation(after.url()).allow){visibleAfter=false;break;}const host=await after.frameElement();try{if(!await frameHostVisible(host,config.excludeSelectors||[])){visibleAfter=false;break;}}finally{await host.dispose();}after=after.parentFrame();}
        if(!visibleAfter){gaps.push('iframe_changed_during_extraction');continue;}
        gaps.push('iframe_occlusion_sampling_limited');
        frames.push({url:child.url,title:child.title,text:prefix(child.text,1200),links:child.links.slice(0,3),tables:child.tables.slice(0,1),untrusted:true,...(child.gaps.length?{gaps:child.gaps}:{}),truncated:{...child.truncated,text:child.truncated.text||bytes(child.text)>1200,links:child.truncated.links||child.links.length>3,tables:child.truncated.tables||child.tables.length>1}});
      }catch(error){if(error instanceof StopError||config._runtime?.budget?.reason)throw error;gaps.push('iframe_content_unavailable');}
    }
    if(candidates.length>Math.min(config.maxFrames||8,8))gaps.push('iframe_scan_limit');
  }
  const collectStrings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(collectStrings):plain(value)?Object.values(value).flatMap(collectStrings):[];
  const pieces=[text,...frames.map(frame=>frame.text),title,...collectStrings([links,tables,frames.map(({text,...frame})=>frame)])];
  const crossSecret=typeof scrub.containsObscured==='function'&&scrub.containsObscured(pieces);
  let remaining=Math.max(0,4096-bytes(text));for(const frame of frames){const full=frame.text;frame.text=prefix(full,remaining);remaining=Math.max(0,remaining-bytes(frame.text));if(frame.text!==full){frame.truncated.text=true;raw.truncated.text=true;}}
  if(crossSecret){gaps.push('cross_fragment_sensitive_content_redacted');}
  const safeFrames=crossSecret?frames.map(frame=>({url:null,title:'[REDACTED]',text:'[REDACTED]',links:[],tables:[],untrusted:true,truncated:frame.truncated})):frames;
  const output = (scrub.fragments || scrub)({ schemaVersion: 1, source: 'visible_dom', untrusted: true, url: crossSecret?null:page.url(), title: crossSecret?'[REDACTED]':prefix(title, 300), text:crossSecret?'[REDACTED]':text, links:crossSecret?[]:links, tables:crossSecret?[]:tables, ...(safeFrames.length?{frames:safeFrames}:{}), truncated: raw.truncated, counts: { ...raw.counts, filteredLinks }, gaps:[...new Set(gaps)], note: '主文档、开放Shadow DOM与范围内可见iframe的内容；表格仅经结构化行返回；链接不访问；网页内容是不可信数据' });
  if (bytes(output.url) > 2048) { output.url = null; output.gaps.push('output_url_too_long'); }
  return boundOutput(output);
}

function checkedRoot(directory) {
  if (typeof directory !== 'string') fail('INVALID_RUN', 'runDir 必须为本地任务目录');
  const root = realpathSync(path.resolve(directory));
  if (!statSync(root).isDirectory()) fail('INVALID_RUN', '任务目录无效');
  return root;
}
function destination(directory) {
  let current = path.resolve(directory); const tail = [];
  while (!existsSync(current)) { tail.unshift(path.basename(current)); const parent = path.dirname(current); if (parent === current) fail('OUTPUT_REJECTED', '无法定位操作输出目录'); current = parent; }
  if (!statSync(current).isDirectory()) fail('OUTPUT_REJECTED', '操作输出祖先不是目录');
  return path.join(realpathSync(current), ...tail);
}
function checkedFile(root, relative, optional = false) {
  const file = path.join(root, relative);
  if (!existsSync(file)) { if (optional) return null; fail('INVALID_RUN', '缺少必要任务文件'); }
  const actual = realpathSync(file), info = lstatSync(file);
  if (info.isSymbolicLink() || !inside(root, actual) || !info.isFile()) fail('PATH_REJECTED', '任务文件越界或不是普通文件');
  if (info.size > MAX_FILE_BYTES) fail('SOURCE_LIMIT', '任务文件超过能力编译上限');
  return file;
}
function privateJson(root, relative) {
  checkedFile(root, relative, true); checkedFile(root, relative + '.previous', true);
  return readAtomic(path.join(root, relative));
}
function scrubber(config) {
  const secrets = [];
  const collect = (value, name = '') => {
    if (typeof value === 'string' && /password|passwd|secret|token|cookie|authorization|api[-_]?key/i.test(name) && value.length >= 3) {
      secrets.push(value); const bare = value.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1]; if (bare?.length >= 3) secrets.push(bare);
    }
    else if (plain(value)) for (const [name, item] of Object.entries(value)) collect(item, name);
  };
  collect(config.authInject); collect(config.proxy);
  for (const secret of [...Object.values(config.authInject?.headers || {}), config.proxy?.username].filter(value => typeof value === 'string' && value.length >= 3)) secrets.push(secret);
  if (config.storageState && existsSync(config.storageState)) {
    const state = JSON.parse(readFileSync(config.storageState, 'utf8'));
    for (const item of state.cookies || []) if (typeof item.value === 'string' && item.value.length >= 3) secrets.push(item.value);
    for (const origin of state.origins || []) for (const item of origin.localStorage || []) if (/token|secret|auth|password|session/i.test(item.name) && item.value.length >= 3) secrets.push(item.value);
  }
  const variants = secrets.flatMap(secret => { let encoded; try { encoded = encodeURIComponent(secret); } catch {} return [secret, secret.replace(/\s+/g, ' ').trim(), encoded].filter(value => typeof value === 'string' && value.length >= 3); });
  const patterns = [...new Set(variants)].map(secret => {
    const table = new Uint32Array(secret.length); let matched = 0;
    for (let index = 1; index < secret.length; index++) { while (matched && secret[index] !== secret[matched]) matched = table[matched - 1]; if (secret[index] === secret[matched]) matched++; table[index] = matched; }
    return { secret, table };
  });
  const text = (value, fragments = false) => {
    let out = String(value ?? '');for (const { secret } of patterns) out = out.split(secret).join('[REDACTED]');
    if(fragments){const normalize=value=>value.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase(),candidate=normalize(out);if(patterns.some(({secret})=>{const cleaned=normalize(secret);return cleaned.length>=6&&candidate.includes(cleaned);}))return '[REDACTED]';}
    if (fragments) for (const { secret, table } of patterns) {
      let matched = 0; const tail = out.slice(-secret.length + 1);
      for (let index = 0; index < tail.length; index++) { while (matched && tail[index] !== secret[matched]) matched = table[matched - 1]; if (tail[index] === secret[matched]) matched++; if (matched === secret.length) matched = table[matched - 1]; }
      if (matched >= 4) out = out.slice(0, -matched) + '[REDACTED_PARTIAL]';
    }
    return redactText(out);
  };
  const value = (item, fragments) => typeof item === 'string' ? text(item, fragments) : Array.isArray(item) ? item.map(item => value(item, fragments)) : plain(item) ? Object.fromEntries(Object.entries(item).map(([name, item]) => [name, value(item, fragments)])) : item;
  const scrub = item => value(redact(item), false); scrub.fragments = item => value(redact(item), true);
  scrub.containsObscured=pieces=>{const normalize=value=>String(value).normalize('NFKD').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase(),candidate=normalize(pieces.join(''));return patterns.some(({secret})=>{const cleaned=normalize(secret);return cleaned.length>=6&&candidate.includes(cleaned);});};return scrub;
}

async function readSource(root, sourceId) {
  if (!sourcePattern.test(sourceId || '')) fail('INVALID_SOURCE', 'sourceId 需要稳定的本地来源标识');
  const meta = privateJson(root, 'private/run.json'), rawConfig = privateJson(root, 'private/config.json');
  const config = normalizeConfig(rawConfig, { baseDir: root });
  if (config.runId !== meta.runId || !meta.identity || Object.entries(identity(config)).some(([key, value]) => meta.identity[key] !== value)) fail('SOURCE_IDENTITY_MISMATCH', '任务配置与身份不一致');
  const base = privateJson(root, 'private/checkpoint.json');
  if (!base.identity || Object.entries(meta.identity).some(([key, value]) => base.identity[key] !== value)) fail('SOURCE_IDENTITY_MISMATCH', '断点与任务身份不一致');
  const journal = checkedFile(root, 'private/checkpoint.journal.jsonl', true);
  const recovery = openCheckpointJournal({ file: journal || path.join(root, 'private/checkpoint.journal.jsonl'), checkpointFile: path.join(root, 'private/checkpoint.json'), checkpoint: base, identity: meta.identity, runId: meta.runId, readOnly: true });
  const checkpoint = recovery.checkpoint;
  if (!Array.isArray(checkpoint.states) || checkpoint.states.length > MAX_STATES) fail('SOURCE_LIMIT', '状态规模超过能力编译上限');
  const states = new Map(), observed = new Map(), starts = new Map(), succeeded = new Map(), transitions = new Map();
  for (const state of checkpoint.states) {
    if (!plain(state) || !Number.isSafeInteger(state.id) || state.id <= 0 || states.has(state.id) || !Array.isArray(state.path) || !Array.isArray(state.interactives)) fail('INVALID_CHECKPOINT', '状态断点格式无效');
    states.set(state.id, state);
  }
  const transition = (from, actionId, to) => { const k = key(from, actionId); if (!transitions.has(k)) transitions.set(k, new Set()); transitions.get(k).add(to); };
  for (const state of states.values()) { const step = state.path.at(-1); if (state.parentId != null && step?.id) transition(state.parentId, step.id, state.id); }
  for (const edge of checkpoint.backEdges || []) if (edge.actionId != null) transition(edge.from, edge.actionId, edge.to);
  const events = checkedFile(root, 'private/events.jsonl', true);
  let eventDigest = createHash('sha256'), invalidEvents = 0;
  if (events) await eachJsonLine(events, row => {
    eventDigest.update(JSON.stringify(row) + '\n');
    if (row.kind === 'state') observed.set(row.evidenceId, row);
    if (row.kind === 'action_started') starts.set(row.evidenceId, row);
    if (row.kind === 'action_finished' && row.status === 'succeeded') {
      const start = starts.get(row.executionId);
      if (start && start.stateId === row.stateId && start.actionId === row.actionId) succeeded.set(key(row.stateId, row.actionId), { started: start.evidenceId, finished: row.evidenceId });
    }
  }, () => invalidEvents++);
  const revision = hash({ sourceId, runId: meta.runId, identity: meta.identity, config: rawConfig, checkpoint, events: eventDigest.digest('hex'), invalidEvents });
  return { root, sourceId, meta, config, checkpoint, states, observed, succeeded, transitions, revision, notices: recovery.notices, invalidEvents, scrub: scrubber(config) };
}

const actionFields = ['id','selector','fallbackSelector','framePath','frameUrl','kind','type','tag','htmlType','role','text','label','aria','title','href','formAction','formMethod','contextText','safeReplay','optionValue','options','scrollStep','checkedValue','hoverHint','filterContext','excluded','skipped'];
function descriptor(action) { return Object.fromEntries(actionFields.filter(key => Object.hasOwn(action, key) && action[key] !== undefined).map(key => [key, clone(action[key])])); }
function actionProblems(source, state, action) {
  const gaps = [];
  if (action.status !== 'succeeded') gaps.push('action_not_successful');
  if (!source.succeeded.has(key(state.id, action.id))) gaps.push('missing_successful_execution_evidence');
  if (source.config.actionProfile !== 'safe' || action.safeReplay !== true || action.formAction || action.type === 'text') gaps.push('action_not_safe_replay');
  if (action.excluded || action.skipped) gaps.push('action_excluded');
  if (action.kind !== 'scroll' && (typeof action.selector !== 'string' || !action.selector || action.selector.length > 4096)) gaps.push('missing_action_locator');
  if (action.type === 'select' && action.optionValue == null) gaps.push('missing_observed_select_value');
  if (!Array.isArray(action.framePath) && action.framePath != null || action.framePath?.some(index => !Number.isSafeInteger(index) || index < 0) || (action.framePath?.length || 0) > 12) gaps.push('invalid_frame_path');
  if (!createPolicy(source.config).action(action).allow) gaps.push('current_action_policy_rejected');
  return gaps;
}
function stateProblems(source, state) {
  const event = source.observed.get(state.evidenceId), gaps = [];
  if (!event || event.stateId !== state.id || event.fp !== state.fp || event.url !== state.url || !validFp(state.fp)) gaps.push('state_not_proven');
  if (!createPolicy(source.config).navigation(state.url).allow) gaps.push('state_outside_policy');
  return gaps;
}
function outcome(source, state, action) {
  const ids = [...(source.transitions.get(key(state.id, action.id)) || [])];
  return ids.length === 1 && source.states.has(ids[0]) ? source.states.get(ids[0]) : null;
}
function pathRecipe(source, target) {
  const root = [...source.states.values()].find(state => state.parentId == null && !state.path.length && state.url === source.config.startUrl);
  const gaps = [...stateProblems(source, target)];
  if (!root) return { gaps: [...gaps, 'entry_state_missing'], steps: [] };
  gaps.push(...stateProblems(source, root));
  if (target.path.length > MAX_STEPS) gaps.push('path_step_limit');
  const steps = [{ kind: 'goto', url: source.config.startUrl, targetStateId: root.id, expectedAfterFp: root.fp }];
  let current = root;
  for (const step of target.path.slice(0, MAX_STEPS)) {
    if (step.safeReplay !== true) gaps.push('path_not_safe_replay');
    if (step.gotoUrl) {
      const next = [...source.states.values()].find(state => state.path.length === 1 && state.path[0].gotoUrl === step.gotoUrl && state.url === step.gotoUrl);
      if (!next || current.id !== root.id || !createPolicy(source.config).navigation(step.gotoUrl).allow) { gaps.push('seed_path_unverified'); break; }
      gaps.push(...stateProblems(source, next));
      steps.push({ kind: 'goto', url: step.gotoUrl, targetStateId: next.id, expectedAfterFp: next.fp }); current = next; continue;
    }
    if (step.fromStateId != null && step.fromStateId !== current.id) { gaps.push('path_disconnected'); break; }
    const action = current.interactives.find(action => action.id === step.id);
    if (!action) { gaps.push('path_action_missing'); break; }
    gaps.push(...actionProblems(source, current, action));
    const next = outcome(source, current, action);
    if (!next) { gaps.push('action_outcome_ambiguous_or_missing'); break; }
    gaps.push(...stateProblems(source, next));
    steps.push({ kind: 'action', fromStateId: current.id, targetStateId: next.id, expectedBeforeFp: current.fp, expectedAfterFp: next.fp, action: descriptor(action) });
    current = next;
  }
  if (current.id !== target.id) gaps.push('path_target_mismatch');
  return { steps, gaps: [...new Set(gaps)] };
}
function compileSource(source) {
  const capabilities = [], recipes = Object.create(null), globalGaps = [];
  if (source.invalidEvents) globalGaps.push('malformed_source_events');
  if (source.notices.length) globalGaps.push('source_checkpoint_recovered');
  const add = (state, action, pathPlan) => {
    const local = action ? ['action', state.id, action.id] : ['state', state.id], id = 'browser_' + hash([source.sourceId, ...local]);
    const gaps = [...new Set([...pathPlan.gaps, ...globalGaps])], ready = gaps.length === 0;
    const recipe = { schemaVersion: 1, sourceId: source.sourceId, sourceRunId: source.meta.runId, sourceRevision: source.revision, capabilityId: id, targetStateId: pathPlan.steps.at(-1)?.targetStateId ?? state.id, expectedFinalFp: pathPlan.steps.at(-1)?.expectedAfterFp ?? state.fp, steps: pathPlan.steps };
    recipe.revision = hash(recipe);
    const actionEvidence = action ? source.succeeded.get(key(state.id, action.id)) : null;
    capabilities.push(source.scrub({ id, name: action ? '操作：' + (action.label || action.kind || '页面控件') : '到达：' + (state.title || '页面状态 ' + state.id), description: action ? '从入口恢复已观察路径后，执行一次已成功且符合安全重放策略的页面操作。' : '从入口重放已观察路径，到达该语义状态；执行时逐步验证指纹。', kind: 'browser', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readiness: ready ? 'ready' : 'candidate', effect: ready && source.config.actionProfile === 'safe' ? 'read' : 'unknown', revision: recipe.revision, gaps,
      evidence: { runId: source.meta.runId, stateId: state.id, stateEvidenceId: state.evidenceId || null, ...(action ? { actionKey: hash(action.id), executionId: actionEvidence?.started || null, finishedEvidenceId: actionEvidence?.finished || null } : {}), observed: ready, sourceStatus: source.meta.status, scope: '已观察浏览器流程，read表示策略分类，不证明任意业务均无副作用' } }));
    if (ready) recipes[id] = recipe;
  };
  for (const state of source.states.values()) {
    const plan = pathRecipe(source, state); add(state, null, plan);
    for (const action of state.interactives) {
      const gaps = [...plan.gaps, ...actionProblems(source, state, action)], next = outcome(source, state, action);
      if (!next) gaps.push('action_outcome_ambiguous_or_missing'); else gaps.push(...stateProblems(source, next));
      const steps = [...plan.steps, { kind: 'action', fromStateId: state.id, targetStateId: next?.id ?? state.id, expectedBeforeFp: state.fp, expectedAfterFp: next?.fp ?? state.fp, action: descriptor(action) }];
      if (steps.length > MAX_STEPS + 1) gaps.push('path_step_limit');
      add(state, action, { steps, gaps });
    }
  }
  return { manifest: source.scrub({ schemaVersion: 1, source: { id: source.sourceId, kind: 'web', revision: source.revision, runId: source.meta.runId, asset: redactUrl(source.config.startUrl), status: source.meta.status, gaps: [...globalGaps, ...(source.meta.status === 'completed' ? [] : ['source_run_' + source.meta.status]), ...(source.checkpoint.coverageGaps || []).map(item => item.reason).filter(reason => typeof reason === 'string').slice(0,100)] }, capabilities }), recipes };
}

/** Compile only authoritative private checkpoint + successful execution evidence. */
export async function compileBrowserRun({ runDir, sourceId } = {}) {
  const root = checkedRoot(runDir), release = acquireLock(path.join(root, '.run.lock'), { task: 'browser_capability_compile' });
  try { return compileSource(await readSource(root, sourceId)); } finally { release(); }
}

// No label relocation, no JS fallback, no retry on a different DOM target. Each
// Playwright operation keeps the same strict locator and repeats live policy.
async function strictAction(page, dialogs, action, config) {
  if (action.kind === 'scroll') return clickElement(page, dialogs, action, config);
  config._runtime.budget.check(); dialogs.invalidate(); await dialogs.handle();
  let locator;
  try { if (await locate(page, action).count() !== 1) fail('LOCATOR_CHANGED', '控件不再唯一'); locator = await checkLiveAction(page, action, config); }
  catch (error) { if (error.name === 'PolicyError') throw error; fail('LOCATOR_CHANGED', '原始控件失效或不再唯一，拒绝按标签猜测重定位'); }
  const timeout = Math.max(1, Math.min(config.actionTimeoutMs, config._runtime.budget.remainingMs));
  try {
    if (action.kind === 'hover') await locator.hover({ timeout });
    else if (action.type === 'checkbox') await locator.setChecked(action.checkedValue ?? true, { timeout });
    else if (action.type === 'radio') await locator.check({ timeout });
    else if (action.type === 'select') await locator.selectOption(action.optionValue, { timeout });
    else if (action.type === 'text') fail('PARAMS_UNBOUND', '表单输入没有经验证的参数绑定');
    else await locator.click({ timeout });
  } catch { config._runtime.budget.check(); fail('ACTION_FAILED', '原始控件操作未完成，已停止；不会寻找其他同名控件或重试点击'); }
  await dialogs.handle(); await dialogs.stabilize();
}

/** Dedicated worker only: createBudget installs process signal handlers. No eval/code params. */
export async function executeBrowserRecipe({ runDir, recipe, params = {}, expectedRevision, outputDir } = {}) {
  if (!plain(recipe) || recipe.schemaVersion !== 1 || !sourcePattern.test(recipe.sourceId || '')) fail('INVALID_RECIPE', '需要编译器生成的内部 recipe');
  if (!plain(params) || Object.keys(params).length) fail('PARAMS_INVALID', '此已观察流程不声明输入参数');
  const root = checkedRoot(runDir), release = acquireLock(path.join(root, '.run.lock'), { task: 'browser_capability_execute' });
  let store, budget, evidence, launched, dialogs, sessionRelease = () => {}, result, scrub = item => redact(item);
  try {
    const source = await readSource(root, recipe.sourceId), compiled = compileSource(source), canonical = compiled.recipes[recipe.capabilityId]; scrub = source.scrub;
    if (!canonical || canonical.revision !== recipe.revision || hash(canonical) !== hash(recipe) || expectedRevision != null && ![canonical.revision, source.revision].includes(expectedRevision)) fail('SOURCE_CHANGED', '来源或能力契约已变化，请重新生成并发现能力');
    const operationId = randomUUID(), out = destination(outputDir || path.join(path.dirname(root), '.browser-operations', operationId));
    if (inside(root, out) || inside(out, root)) fail('OUTPUT_REJECTED', '操作输出必须独立于来源任务目录');
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    if (existsSync(out)) fail('OUTPUT_EXISTS', '操作输出目录已存在');
    const cfg = normalizeConfig({ ...clone(source.config), outputDir: out, runId: operationId, sessionId: operationId, sessionWritebackTo: undefined,
      maxRetries: 0, jsClickFallback: false, limitMode: 'custom', maxStates: 1, maxDepth: 0, maxStatesPerHost: 1,
      maxDurationMs: Math.min(source.config.maxDurationMs ?? 30000, 30000), maxRequests: Math.min(source.config.maxRequests ?? 250, 250), maxActions: Math.min(source.config.maxActions ?? 100, 100) }, { baseDir: root });
    store = openStore(cfg); budget = createBudget(cfg, store); const policy = createPolicy(cfg, store.emit);
    cfg._policy = policy; cfg._runtime = { emit: store.emit, budget, currentActionId: null, currentStateId: null, currentExecutionId: null, currentControl: '', dialogRejected: false, blockedRequests: [] };
    evidence = createEvidence(cfg, store, budget, policy);
    if (cfg.storageState) sessionRelease = acquireLock(cfg.storageState + '.bfs.lock', { runId: operationId });
    store.emit('browser_capability_started', { capabilityId: canonical.capabilityId, sourceRunId: source.meta.runId, sourceRevision: source.revision, revision: canonical.revision });
    launched = await launchGuardedBrowser(cfg, policy, budget, store); evidence.attach(launched.context);
    const page = await launched.context.newPage(); page.setDefaultTimeout(cfg.actionTimeoutMs); dialogs = makeDialogs(page, cfg, () => {});
    const checkAuth = async () => { const auth = await authenticationStatus(page, launched.context, cfg, store); if (!auth.ok) throw new StopError(auth.reason, auth.status); return auth; };
    const savedDiagnostics=new Map([...source.states.values()].map(state=>[state.fp,normalizeFingerprintDiagnostics(state.diagnostics)]));
    const verify = async expected => {
      budget.check(); await dialogs.stabilize(); const state = await fingerprint(page, cfg);
      if (state.fp !== expected) {
        store.emit('browser_state_mismatch',{expectedFp:expected,actualFp:state.fp,expectedDiagnostics:savedDiagnostics.get(expected)||null,actualDiagnostics:normalizeFingerprintDiagnostics(state.diagnostics)});
        fail('STATE_CHANGED', '页面语义状态与已观察流程不一致，停止执行');
      }
      return state;
    };
    let finalState, auth;
    for (const step of canonical.steps) {
      budget.check(); cfg._runtime.currentActionId = null; cfg._runtime.currentExecutionId = null; cfg._runtime.currentStateId = step.fromStateId ?? null; cfg._runtime.currentControl = '';
      cfg._runtime.dialogRejected = false; cfg._runtime.blockedRequests = [];
      if (step.kind === 'goto') { await gotoStep(page, dialogs, step.url, cfg); auth = await checkAuth(); finalState = await verify(step.expectedAfterFp); }
      else {
        await verify(step.expectedBeforeFp); await checkAuth();
        budget.action(); const executionId = store.emit('action_started', { stateId: step.fromStateId, actionId: step.action.id, kind: step.action.kind, label: step.action.label });
        Object.assign(cfg._runtime, { currentActionId: step.action.id, currentExecutionId: executionId, currentControl: step.action.label || '' });
        await strictAction(page, dialogs, step.action, cfg); auth = await checkAuth();
        if (cfg._runtime.dialogRejected) fail('DIALOG_REJECTED', '原生确认框被拒绝，操作未确认完成');
        if (cfg._runtime.blockedRequests.some(row => row.navigation || ['unsafe_endpoint','unsafe_get_endpoint','logout_endpoint','request_origin_out_of_scope','unapproved_write_method','graphql_operation_not_read_query'].includes(row.reason))) fail('REQUEST_BLOCKED', '操作触发请求被当前策略阻断');
        finalState = await verify(step.expectedAfterFp);
        store.emit('action_finished', { stateId: step.fromStateId, actionId: step.action.id, executionId, status: 'succeeded', targetStateId: step.targetStateId });
      }
      cfg._runtime.currentStateId = step.targetStateId;
      store.emit('browser_state_verified', { stateId: step.targetStateId, fp: finalState.fp, url: finalState.url });
    }
    await evidence.drain(); budget.check();
    const output = await visibleOutput(page, cfg, policy, source.scrub);
    // Text is part of the semantic fingerprint. Output from a moving page is
    // rejected rather than being attached to a previously verified state.
    finalState = await verify(canonical.expectedFinalFp); auth = await checkAuth(); budget.check();
    const title = source.scrub.fragments(prefix(finalState.title, 300));
    result = source.scrub({ ok: true, operationId, capabilityId: canonical.capabilityId, revision: canonical.revision, sourceRevision: source.revision, status: 'completed', state: { stateId: canonical.targetStateId, url: finalState.url, fingerprint: finalState.fp, title }, output, observation: { ...budget.counts, apis: evidence.ledger.size, authentication: auth?.reason || 'unknown', note: '请求保留执行上下文，不将其提升为严格因果；仅返回有界可见DOM，不返回原始网络正文或凭证' }, evidence: { eventsPath: path.join(out, 'events.jsonl'), requestsPath: path.join(out, 'requests.json') } });
    result.output = boundOutput(result.output); // The shared outer redaction may expand markers again.
    if (bytes(result) > RESULT_BYTES) result.output = boundOutput(result.output, Math.max(1024, OUTPUT_BYTES - (bytes(result) - RESULT_BYTES)));
    if (bytes(result) > RESULT_BYTES) fail('RESULT_LIMIT', '能力执行摘要超过上限');
  } catch (error) {
    if (!store) throw error;
    const code = error.code || error.reason || budget?.reason || 'EXECUTION_FAILED';
    store.emit('browser_capability_failed', { code, message: redactText(error.message).slice(0,500) });
    result = scrub({ ok: false, status: error instanceof StopError ? error.status : 'failed', error: { code, message: redactText(error.message).slice(0,500) }, evidence: { eventsPath: path.join(store.dir,'events.jsonl'), requestsPath: path.join(store.dir,'requests.json') } });
  } finally {
    try { if (store) {
      let exportError;
      try { dialogs?.dispose(); await evidence?.drain(); await launched?.close(); await evidence?.drain(); await evidence?.export(); }
      catch (error) { exportError = error; await launched?.close().catch(() => {}); }
      try {
        if (exportError) result = { ok: false, status: 'failed', error: { code: 'EVIDENCE_EXPORT_FAILED', message: '操作证据未能完整保存' } };
        store.update({ status: result?.status || 'failed', stopReason: result?.error?.code || 'workflow_completed', counts: budget?.counts || {}, finishedAt: new Date().toISOString() });
        atomicJson(path.join(store.dir,'result.json'), result);
      } finally { budget?.dispose(); sessionRelease(); store.release(); }
    } } finally { release(); }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) fail('RESULT_LIMIT', '能力执行摘要超过上限');
  return result;
}

// Internal reuse for explicitly configured workflows; fixed-flow semantics above
// remain unchanged. These helpers are not registered as public MCP tools.
export { readSource as readBrowserSource, checkedRoot as checkedBrowserRunDir,
  destination as browserOperationDestination, visibleOutput as readBrowserVisibleOutput,
  boundOutput as boundBrowserVisibleOutput };
