import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSiteGraph } from '../src/graph.js';

const site='http://127.0.0.1:3100';
const action=(id='same-selector',extra={})=>({id,label:'View details',kind:'click',status:'succeeded',...extra});
const state=(id,extra={})=>({id,url:site+'/console',title:'Console '+id,parentId:null,depth:0,path:[],children:[],expanded:true,interactives:[action()],evidenceId:'state-'+id,...extra});
function fixture(t,events=[],traffic=[]) {
  const dir=mkdtempSync(path.join(tmpdir(),'bfs-graph-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const eventsFile=path.join(dir,'events.jsonl'),trafficFile=path.join(dir,'traffic.jsonl');
  writeFileSync(eventsFile,events.map(row=>JSON.stringify(row)+'\n').join(''));writeFileSync(trafficFile,traffic.map(row=>JSON.stringify(row)+'\n').join(''));
  return {dir,eventsFile,trafficFile};
}
const options=(f,extra={})=>({...f,states:[state(1)],config:{startUrl:site+'/',requestOrigins:[site],navigationOrigins:[site],shotFormat:'none'},
  run:{runId:'graph-test',status:'partial',stopReason:'max_actions',pending:{actions:2},counts:{states:1,requests:1},budgets:{maxStates:50}},...extra});
const find=(graph,type,url)=>graph.nodes.find(node=>node.type===type&&(!url||node.url===url));
const request=(id,url=site+'/api/data',source={},extra={})=>({kind:'request',evidenceId:id,requestId:id,url,method:'GET',type:'fetch',source,...extra});
const response=(id,requestEvidenceId,url=site+'/api/data',extra={})=>({kind:'response',evidenceId:id,requestEvidenceId,url,status:200,method:'GET',type:'fetch',...extra});

test('same URL states stay separate and repeated local action keys have unique stable node IDs',async t=>{
  const f=fixture(t),input=options(f,{states:[state(1),state(2)]});
  const graph=await buildSiteGraph(input),again=await buildSiteGraph(input);
  const states=graph.nodes.filter(node=>node.type==='state'),actions=graph.nodes.filter(node=>node.type==='action');
  assert.equal(states.length,2);assert.equal(actions.length,2);assert.notEqual(states[0].id,states[1].id);assert.notEqual(actions[0].id,actions[1].id);
  assert.equal(actions[0].actionId,actions[1].actionId);assert.deepEqual(graph.nodes.map(node=>node.id),again.nodes.map(node=>node.id));
  assert.doesNotMatch(actions[0].id,/same-selector/);
});

test('observed actions and parent transitions form a flow with graph action references',async t=>{
  const f=fixture(t,[{kind:'action_started',evidenceId:'exec-1',stateId:1,actionId:'open',label:'Open'},
    {kind:'action_finished',evidenceId:'done-1',stateId:1,actionId:'open',executionId:'exec-1',status:'succeeded'}]);
  const graph=await buildSiteGraph(options(f,{states:[state(1,{interactives:[action('open')]}),state(2,{parentId:1,depth:1,path:[{id:'open',label:'Open',kind:'click',fromStateId:1}]})]}));
  const step=graph.flows.find(flow=>flow.stateId===2).steps[0],node=graph.nodes.find(node=>node.id===step.actionId);
  assert.equal(node.type,'action');assert.equal(node.stateId,1);assert.equal(step.targetStateId,2);
  assert.ok(graph.edges.some(edge=>edge.type==='action'&&edge.target===node.id&&edge.confidence==='observed'));
  assert.ok(graph.edges.some(edge=>edge.type==='transition'&&edge.source===node.id&&edge.confidence==='observed'));
  assert.equal(graph.flows.find(flow=>flow.stateId===2).complete,true);
});

test('transition labels alone never pick an unrelated action',async t=>{
  const f=fixture(t),graph=await buildSiteGraph(options(f,{states:[state(1,{interactives:[action('one',{label:'Identical'}),action('two',{label:'Identical'})]}),
    state(2,{parentId:1,path:[{label:'Identical',kind:'click'}]})]}));
  const transition=graph.edges.find(edge=>edge.type==='transition');
  assert.equal(graph.nodes.find(node=>node.id===transition.source).type,'state');assert.equal(transition.confidence,'context');
  assert.equal(graph.flows.find(flow=>flow.stateId===2).complete,false);
});

test('merged event and matching backedge do not double-count one observed loop',async t=>{
  const merge={kind:'state_merged',evidenceId:'merge-1',stateId:1,actionId:'same-selector',executionId:'exec-loop',into:1};
  const f=fixture(t,[merge,merge]),graph=await buildSiteGraph(options(f,{backEdges:[{from:1,to:1,actionId:'same-selector',executionId:'exec-loop',label:'View details'}]}));
  const loops=graph.edges.filter(edge=>edge.type==='transition');assert.equal(loops.length,1);assert.equal(loops[0].count,1);assert.equal(loops[0].loop,true);
  assert.equal(loops[0].confidence,'observed');assert.equal(graph.coverage.graph.duplicateEvents,1);
});

test('legacy backedge without action key uses state context instead of guessing by label',async t=>{
  const f=fixture(t),graph=await buildSiteGraph(options(f,{states:[state(1),state(2)],backEdges:[{from:2,to:1,label:'View details'}]}));
  const back=graph.edges.find(edge=>edge.type==='transition');assert.equal(back.confidence,'context');assert.equal(graph.nodes.find(node=>node.id===back.source).type,'state');
});

test('static unknown-method API candidate is separate from the actually requested GET API',async t=>{
  const f=fixture(t,[{kind:'static_candidate',evidenceId:'candidate-1',url:site+'/api/data',document:site+'/bundle.js'},request('req-1'),response('resp-1','req-1')]);
  const graph=await buildSiteGraph(options(f));const apis=graph.nodes.filter(node=>node.type==='api');
  assert.equal(apis.length,2);const candidate=apis.find(node=>node.method==='unknown'),observed=apis.find(node=>node.method==='GET');
  assert.equal(candidate.observed,false);assert.equal(candidate.status,'candidate');assert.equal(observed.responseObserved,true);
  const edge=graph.edges.find(edge=>edge.type==='candidate');assert.equal(edge.observed,false);assert.equal(edge.confidence,'static');
  assert.equal(graph.coverage.graph.observedApis,1);
});

test('duplicate event and traffic copies enrich one network instance without double-counting',async t=>{
  const req=request('req-1',undefined,{stateId:1,actionId:'same-selector',executionId:'exec-1',page:site+'/console'});
  const resp=response('resp-1','req-1');const traffic={evidenceId:'resp-1',requestEvidenceId:'req-1',url:site+'/api/data',method:'GET',resourceType:'fetch',status:200,source:req.source,authEpoch:4};
  const f=fixture(t,[{kind:'action_started',evidenceId:'exec-1',stateId:1,actionId:'same-selector'},req,resp,resp],[traffic,traffic]);
  const graph=await buildSiteGraph(options(f)),edges=graph.edges.filter(edge=>edge.type==='request');
  assert.equal(edges.length,1);assert.equal(edges[0].count,1);assert.equal(edges[0].authEpoch,4);assert.equal(edges[0].responseObserved,true);
  assert.equal(graph.nodes.find(node=>node.id===edges[0].source).type,'action');assert.match(edges[0].sourceContext.executionId,/^execution:/);
  assert.equal(graph.coverage.graph.capturedRequests,1);assert.equal(graph.coverage.graph.respondedRequests,1);
  assert.equal(graph.coverage.graph.duplicateEvents,1);assert.equal(graph.coverage.graph.duplicateTraffic,1);
});

test('raw background requests never attach to an action or a same-URL state',async t=>{
  const f=fixture(t,[request('req-1',undefined,{page:site+'/console',actionId:'same-selector'}),response('resp-1','req-1')]);
  const graph=await buildSiteGraph(options(f,{states:[state(1),state(2)]})),edge=graph.edges.find(edge=>edge.type==='request');
  const origin=graph.nodes.find(node=>node.id===edge.source);assert.equal(origin.type,'route');assert.equal(origin.background,true);assert.equal(origin.observed,true);
  assert.equal(origin.confidence,'context');assert.equal(edge.confidence,'context');assert.equal(edge.sourceContext.stateId,undefined);
});

test('explicit execution ID resolves exact action context and late response context cannot overwrite it',async t=>{
  const f=fixture(t,[{kind:'action_started',evidenceId:'exec-1',stateId:1,actionId:'same-selector'},
    request('req-1',undefined,{executionId:'exec-1',page:site+'/console'}),
    response('resp-1','req-1',undefined,{source:{stateId:2,actionId:'same-selector',executionId:'late-other'}})]);
  const graph=await buildSiteGraph(options(f,{states:[state(1),state(2)]})),edge=graph.edges.find(edge=>edge.type==='request');
  assert.equal(graph.nodes.find(node=>node.id===edge.source).stateId,1);
});

test('policy scope block and browser blocked failure stay visible without pretending HTTP reached a server',async t=>{
  const outside='https://outside.example/api/data',source={stateId:1,actionId:'same-selector',executionId:'exec-1'};
  const f=fixture(t,[{kind:'policy',evidenceId:'policy-1',url:outside,method:'GET',type:'fetch',allow:false,reason:'request_origin_out_of_scope',...source},
    request('req-1',outside,source),{kind:'request_failed',evidenceId:'failed-1',requestEvidenceId:'req-1',url:outside,method:'GET',type:'fetch',source,error:'net::ERR_BLOCKED_BY_CLIENT'}]);
  const graph=await buildSiteGraph(options(f)),endpoint=find(graph,'api',outside);
  assert.equal(endpoint.inScope,false);assert.equal(endpoint.responseObserved,false);assert.equal(endpoint.observed,false);
  assert.equal(graph.coverage.graph.respondedRequests,0);assert.equal(graph.coverage.graph.blockedRequests,1);assert.equal(graph.coverage.graph.policyBlocks,1);
  const network=graph.edges.find(edge=>edge.outcome==='blocked');assert.equal(network.responseObserved,false);assert.equal(network.confidence,'context');
  assert.ok(graph.edges.some(edge=>edge.outcome==='policy_blocked'&&edge.observed===false));
});

test('failed DNS connection is not counted as a responded API',async t=>{
  const f=fixture(t,[request('req-1'),{kind:'request_failed',evidenceId:'fail-1',requestEvidenceId:'req-1',url:site+'/api/data',method:'GET',type:'fetch',error:'net::ERR_NAME_NOT_RESOLVED'}]);
  const graph=await buildSiteGraph(options(f));assert.equal(graph.coverage.graph.failedRequests,1);assert.equal(graph.coverage.graph.observedApis,0);
  assert.equal(find(graph,'api').status,'failed');
});

test('document, fetch and script requests keep distinct graph resource roles',async t=>{
  const url=site+'/console',f=fixture(t,[request('doc',url,{}, {type:'document'}),response('doc-r','doc',url,{type:'document',contentType:'text/html'}),
    request('fetch',url,{}, {type:'fetch'}),response('fetch-r','fetch',url,{type:'fetch',contentType:'text/html'}),
    request('script',site+'/bundle.js',{}, {type:'script'}),response('script-r','script',site+'/bundle.js',{type:'script',contentType:'text/javascript'})]);
  const graph=await buildSiteGraph(options(f));assert.ok(find(graph,'route',url));assert.ok(find(graph,'api',url));assert.ok(find(graph,'script',site+'/bundle.js'));
  assert.equal(graph.coverage.graph.observedApis,1);
});

test('JS initiator preserves bounded function/async stack locations without inventing an exact request pairing',async t=>{
  const f=fixture(t,[request('req-1'),response('resp-1','req-1'),{kind:'network_initiator',evidenceId:'init-1',networkId:'network-1',url:site+'/api/data',method:'GET',type:'Fetch',
    source:{stateId:1,actionId:'same-selector',executionId:'exec-1'},initiator:{type:'script',stack:{callFrames:[{functionName:'loadData',url:site+'/api-client.js',lineNumber:9,columnNumber:4}],
      parent:{description:'Promise.then',callFrames:[{functionName:'onOpen',url:site+'/ui.js',lineNumber:19,columnNumber:0}]}}}}]);
  const graph=await buildSiteGraph(options(f)),call=graph.edges.find(edge=>edge.type==='initiates'&&graph.nodes.find(node=>node.id===edge.target).type==='api');
  assert.equal(call.confidence,'context');assert.equal(call.observed,false);assert.equal(call.callFrames[0].functionName,'loadData');assert.equal(call.callFrames[0].line,10);assert.equal(call.callFrames[0].column,5);
  assert.equal(call.callFrames[1].stackDepth,1);assert.equal(call.callFrames[1].asyncDescription,'Promise.then');
  assert.equal(find(graph,'script',site+'/api-client.js').functions[0].line,10);
  assert.equal(find(graph,'script',site+'/api-client.js').executionObserved,true);
  assert.ok(graph.edges.some(edge=>edge.type==='initiates'&&edge.label.includes('异步父栈')));
});

test('initiator with explicit request evidence reference may link the captured request exactly',async t=>{
  const f=fixture(t,[request('req-1'),response('resp-1','req-1'),{kind:'network_initiator',evidenceId:'init-1',requestEvidenceId:'req-1',url:site+'/api/data',method:'GET',type:'XHR',
    initiator:{type:'script',stack:{callFrames:[{url:site+'/client.js',functionName:'query',lineNumber:0,columnNumber:0}]}}}]);
  const graph=await buildSiteGraph(options(f)),call=graph.edges.find(edge=>edge.type==='initiates');assert.equal(call.confidence,'observed');assert.equal(call.observed,true);
});

test('missing JS stack is represented as unavailable rather than fabricated script functions',async t=>{
  const f=fixture(t,[{kind:'network_initiator',evidenceId:'init-1',url:site+'/api/data',method:'GET',type:'XHR',documentURL:site+'/console',initiator:{type:'other'}}]);
  const graph=await buildSiteGraph(options(f));assert.equal(graph.nodes.filter(node=>node.type==='script').length,0);
  assert.equal(graph.edges.find(edge=>edge.type==='initiates').callFramesUnavailable,true);assert.equal(graph.coverage.graph.observedApis,0);
});

test('HTML parser initiator URL is not invented as an executed inline JavaScript frame',async t=>{
  const f=fixture(t,[{kind:'network_initiator',evidenceId:'init-1',url:site+'/bundle.js',method:'GET',type:'Script',documentURL:site+'/console',
    initiator:{type:'parser',url:site+'/console',lineNumber:4}}]);
  const graph=await buildSiteGraph(options(f));assert.equal(graph.nodes.some(node=>node.type==='script'&&node.url===site+'/console'),false);
  assert.equal(graph.edges.find(edge=>edge.type==='initiates').callFramesUnavailable,true);
});

test('redirect requires an explicit observed relationship, not just a 3xx status',async t=>{
  const f=fixture(t,[request('req-1',site+'/old',{}, {type:'document'}),response('resp-1','req-1',site+'/old',{status:302,type:'document'}),
    {kind:'network_redirect',evidenceId:'redirect-1',networkId:'n1',fromUrl:site+'/old',toUrl:'https://outside.example/new',status:302,source:{stateId:1}}]);
  const graph=await buildSiteGraph(options(f)),edges=graph.edges.filter(edge=>edge.type==='redirect');assert.equal(edges.length,1);assert.equal(edges[0].observed,true);assert.equal(edges[0].status,302);
  assert.equal(graph.nodes.find(node=>node.id===edges[0].target).inScope,false);
});

test('manual seed path and skipped/failed/planned actions are preserved honestly',async t=>{
  const f=fixture(t),graph=await buildSiteGraph(options(f,{states:[state(1,{interactives:[action('planned',{status:'planned'}),action('skipped',{status:'skipped',reason:'unsafe_action'}),action('failed',{status:'failed'})]}),
    state(2,{parentId:1,url:site+'/seed',path:[{gotoUrl:site+'/seed',label:'seed: '+site+'/seed',safeReplay:true}]})]}));
  const flow=graph.flows.find(flow=>flow.stateId===2);assert.equal(flow.steps[0].kind,'seed');assert.equal(flow.steps[0].actionId,null);assert.equal(flow.complete,true);
  assert.ok(graph.nodes.some(node=>node.seed));assert.ok(graph.edges.some(edge=>edge.seed&&edge.observed));
  assert.deepEqual(graph.nodes.filter(node=>node.type==='action'&&node.stateId===1).map(node=>node.status),['planned','skipped','failed']);
  assert.equal(graph.run.status,'partial');assert.deepEqual(graph.run.pending,{actions:2});assert.equal(graph.coverage.limits.maxStates,50);
});

test('malformed and truncated lines retain valid evidence and add explicit coverage gaps without copying raw log text',async t=>{
  const f=fixture(t,[request('req-1'),response('resp-1','req-1')]);
  writeFileSync(f.eventsFile,'broken password=do-not-copy\n'+JSON.stringify(request('req-1'))+'\n'+JSON.stringify(response('resp-1','req-1'))+'\n{"kind":"request","body":"private-tail');
  const graph=await buildSiteGraph(options(f));assert.equal(graph.coverage.graph.respondedRequests,1);
  assert.ok(graph.coverage.gaps.some(gap=>gap.reason==='graph_log_malformed_line'));assert.ok(graph.coverage.gaps.some(gap=>gap.reason==='graph_log_truncated_line'));
  assert.doesNotMatch(JSON.stringify(graph),/do-not-copy|private-tail/);
});

test('graph data excludes raw headers, bodies, tokens and raw selector-derived identifiers',async t=>{
  const local='[data-token="raw-selector-secret"]',url=site+'/api/data?token=raw-query-secret';
  const f=fixture(t,[request('req-1',url,{stateId:1,actionId:local,executionId:'exec-secret-selector'},
    {headers:{Authorization:'Bearer raw-header-secret'},postData:'{"password":"raw-body-secret"}'}),response('resp-1','req-1',url)],
    [{requestEvidenceId:'req-1',evidenceId:'resp-1',url,method:'GET',resourceType:'fetch',status:200,body:'raw-response-secret',reqHeaders:{Cookie:'raw-cookie-secret'}}]);
  const graph=await buildSiteGraph(options(f,{states:[state(1,{interactives:[action(local,{label:'View token=raw-label-secret'})]})]}));
  assert.doesNotMatch(JSON.stringify(graph),/raw-selector-secret|raw-query-secret|raw-header-secret|raw-body-secret|raw-response-secret|raw-cookie-secret|raw-label-secret|exec-secret-selector/);
});

test('aggregated request counts and execution samples stay accurate after evidence sample cap',async t=>{
  const events=[];
  for(let i=0;i<40;i++)events.push({kind:'action_started',evidenceId:'exec-'+i,stateId:1,actionId:'same-selector'},
    request('req-'+i,undefined,{stateId:1,actionId:'same-selector',executionId:'exec-'+i}),response('resp-'+i,'req-'+i));
  const f=fixture(t,events),graph=await buildSiteGraph(options(f)),edge=graph.edges.find(edge=>edge.type==='request');
  assert.equal(edge.count,40);assert.equal(edge.evidenceIds.length,12);assert.ok(edge.evidenceOmitted>0);assert.equal(edge.executionIds.length,12);assert.equal(edge.executionOmitted,28);
  const action=find(graph,'action');assert.equal(action.executionCount,40);assert.equal(action.executionIds.length,12);assert.equal(action.executionOmitted,28);
  assert.equal(graph.coverage.graph.capturedRequests,40);
});

test('ledger-only historical categories do not fabricate raw observed request edges',async t=>{
  const f=fixture(t),graph=await buildSiteGraph(options(f,{apis:[{method:'GET',url:site+'/api/legacy',categories:['observed_request'],samples:[{status:200}]}]}));
  const endpoint=find(graph,'api',site+'/api/legacy');assert.equal(endpoint.reportedObserved,true);assert.equal(endpoint.observed,false);assert.equal(graph.coverage.graph.observedApis,0);
  assert.equal(graph.edges.filter(edge=>edge.type==='request').length,0);
});

test('flow cycles, missing parents and missing logs are explicit gaps',async t=>{
  const f=fixture(t),graph=await buildSiteGraph(options({...f,trafficFile:path.join(f.dir,'missing.jsonl')},{states:[state(1,{parentId:2}),state(2,{parentId:1}),state(3,{parentId:999})]}));
  assert.ok(graph.coverage.gaps.some(gap=>gap.reason==='graph_flow_parent_cycle'));assert.ok(graph.coverage.gaps.some(gap=>gap.reason==='graph_flow_parent_missing'));
  assert.ok(graph.coverage.gaps.some(gap=>gap.reason==='graph_log_missing'));assert.equal(graph.flows.every(flow=>!flow.complete),true);
});

test('disabled traffic capture still builds responses from events without a missing-log gap',async t=>{
  const f=fixture(t,[request('req-1'),response('resp-1','req-1')]);rmSync(f.trafficFile);
  const graph=await buildSiteGraph(options(f,{config:{captureTraffic:false}}));
  assert.equal(graph.coverage.sources.traffic.status,'disabled');assert.equal(graph.coverage.graph.observedApis,1);
  assert.equal(graph.coverage.gaps.some(gap=>gap.reason==='graph_log_missing'&&gap.file==='traffic'),false);
});

test('non-call static assets are omitted with an explicit count',async t=>{
  const f=fixture(t,[request('req-1',site+'/logo.png',{}, {type:'image'}),response('resp-1','req-1',site+'/logo.png',{type:'image',contentType:'image/png'})]);
  const graph=await buildSiteGraph(options(f));assert.equal(graph.coverage.graph.omittedAssets,1);assert.equal(graph.nodes.some(node=>node.url===site+'/logo.png'),false);
});

test('screenshot references are emitted only for an actual local state capture',async t=>{
  const f=fixture(t);mkdirSync(path.join(f.dir,'states'));writeFileSync(path.join(f.dir,'states','001.jpg'),'synthetic image marker');
  const graph=await buildSiteGraph(options(f,{config:{outputDir:f.dir,shotFormat:'jpeg'}}));assert.equal(find(graph,'state').screenshot,'states/001.jpg');
});

test('many repeated endpoint observations grow counts without duplicate graph nodes or unbounded exported evidence',async t=>{
  const events=[];for(let i=0;i<1000;i++)events.push(request('req-'+i),response('resp-'+i,'req-'+i));
  const f=fixture(t,events),graph=await buildSiteGraph(options(f));
  assert.equal(graph.coverage.graph.respondedRequests,1000);assert.equal(graph.nodes.filter(node=>node.type==='api').length,1);
  const edge=graph.edges.find(edge=>edge.type==='request');assert.equal(edge.count,1000);assert.equal(edge.evidenceIds.length,12);assert.equal(edge.evidenceOmitted,1988);
});
