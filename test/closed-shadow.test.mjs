import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';
import {normalizeConfig} from '../src/asset.js';import {identity} from '../src/store.js';
import {collectInteractives,locate,actionKey} from '../src/discover.js';import {createPolicy} from '../src/policy.js';import {fingerprint} from '../src/state.js';
import {normalizeClosedShadowRoots,closedTarget,resetClosedShadow} from '../src/closed-shadow.js';
import {gotoWithRetry} from '../src/replay.js';
import {closedSite,closedWebConfig,target,roots} from './closed-shadow-fixture.mjs';
async function context(t,site,patch={}){const browser=await chromium.launch({headless:true}),page=await browser.newPage();t.after(()=>browser.close());await page.goto(site.origin);const config=normalizeConfig({...closedWebConfig(site),startUrl:site.origin,...patch});config._policy=createPolicy(config);return{browser,page,config};}

test('closed opt-in is typed, finite, source-bound and never granted by metadata alone',()=>{
 const empty=normalizeConfig({startUrl:'http://127.0.0.1:1'});assert.deepEqual(empty.closedShadowRoots,[]);assert.deepEqual(identity(empty),identity({...empty,closedShadowRoots:undefined}));
 const enabled=normalizeConfig({startUrl:'http://127.0.0.1:1',closedShadowRoots:roots});assert.notEqual(identity(enabled).policyFingerprint,identity(empty).policyFingerprint);
 for(const input of [[{id:123,hosts:['#a']}],[{id:'a',hosts:[]}],[{id:'a',hosts:['#a'],framePath:[0]}],[{id:'a',hosts:['#a'],maxNodes:257}],Array.from({length:5},(_,i)=>({id:String(i),hosts:['#'+i]}))])assert.throws(()=>normalizeClosedShadowRoots(input));
 for(const value of [{...target('alpha','#query'),framePath:[0]},{...target('alpha','#query'),framePath:''},{selector:target('alpha','#query').selector,framePath:[]},{...target('alpha','#query'),closedShadow:{...target('alpha','#query').closedShadow,hosts:['#other']}}])assert.throws(()=>closedTarget(value,enabled));
 assert.throws(()=>closedTarget(target('alpha','#query'),empty));assert.notEqual(actionKey(target('alpha','#query')),actionKey(target('beta','#query')));assert.notEqual(actionKey(target('alpha','#query')),actionKey({selector:'#query',framePath:[]}));
});

test('real closed roots stay closed; body and two hosts with identical ids never alias',{timeout:30000},async t=>{
 const site=await closedSite(t),{page,config}=await context(t,site);
 assert.equal(await page.locator('#query').count(),1,'only BODY input is visible to ordinary locator');
 const before=page.context().newCDPSession.bind(page.context());let sessions=0;page.context().newCDPSession=async(...args)=>{sessions++;return before(...args)};
 const disabled={...config,closedShadowRoots:[]},ordinary=await collectInteractives(page,disabled);assert.equal(sessions,0);assert(!ordinary.some(row=>row.closedShadow));assert(!JSON.stringify(ordinary).includes('B-DECOY'));
 assert.throws(()=>locate(page,target('alpha','#query'),disabled),{code:'CLOSED_SHADOW_NOT_APPROVED'});assert.equal(sessions,0);
 const rows=await collectInteractives(page,config);assert.equal(rows.filter(row=>row.closedShadow&&row.closedShadow.selector==='#query').length,2);assert(!JSON.stringify(rows).includes('B-DECOY'));assert(!JSON.stringify(rows).includes('UNAPPROVED-NESTED'));
 await locate(page,target('alpha','#query'),config).fill('alpha');assert.equal(await locate(page,target('alpha','#query'),config).inputValue(),'alpha');assert.equal(await locate(page,target('beta','#query'),config).inputValue(),'B-DECOY');assert.equal(await page.locator('#query').inputValue(),'BODY-DECOY');
 await locate(page,target('alpha','#search'),config).click();await page.waitForTimeout(80);assert.deepEqual(site.queries.map(row=>[row.host,row.q]),[['alpha','alpha']]);
 assert.deepEqual(await page.locator('#widgetA,#widgetB').evaluateAll(rows=>rows.map(row=>row.shadowRoot)),[null,null]);
});

test('closed digest observes result changes without persisting input values or root text',{timeout:30000},async t=>{
 const site=await closedSite(t),{page,config}=await context(t,site),before=await fingerprint(page,config);await locate(page,target('alpha','#query'),config).fill('alpha');await locate(page,target('alpha','#search'),config).click();await page.waitForTimeout(80);const after=await fingerprint(page,config);assert.notEqual(before.fp,after.fp);const closed=after.surface.at(-1);assert.equal(closed.title,'closed_root_digests');assert(!JSON.stringify(closed).includes('RESULT'));assert(!JSON.stringify(closed).includes('B-DECOY'));assert(closed.lines.every(row=>/^[a-z]+:[a-f0-9]{64}$/.test(row)));
});

test('root and element reconstruction, unknown nested scopes, hidden inner and real occlusion refuse action',{timeout:60000},async t=>{
 for(const mode of ['rebuild-focus','target-focus','inner-hidden','overlay','focus-type','focus-name','focus-host','key-type','focus-input-excluded','focus-ancestor-excluded']){
  const site=await closedSite(t);site.setMode(mode);const {browser,page,config}=await context(t,site,{excludeSelectors:['.blocked']});await assert.rejects(locate(page,target('alpha','#query'),config).fill('alpha'),e=>e.code?.startsWith('CLOSED_SHADOW_'));assert.equal(site.queries.length,0,mode);assert.equal((await page.evaluate(()=>window.fixtureEvents)).filter(e=>e.type==='input').length,0,mode);await browser.close();
 }
 const site=await closedSite(t),{page,config}=await context(t,site);assert.throws(()=>locate(page,{...target('alpha','#query'),closedShadow:{...target('alpha','#query').closedShadow,hosts:['#widgetA','#nested']}},config),{code:'CLOSED_SHADOW_NOT_APPROVED'});
 const old=locate(page,target('alpha','#query'),config);assert.equal(await old.count(),1);await page.evaluate(()=>document.querySelector('#widgetA').remove());await assert.rejects(old.fill('alpha'),e=>e.code?.startsWith('CLOSED_SHADOW_'));assert.equal(site.queries.length,0);
 await resetClosedShadow(page);
});

test('a separately approved nested author-closed chain never grants its sibling or outer input identity',{timeout:30000},async t=>{
 const site=await closedSite(t),nested={id:'nested',hosts:['#widgetA','#nested'],maxNodes:8},{page,config}=await context(t,site,{closedShadowRoots:[...roots,nested]}),inner={selector:'closed::nested::#query',framePath:[],closedShadow:{schemaVersion:1,policyId:'nested',hosts:nested.hosts,selector:'#query'}};
 await locate(page,inner,config).fill('nested');assert.equal(await locate(page,inner,config).inputValue(),'nested');assert.equal(await locate(page,target('alpha','#query'),config).inputValue(),'');assert.equal(await locate(page,target('beta','#query'),config).inputValue(),'B-DECOY');assert.equal(await page.locator('#query').inputValue(),'BODY-DECOY');
});

test('page prototype tampering cannot redirect the isolated closed reader or physical input into BODY',{timeout:30000},async t=>{
 const site=await closedSite(t);site.setMode('hostile-prototype');const {page,config}=await context(t,site);const rows=await collectInteractives(page,config);assert.equal(rows.filter(r=>r.closedShadow).length,4);assert(!JSON.stringify(rows).includes('UNAPPROVED-NESTED-TEXT'));
 await locate(page,target('alpha','#query'),config).fill('alpha');assert.equal(await locate(page,target('alpha','#query'),config).inputValue(),'alpha');assert.equal(await page.locator('#query').inputValue(),'BODY-DECOY');
 assert(!JSON.stringify((await fingerprint(page,config)).surface.at(-1)).includes('UNAPPROVED-NESTED-TEXT'));assert(!(await locate(page,target('alpha','#nested'),config).innerText()).includes('UNAPPROVED-NESTED-TEXT'));
});

test('mock failed CDP detach blocks navigation and cannot create a second authorized backend',{timeout:30000},async t=>{
 const site=await closedSite(t),{page,config}=await context(t,site);let sessions=0;const original=page.context().newCDPSession.bind(page.context());page.context().newCDPSession=async owner=>{sessions++;const session=await original(owner);session.detach=async()=>{throw new Error('synthetic detach failure')};return session};assert.equal(await locate(page,target('alpha','#query'),config).count(),1);let navigations=0;page.goto=async()=>{navigations++};await assert.rejects(gotoWithRetry(page,site.origin,config),{code:'CLOSED_SHADOW_CLEANUP_FAILED'});assert.equal(navigations,0);await assert.rejects(locate(page,target('alpha','#query'),config).count(),{code:'CLOSED_SHADOW_LIMIT'});assert.equal(sessions,1);
});

test('mock late readonly response and hung physical send obey caller deadline without later keyboard dispatch',{timeout:30000},async t=>{
 for(const kind of ['late-read','hung-input']){const site=await closedSite(t),{page,config,browser}=await context(t,site);let keyCalls=0,mouseCalls=0,delayed=false;const original=page.context().newCDPSession.bind(page.context());page.context().newCDPSession=async owner=>{const session=await original(owner),send=session.send.bind(session);session.send=async(method,params)=>{const result=await send(method,params);if(kind==='late-read'&&method==='DOM.getDocument'){delayed=true;await new Promise(resolve=>setTimeout(resolve,400))}return result};return session};page.keyboard.press=async()=>{keyCalls++};page.keyboard.insertText=async()=>{keyCalls++};if(kind==='hung-input'){await locate(page,target('alpha','#query'),config).count();page.mouse.click=async()=>{mouseCalls++;await new Promise(()=>{})};}
  const timeout=kind==='hung-input'?2000:150,start=Date.now();await assert.rejects(locate(page,target('alpha','#query'),config).fill('alpha',{timeout}),{code:'CLOSED_SHADOW_TIMEOUT'});assert(Date.now()-start<timeout+800);await new Promise(resolve=>setTimeout(resolve,500));assert.equal(keyCalls,0);assert.equal(site.queries.length,0);if(kind==='hung-input')assert.equal(mouseCalls,1);else assert(delayed);await browser.close();
 }
});

test('mock stalled first CDP attachment respects a short read timeout',{timeout:10000},async t=>{
 const site=await closedSite(t),{page,config}=await context(t,site);page.context().newCDPSession=()=>new Promise(()=>{});const started=Date.now();await assert.rejects(locate(page,target('alpha','#result'),config).innerText({timeout:100}),{code:'CLOSED_SHADOW_TIMEOUT'});assert(Date.now()-started<800);assert.equal(site.queries.length,0);
});

test('actual cross-origin iframe closed contents are never treated as top-level roots',{timeout:30000},async t=>{
 const site=await closedSite(t),foreign=await closedSite(t),{page,config}=await context(t,site,{navigationOrigins:[site.origin,foreign.origin],requestOrigins:[site.origin,foreign.origin]});
 await page.evaluate(url=>new Promise(resolve=>{const frame=document.createElement('iframe');frame.src=url;frame.onload=resolve;document.body.append(frame)}),foreign.origin);
 let calls=0;const original=page.context().newCDPSession.bind(page.context());page.context().newCDPSession=async owner=>{assert.equal(owner,page,'closed backend must never attach to the foreign frame');calls++;return original(owner)};
 const rows=await collectInteractives(page,config);assert.equal(rows.filter(row=>row.closedShadow).length,4);assert(rows.filter(row=>row.closedShadow).every(row=>row.framePath.length===0));assert.equal(calls,1);
 assert.throws(()=>locate(page,{...target('alpha','#query'),framePath:[0]},config),{code:'CLOSED_SHADOW_TARGET_INVALID'});assert.equal(foreign.queries.length,0);
 await page.goto(foreign.origin);const restricted={...config,navigationOrigins:[site.origin]};restricted._policy=createPolicy(restricted);
 await assert.rejects(locate(page,target('alpha','#query'),restricted).count(),{code:'CLOSED_SHADOW_SCOPE_NOT_APPROVED'});assert.equal(foreign.queries.length,0);
});
