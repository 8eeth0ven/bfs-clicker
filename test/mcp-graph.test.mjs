import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGraphReader } from '../src/mcp-graph.js';

const state=(id,parentId=null)=>({id:'s'+id,type:'state',stateId:id,parentId,label:'State '+id,url:'https://fixture.example/page/'+id,status:'observed',confidence:'observed',observed:true});
const action=(id,stateId)=>({id:'a'+id,type:'action',stateId,label:'View '+id,status:'succeeded',confidence:'observed',observed:true,attemptObserved:true});
const edge=(id,source,target,type='transition',extra={})=>({id:'e'+id,source,target,type,label:'edge '+id,confidence:'observed',observed:true,...extra});
function graph(){return {schemaVersion:1,run:{runId:'fixture-run',asset:'https://fixture.example/',status:'completed',elapsedMs:1200},
  nodes:[state(1),action(1,1),state(2,1),action(2,2),state(3,2),{id:'api',type:'api',method:'GET',url:'https://fixture.example/api/items',label:'GET /api/items',responseObserved:true,observed:true,status:'observed'},
    {id:'candidate',type:'api',method:'unknown',url:'https://fixture.example/api/unused',label:'Candidate',observed:false,status:'candidate',confidence:'static'}],
  edges:[edge(1,'s1','a1','action'),edge(2,'a1','s2'),edge(3,'s2','a2','action'),edge(4,'a2','s3'),edge(5,'a2','api','request',{confidence:'context',responseObserved:true,status:200}),edge(6,'s1','candidate','candidate',{observed:false,confidence:'static'})],
  flows:[{stateId:1,steps:[],complete:true},{stateId:2,steps:[{stateId:1,actionId:'a1',targetStateId:2,label:'View 1',kind:'click',status:'succeeded'}],complete:true},
    {stateId:3,steps:[{stateId:1,actionId:'a1',targetStateId:2,label:'View 1',kind:'click',status:'succeeded'},{stateId:2,actionId:'a2',targetStateId:3,label:'View 2',kind:'click',status:'succeeded'}],complete:true}],
  coverage:{status:'completed',stopReason:'frontier_exhausted',counts:{states:3,requests:4,actions:2},pending:{actions:0},gaps:[],graph:{respondedRequests:4}}};}
function harness(t,options={}){
  const root=mkdtempSync(path.join(tmpdir(),'bfs-mcp-graph-')),registered=new Map();let resolutions=0;
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const write=(id,value=graph())=>{const dir=path.join(root,id);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'graph.json'),JSON.stringify(value));registered.set(id,dir);return dir;};
  const reader=createGraphReader({getRunDir:async id=>{resolutions++;if(!registered.has(id))throw new Error('/private/secret.json');return registered.get(id);},...options});
  return {root,registered,write,reader,get resolutions(){return resolutions;}};
}
const code=name=>error=>error.code===name;

test('summary returns bounded graph counts and whitelisted coverage rather than arbitrary metadata',async t=>{
  const h=harness(t),value=graph();value.run.password='raw-password';value.run.arbitrary={body:'raw-body'};value.coverage.headers={Cookie:'raw-cookie'};value.coverage.counts.privateData='raw-count';h.write('run',value);
  const result=await h.reader.summary({runId:'run'});assert.equal(result.counts.nodes,7);assert.equal(result.counts.edges,6);assert.equal(result.counts.respondedApis,1);assert.equal(result.coverage.counts.states,3);
  assert.doesNotMatch(JSON.stringify(result),/raw-password|raw-body|raw-cookie|raw-count|arbitrary|headers/);assert.equal(result.truncated,false);
});

test('nodes and edges paginate, filter and keep context and static confidence honest',async t=>{
  const h=harness(t);h.write('run');const first=await h.reader.nodes({runId:'run',limit:2});assert.equal(first.items.length,2);assert.equal(first.total,7);assert.equal(first.nextOffset,2);assert.equal(first.truncated,true);
  const last=await h.reader.nodes({runId:'run',offset:6,limit:2});assert.equal(last.items.length,1);assert.equal(last.nextOffset,null);
  const apis=await h.reader.nodes({runId:'run',type:'api',search:'unused'});assert.equal(apis.items.length,1);assert.equal(apis.items[0].observed,false);
  const context=await h.reader.edges({runId:'run',nodeId:'api',kind:'request'});assert.equal(context.items.length,1);assert.equal(context.items[0].confidence,'context');assert.equal(context.items[0].responseObserved,true);
  const candidates=await h.reader.edges({runId:'run',kind:'candidate'});assert.equal(candidates.items[0].observed,false);
});

test('neighborhood is bounded and preserves real edge endpoints with explicit totals',async t=>{
  const h=harness(t);h.write('run');const near=await h.reader.neighborhood({runId:'run',nodeId:'s1',depth:3,limit:3});
  assert.equal(near.nodes[0].id,'s1');assert.ok(near.totalNodes>3);assert.equal(near.nodes.length,3);assert.equal(near.truncated,true);assert.ok(near.gaps.some(gap=>gap.reason==='neighborhood_result_limit'));
  const shown=new Set(near.nodes.map(row=>row.id));assert.ok(near.edges.every(row=>shown.has(row.source)&&shown.has(row.target)));
});

test('path returns only canonical observed steps and accepts state node ID as well as numeric state ID',async t=>{
  const h=harness(t);h.write('run');const path=await h.reader.path({runId:'run',stateId:3});assert.equal(path.complete,true);assert.equal(path.observed,true);assert.equal(path.steps.length,2);assert.equal(path.steps[1].targetStateId,3);
  assert.ok(path.steps.every(step=>step.observed));assert.deepEqual(await h.reader.path({runId:'run',stateId:'s3'}),path);
  assert.equal((await h.reader.path({runId:'run',stateId:1})).complete,true);
});

test('path never infers causality from script/context edges or URL matches',async t=>{
  const h=harness(t),value=graph();value.edges[1].confidence='context';h.write('run',value);
  const path=await h.reader.path({runId:'run',stateId:3});assert.equal(path.observed,false);assert.equal(path.complete,false);assert.equal(path.steps.length,0);assert.equal(path.unverifiedSteps,2);assert.ok(path.gaps.some(gap=>gap.reason==='path_not_observed'));
});

test('missing, cyclic, incomplete and overall partial paths carry explicit gaps',async t=>{
  const h=harness(t),value=graph();value.run.status='partial';value.coverage.status='partial';value.flows[2].complete=false;h.write('partial',value);
  const partial=await h.reader.path({runId:'partial',stateId:3});assert.equal(partial.complete,false);assert.equal(partial.observed,true);assert.ok(partial.gaps.some(gap=>gap.reason==='run_partial'));assert.ok(partial.gaps.some(gap=>gap.reason==='flow_incomplete'));
  assert.ok((await h.reader.path({runId:'partial',stateId:999})).gaps.some(gap=>gap.reason==='state_not_found'));
  value.flows=value.flows.filter(flow=>flow.stateId!==2);h.write('missing',value);assert.ok((await h.reader.path({runId:'missing',stateId:2})).gaps.some(gap=>gap.reason==='path_not_recorded'));
  const cycle=graph();cycle.flows[2].steps[1].targetStateId=1;h.write('cycle',cycle);const loop=await h.reader.path({runId:'cycle',stateId:3});assert.equal(loop.complete,false);assert.ok(loop.gaps.some(gap=>gap.reason==='path_cycle'));
});

test('manual seed entry requires an explicit observed seed transition',async t=>{
  const h=harness(t),value=graph();value.nodes.push({id:'seed',type:'route',url:'https://fixture.example/seed',seed:true,observed:true});value.edges.push(edge(7,'seed','s2','transition',{seed:true}));
  value.flows[1]={stateId:2,steps:[{stateId:1,actionId:null,targetStateId:2,kind:'seed',label:'Explicit seed'}],complete:true};h.write('run',value);
  const seed=await h.reader.path({runId:'run',stateId:2});assert.equal(seed.complete,true);assert.equal(seed.steps[0].kind,'seed');
  value.edges.pop();h.write('no-proof',value);assert.equal((await h.reader.path({runId:'no-proof',stateId:2})).observed,false);
});

test('malformed graph JSON, duplicate node/edge/state/flow identifiers and oversize schema are rejected',async t=>{
  const h=harness(t);const dir=h.write('broken');writeFileSync(path.join(dir,'graph.json'),'{broken');await assert.rejects(h.reader.summary({runId:'broken'}),code('GRAPH_INVALID'));
  for(const [id,mutate] of [['nodes',g=>g.nodes.push({...g.nodes[0]})],['edges',g=>g.edges.push({...g.edges[0]})],['cross-ids',g=>g.edges[0].id=g.nodes[0].id],['states',g=>g.nodes.push({...g.nodes[0],id:'another-state'})],['flows',g=>g.flows.push({...g.flows[0]})]]){
    const value=graph();mutate(value);h.write(id,value);await assert.rejects(h.reader.summary({runId:id}),code('GRAPH_INVALID'));
  }
  const huge={schemaVersion:1,nodes:Array(100001).fill(null),edges:[]};h.write('huge',huge);await assert.rejects(h.reader.summary({runId:'huge'}),code('GRAPH_INVALID'));
  h.write('huge-edges',{schemaVersion:1,nodes:[],edges:Array(300001).fill(null)});await assert.rejects(h.reader.summary({runId:'huge-edges'}),code('GRAPH_INVALID'));
});

test('dangling edges and malformed rows are dropped only with explicit incomplete validation',async t=>{
  const h=harness(t),value=graph();value.nodes.push(null);value.edges.push(edge(7,'s1','absent'));value.edges.push({id:'bad',type:'not-a-kind'});value.flows.push({stateId:50,steps:[]});h.write('run',value);
  const summary=await h.reader.summary({runId:'run'});assert.equal(summary.validation.invalidNodes,1);assert.equal(summary.validation.danglingEdges,1);assert.equal(summary.validation.invalidEdges,1);assert.equal(summary.validation.invalidFlows,1);assert.equal(summary.validation.incomplete,true);assert.equal(summary.truncated,true);
  const path=await h.reader.path({runId:'run',stateId:3});assert.equal(path.complete,false);
});

test('orphan actions, missing state IDs and malformed flow steps never silently produce complete evidence',async t=>{
  const h=harness(t),value=graph();value.nodes.push({id:'invalid-state',type:'state',label:'No state id'});value.nodes.push(action(99,999));value.flows[2].steps.push({label:'No source or target'});h.write('run',value);
  const summary=await h.reader.summary({runId:'run'});assert.equal(summary.validation.invalidNodes,1);assert.equal(summary.validation.orphanActions,1);assert.equal(summary.validation.invalidFlowSteps,1);assert.equal(summary.validation.incomplete,true);
  const result=await h.reader.path({runId:'run',stateId:3});assert.equal(result.complete,false);assert.ok(result.gaps.some(gap=>gap.reason==='flow_incomplete'));
});

test('file-like identifiers and contradictory run/coverage statuses are explicit validation gaps',async t=>{
  const h=harness(t),value=graph();value.nodes.push({...state(99),id:'/private/session.json'});value.coverage.status='partial';h.write('run',value);
  const summary=await h.reader.summary({runId:'run'});assert.equal(summary.validation.invalidNodes,1);assert.equal(summary.validation.incomplete,true);assert.ok(summary.validation.gaps.some(gap=>gap.reason==='graph_status_mismatch'));
  assert.doesNotMatch(JSON.stringify(await h.reader.nodes({runId:'run'})),/\/private\/session.json/);assert.equal((await h.reader.path({runId:'run',stateId:3})).complete,false);
});

test('overlong recorded flows return only a bounded observed prefix and identify the missing tail',async t=>{
  const h=harness(t),value=graph(),steps=[];value.nodes=[];value.edges=[];
  for(let i=1;i<=260;i++){value.nodes.push(state(i,i===1?null:i-1));if(i<260){value.nodes.push(action(i,i));value.edges.push(edge(i*2,'s'+i,'a'+i,'action'),edge(i*2+1,'a'+i,'s'+(i+1)));steps.push({stateId:i,actionId:'a'+i,targetStateId:i+1,kind:'click'});}}
  value.flows=[{stateId:260,complete:true,steps}];h.write('run',value);const result=await h.reader.path({runId:'run',stateId:260});
  assert.equal(result.totalSteps,259);assert.ok(result.steps.length<=256);assert.equal(result.truncated,true);assert.equal(result.complete,false);assert.equal(result.observed,false);assert.ok(result.gaps.some(gap=>gap.reason==='path_step_limit'));assert.ok(Buffer.byteLength(JSON.stringify(result))<=131072);
});

test('unregistered runs and path-like run IDs never resolve arbitrary files or expose filesystem errors',async t=>{
  const h=harness(t);await assert.rejects(h.reader.summary({runId:'../../private'}),code('INVALID_ARGUMENT'));assert.equal(h.resolutions,0);
  await assert.rejects(h.reader.summary({runId:'unknown'}),error=>error.code==='RUN_NOT_FOUND'&&!error.message.includes('/private'));
});

test('nonregular, symlinked and oversized graph files are rejected without reading private evidence',async t=>{
  const h=harness(t,{maxBytes:4000});const dir=h.write('directory');rmSync(path.join(dir,'graph.json'));mkdirSync(path.join(dir,'graph.json'));await assert.rejects(h.reader.summary({runId:'directory'}),code('GRAPH_INVALID_FILE'));
  const large=h.write('large');writeFileSync(path.join(large,'graph.json'),'x'.repeat(4001));await assert.rejects(h.reader.summary({runId:'large'}),code('GRAPH_TOO_LARGE'));
  if(process.platform!=='win32'){
    const linked=h.write('linked'),privateFile=path.join(h.root,'private.json');writeFileSync(privateFile,JSON.stringify({password:'MUST-NOT-READ'}));rmSync(path.join(linked,'graph.json'));symlinkSync(privateFile,path.join(linked,'graph.json'));
    await assert.rejects(h.reader.summary({runId:'linked'}),code('GRAPH_INVALID_FILE'));
  }
});

test('all query responses redact known secrets and omit raw headers/body/private arbitrary fields',async t=>{
  const h=harness(t),value=graph();value.nodes[0].label='Bearer node-secret password=label-secret';value.nodes[0].url='https://user:password@example.test/p?token=url-secret';value.nodes[0].headers={Cookie:'cookie-secret'};value.nodes[0].body='body-secret';
  value.nodes[1].label='Basic dXNlcjpwcml2YXRl';value.nodes[2].label='Cookie: session=cookie-label-secret';
  value.edges[0].callFrames=[{url:'https://example.test/app.js?api_key=frame-secret',functionName:'Bearer function-secret',body:'frame-body',private:'/private/key'}];
  value.edges[0].sourceContext={page:'https://example.test/?sessionid=context-secret',headers:{Cookie:'source-cookie'}};value.flows[2].steps[0].label='Bearer flow-secret';value.coverage.password='coverage-secret';h.write('run',value);
  const responses=await Promise.all([h.reader.summary({runId:'run'}),h.reader.nodes({runId:'run'}),h.reader.edges({runId:'run'}),h.reader.neighborhood({runId:'run',nodeId:'s1',depth:3}),h.reader.path({runId:'run',stateId:3})]);
  for(const output of responses)assert.doesNotMatch(JSON.stringify(output),/node-secret|label-secret|url-secret|cookie-secret|body-secret|frame-secret|function-secret|frame-body|context-secret|source-cookie|flow-secret|coverage-secret|cookie-label-secret|dXNlcjpwcml2YXRl|\/private\/key/);
});

test('script execution evidence stays distinct from download evidence with bounded async callsites',async t=>{
  const h=harness(t),value=graph();value.nodes.push({id:'script',type:'script',label:'inline script',url:'https://fixture.example/',observed:true,responseObserved:false,executionObserved:true,
    functions:[{url:'https://fixture.example/app.js?token=stack-secret',functionName:'loadItems',line:12,column:4,lineNumber:11,columnNumber:3,stackDepth:1,asyncDescription:'async event handler',headers:{Cookie:'private-cookie'}}]});
  h.write('run',value);const script=(await h.reader.nodes({runId:'run',type:'script'})).items[0];
  assert.equal(script.executionObserved,true);assert.equal(script.responseObserved,false);assert.equal(script.functions[0].functionName,'loadItems');assert.equal(script.functions[0].stackDepth,1);assert.equal(script.functions[0].line,12);
  assert.equal(script.functions[0].asyncDescription,'async event handler');assert.doesNotMatch(JSON.stringify(script),/stack-secret|private-cookie/);
});

test('overlong URL credentials cannot survive truncation and malformed/file URLs are not exposed',async t=>{
  const h=harness(t),value=graph();value.nodes[0].url='https://user:'+'credential-fragment'.repeat(1000)+'@fixture.example/path?token=hidden';value.nodes[1].url='file:///private/session.json';value.nodes[2].url='https://user:bad-secret@bad host/';h.write('run',value);
  const output=await h.reader.nodes({runId:'run'});assert.doesNotMatch(JSON.stringify(output),/credential-fragment|bad-secret|\/private\/session.json/);assert.equal(new URL(output.items[0].url).origin,'https://fixture.example');assert.equal(new URL(output.items[0].url).searchParams.get('token'),'[REDACTED]');
});

test('long strings, call stacks, coverage gaps and results stay explicitly bounded',async t=>{
  const h=harness(t),value=graph();value.nodes=Array.from({length:180},(_,i)=>({...state(i+1),label:'中'.repeat(20000),url:'https://fixture.example/'+'x'.repeat(20000),locations:Array.from({length:30},()=>({url:'https://fixture.example/a.js',functionName:'f'.repeat(10000)}))}));
  value.edges=[];value.flows=[];value.coverage.gaps=Array.from({length:500},()=>({reason:'reason'.repeat(2000),arbitrary:{body:'secret'}}));h.write('run',value);
  const summary=await h.reader.summary({runId:'run'});assert.equal(summary.coverage.gaps.length,20);assert.equal(summary.coverage.totalGaps,500);assert.equal(summary.coverage.gapsTruncated,true);
  const page=await h.reader.nodes({runId:'run',limit:100});assert.ok(Buffer.byteLength(JSON.stringify(page))<=131072);assert.equal(page.truncated,true);assert.ok(page.items.length>0&&page.items.length<100);assert.equal(page.nextOffset,page.items.length);assert.ok(page.items.every(row=>row.label.length<=512&&row.locations.length<=8&&row.url.length<=1024));
});

test('query argument limits apply independently of MCP protocol validation',async t=>{
  const h=harness(t);h.write('run');for(const args of [{limit:101},{limit:0},{offset:-1},{offset:1.5}])await assert.rejects(h.reader.nodes({runId:'run',...args}),code('INVALID_ARGUMENT'));
  await assert.rejects(h.reader.nodes({runId:'run',type:'private'}),code('INVALID_ARGUMENT'));await assert.rejects(h.reader.nodes({runId:'run',search:'x'.repeat(257)}),code('INVALID_ARGUMENT'));
  await assert.rejects(h.reader.edges({runId:'run',kind:'backend-call'}),code('INVALID_ARGUMENT'));await assert.rejects(h.reader.edges({runId:'run',nodeId:'missing'}),code('NODE_NOT_FOUND'));
  for(const args of [{depth:0},{depth:4},{limit:201}])await assert.rejects(h.reader.neighborhood({runId:'run',nodeId:'s1',...args}),code('INVALID_ARGUMENT'));
});

test('cache reuses parsed graph and callers cannot mutate cached results',async t=>{
  const h=harness(t);h.write('run');const first=await h.reader.nodes({runId:'run'});first.items[0].label='modified by caller';const second=await h.reader.nodes({runId:'run'});
  assert.equal(second.items[0].label,'State 1');assert.equal(h.reader.stats.loads,1);assert.equal(h.reader.stats.cacheHits,1);
});

test('cache invalidates on same-size atomic replacement even when mtime is retained',async t=>{
  const h=harness(t),dir=h.write('run');await h.reader.summary({runId:'run'});const file=path.join(dir,'graph.json'),before=statSync(file),value=graph();value.nodes[0].label='State X';
  const temp=file+'.next';writeFileSync(temp,JSON.stringify(value));assert.equal(statSync(temp).size,before.size);utimesSync(temp,before.atime,before.mtime);renameSync(temp,file);
  const rows=await h.reader.nodes({runId:'run'});assert.equal(rows.items[0].label,'State X');assert.equal(h.reader.stats.loads,2);
});

test('concurrent reads coalesce and LRU evicts the least recently used registered graph',async t=>{
  const h=harness(t,{maxEntries:2});h.write('a');h.write('b');h.write('c');await Promise.all(Array.from({length:12},()=>h.reader.summary({runId:'a'})));assert.equal(h.reader.stats.loads,1);
  await h.reader.summary({runId:'b'});await h.reader.summary({runId:'a'});await h.reader.summary({runId:'c'});assert.equal(h.reader.stats.cachedEntries,2);assert.equal(h.reader.stats.evictions,1);
  await h.reader.summary({runId:'b'});assert.equal(h.reader.stats.loads,4);assert.equal(h.reader.stats.evictions,2);
});

test('real-sized repeated graph queries build one index and publish measurable bounded results',async t=>{
  const h=harness(t),size=12000,value=graph();value.nodes=Array.from({length:size},(_,i)=>state(i+1));value.edges=Array.from({length:size-1},(_,i)=>edge(i+1,'s'+(i+1),'s'+(i+2)));value.flows=[];
  const dir=h.write('large',value),at=performance.now();const summary=await h.reader.summary({runId:'large'}),coldMs=performance.now()-at;const warm=[];
  for(let i=0;i<30;i++){const start=performance.now();const page=await h.reader.nodes({runId:'large',offset:i*100,limit:100});warm.push(performance.now()-start);assert.equal(page.items.length,100);assert.ok(Buffer.byteLength(JSON.stringify(page))<=131072);}
  const near=await h.reader.neighborhood({runId:'large',nodeId:'s6000',depth:3,limit:100});assert.equal(near.totalNodes,7);assert.equal(h.reader.stats.loads,1);assert.ok(h.reader.stats.cacheHits>=31);assert.equal(summary.counts.nodes,size);
  const output=path.resolve('output-performance-review');mkdirSync(output,{recursive:true});writeFileSync(path.join(output,'mcp-graph-performance.json'),JSON.stringify({date:new Date().toISOString(),node:process.version,nodes:size,edges:size-1,fileBytes:statSync(path.join(dir,'graph.json')).size,coldMs,warmPageMs:warm,warmMedianMs:[...warm].sort((a,b)=>a-b)[Math.floor(warm.length/2)],stats:h.reader.stats,responseByteLimit:131072},null,2));
});
