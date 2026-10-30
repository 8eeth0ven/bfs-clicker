import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runAsset } from '../src/runner.js';
import { temp, fixture, document, config, readRun, json } from './helpers.mjs';

const run=input=>runAsset(input,{log(){}});
const hit=(site,pathname)=>site.requests.filter(request=>request.url.pathname===pathname);
const actions=data=>data.cp.states.flatMap(state=>state.interactives);
const report=dir=>json(path.join(dir,'tree.json'));

test('allowlisted text action without enabled filling records a gap instead of false successful execution', {timeout:30000},async t=>{
  const dir=temp(t),site=await fixture(t,()=>({body:document('只读输入','<input id="query" aria-label="查询">')}));
  await run(config(site.origin,dir,{actionAllowlist:['#query'],fillText:false,formExplore:false,exploreHover:false,exploreScroll:false}));
  const data=readRun(dir),action=actions(data).find(item=>item.selector==='#query');
  assert.ok(action);assert.notEqual(action.status,'succeeded');assert.equal(action.reason,'form_fill_disabled');
  assert(!data.events.some(event=>event.kind==='action_finished'&&event.actionId===action.id&&event.status==='succeeded'));
});
function observed(data,origin,pathname,control){
  const row=data.apis.find(api=>api.url===origin+pathname&&api.categories.includes('observed_request'));
  assert.ok(row,`missing observed API ${pathname}`);
  assert.ok(row.sources.some(source=>source.control===control),`missing source control ${control}`);
  const sample=row.samples.find(sample=>sample.category==='observed_request');
  assert.equal(sample.status,200);assert.ok(sample.responseDigest);assert.ok(sample.actionId);
  return sample;
}

test('same-origin iframe and open shadow controls issue real APIs with frame/shadow action provenance', {timeout:30000},async t=>{
  const dir=temp(t);
  const site=await fixture(t,({url})=>{
    if(url.pathname.startsWith('/api/'))return {type:'application/json',body:'{"ok":true}'};
    if(url.pathname==='/inside')return {body:document('内联页面','<button id="frame-open" onclick="fetch(\'/api/from-frame\')">查看框架内容</button>')};
    return {body:document('复杂交互面','<div id="shadow-host"></div><iframe src="/inside" title="same origin" style="width:600px;height:180px"></iframe>',
      `const shadow=document.querySelector('#shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<button id="shadow-open">查看影子内容</button>';shadow.querySelector('#shadow-open').onclick=()=>fetch('/api/from-shadow');`)};
  });
  const result=await run(config(site.origin,dir,{exploreHover:false,exploreScroll:false}));const data=readRun(dir);
  assert.equal(result.status,'completed');assert.equal(hit(site,'/api/from-shadow').length,1);assert.equal(hit(site,'/api/from-frame').length,1);
  const shadow=actions(data).find(action=>action.selector==='#shadow-host >> #shadow-open');
  const frame=actions(data).find(action=>action.selector==='#frame-open');
  assert.ok(shadow);assert.ok(frame);assert.equal(shadow.status,'succeeded');assert.equal(frame.status,'succeeded');
  assert.deepEqual(shadow.framePath,[]);assert.deepEqual(frame.framePath,[0]);assert.equal(shadow.shadowPath,true);
  assert.equal(observed(data,site.origin,'/api/from-shadow','查看影子内容').actionId,shadow.id);
  assert.equal(observed(data,site.origin,'/api/from-frame','查看框架内容').actionId,frame.id);
  const view=report(dir);assert.equal(view.run.status,'completed');
  assert.ok(view.tree.clickables.some(action=>action.selector===shadow.selector&&action.status==='succeeded'));
  assert.ok(view.tree.clickables.some(action=>action.selector===frame.selector&&action.framePath[0]===0&&action.status==='succeeded'));
});

test('hover-only menu state exposes and traverses a hidden link while retaining the hover replay path', {timeout:30000},async t=>{
  const dir=temp(t);
  const site=await fixture(t,({url})=>{
    if(url.pathname==='/api/hover-detail')return {type:'application/json',body:'{"detail":1}'};
    if(url.pathname==='/hover-detail')return {body:document('悬停详情','<p>详情内容</p>',`fetch('/api/hover-detail')`)};
    return {body:document('悬停入口',`<button id="menu" role="menuitem" aria-haspopup="true" aria-expanded="false">菜单内容</button><div id="menu-body" style="display:none"><a id="hover-link" href="/hover-detail">查看悬停详情</a></div>`,
      `const menu=document.querySelector('#menu'),body=document.querySelector('#menu-body');menu.onmouseenter=()=>{body.style.display='block';menu.setAttribute('aria-expanded','true');};menu.onclick=()=>{body.style.display='none';menu.setAttribute('aria-expanded','false');};`)};
  });
  const result=await run(config(site.origin,dir,{exploreScroll:false}));const data=readRun(dir);
  assert.equal(result.status,'completed');assert.ok(hit(site,'/hover-detail').length>0);assert.ok(hit(site,'/api/hover-detail').length>0);
  const destination=data.cp.states.find(state=>state.url===site.origin+'/hover-detail');assert.ok(destination);
  assert.ok(destination.path.some(step=>step.selector==='#menu'&&step.kind==='hover'));
  const hover=actions(data).find(action=>action.selector==='#menu'&&action.kind==='hover');assert.ok(hover);assert.equal(hover.status,'succeeded');
  assert.ok(data.events.some(event=>event.kind==='action_started'&&event.actionId===hover.id));
  assert.equal(observed(data,site.origin,'/api/hover-detail','查看悬停详情').actionId,destination.path.at(-1).id);
  assert.equal(report(dir).run.status,'completed');assert.match(readFileSync(path.join(dir,'report.md'),'utf8'),/\/hover-detail/);
});

test('bounded scrolling discovers a late visible link and reaches its route and business API', {timeout:30000},async t=>{
  const dir=temp(t);
  const site=await fixture(t,({url})=>{
    if(url.pathname==='/api/scroll-detail')return {type:'application/json',body:'{"detail":2}'};
    if(url.pathname==='/scroll-detail')return {body:document('滚动详情','<p>滚动后到达</p>',`fetch('/api/scroll-detail')`)};
    return {body:document('滚动入口','<div style="height:2200px">长列表</div><a id="scroll-link" href="/scroll-detail" style="display:none;position:fixed;top:100px;left:20px">查看滚动详情</a>',
      `addEventListener('scroll',()=>{if(scrollY>300)document.querySelector('#scroll-link').style.display='block';});`)};
  });
  const result=await run(config(site.origin,dir,{exploreHover:false,maxScrollSteps:2}));const data=readRun(dir);
  assert.equal(result.status,'completed');assert.ok(hit(site,'/scroll-detail').length>0);assert.ok(hit(site,'/api/scroll-detail').length>0);
  const destination=data.cp.states.find(state=>state.url===site.origin+'/scroll-detail');assert.ok(destination);
  assert.ok(destination.path.some(step=>step.kind==='scroll'));assert.ok(destination.path.some(step=>step.selector==='#scroll-link'));
  assert.ok(actions(data).some(action=>action.kind==='scroll'&&action.status==='succeeded'));
  assert.equal(observed(data,site.origin,'/api/scroll-detail','查看滚动详情').actionId,destination.path.at(-1).id);
  assert.equal(report(dir).run.status,'completed');assert.match(readFileSync(path.join(dir,'report.md'),'utf8'),/\/scroll-detail/);
});

test('explicit form submission fills allowed data while an excluded shadow field and unapproved submit stay untouched', {timeout:30000},async t=>{
  const dir=temp(t);
  const site=await fixture(t,async(entry,request)=>{
    if(entry.url.pathname.startsWith('/api/')){
      const chunks=[];for await(const chunk of request)chunks.push(chunk);entry.body=Buffer.concat(chunks).toString('utf8');
      return {type:'application/json',body:'{"accepted":true}'};
    }
    return {body:document('表单入口',`<form id="form" method="post" action="/api/apply"><input id="email" type="email" name="email" aria-label="邮箱"><div id="protected-host"></div><button id="submit" type="submit">提交</button><button id="denied" type="button" onclick="fetch('/api/denied',{method:'POST'})">提交未批准</button></form><div id="result"></div>`,
      `const shadow=document.querySelector('#protected-host').attachShadow({mode:'open'});shadow.innerHTML='<input id="protected" type="text" name="protected" aria-label="Protected field">';document.querySelector('#form').onsubmit=event=>{event.preventDefault();fetch('/api/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.querySelector('#email').value,protected:shadow.querySelector('#protected').value})}).then(response=>response.json()).then(()=>{document.querySelector('#result').innerHTML='<p>表单已处理</p>';});};`)};
  });
  const result=await run(config(site.origin,dir,{actionProfile:'forms',formExplore:true,exploreHover:false,exploreScroll:false,
    actionAllowlist:['#submit'],requestAllowlist:[{method:'POST',url:site.origin+'/api/apply'}],excludeSelectors:['#protected-host'],
    formValues:{'#email':'sunshine-4-26@example.invalid','#protected':'must-stay-empty'},fillTextValue:'fixture-value'}));
  const data=readRun(dir);assert.equal(result.status,'partial');assert.equal(result.stopReason,'unresolved_coverage_errors');
  assert.ok(!actions(data).some(action=>action.status==='failed'));assert.equal(hit(site,'/api/apply').length,1);assert.equal(hit(site,'/api/denied').length,0);
  assert.deepEqual(JSON.parse(hit(site,'/api/apply')[0].body),{email:'sunshine-4-26@example.invalid',protected:''});
  const protectedAction=data.cp.states[0].interactives.find(action=>action.selector==='#protected-host >> #protected');assert.ok(protectedAction);
  assert.equal(protectedAction.status,'skipped');assert.equal(protectedAction.reason,'excluded_selector');
  assert.equal(data.cp.states[0].interactives.find(action=>action.selector==='#denied').status,'skipped');
  assert.equal(data.cp.states[0].interactives.find(action=>action.selector==='#submit').status,'succeeded');
  const api=data.apis.find(api=>api.url===site.origin+'/api/apply'&&api.method==='POST');assert.ok(api);
  assert.ok(api.categories.includes('observed_request'));assert.ok(api.samples.some(sample=>sample.category==='observed_request'&&sample.actionId.includes('#submit')));
  const view=report(dir);assert.equal(view.run.status,result.status);
  assert.ok(view.tree.clickables.some(action=>action.selector===protectedAction.selector&&action.status==='skipped'&&action.reason==='excluded_selector'));
});

test('a freshly resident forms state still refuses unsafe path replay and reports the uncovered child action', {timeout:30000},async t=>{
  const dir=temp(t);
  const site=await fixture(t,({url})=>{
    if(url.pathname.startsWith('/api/'))return {type:'application/json',body:'{"ok":true}'};
    return {body:document('手动状态边界','<button id="open">查看下一步</button><div id="slot"></div>',
      `document.querySelector('#open').onclick=()=>{fetch('/api/opened');const child=document.createElement('button');child.id='child';child.textContent='查看后续';child.onclick=()=>fetch('/api/child');document.querySelector('#slot').replaceChildren(child);};`)};
  });
  const result=await run(config(site.origin,dir,{actionProfile:'forms',requestAllowlist:[{method:'POST',url:site.origin+'/api/explicit-unused'}],exploreHover:false,exploreScroll:false}));
  const data=readRun(dir);assert.equal(result.status,'partial');assert.equal(result.stopReason,'unresolved_coverage_errors');
  assert.equal(hit(site,'/api/opened').length,1);assert.equal(hit(site,'/api/child').length,0);
  const childState=data.cp.states.find(state=>state.path.some(step=>step.selector==='#open'));assert.ok(childState);
  assert.equal(childState.path.at(-1).safeReplay,false);
  const childAction=childState.interactives.find(action=>action.selector==='#child');assert.ok(childAction);
  assert.equal(childAction.status,'skipped');assert.equal(childAction.reason,'unsafe_replay_requires_manual_state');
  assert.ok(data.events.some(event=>event.kind==='coverage_gap'&&event.reason==='unsafe_replay_requires_manual_state'));
  assert.ok(!data.events.some(event=>event.kind==='state_reused'&&event.stateId===childState.id));
  assert.ok(!data.events.some(event=>event.kind==='action_replay'&&event.actionId.includes('#open')));
  observed(data,site.origin,'/api/opened','查看下一步');
  const view=report(dir);assert.equal(view.run.status,'partial');assert.match(readFileSync(path.join(dir,'report.md'),'utf8'),/unsafe_replay_requires_manual_state/);
});
