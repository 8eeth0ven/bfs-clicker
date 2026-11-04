import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { redact, redactText, redactUrl } from './redact.js';

const EVIDENCE_LIMIT=12,STACK_LIMIT=24,FLOW_LIMIT=256,LINE_LIMIT=2*1024*1024;
const clean=(value,max=220)=>redactText(value??'').replace(/[\r\n\t]+/g,' ').slice(0,max);
const opaque=(type,value)=>type+':'+createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const urlOf=value=>{try{const u=new URL(String(value));if(!['http:','https:'].includes(u.protocol))return '';u.hash='';return u.href}catch{return ''}};
const shownUrl=value=>value?redactUrl(value):'';
const methodOf=value=>/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)$/i.test(String(value||''))?String(value).toUpperCase():'unknown';
const keyOf=value=>value===undefined||value===null?'':String(value);
const stateKey=value=>opaque('state',keyOf(value));
const actionKey=(stateId,actionId)=>opaque('action',[keyOf(stateId),keyOf(actionId)]);
const actionLocal=value=>opaque('action-key',keyOf(value));
const labelUrl=value=>{try{const u=new URL(shownUrl(value));return clean(u.host+u.pathname+u.search,180)}catch{return clean(value)}};

// Stream each input once. Invalid lines are counted, never copied into a public
// graph or silently treated as proof that an API was reached.
async function readLog(file,kind,onRow,gap) {
  const result={status:file?'missing':'not_provided',lines:0,records:0,malformed:0,truncated:0,oversized:0};
  if(!file||!existsSync(file)){if(file)gap('graph_log_missing',{file:kind});return result;}
  result.status='read';let pending='',dropping=false;
  const parse=(line,final=false)=>{
    result.lines++;if(!line.trim())return;
    let row;
    try{row=JSON.parse(line);if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('not an object');}
    catch{result[final?'truncated':'malformed']++;gap(final?'graph_log_truncated_line':'graph_log_malformed_line',{file:kind,line:result.lines});return;}
    onRow(row);result.records++;
  };
  try {
    for await(const chunk of createReadStream(file,{encoding:'utf8',highWaterMark:65536})) {
      pending+=chunk;let offset=0,newline;
      while((newline=pending.indexOf('\n',offset))>=0) {
        const line=pending.slice(offset,newline);
        if(dropping||Buffer.byteLength(line)>LINE_LIMIT){result.lines++;result.oversized++;gap('graph_log_line_limit',{file:kind,line:result.lines});dropping=false;}
        else parse(line);
        offset=newline+1;
      }
      pending=pending.slice(offset);
      if(Buffer.byteLength(pending)>LINE_LIMIT){pending='';dropping=true;}
    }
    if(dropping){result.lines++;result.oversized++;gap('graph_log_line_limit',{file:kind,line:result.lines});}
    else if(pending)parse(pending,true);
  } catch{result.status='read_failed';gap('graph_log_read_failed',{file:kind});}
  return result;
}

/** Observed state graph and evidence-backed request/initiator relationships.
 * No HTTP requests, code execution, file writes or URL-only state merging.
 */
export async function buildSiteGraph({states=[],backEdges=[],run={},config={},eventsFile,trafficFile,apis=[]}={}) {
  const stateRows=states instanceof Map?[...states.values()]:Array.isArray(states)?states:Object.values(states||{});
  const stateIndex=new Map(),actionIndex=new Map(),nodeIndex=new Map(),edgeIndex=new Map();
  const nodeEvidence=new Map(),edgeEvidence=new Map(),edgeContributions=new Map(),edgeExecutions=new Map(),actionExecutions=new Map();
  const executions=new Map(),requests=new Map(),terminalIndex=new Map(),networkIndex=new Map();
  const seenEvents=new Set(),seenTraffic=new Set(),evidenceNodes=new Map(),mergedPairs=new Set(),gaps=new Map();
  const initiators=[],redirects=[];
  const stats={duplicateEvents:0,duplicateTraffic:0,capturedRequests:0,observedRequests:0,respondedRequests:0,pendingRequests:0,blockedRequests:0,failedRequests:0,policyBlocks:0,flowsTruncated:0,omittedAssets:0};
  const originSet=new Set(config.requestOrigins||run.policy?.requestOrigins||[]);
  const navSet=new Set(config.navigationOrigins||run.policy?.navigationOrigins||[]);
  const gap=(reason,data={})=>{
    const safe={reason,...redact(data)},key=JSON.stringify(safe);
    const existing=gaps.get(key);if(existing)existing.count++;else gaps.set(key,{...safe,count:1});
  };
  for(const item of run.coverageGaps||[])gap(clean(item.reason||'unspecified_gap'),{
    ...(item.url?{url:shownUrl(item.url)}:{}),...(item.stateId!=null?{stateId:item.stateId}:{}),...(item.message?{message:clean(item.message,300)}:{})});
  const scope=url=>{
    try{const origin=new URL(url).origin;return {inScope:originSet.size?originSet.has(origin):null,navigationInScope:navSet.size?navSet.has(origin):null};}
    catch{return {inScope:null,navigationInScope:null}};
  };
  const evidence=(owner,index,ids)=>{
    if(!index.has(owner.id))index.set(owner.id,new Set());const set=index.get(owner.id);
    for(const value of ids||[])if(value!=null&&value!==''){
      const id=clean(value,220);if(set.has(id))continue;set.add(id);
      if(owner.evidenceIds.length<EVIDENCE_LIMIT)owner.evidenceIds.push(id);else owner.evidenceOmitted++;
    }
  };
  const node=(row,ids=[])=>{
    let value=nodeIndex.get(row.id);
    if(!value){value={evidenceIds:[],evidenceOmitted:0,...row};nodeIndex.set(value.id,value);}
    else {
      if(row.observed){value.observed=true;value.confidence='observed';}
      if(row.responseObserved)value.responseObserved=true;
      if(row.status==='observed'||value.status==='unknown'||value.status==='candidate'&&row.status!=='candidate')value.status=row.status;
    }
    evidence(value,nodeEvidence,ids);return value;
  };
  const edge=(row,contribution,ids=[])=>{
    const id=opaque('edge',[row.source,row.target,row.type,row.confidence,row.method??null,row.type==='action'?null:row.status??null,row.authEpoch??null,row.outcome??null]);
    let value=edgeIndex.get(id);
    if(!value){value={id,...row,count:0,evidenceIds:[],evidenceOmitted:0};edgeIndex.set(id,value);edgeContributions.set(id,new Set());}
    const contributions=edgeContributions.get(id),key=String(contribution??ids[0]??id);
    if(!contributions.has(key)){contributions.add(key);value.count++;}
    if(row.sourceContext?.executionId){
      if(!edgeExecutions.has(id))edgeExecutions.set(id,new Set());const executions=edgeExecutions.get(id),executionId=row.sourceContext.executionId;
      if(!value.executionIds){value.executionIds=[];value.executionOmitted=0;}
      if(!executions.has(executionId)){executions.add(executionId);if(value.executionIds.length<EVIDENCE_LIMIT)value.executionIds.push(executionId);else value.executionOmitted++;}
    }
    evidence(value,edgeEvidence,ids);return value;
  };
  const resourceType=(url,type='',contentType='',method='GET')=>{
    const kind=String(type).toLowerCase();
    if(kind==='document'||kind==='navigation')return 'route';
    if(kind==='script')return 'script';
    if(['xhr','fetch'].includes(kind))return 'api';
    if(/javascript|ecmascript/i.test(contentType)||/\.(?:m?js)(?:\?|$)/i.test(url))return 'script';
    if(/text\/html/i.test(contentType))return 'route';
    if(/json|graphql/i.test(contentType))return 'api';
    if(['image','font','media','stylesheet','manifest','texttrack'].includes(kind)||/\.(?:css|png|jpe?g|svg|gif|webp|woff2?|ttf|mp4|ico)(?:\?|$)/i.test(url))return 'route';
    return /\/(?:api|graphql|gql|rest|services?|gateway|rpc|v\d+)(?:\/|$|\?)/i.test(url)||!['GET','HEAD','unknown'].includes(methodOf(method))?'api':'route';
  };
  const omitAsset=(url,type='')=>{
    const kind=String(type).toLowerCase();
    return ['image','font','media','stylesheet','manifest','texttrack'].includes(kind)||
      !['fetch','xhr','document','navigation','script'].includes(kind)&&/\.(?:css|png|jpe?g|svg|gif|webp|woff2?|ttf|mp4|ico)(?:\?|$)/i.test(url||'');
  };
  const target=(url,method='GET',type='',contentType='',status='candidate',observed=false,ids=[])=>{
    url=urlOf(url);if(!url)return null;
    const kind=resourceType(url,type,contentType,method),m=methodOf(method);
    return node({id:opaque(kind,[kind==='api'?m:null,url]),type:kind,label:(kind==='api'?m+' ':'')+labelUrl(url),
      url:shownUrl(url),...(kind==='api'?{method:m}:{}),resourceType:clean(type,40),status,observed,responseObserved:observed,confidence:observed?'observed':'context',...scope(url)},ids);
  };
  const route=(url,label='后台/页面请求',ids=[])=>{
    const canonical=urlOf(url),id=opaque('route',['context',canonical||'background']);
    return node({id,type:'route',label:canonical?label+' · '+labelUrl(canonical):'后台/未关联页面',url:shownUrl(canonical),
      status:'context',observed:false,confidence:'context',background:true,...scope(canonical)},ids);
  };
  const makeAction=(stateId,localId,description={})=>{
    if(stateId==null||localId==null||!stateIndex.has(keyOf(stateId)))return null;
    const id=actionKey(stateId,localId),key=JSON.stringify([keyOf(stateId),keyOf(localId)]);
    const value=node({id,type:'action',stateId:stateIndex.get(keyOf(stateId)).id,actionId:actionLocal(localId),
      label:clean(description.label||description.text||description.control||description.kind||'交互动作'),kind:clean(description.kind||'click',40),
      status:clean(description.status||'unknown',80),reason:clean(description.reason||description.skipReason||'',300),
      observed:['running','succeeded','failed'].includes(description.status),confidence:'context'},[description.evidenceId]);
    actionIndex.set(key,value);
    return value;
  };
  const actionFor=(stateId,localId)=>actionIndex.get(JSON.stringify([keyOf(stateId),keyOf(localId)]));
  const sourceOf=(row,fallback={})=>{
    const src={...fallback,...(row.source||{})};
    for(const key of ['stateId','actionId','executionId'])if(src[key]==null&&row[key]!=null)src[key]=row[key];
    if(src.executionId&&executions.has(String(src.executionId))) {
      const known=executions.get(String(src.executionId));
      for(const key of ['stateId','actionId'])if(src[key]==null)src[key]=known[key];
    }
    return src;
  };
  const origin=(src,ids=[])=>{
    const st=stateIndex.get(keyOf(src.stateId));
    if(st&&src.actionId!=null){const action=actionFor(st.id,src.actionId)||makeAction(st.id,src.actionId,{label:src.control,status:'unknown'});if(action)return action;}
    if(st)return nodeIndex.get(stateKey(st.id));
    return route(src.page||src.documentURL||src.document||'',undefined,ids);
  };
  const publicSource=src=>({kind:clean(src.kind||'page',40),
    ...(stateIndex.has(keyOf(src.stateId))?{stateId:stateIndex.get(keyOf(src.stateId)).id}:{}),
    ...(src.actionId!=null?{actionId:actionLocal(src.actionId)}:{}),
    ...(src.executionId?{executionId:opaque('execution',String(src.executionId))}:{}),...(src.page?{page:shownUrl(src.page)}:{})});
  for(const st of stateRows)if(st&&st.id!=null) {
    stateIndex.set(keyOf(st.id),st);
    const actions=st.interactives||[],pending=actions.some(a=>['planned','running'].includes(a.status));
    const value=node({id:stateKey(st.id),type:'state',stateId:st.id,label:clean(st.title||st.url||'状态 '+st.id),url:shownUrl(st.url||''),
      status:pending?'pending':actions.some(a=>a.status==='failed')?'failed':st.expanded?'expanded':'observed',
      observed:true,confidence:'observed',depth:Number(st.depth)||0,parentId:st.parentId??null,...scope(st.url)},[st.evidenceId]);
    if(st.evidenceId)evidenceNodes.set(String(st.evidenceId),value.id);
    const number=Number(st.id),format=['jpg','jpeg'].includes(config.shotFormat)?'jpg':'png';
    if(config.shotFormat!=='none'&&config.outputDir&&Number.isSafeInteger(number)&&number>0){const relative='states/'+String(number).padStart(3,'0')+'.'+format;if(existsSync(path.join(config.outputDir,relative)))value.screenshot=relative;}
  }
  for(const st of stateIndex.values())for(const action of st.interactives||[])makeAction(st.id,action.id??action.selector,action);
  const authoritativeActions=new Set([...actionIndex.values()].map(a=>a.id));
  const rawContext=row=>sourceOf(row,{page:row.documentURL||row.page||''});
  const requestFor=(key,description={})=>{
    key=String(key);let value=requests.get(key);
    if(!value){value={key,evidenceIds:new Set(),terminal:false,source:{},method:'unknown',url:'',type:''};requests.set(key,value);}
    for(const field of ['url','method','type','contentType','status','authEpoch','failed','blockedReason','redirectedFromUrl','networkId'])if(description[field]!=null&&description[field]!=='')value[field]=description[field];
    if(description.source)for(const [key,field] of Object.entries(description.source))if((value.source[key]==null||value.source[key]==='')&&field!==null&&field!==undefined&&field!=='')value.source[key]=field;
    for(const id of description.evidenceIds||[])if(id)value.evidenceIds.add(String(id));
    if(description.terminal)value.terminal=true;
    if(description.responseObserved)value.responseObserved=true;
    if(Number(description.status)>0)value.httpStatus=Number(description.status);
    if(value.networkId)networkIndex.set(String(value.networkId),value);
    return value;
  };
  const logs={};
  logs.events=await readLog(eventsFile,'events',row=>{
    if(row.evidenceId&&seenEvents.has(String(row.evidenceId))){stats.duplicateEvents++;return;}
    if(row.evidenceId)seenEvents.add(String(row.evidenceId));
    const ids=[row.evidenceId];
    if(row.kind==='request') {
      const key=row.evidenceId||opaque('legacy-request',[row.requestId,row.url,row.ts]);
      requestFor(key,{...row,source:rawContext(row),evidenceIds:ids,redirectedFromUrl:row.redirectedFromUrl||(typeof row.redirectedFrom==='string'&&/^https?:/.test(row.redirectedFrom)?row.redirectedFrom:null)});
    }else if(row.kind==='response'||row.kind==='request_failed') {
      const key=row.requestEvidenceId||row.evidenceId||opaque('legacy-terminal',[row.kind,row.url,row.ts]);
      const failed=row.kind==='request_failed'?(row.error||'request_failed'):null;
      const value=requestFor(key,{...row,type:row.type||row.resourceType,source:rawContext(row),evidenceIds:[...ids,row.requestEvidenceId],terminal:true,responseObserved:row.kind==='response',
        ...(failed?{failed,status:0}:{})});
      if(row.evidenceId)terminalIndex.set(String(row.evidenceId),value);
    }else if(row.kind==='response_body') {
      const key=row.requestEvidenceId,known=key?requests.get(String(key)):terminalIndex.get(String(row.responseEvidenceId));
      if(known){if(row.evidenceId)known.evidenceIds.add(String(row.evidenceId));}
    }else if(row.kind==='action_started'||row.kind==='action_replay') {
      const executionId=row.executionId||row.evidenceId;
      if(executionId)executions.set(String(executionId),{stateId:row.stateId,actionId:row.actionId});
      const action=makeAction(row.stateId,row.actionId,{label:row.label,kind:row.actionKind,status:'running'});
      if(action){action.observed=true;action.attemptObserved=true;if(!authoritativeActions.has(action.id))action.status='running';evidence(action,nodeEvidence,ids);
        if(!actionExecutions.has(action.id))actionExecutions.set(action.id,new Set());const executionSet=actionExecutions.get(action.id);
        if(!action.executionIds){action.executionIds=[];action.executionOmitted=0;}
        if(executionId&&!executionSet.has(String(executionId))){executionSet.add(String(executionId));if(action.executionIds.length<EVIDENCE_LIMIT)action.executionIds.push(opaque('execution',String(executionId)));else action.executionOmitted++;}
        action.executionCount=executionSet.size;}
    }else if(row.kind==='action_finished') {
      const action=actionFor(row.stateId,row.actionId)||makeAction(row.stateId,row.actionId,{label:row.label,status:row.status});
      if(action){if(!authoritativeActions.has(action.id))action.status=clean(row.status||'unknown',80);evidence(action,nodeEvidence,ids);}
    }else if(row.kind==='state_merged') {
      const from=stateIndex.get(keyOf(row.stateId)),to=stateIndex.get(keyOf(row.into));
      if(from&&to){const action=actionFor(from.id,row.actionId),source=action?.id||stateKey(from.id);mergedPairs.add(keyOf(from.id)+'|'+keyOf(to.id));
        edge({source,target:stateKey(to.id),type:'transition',label:action?.label||'观察到合流/回边',observed:true,confidence:action?'observed':'context',
          stateId:from.id,targetStateId:to.id,loop:from.id===to.id,merged:true},row.evidenceId||opaque('merge',row),ids);}
    }else if(row.kind==='static_candidate'||row.kind==='endpoint_discovered') {
      const endpoint=target(row.url,'unknown','','','candidate',false,ids);if(!endpoint)return;
      endpoint.confidence='static';
      const sourceId=evidenceNodes.get(String(row.sourceId));
      const document=sourceId?nodeIndex.get(sourceId):target(row.document,'GET',/\.(?:m?js)(?:\?|$)/i.test(row.document||'')?'script':'document','','context',false,[row.sourceId]);
      const from=document||route('',undefined,ids);
      edge({source:from.id,target:endpoint.id,type:'candidate',label:'静态候选，未执行',observed:false,confidence:'static',method:'unknown'},row.evidenceId||opaque('candidate',[row.url,row.document]),ids);
    }else if(row.kind==='policy'&&row.allow===false) {
      stats.policyBlocks++;const endpoint=target(row.url,row.method,row.type,'','blocked',false,ids);if(!endpoint)return;
      const src=rawContext(row),from=origin(src,ids);
      edge({source:from.id,target:endpoint.id,type:'request',label:'策略阻断 · '+clean(row.reason,100),observed:false,confidence:'context',outcome:'policy_blocked',
        method:methodOf(row.method),status:0,reason:clean(row.reason,100),sourceContext:publicSource(src)},row.evidenceId||opaque('policy',row),ids);
    }else if(row.kind==='network_initiator')initiators.push(row);
    else if(row.kind==='network_redirect'||row.kind==='redirect')redirects.push(row);
    else if(row.kind==='coverage_gap')gap(clean(row.reason||'unspecified_gap'),{...(row.url?{url:shownUrl(row.url)}:{}),...(row.stateId!=null?{stateId:row.stateId}:{}),...(row.message?{message:clean(row.message,300)}:{})});
  },gap);
  const onTraffic=row=>{
    const signature=String(row.evidenceId||row.requestEvidenceId||opaque('traffic',[row.ts,row.method,row.url,row.status,row.failed]));
    if(seenTraffic.has(signature)){stats.duplicateTraffic++;return;}seenTraffic.add(signature);
    const known=row.requestEvidenceId?requests.get(String(row.requestEvidenceId)):terminalIndex.get(String(row.evidenceId));
    const key=known?.key||row.requestEvidenceId||row.evidenceId||signature;
    const value=requestFor(key,{...row,type:row.resourceType||row.type,source:rawContext(row),terminal:row.status!=null||!!row.failed,responseObserved:Number(row.status)>0,evidenceIds:[row.evidenceId,row.requestEvidenceId]});
    if(row.evidenceId)terminalIndex.set(String(row.evidenceId),value);
  };
  logs.traffic=config.captureTraffic===false&&(!trafficFile||!existsSync(trafficFile))?
    {status:'disabled',lines:0,records:0,malformed:0,truncated:0,oversized:0}:await readLog(trafficFile,'traffic',onTraffic,gap);
  for(const request of requests.values()) {
    stats.capturedRequests++;
    const blocked=!!request.failed&&/blocked|aborted|denied/i.test(String(request.failed));
    const outcome=request.failed?(blocked?'blocked':'failed'):request.terminal?'response':'pending';
    if(request.responseObserved){stats.observedRequests++;stats.respondedRequests++;}
    if(request.terminal){if(blocked)stats.blockedRequests++;else if(request.failed)stats.failedRequests++;}else stats.pendingRequests++;
    if(omitAsset(request.url,request.type)){stats.omittedAssets++;continue;}
    const src=sourceOf({source:request.source}),from=origin(src,[...request.evidenceIds]);
    const endpoint=target(request.url,request.method,request.type,request.contentType,request.terminal?(request.failed?outcome:'observed'):'pending',!!request.responseObserved,[...request.evidenceIds]);
    if(!endpoint)continue;
    endpoint.requestObserved=true;endpoint.capturedRequests=(endpoint.capturedRequests||0)+1;
    if(request.responseObserved)endpoint.responseObserved=true;
    if(from.background&&request.terminal){from.observed=true;from.status='request_source';}
    edge({source:from.id,target:endpoint.id,type:'request',label:methodOf(request.method)+' '+(request.failed?outcome:request.httpStatus??request.status??'pending'),
      observed:request.terminal,confidence:'context',method:methodOf(request.method),status:request.httpStatus??request.status??null,
      authEpoch:request.authEpoch??0,outcome,responseObserved:!!request.responseObserved,sourceContext:publicSource(src)},'request:'+request.key,[...request.evidenceIds]);
    if(request.redirectedFromUrl)redirects.push({fromUrl:request.redirectedFromUrl,toUrl:request.url,source:src,method:request.method,type:request.type,evidenceId:[...request.evidenceIds][0]});
  }
  for(const row of apis||[]) {
    const endpoint=target(row.url,row.method,'','','ledger_only',false,[]);if(!endpoint)continue;
    if(!endpoint.observed&&row.categories?.some(c=>['observed_request','failed_request','blocked_request'].includes(c)))endpoint.reportedObserved=true;
  }
  for(const st of stateIndex.values()) {
    const parent=stateIndex.get(keyOf(st.parentId));if(!parent)continue;
    const step=st.path?.at(-1),isSeed=!!step?.gotoUrl;
    const action=!isSeed&&step?actionFor(parent.id,step.id??step.actionId):null;
    const from=isSeed?route(step.gotoUrl,'手工/发现种子',[st.evidenceId]):action||nodeIndex.get(stateKey(parent.id));
    if(isSeed){from.seed=true;from.observed=true;}
    edge({source:from.id,target:stateKey(st.id),type:'transition',label:isSeed?'种子入口':action?.label||'观察到子状态（动作未关联）',
      observed:true,confidence:isSeed||action?'observed':'context',stateId:parent.id,targetStateId:st.id,seed:isSeed},'state:'+keyOf(st.id),[st.evidenceId,action?.evidenceIds?.[0]]);
  }
  for(const row of backEdges||[]) {
    const from=stateIndex.get(keyOf(row.from)),to=stateIndex.get(keyOf(row.to));if(!from||!to)continue;
    if(mergedPairs.has(keyOf(from.id)+'|'+keyOf(to.id)))continue;
    const action=row.actionId!=null?actionFor(from.id,row.actionId):null;
    edge({source:action?.id||stateKey(from.id),target:stateKey(to.id),type:'transition',label:action?.label||clean(row.label||'回边/合流'),
      observed:true,confidence:action?'observed':'context',stateId:from.id,targetStateId:to.id,loop:from.id===to.id,merged:true},
    row.executionId||opaque('backedge',[row.from,row.to,row.actionId,row.label,row.url]),[row.evidenceId,row.executionId]);
  }
  for(const row of initiators) {
    if(omitAsset(row.url,row.type))continue;
    const matching=row.requestEvidenceId?requests.get(String(row.requestEvidenceId)):networkIndex.get(String(row.networkId));
    const endpoint=target(row.url,row.method||matching?.method||'GET',row.type||matching?.type,matching?.contentType,
      matching?.responseObserved?'observed':'pending',!!matching?.responseObserved,[row.evidenceId]);if(!endpoint)continue;
    const frames=[];let stack=row.initiator?.stack,depth=0;
    while(stack&&depth++<8&&frames.length<STACK_LIMIT){for(const frame of stack.callFrames||[]){if(frames.length>=STACK_LIMIT)break;if(urlOf(frame.url))frames.push({...frame,stackDepth:depth-1,asyncDescription:clean(stack.description,120)});}stack=stack.parent;}
    if(!frames.length&&row.initiator?.type==='script'&&urlOf(row.initiator?.url))frames.push({url:row.initiator.url,lineNumber:row.initiator.lineNumber,columnNumber:row.initiator.columnNumber,functionName:''});
    const confidence=matching?.terminal&&row.requestEvidenceId?'observed':'context';
    const id=row.networkId||row.evidenceId||opaque('initiator',[row.url,row.ts,frames]);
    const locations=frames.map(frame=>({url:shownUrl(frame.url),functionName:clean(frame.functionName,120),stackDepth:frame.stackDepth??0,asyncDescription:frame.asyncDescription||'',
      lineNumber:Number.isInteger(frame.lineNumber)?frame.lineNumber:null,columnNumber:Number.isInteger(frame.columnNumber)?frame.columnNumber:null,
      line:Number.isInteger(frame.lineNumber)?frame.lineNumber+1:null,column:Number.isInteger(frame.columnNumber)?frame.columnNumber+1:null}));
    if(frames.length) {
      const scripts=frames.map(frame=>target(frame.url,'GET','script','','context',false,[row.evidenceId]));
      for(let i=0;i<scripts.length;i++){
        const script=scripts[i];if(!script.functions)script.functions=[];
        // A real CDP call frame can execute an inline script whose URL is the
        // HTML document. Execution evidence is separate from a script download.
        script.executionObserved=true;script.observed=true;
        if(!script.responseObserved){script.confidence='context';script.status='executed_context';}
        if(script.functions.length<STACK_LIMIT&&!script.functions.some(item=>item.functionName===locations[i].functionName&&item.line===locations[i].line&&item.column===locations[i].column))script.functions.push(locations[i]);
        script.locationConvention='line/column为1-based显示；lineNumber/columnNumber保留CDP 0-based原值';
      }
      for(let i=scripts.length-1;i>0;i--)if(scripts[i].id!==scripts[i-1].id)edge({source:scripts[i].id,target:scripts[i-1].id,type:'initiates',
        label:'浏览器调用栈/异步父栈线索',observed:false,confidence:'context'},'stack:'+id,[row.evidenceId]);
      const call=edge({source:scripts[0].id,target:endpoint.id,type:'initiates',label:'JS 发起上下文',observed:confidence==='observed',confidence,
        method:methodOf(row.method||matching?.method||'GET'),sourceContext:publicSource(rawContext(row)),locationConvention:'callFrames.line/column为1-based，lineNumber/columnNumber为CDP0-based'},'initiator:'+id,[row.evidenceId]);
      if(!call.callFrames)call.callFrames=locations;
    }else {
      const from=route(row.documentURL||row.source?.page||'','资源发起上下文',[row.evidenceId]);
      edge({source:from.id,target:endpoint.id,type:'initiates',label:'浏览器资源发起上下文（JS调用栈不可得）',observed:false,confidence:'context',callFramesUnavailable:true},'initiator:'+id,[row.evidenceId]);
    }
  }
  for(const row of redirects) {
    const from=target(row.fromUrl,row.method||'GET',row.type||'document','','observed',true,[row.evidenceId]);
    const to=target(row.toUrl,row.method||'GET',row.type||'document','','pending',false,[row.evidenceId]);if(!from||!to)continue;
    edge({source:from.id,target:to.id,type:'redirect',label:'重定向'+(row.status?' '+row.status:''),observed:true,confidence:'observed',status:row.status??null,
      method:methodOf(row.method||'GET'),sourceContext:publicSource(rawContext(row))},row.networkId||row.evidenceId||opaque('redirect',[row.fromUrl,row.toUrl,row.status]),[row.evidenceId]);
  }
  const flows=[];
  for(const action of actionIndex.values())edge({source:stateKey(action.stateId),target:action.id,type:'action',label:action.label,observed:!!action.attemptObserved,
    confidence:action.attemptObserved?'observed':'context',status:action.status},'state-action:'+action.id,action.evidenceIds);
  for(const st of stateIndex.values()) {
    const chain=[],seen=new Set();let cursor=st,complete=true;
    while(cursor?.parentId!=null) {
      if(seen.has(keyOf(cursor.id))){complete=false;gap('graph_flow_parent_cycle',{stateId:st.id});break;}seen.add(keyOf(cursor.id));
      if(chain.length>=FLOW_LIMIT){complete=false;stats.flowsTruncated++;gap('graph_flow_steps_truncated',{stateId:st.id,limit:FLOW_LIMIT});break;}
      const parent=stateIndex.get(keyOf(cursor.parentId));if(!parent){complete=false;gap('graph_flow_parent_missing',{stateId:st.id,parentId:cursor.parentId});break;}
      const step=cursor.path?.at(-1),action=step&&!step.gotoUrl?actionFor(parent.id,step.id??step.actionId):null;
      if(!action&&!step?.gotoUrl)complete=false;
      chain.push({stateId:parent.id,actionId:action?.id||null,label:step?.gotoUrl?'种子入口 · '+labelUrl(step.gotoUrl):action?.label||clean(step?.label||'动作未关联'),
        kind:step?.gotoUrl?'seed':clean(step?.kind||action?.kind||'unknown',40),targetStateId:cursor.id,status:action?.status||'observed'});cursor=parent;
    }
    flows.push({stateId:st.id,url:shownUrl(st.url),steps:chain.reverse(),complete});
  }
  const counts={...(run.counts||{})},limits={...(run.budgets||{})};
  for(const key of ['maxStates','maxDepth','maxDurationMs','maxRequests','maxActions','maxStatesPerHost'])if(!(key in limits)&&key in config)limits[key]=config[key];
  return {schemaVersion:1,run:redact({runId:run.runId||config.runId||null,asset:shownUrl(run.asset||config.startUrl||''),status:run.status||'unknown',stopReason:run.stopReason||null,
    startedAt:run.startedAt||null,finishedAt:run.finishedAt||null,elapsedMs:run.elapsedMs??null,pending:run.pending||{},counts,limits,gaps:[...gaps.values()]}),nodes:[...nodeIndex.values()],edges:[...edgeIndex.values()],flows,
    coverage:{status:run.status||'unknown',stopReason:run.stopReason||null,counts:redact(counts),limits:redact(limits),pending:redact(run.pending||{}),gaps:[...gaps.values()],
      sources:logs,graph:{...stats,observedApis:[...nodeIndex.values()].filter(node=>node.type==='api'&&node.responseObserved).length,nodes:nodeIndex.size,edges:edgeIndex.size,evidenceLimit:EVIDENCE_LIMIT,flowStepLimit:FLOW_LIMIT,
        note:'图关注页面流程、API与JS调用，图片/字体/媒体/样式等资产省略但计入omittedAssets；页面/动作到请求表示捕获时执行上下文；JS initiator未精确配对时仅为上下文证据，静态候选不表示已调用。'}}};
}
