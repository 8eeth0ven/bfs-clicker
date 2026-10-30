import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEvidence } from '../src/evidence.js';
import { normalizeConfig } from '../src/asset.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const rows=file=>existsSync(file)?readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const sha=body=>createHash('sha256').update(body).digest('hex');
function harness(t,overrides={}){
  const dir=mkdtempSync(path.join(os.tmpdir(),'bfs-evidence-test-'));const privateDir=path.join(dir,'private');mkdirSync(privateDir);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const config={...normalizeConfig({startUrl:'http://127.0.0.1:3100/',outputDir:dir,limitMode:'unlimited'}),captureBinaryBodies:false,...overrides};
  config._runtime={currentActionId:'a:one',currentControl:'View first'};
  let sequence=0;const events=[];
  const store={dir,privateDir,checkpoint:overrides.checkpoint,meta:{runId:'test-run',authEpoch:3},emit(kind,data={}){
    const evidenceId=`test-run:${++sequence}`;const row={...data,...(data.evidenceId?{relatedEvidenceId:data.evidenceId}:{}),kind,evidenceId,authEpoch:3};
    events.push(row);appendFileSync(path.join(privateDir,'events.jsonl'),JSON.stringify(row)+'\n');return evidenceId;
  }};
  const evidence=createEvidence(config,store,{remainingMs:Infinity},{navigation:()=>({allow:true})});const context=new EventEmitter();evidence.attach(context);
  const emit=({url='http://127.0.0.1:3100/api/read',body='{"ok":1}',type='fetch',contentType='application/json',contentLength=Buffer.byteLength(body),read=async()=>Buffer.from(body),headers={},method='GET',postData=null,status=200,failed=null}={})=>{
    let calls=0;const request={url:()=>url,method:()=>method,resourceType:()=>type,isNavigationRequest:()=>type==='document',postData:()=>postData,
      headers:()=>headers,allHeaders:async()=>headers,frame:()=>({page:()=>({url:()=>config.startUrl})}),failure:()=>failed?{errorText:failed}:null};
    const response={url:()=>url,request:()=>request,status:()=>status,allHeaders:async()=>({'content-type':contentType,...(contentLength==null?{}:{'content-length':String(contentLength)})}),body:()=>{calls++;return read();}};
    context.emit('request',request);if(failed)context.emit('requestfailed',request);else context.emit('response',response);
    return {request,response,get calls(){return calls;}};
  };
  return {dir,privateDir,config,store,evidence,context,events,emit,traffic:()=>rows(evidence.trafficFile)};
}

test('默认二进制仅元数据，HTML/JS/JSON仍读取并提取端点',async t=>{
  const h=harness(t);
  const image=h.emit({url:'http://127.0.0.1:3100/logo.png',type:'image',contentType:'image/png',body:'PNG'});
  const font=h.emit({url:'http://127.0.0.1:3100/font.woff2',type:'font',contentType:'font/woff2',body:'FONT'});
  const svg=h.emit({url:'http://127.0.0.1:3100/logo.svg',type:'image',contentType:'image/svg+xml',body:'<svg/>'});
  const script=h.emit({url:'http://127.0.0.1:3100/app.js',type:'script',contentType:'application/javascript',body:'fetch("/api/from-script");'});
  const json=h.emit({body:'{"next":"/api/from-json"}'});
  await h.evidence.drain();
  assert.equal(image.calls,0);assert.equal(font.calls,0);assert.equal(svg.calls,0);assert.equal(script.calls,1);assert.equal(json.calls,1);
  const traffic=h.traffic();assert.equal(traffic.length,5);
  const imageRow=traffic.find(row=>row.url.endsWith('/logo.png'));
  assert.equal(imageRow.bodyOmitted,true);assert.equal(imageRow.bodyReason,'binary_body_not_captured');assert.equal(imageRow.responseDigest,null);
  assert.ok(h.events.some(row=>row.kind==='request'&&row.source.actionId==='a:one'));
  assert.ok([...h.evidence.endpoints].some(url=>url.endsWith('/api/from-script')));
});

test('显式二进制归档保留base64、headers、digest和每次请求来源',async t=>{
  const h=harness(t,{captureBinaryBodies:true});const body=Buffer.from([0,255,7]);
  h.emit({url:'http://127.0.0.1:3100/raw.bin',type:'fetch',contentType:'application/octet-stream',body,headers:{'x-test':'kept'}});
  h.config._runtime={currentActionId:'a:two',currentControl:'View second'};
  h.emit({url:'http://127.0.0.1:3100/raw.bin',type:'fetch',contentType:'application/octet-stream',body,headers:{'x-test':'kept'}});
  await h.evidence.drain();const traffic=h.traffic();
  assert.equal(traffic.length,2);assert.deepEqual(traffic.map(row=>row.source.actionId),['a:one','a:two']);
  for(const row of traffic){assert.equal(row.body,body.toString('base64'));assert.equal(row.responseDigest,sha(body));assert.equal(row.bodyOmitted,false);assert.equal(row.reqHeaders['x-test'],'kept');}
});

test('相同长度不同正文保留不同digest，重复来源不被去重',async t=>{
  const h=harness(t);h.emit({body:'{"x":1}'});h.config._runtime={currentActionId:'a:two',currentControl:'View second'};h.emit({body:'{"x":2}'});
  await h.evidence.drain();const traffic=h.traffic();
  assert.equal(traffic.length,2);assert.equal(traffic[0].respBytes,traffic[1].respBytes);assert.notEqual(traffic[0].responseDigest,traffic[1].responseDigest);
  assert.deepEqual(traffic.map(row=>row.source.actionId),['a:one','a:two']);
  assert.equal(h.evidence.snapshot().apis[0].samples.filter(sample=>sample.category==='observed_request').length,2);
});

test('关闭traffic后跳过无挖掘用途正文，但继续挖掘JSON与JS',async t=>{
  const h=harness(t,{captureTraffic:false,captureBinaryBodies:true});
  const binary=h.emit({type:'image',contentType:'image/png',body:'abc'});
  const css=h.emit({url:'http://127.0.0.1:3100/main.css',type:'stylesheet',contentType:'text/css',body:'body{}'});
  const json=h.emit({body:'{"next":"/api/retained"}'});await h.evidence.drain();
  assert.equal(binary.calls,0);assert.equal(css.calls,0);assert.equal(json.calls,1);assert.equal(existsSync(h.evidence.trafficFile),false);
  assert.ok(h.events.some(row=>row.kind==='response_body'&&row.bodyReason==='capture_disabled'));
});

test('正文队列满时文本优先于等待中的二进制，不中断已开始的读取',async t=>{
  const h=harness(t,{captureBinaryBodies:true,maxBodyConcurrency:1,maxPendingBodies:1,bodyTimeoutMs:1000});const gate=deferred();const order=[];
  const first=h.emit({url:'http://127.0.0.1:3100/one.png',type:'image',contentType:'image/png',body:'abc',read:()=>{order.push('image-one');return gate.promise;}});
  const second=h.emit({url:'http://127.0.0.1:3100/two.png',type:'image',contentType:'image/png',body:'abc',read:async()=>{order.push('image-two');return Buffer.from('abc');}});
  const api=h.emit({read:async()=>{order.push('api');return Buffer.from('{"ok":1}');}});
  await tick();assert.equal(first.calls,1);assert.equal(second.calls,0);assert.equal(api.calls,0);
  gate.resolve(Buffer.from('abc'));await h.evidence.drain();
  assert.deepEqual(order,['image-one','api']);assert.equal(second.calls,0);assert.equal(api.calls,1);
  assert.equal(h.traffic().find(row=>row.url.endsWith('two.png')).bodyReason,'body_queue_preempted');
});

test('同优先级队列满则明确metadata-only且不丢请求记录',async t=>{
  const h=harness(t,{maxBodyConcurrency:1,maxPendingBodies:1,bodyTimeoutMs:1000});const gate=deferred();
  h.emit({read:()=>gate.promise});h.emit();const dropped=h.emit();await tick();
  gate.resolve(Buffer.from('{"ok":1}'));await h.evidence.drain();
  assert.equal(dropped.calls,0);assert.equal(h.traffic().length,3);
  assert.equal(h.traffic().filter(row=>row.bodyReason==='body_queue_limit').length,1);
  assert.ok(h.events.some(row=>row.kind==='coverage_gap'&&row.reason==='body_queue_limit'));
});

test('超时仍占物理读取槽，drain有界且后续能感知晚到settle',async t=>{
  const h=harness(t,{maxBodyConcurrency:2,maxPendingBodies:32,bodyTimeoutMs:10,drainTimeoutMs:20});const gates=[deferred(),deferred()];
  let active=0,peak=0,calls=0;
  for(let i=0;i<8;i++)h.emit({read:()=>{const index=calls++;active++;peak=Math.max(peak,active);return gates[index].promise.finally(()=>active--);}});
  await pause(25);assert.equal(calls,2);assert.equal(peak,2);assert.equal(h.evidence.bodyStats.activeReads,2);
  const start=Date.now();await h.evidence.drain();assert.ok(Date.now()-start<150);assert.equal(h.evidence.bodyStats.activeReads,2);
  assert.ok(h.events.some(row=>row.kind==='coverage_gap'&&row.reason==='evidence_drain_timeout'&&row.pendingBodyReads===2));
  assert.equal(h.traffic().length,8);assert.equal(h.traffic().filter(row=>row.bodyReason==='body_timeout').length,2);
  gates.forEach(gate=>gate.resolve(Buffer.from('{"ok":1}')));await h.evidence.drain();assert.equal(h.evidence.bodyStats.activeReads,0);assert.equal(calls,2);
  assert.ok(h.traffic().every(row=>row.bodyOmitted));
});

test('drain期限先到时补齐排队metadata，永不settle也不阻止返回',async t=>{
  const h=harness(t,{maxBodyConcurrency:1,maxPendingBodies:2,bodyTimeoutMs:1000,drainTimeoutMs:10});const gate=deferred();
  h.emit({read:()=>gate.promise});h.emit();await tick();const start=Date.now();await h.evidence.drain();await tick();
  assert.ok(Date.now()-start<150);assert.equal(h.evidence.bodyStats.queued,0);assert.equal(h.traffic().length,2);
  assert.ok(h.traffic().every(row=>row.bodyReason==='body_drain_timeout'));
  gate.resolve(Buffer.from('{"ok":1}'));await h.evidence.drain();
});

test('未知Content-Length与超预算正文诚实记录缺口，空body保留digest',async t=>{
  const h=harness(t,{trafficHarvestMaxBytes:10,trafficMaxBodyBytes:5});
  const unknown=h.emit({url:'http://127.0.0.1:3100/api/unknown',contentLength:null});
  const large=h.emit({url:'http://127.0.0.1:3100/api/large',contentLength:11});
  const decoded=h.emit({url:'http://127.0.0.1:3100/api/decoded',contentLength:1,read:async()=>Buffer.from('12345678901')});
  h.emit({url:'http://127.0.0.1:3100/api/empty',body:''});await h.evidence.drain();
  assert.equal(unknown.calls,0);assert.equal(large.calls,0);assert.equal(decoded.calls,1);
  const traffic=h.traffic();assert.equal(traffic.find(row=>row.url.endsWith('/unknown')).bodyReason,'unknown_length_not_buffered');
  assert.equal(traffic.find(row=>row.url.endsWith('/large')).bodyReason,'body_limit');assert.equal(traffic.find(row=>row.url.endsWith('/decoded')).bodyReason,'decoded_body_limit');
  const empty=traffic.find(row=>row.url.endsWith('/empty'));assert.equal(empty.responseDigest,sha(''));assert.equal(empty.body,'');assert.equal(empty.bodyOmitted,false);
});

test('存档上限省略正文仍保留digest，读取失败释放物理槽并记录原因',async t=>{
  const h=harness(t,{trafficMaxBodyBytes:4,maxBodyConcurrency:1});
  h.emit({url:'http://127.0.0.1:3100/api/failure',read:async()=>{throw new Error('body unavailable');}});
  h.emit({url:'http://127.0.0.1:3100/api/omitted',body:'{"ok":1}'});await h.evidence.drain();
  const traffic=h.traffic();assert.equal(traffic.find(row=>row.url.endsWith('/failure')).bodyReason,'body_read_failed');
  const omitted=traffic.find(row=>row.url.endsWith('/omitted'));assert.equal(omitted.bodyOmitted,true);assert.equal(omitted.bodyReason,'storage_body_limit');assert.equal(omitted.responseDigest,sha('{"ok":1}'));
  assert.equal(h.evidence.bodyStats.activeReads,0);assert.ok(h.events.some(row=>row.kind==='body_error'));
});

test('从完整日志恢复旧snapshot之后的晚到正文、来源、类别与候选，重复恢复不双计数',async t=>{
  const h=harness(t,{discoverySeeds:true,maxApiSamples:3});const initial=h.evidence.snapshot();const gate=deferred();
  h.emit({url:'http://127.0.0.1:3100/api/graphql',method:'POST',postData:'{"query":"query Read { viewer { id } }"}',headers:{'content-type':'application/json'},read:()=>gate.promise});
  await tick();const stale=h.evidence.snapshot();assert.equal(stale.apis[0].samples.length,1);
  gate.resolve(Buffer.from('{"ok":1}'));await h.evidence.drain();
  h.config._runtime={currentActionId:'a:two',currentControl:'View second'};h.emit({url:'http://127.0.0.1:3100/api/graphql',method:'POST',postData:'{"query":"query Read { viewer { id } }"}',headers:{'content-type':'application/json'}});
  h.emit({url:'http://127.0.0.1:3100/api/blocked',failed:'net::ERR_BLOCKED_BY_CLIENT'});
  h.emit({url:'http://127.0.0.1:3100/api/failed',failed:'net::ERR_CONNECTION_RESET'});await h.evidence.drain();
  h.evidence.mine('http://127.0.0.1:3100/app.js','fetch("/api/static");const href="/reports";','application/javascript','document:1');
  h.store.emit('endpoint_discovered',{url:'http://127.0.0.1:3100/api/harvest-only',document:'http://127.0.0.1:3100/app.js',sourceId:'document:1'});
  const before=h.evidence.snapshot();h.store.checkpoint={...initial,...stale};
  const restored=createEvidence(h.config,h.store,{remainingMs:Infinity},{navigation:()=>({allow:true})});
  await restored.restore();const after=restored.snapshot();
  const api=after.apis.find(row=>row.url.endsWith('/api/graphql'));
  assert.deepEqual(api.categories,['attempted_request','observed_request']);assert.equal(api.samples.length,3);assert.equal(api.samplesTruncated,1);
  assert.equal(api.samples.find(sample=>sample.category==='observed_request').responseDigest,sha('{"ok":1}'));
  assert.equal(api.samples.find(sample=>sample.category==='observed_request').actionId,'a:one');assert.equal(api.samples[0].authEpoch,3);
  assert.ok(after.apis.find(row=>row.url.endsWith('/api/blocked')).categories.includes('blocked_request'));
  assert.ok(after.apis.find(row=>row.url.endsWith('/api/failed')).categories.includes('failed_request'));
  assert.ok(after.apis.some(row=>row.url.endsWith('/api/static')&&row.categories.includes('static_candidate')));
  assert.ok(after.endpoints.some(url=>url.endsWith('/api/harvest-only')));assert.ok(after.seeds.some(url=>url.endsWith('/reports')));assert.equal(after.requestCounter,before.requestCounter);
  const eventKinds=h.events.slice(h.events.findIndex(row=>row.kind==='evidence_restored')).map(row=>row.kind);assert.ok(eventKinds.every(kind=>kind==='evidence_restored'));
  await restored.restore();assert.deepEqual(restored.snapshot(),after);
});

test('恢复流式跳过损坏行并保留正常记录，缺失终态事件可由traffic补齐',async t=>{
  const h=harness(t);h.emit({body:'{"x":1}'});await h.evidence.drain();const expected=h.evidence.snapshot();
  const eventFile=path.join(h.privateDir,'events.jsonl');const valid=rows(eventFile).filter(row=>!['response','response_body'].includes(row.kind));
  const {writeFileSync}=await import('node:fs');writeFileSync(eventFile,valid.map(row=>JSON.stringify(row)).join('\n')+'\n{broken\n');
  appendFileSync(h.evidence.trafficFile,'{broken\n');
  const restored=createEvidence(h.config,h.store,{remainingMs:Infinity},{navigation:()=>({allow:true})});const stats=await restored.restore();
  assert.equal(stats.malformedEvents,1);assert.equal(stats.malformedTraffic,1);
  const actual=restored.snapshot();assert.deepEqual(actual.apis,expected.apis);
  assert.ok(h.events.some(row=>row.kind==='coverage_gap'&&row.reason==='evidence_recovery_malformed_lines'));
});

test('无traffic时仅凭事件恢复API正文digest与action来源，重复恢复保持样本帽',async t=>{
  const h=harness(t,{captureTraffic:false,maxApiSamples:2});
  h.emit({body:'{"x":1}'});h.config._runtime={currentActionId:'a:two',currentControl:'View second'};h.emit({body:'{"x":2}'});await h.evidence.drain();
  const expected=h.evidence.snapshot();const restored=createEvidence(h.config,h.store,{remainingMs:Infinity},{navigation:()=>({allow:true})});
  await restored.restore();assert.deepEqual(restored.snapshot(),expected);
  await restored.restore();assert.deepEqual(restored.snapshot(),expected);
  assert.equal(restored.snapshot().apis[0].samplesTruncated,2);
});

test('恢复traffic不会把无扩展名图片误记为API',async t=>{
  const h=harness(t);h.emit({url:'http://127.0.0.1:3100/tracking-pixel',type:'image',contentType:'image/png',body:'PNG'});await h.evidence.drain();
  assert.equal(h.evidence.ledger.size,0);const restored=createEvidence(h.config,h.store,{remainingMs:Infinity},{navigation:()=>({allow:true})});
  await restored.restore();assert.equal(restored.ledger.size,0);
});
