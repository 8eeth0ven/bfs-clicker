import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compileBrowserRun, executeBrowserRecipe } from '../src/browser-capabilities.js';
import { normalizeConfig } from '../src/asset.js';
import { openStore, acquireLock } from '../src/store.js';
import { runAsset } from '../src/runner.js';
import { temp, fixture, document, config, json, lines } from './helpers.mjs';

const fp = n => String(n).padStart(32, '0');
function recorded(t, { missingFinish = false, unsafe = false, planned = false, extra = {}, seed = false } = {}) {
  const home = temp(t), dir = path.join(home, 'run');
  const cfg = normalizeConfig(config('http://127.0.0.1:5555', dir, extra)), store = openStore(cfg);
  const action = { id: '[]|#open|click||', selector: '#open', framePath: [], kind: 'click', type: 'click', tag: 'button', htmlType: 'button', label: '展开页面', safeReplay: !unsafe, status: planned ? 'planned' : 'succeeded', attempts: planned ? 0 : 1 };
  const a = { id: 1, parentId: null, path: [], fp: fp(1), url: cfg.startUrl, title: '入口', interactives: [action], children: [2] };
  const b = { id: 2, parentId: 1, path: seed ? [{ gotoUrl: cfg.startUrl + 'seed', safeReplay: true }] : [{ ...action, fromStateId: 1 }], fp: fp(2), url: seed ? cfg.startUrl + 'seed' : cfg.startUrl, title: '展开后', interactives: [], children: [] };
  a.evidenceId = store.emit('state', { stateId: 1, fp: a.fp, url: a.url });
  b.evidenceId = store.emit('state', { stateId: 2, fp: b.fp, url: b.url });
  if (!planned) {
    action.evidenceId = store.emit('action_started', { stateId: 1, actionId: action.id });
    if (!missingFinish) store.emit('action_finished', { stateId: 1, actionId: action.id, executionId: action.evidenceId, status: 'succeeded' });
  }
  store.save({ states: [a, b], backEdges: [], coverageGaps: [] }); store.update({ status: 'completed' }); store.release();
  return { home, dir, cfg, a, b, action };
}

test('compile: ready capabilities come from private descriptors and successful execution evidence', async t => {
  const { dir } = recorded(t), compiled = await compileBrowserRun({ runDir: dir, sourceId: 'local-web' });
  assert.equal(compiled.manifest.schemaVersion, 1); assert.equal(compiled.manifest.source.kind, 'web');
  assert.equal(compiled.manifest.capabilities.filter(cap => cap.readiness === 'ready').length, 3);
  assert.equal(Object.getPrototypeOf(compiled.recipes), null);
  const cap = compiled.manifest.capabilities.find(cap => cap.name === '操作：展开页面'), recipe = compiled.recipes[cap.id];
  assert.equal(recipe.steps[1].action.selector, '#open'); assert.equal(recipe.steps[1].expectedBeforeFp, fp(1));
  assert.equal(recipe.steps[1].expectedAfterFp, fp(2)); assert.equal(recipe.revision, cap.revision);
  const publicText = JSON.stringify(compiled.manifest);
  for (const forbidden of ['#open', 'framePath', 'selector', 'recipes', 'storageState', 'postData']) assert(!publicText.includes(forbidden), forbidden);
  assert.deepEqual(cap.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(JSON.parse(JSON.stringify(compiled.recipes)), { ...compiled.recipes });
});

for (const variant of [{ missingFinish: true }, { unsafe: true }, { planned: true }]) test('compile: unproven/unsafe actions stay candidates ' + JSON.stringify(variant), async t => {
  const { dir } = recorded(t, variant), result = await compileBrowserRun({ runDir: dir, sourceId: 'web' });
  const action = result.manifest.capabilities.find(cap => cap.name.startsWith('操作：'));
  assert.equal(action.readiness, 'candidate'); assert(action.gaps.length); assert.equal(result.recipes[action.id], undefined);
  assert.equal(result.manifest.capabilities.find(cap => cap.name === '到达：展开后').readiness, 'candidate');
});

test('compile: state identity, source lock and journal are authoritative', async t => {
  const { dir, b } = recorded(t), release = acquireLock(path.join(dir, '.run.lock'));
  await assert.rejects(compileBrowserRun({ runDir: dir, sourceId: 'web' }), /正在被/); release();
  const cfg = json(path.join(dir, 'private/config.json')), store = openStore(cfg, true);
  store.journal({ upsertStates: [{ ...b, title: '来自增量' }] }); store.release();
  const compiled = await compileBrowserRun({ runDir: dir, sourceId: 'web' });
  assert(compiled.manifest.capabilities.some(cap => cap.name === '到达：来自增量'));
  cfg.actionAllowlist.push('#different'); writeFileSync(path.join(dir, 'private/config.json'), JSON.stringify(cfg));
  await assert.rejects(compileBrowserRun({ runDir: dir, sourceId: 'web' }), { code: 'SOURCE_IDENTITY_MISMATCH' });
});

test('compile: seed navigation remains a genuine direct entry', async t => {
  const { dir } = recorded(t, { seed: true }), result = await compileBrowserRun({ runDir: dir, sourceId: 'web' });
  const cap = result.manifest.capabilities.find(cap => cap.name === '到达：展开后');
  assert.equal(cap.readiness, 'ready');
  assert.deepEqual(result.recipes[cap.id].steps.map(step => step.kind), ['goto', 'goto']);
});

test('compile: a stored unsafe path cannot be upgraded by a safe action inventory', async t => {
  const { dir } = recorded(t), file = path.join(dir,'private/checkpoint.json'), cp = json(file);
  cp.states[1].path[0].safeReplay = false; writeFileSync(file,JSON.stringify(cp));
  const compiled = await compileBrowserRun({runDir:dir,sourceId:'web'}), state = compiled.manifest.capabilities.find(cap=>cap.name==='到达：展开后');
  assert.equal(state.readiness,'candidate'); assert(state.gaps.includes('path_not_safe_replay')); assert.equal(compiled.recipes[state.id],undefined);
});

test('compile: a legacy text action labelled succeeded is still not proof of a parameter binding', async t => {
  const {dir}=recorded(t,{extra:{actionAllowlist:['#open']}}),file=path.join(dir,'private/checkpoint.json'),cp=json(file);
  cp.states[0].interactives[0].type='text';cp.states[1].path[0].type='text';writeFileSync(file,JSON.stringify(cp));
  const compiled=await compileBrowserRun({runDir:dir,sourceId:'web'}),action=compiled.manifest.capabilities.find(cap=>cap.name.startsWith('操作：'));
  assert.equal(action.readiness,'candidate');assert(action.gaps.includes('action_not_safe_replay'));assert.equal(compiled.recipes[action.id],undefined);
  assert.deepEqual(action.inputSchema,{type:'object',properties:{},additionalProperties:false});
});

test('execute: stale, altered, unknown-input and overlapping-output recipes reject before launching a browser', async t => {
  const { dir, home } = recorded(t), result = await compileBrowserRun({ runDir: dir, sourceId: 'web' });
  const recipe = Object.values(result.recipes)[0], out = path.join(home, 'operation');
  await assert.rejects(executeBrowserRecipe({ runDir: dir, recipe, expectedRevision: 'stale', outputDir: out }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(executeBrowserRecipe({ runDir: dir, recipe: { ...recipe, targetStateId: 999 }, outputDir: out }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(executeBrowserRecipe({ runDir: dir, recipe, params: { url: 'http://example.invalid/' }, outputDir: out }), { code: 'PARAMS_INVALID' });
  await assert.rejects(executeBrowserRecipe({ runDir: dir, recipe, outputDir: path.join(dir, 'operation') }), { code: 'OUTPUT_REJECTED' });
  assert(!existsSync(out)); assert(!existsSync(path.join(dir, '.run.lock')));
});

test('compile: missing/corrupt evidence, malformed selectors, and known credentials never become public recipes', async t => {
  const { dir } = recorded(t, { extra: { authInject: { headers: { Authorization: 'Bearer privateKnownValue', 'X-Signature': 'privateSignatureValue' } } } });
  const cpFile = path.join(dir, 'private/checkpoint.json'), cp = json(cpFile);
  cp.states[0].title = 'privateKnownValue privateSignatureValue'; cp.states[0].interactives[0].selector = '';
  writeFileSync(cpFile, JSON.stringify(cp));
  const compiled = await compileBrowserRun({ runDir: dir, sourceId: 'web' });
  assert(!JSON.stringify(compiled.manifest).includes('privateKnownValue'));
  assert(!JSON.stringify(compiled.manifest).includes('privateSignatureValue'));
  assert.equal(compiled.manifest.capabilities.find(cap => cap.name.startsWith('操作：')).readiness, 'candidate');
  writeFileSync(path.join(dir, 'private/events.jsonl'), '{broken}\n', { flag: 'a' });
  const broken = await compileBrowserRun({ runDir: dir, sourceId: 'web' });
  assert(broken.manifest.source.gaps.includes('malformed_source_events'));
  assert.equal(Object.keys(broken.recipes).length, 0);
});

test('browser: explores a same-URL dynamic site, generates and actually calls a browser capability', { timeout: 60000 }, async t => {
  const dir = temp(t), site = await fixture(t, ({ url }) => url.pathname.startsWith('/api/') ? { type: 'application/json', body: '{"items":[1,2]}' } : {
    body: document('动态站点', '<button id="open" onclick="openMenu()">展开菜单</button><div id="slot"></div>', `window.mode='initial'; function openMenu(){if(document.querySelector('#query'))return;window.mode='opened';setTimeout(()=>{const button=document.createElement('button');button.id='query';button.textContent='查询项目';button.onclick=()=>fetch('/api/items?mode='+window.mode+'&tag=a&tag=b');document.querySelector('#slot').append(button)},120)}`)
  });
  const runDir = path.join(dir, 'source'), run = await runAsset(config(site.origin, runDir, {maxStates:6,maxActions:10,maxDurationMs:15000}), { log() {} });
  assert.equal(run.status, 'completed');
  const originalCheckpoint = readFileSync(path.join(runDir,'private/checkpoint.json'));
  const compiled = await compileBrowserRun({ runDir, sourceId: 'dynamic-web' });
  const cap = compiled.manifest.capabilities.find(cap => cap.name === '操作：查询项目'); assert(cap); assert.equal(cap.readiness, 'ready');
  const recipe = compiled.recipes[cap.id], before = site.requests.length;
  const called = await executeBrowserRecipe({ runDir, recipe, expectedRevision: cap.revision, outputDir: path.join(dir,'call') });
  assert.equal(called.ok, true, JSON.stringify(called)); assert.equal(called.observation.actions, 2);
  const newRequests = site.requests.slice(before), itemRequest = newRequests.find(row => row.url.pathname === '/api/items');
  assert(itemRequest); assert.equal(itemRequest.url.searchParams.get('mode'),'opened'); assert.deepEqual(itemRequest.url.searchParams.getAll('tag'),['a','b']);
  assert.equal(newRequests.filter(row => row.url.pathname === '/api/items').length,1);
  assert.equal(called.state.url, site.origin + '/');
  assert(readFileSync(path.join(runDir,'private/checkpoint.json')).equals(originalCheckpoint));
  const requests = json(called.evidence.requestsPath); assert(requests.some(row => row.source?.executionId && new URL(row.url).pathname === '/api/items'));
  assert.equal(lines(path.join(dir,'call/private/events.jsonl')).filter(row=>row.kind==='action_finished').length,2);
  assert(!existsSync(path.join(runDir,'.run.lock'))); assert(!existsSync(path.join(dir,'call/.run.lock')));
});

test('browser: drift and stale unique selectors fail closed instead of guessing by URL or label', { timeout: 60000 }, async t => {
  const dir = temp(t); let mode = 'initial';
  const site = await fixture(t, ({ url }) => url.pathname === '/api/read' ? { type:'application/json',body:'{}' } : { body: document(mode==='drift'?'页面已改变':'稳定页面', `<button id="${mode==='locator'?'renamed':'query'}" onclick="fetch('/api/read')">查询项目</button>`) });
  const runDir = path.join(dir,'source'); await runAsset(config(site.origin,runDir),{log(){}});
  const compiled = await compileBrowserRun({runDir,sourceId:'drift-web'}), cap = compiled.manifest.capabilities.find(cap=>cap.name==='操作：查询项目'), recipe=compiled.recipes[cap.id];
  let before=site.requests.filter(row=>row.url.pathname==='/api/read').length;
  mode='drift';const drift=await executeBrowserRecipe({runDir,recipe,outputDir:path.join(dir,'drift')});
  assert.equal(drift.ok,false);assert.equal(drift.error.code,'STATE_CHANGED');
  const mismatch=lines(path.join(dir,'drift/private/events.jsonl')).find(row=>row.kind==='browser_state_mismatch');assert(mismatch);
  assert.equal(mismatch.expectedDiagnostics.version,1);assert.equal(mismatch.actualDiagnostics.version,1);
  assert.notEqual(mismatch.expectedDiagnostics.frames[0].headings.sha256,mismatch.actualDiagnostics.frames[0].headings.sha256);
  assert.deepEqual(mismatch.expectedDiagnostics.frames[0].lines,mismatch.actualDiagnostics.frames[0].lines);
  assert(!JSON.stringify([mismatch.expectedDiagnostics,mismatch.actualDiagnostics]).includes('页面已改变'));
  mode='locator';const locator=await executeBrowserRecipe({runDir,recipe,outputDir:path.join(dir,'locator')});
  assert.equal(locator.ok,false);assert.equal(locator.error.code,'LOCATOR_CHANGED');
  assert.equal(site.requests.filter(row=>row.url.pathname==='/api/read').length,before);
});

test('browser: native confirmation and scope guards survive generated execution', { timeout:60000 }, async t=>{
  const dir=temp(t);let hostile=false;
  const external=await fixture(t,()=>({type:'application/json',body:'{}'}));
  const site=await fixture(t,({url})=>url.pathname==='/api/read'?{type:'application/json',body:'{}'}:{body:document('守卫页面','<button id="query" onclick="query()">查询项目</button>',`function query(){${hostile?`fetch('${external.origin}/steal');confirm('是否继续')`:`fetch('/api/read')`}}`)});
  const runDir=path.join(dir,'source');await runAsset(config(site.origin,runDir,{authInject:{headers:{Authorization:'Bearer testKnownSecret'}}}),{log(){}});
  const compiled=await compileBrowserRun({runDir,sourceId:'guard-web'}),cap=compiled.manifest.capabilities.find(cap=>cap.name==='操作：查询项目');
  hostile=true;const result=await executeBrowserRecipe({runDir,recipe:compiled.recipes[cap.id],outputDir:path.join(dir,'guarded')});
  assert.equal(result.ok,false);assert(['DIALOG_REJECTED','REQUEST_BLOCKED'].includes(result.error.code),JSON.stringify(result));
  assert.equal(external.requests.length,0);assert(!JSON.stringify(result).includes('testKnownSecret'));assert(!JSON.stringify(compiled.manifest).includes('testKnownSecret'));
});

test('browser output: visible text, policy-scoped links and tables are useful, redacted and read-only', {timeout:60000},async t=>{
  const dir=temp(t),secret='known-output-credential-value',external=await fixture(t,()=>({body:'outside'}));
  const site=await fixture(t,({url})=>{
    if(url.pathname==='/frame')return {body:document('frame','<p>FRAME-ONLY-MARKER</p><p>known-output-credential-<span>value</span></p>')};
    if(url.pathname!=='/')return {body:document('详情','<p>仅详情内容</p>')};
    return {body:document('只读输出',`<p>公开说明 ${secret} alice@example.com 13800138000</p><p hidden>HIDDEN-MARKER</p><section style="opacity:0"><p>OPACITY-MARKER</p></section><p class="private">EXCLUDED-MARKER</p><input type="password" value="PASSWORD-VALUE"><textarea>TEXTAREA-VALUE</textarea><div contenteditable="true">EDITABLE-VALUE</div><a href="/child">查看详情<span class="private">PRIVATE-LINK-MARKER</span></a><a href="${external.origin}/outside">外部地址</a><a href="/logout">退出登录</a><table><caption>公开清单</caption><thead><tr><th>姓名</th><th>数量</th><th>Token</th></tr></thead><tbody><tr><td>公开用户<span class="private">PRIVATE-CELL-MARKER</span></td><td>2</td><td>UNKNOWN-TABLE-SECRET</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-0</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-1</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-2</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-3</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-4</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-5</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-6</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-7</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-8</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-9</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-10</td></tr><tr><td>更多用户</td><td>2</td><td>SECRET-BEYOND-ROWS-11</td></tr></tbody></table><span id="host" style="display:contents"></span><iframe src="/frame"></iframe>`,`const host=document.querySelector('#host');host.attachShadow({mode:'open'}).innerHTML='<p>SHADOW-READABLE</p><a href="/shadow">查看影子详情</a>'`)};
  });
  const runDir=path.join(dir,'source');await runAsset(config(site.origin,runDir,{excludeSelectors:['.private'],auth:{loggedInSelector:'h1'},authInject:{headers:{'X-Api-Key':secret}}}),{log(){}});
  const compiled=await compileBrowserRun({runDir,sourceId:'output-web'}),cap=compiled.manifest.capabilities.find(cap=>cap.name==='到达：只读输出');assert.equal(cap.readiness,'ready');
  const before=site.requests.length,result=await executeBrowserRecipe({runDir,recipe:compiled.recipes[cap.id],outputDir:path.join(dir,'read')});assert.equal(result.ok,true,JSON.stringify(result));
  const out=result.output,serialized=JSON.stringify(out);assert.equal(out.untrusted,true);assert(out.text.includes('公开说明'));assert(out.text.includes('SHADOW-READABLE'));assert(out.frames.some(frame=>frame.text==='[REDACTED]'));assert(!serialized.includes('credential- value'));assert(!out.gaps.includes('iframe_content_not_included'));
  assert(out.links.some(link=>link.url===site.origin+'/child'&&link.label==='查看详情'));assert(out.links.some(link=>link.url===site.origin+'/shadow'));assert(out.links.every(link=>new URL(link.url).origin===site.origin&&!link.url.includes('logout')));
  assert.deepEqual(out.tables[0].columns,['姓名','数量','Token']);assert.deepEqual(out.tables[0].rows[0],['公开用户','2','[REDACTED]']);assert(out.tables[0].rows.length<=6);assert(out.tables[0].rows.every(row=>row[2]==='[REDACTED]'));assert(out.truncated.rows);assert(!serialized.includes('SECRET-BEYOND-ROWS-'));
  for(const marker of [secret,'alice@example.com','13800138000','HIDDEN-MARKER','OPACITY-MARKER','EXCLUDED-MARKER','PASSWORD-VALUE','TEXTAREA-VALUE','EDITABLE-VALUE','PRIVATE-LINK-MARKER','PRIVATE-CELL-MARKER','UNKNOWN-TABLE-SECRET'])assert(!serialized.includes(marker),marker);
  assert.equal(external.requests.length,0);assert(!site.requests.slice(before).some(row=>['/child','/shadow','/logout'].includes(row.url.pathname)));
  assert(Buffer.byteLength(JSON.stringify(out))<=8192);assert(Buffer.byteLength(JSON.stringify(result))<=16384);
});

test('browser output: UTF8 budgets, table truncation and known secrets crossing a boundary remain safe', {timeout:60000},async t=>{
  const dir=temp(t),secret='BOUNDARY-CREDENTIAL-ABCDEFGHIJKLMN-1234567890-PRIVATE-TAIL';
  const rows=Array.from({length:20},(_,n)=>`<tr><td>${n}</td><td>${'中文🙂'.repeat(30)}</td></tr>`).join('');
  const site=await fixture(t,()=>({body:document('中文🙂预算','<p>'+'A'.repeat(4050)+secret+'中文🙂'.repeat(3000)+`</p><table><tr><th>编号</th><th>内容</th></tr>${rows}</table>`)}));
  const runDir=path.join(dir,'source');await runAsset(config(site.origin,runDir,{authInject:{headers:{'X-Signature':secret}}}),{log(){}});
  const compiled=await compileBrowserRun({runDir,sourceId:'bounded-web'}),cap=compiled.manifest.capabilities.find(cap=>cap.readiness==='ready'),result=await executeBrowserRecipe({runDir,recipe:compiled.recipes[cap.id],outputDir:path.join(dir,'bounded')});
  assert.equal(result.ok,true,JSON.stringify(result));const output=result.output;
  assert(output.truncated.text);assert(output.truncated.rows);assert(output.truncated.cells);assert(output.tables[0].rows.length<=6);
  assert(!JSON.stringify(output).includes('BOUNDARY-CREDENTIAL'));assert(!JSON.stringify(output).includes('\ufffd'));assert(output.tables[0].rows.some(row=>row[1].includes('中文🙂')));
  assert(Buffer.byteLength(JSON.stringify(output))<=8192);assert(Buffer.byteLength(JSON.stringify(result))<=16384);
});

test('browser output: DOM changes during extraction cannot be reported against an old verified state', {timeout:60000},async t=>{
  const dir=temp(t);let mutate=false;
  const site=await fixture(t,()=>({body:document('提取一致性','<p>原始可见正文</p>',mutate?`const original=Element.prototype.checkVisibility;let fired=false;Element.prototype.checkVisibility=function(...args){if(!fired){fired=true;const p=document.createElement('p');p.textContent='AFTER-EXTRACTION-DRIFT';document.body.append(p)}return original.apply(this,args)}`:'')}));
  const runDir=path.join(dir,'source');await runAsset(config(site.origin,runDir),{log(){}});const compiled=await compileBrowserRun({runDir,sourceId:'output-drift'}),cap=compiled.manifest.capabilities.find(cap=>cap.readiness==='ready');
  mutate=true;const result=await executeBrowserRecipe({runDir,recipe:compiled.recipes[cap.id],outputDir:path.join(dir,'drift')});
  assert.equal(result.ok,false);assert.equal(result.error.code,'STATE_CHANGED');assert.equal(result.output,undefined);
});

test('browser output includes scoped visible nested iframes while omitting hidden, excluded and foreign frames',{timeout:30000},async t=>{
 const {chromium}=await import('playwright'),{readBrowserVisibleOutput}=await import('../src/browser-capabilities.js');
 const outside=await fixture(t,()=>({body:'<p>FOREIGN_FRAME_SECRET</p>'}));
 const site=await fixture(t,({url})=>({body:url.pathname==='/clipped'?'<p>FULLY_CLIPPED_FRAME_SECRET</p>':url.pathname==='/inner'?'<p>NESTED_FRAME_TEXT</p>':url.pathname==='/inside'?'<p>VISIBLE_FRAME_TEXT</p><p class="private">FRAME_PRIVATE</p><input value="FRAME_INPUT"><table><tr><th>Name</th><th>Token</th></tr><tr><td>alice</td><td>FRAME_TOKEN</td></tr></table><iframe src="/inner"></iframe>':`<iframe src="/inside"></iframe><iframe hidden src="/inside?hidden=1"></iframe><iframe class="private" src="/inside?excluded=1"></iframe><div style="position:relative;width:30px;height:30px;overflow:hidden"><iframe src="/clipped" style="position:absolute;top:200px"></iframe></div><iframe src="${outside.origin}/"></iframe>`}));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);await page.waitForLoadState('networkidle');
 const policy={navigation:url=>{try{return {allow:new URL(url).origin===site.origin}}catch{return {allow:false}}}},cfg={maxFrames:8,excludeSelectors:['.private'],_runtime:{budget:{check(){}}}},scrub=value=>value;
 const result=await readBrowserVisibleOutput(page,cfg,policy,scrub);assert(result.frames.some(item=>item.text.includes('VISIBLE_FRAME_TEXT')));assert(result.frames.some(item=>item.text.includes('NESTED_FRAME_TEXT')));assert(result.gaps.includes('iframe_out_of_scope'));assert(result.gaps.includes('iframe_hidden_or_excluded'));
 const output=JSON.stringify(result);for(const forbidden of ['FOREIGN_FRAME_SECRET','FRAME_PRIVATE','FRAME_INPUT','FRAME_TOKEN','FULLY_CLIPPED_FRAME_SECRET'])assert(!output.includes(forbidden),forbidden);assert(result.frames.some(item=>item.tables.some(table=>table.rows[0]?.[1]==='[REDACTED]')));assert(Buffer.byteLength(output)<=8192);
});

test('iframe content hidden by full or partial overflow clipping is omitted',{timeout:30000},async t=>{
 const {chromium}=await import('playwright'),{readBrowserVisibleOutput}=await import('../src/browser-capabilities.js');
 const site=await fixture(t,({url})=>({body:url.pathname==='/visible'?'<p>VISIBLE_FRAME</p>':url.pathname==='/partial'?'<p>PARTIAL_SECRET</p>':url.pathname==='/clipped'?'<p>CLIPPED_SECRET</p>':'<iframe src="/visible"></iframe><div style="position:relative;width:40px;height:40px;overflow:hidden"><iframe src="/partial" style="position:absolute;top:10px;width:200px;height:100px"></iframe><iframe src="/clipped" style="position:absolute;top:200px"></iframe></div>'}));const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);await page.waitForLoadState('networkidle');const result=await readBrowserVisibleOutput(page,{maxFrames:8,excludeSelectors:[],_runtime:{budget:{check(){}}}},{navigation:url=>({allow:new URL(url).origin===site.origin})},value=>value);assert(result.frames.some(frame=>frame.text.includes('VISIBLE_FRAME')));assert(!JSON.stringify(result).includes('PARTIAL_SECRET'));assert(!JSON.stringify(result).includes('CLIPPED_SECRET'));assert(result.gaps.includes('iframe_hidden_or_excluded'));
});

test('known secret split between document and iframe never leaves as reconstructable fragments',{timeout:45000},async t=>{
 const dir=temp(t),secret='ABC123XYZ987',site=await fixture(t,({url})=>({body:url.pathname==='/inside'?'<body>123XYZ987</body>':'<title>safe</title><body>ABC<iframe src="/inside"></iframe></body>'}));const runDir=path.join(dir,'source');await runAsset(config(site.origin,runDir,{maxStates:1,maxDepth:0,maxActions:3,authInject:{headers:{'X-Api-Key':secret}}}),{log(){}});const compiled=await compileBrowserRun({runDir,sourceId:'fragment-web'}),cap=compiled.manifest.capabilities.find(cap=>cap.readiness==='ready'),result=await executeBrowserRecipe({runDir,recipe:compiled.recipes[cap.id],outputDir:path.join(dir,'result')});assert.equal(result.ok,true,JSON.stringify(result));assert(result.output.gaps.includes('cross_fragment_sensitive_content_redacted'));assert.equal(result.output.text,'[REDACTED]');assert(result.output.frames.every(frame=>frame.text==='[REDACTED]'));assert(!JSON.stringify(result.output).includes('123XYZ987'));
});

test('main document and iframe text share a 4 KiB UTF-8 budget',{timeout:30000},async t=>{
 const {chromium}=await import('playwright'),{readBrowserVisibleOutput}=await import('../src/browser-capabilities.js');const site=await fixture(t,({url})=>({body:url.pathname==='/inner'?'<p>'+('帧'.repeat(1200))+'</p>':'<p>'+('主'.repeat(1250))+'</p><iframe src="/inner"></iframe>'}));const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);await page.waitForLoadState('networkidle');const output=await readBrowserVisibleOutput(page,{maxFrames:8,excludeSelectors:[],_runtime:{budget:{check(){}}}},{navigation:url=>({allow:new URL(url).origin===site.origin})},value=>value);assert(output.frames.length);assert(Buffer.byteLength(output.text)+output.frames.reduce((sum,frame)=>sum+Buffer.byteLength(frame.text),0)<=4096);assert(output.truncated.text);assert(output.frames[0].truncated.text);assert(!JSON.stringify(output).includes('\ufffd'));
});

test('an opaque overlay covering an iframe prevents its content from being returned',{timeout:30000},async t=>{
 const {chromium}=await import('playwright'),{readBrowserVisibleOutput}=await import('../src/browser-capabilities.js');const site=await fixture(t,({url})=>({body:url.pathname==='/hidden'?'<p>OCCLUDED_FRAME_CONTENT</p>':'<iframe src="/hidden" style="position:absolute;left:40px;top:40px;width:300px;height:150px"></iframe><div style="position:absolute;left:40px;top:40px;width:304px;height:154px;background:black"></div>'}));const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto(site.origin);await page.waitForLoadState('networkidle');const output=await readBrowserVisibleOutput(page,{maxFrames:8,excludeSelectors:[],_runtime:{budget:{check(){}}}},{navigation:url=>({allow:new URL(url).origin===site.origin})},value=>value);assert(!JSON.stringify(output).includes('OCCLUDED_FRAME_CONTENT'));assert(output.gaps.includes('iframe_hidden_or_excluded'));
});
