import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { redact, redactText, redactUrl } from './redact.js';

const NODE_TYPES=new Set(['state','action','api','route','script']);
const EDGE_TYPES=new Set(['action','transition','request','candidate','initiates','redirect']);
const CONFIDENCE=new Set(['observed','context','static']);
const MAX_NODES=100000,MAX_EDGES=300000,MAX_STEPS=256,MAX_RESPONSE_BYTES=131072;
const COUNT_KEYS=['states','requests','actions','totalRequests','totalActions','apis','harEntries'];
const LIMIT_KEYS=['maxStates','maxDepth','maxDurationMs','maxRequests','maxActions','maxStatesPerHost'];
const GRAPH_KEYS=['duplicateEvents','duplicateTraffic','capturedRequests','observedRequests','respondedRequests','pendingRequests','blockedRequests','failedRequests','policyBlocks','flowsTruncated','omittedAssets','observedApis','nodes','edges','evidenceLimit','flowStepLimit'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
const count=value=>Number.isSafeInteger(value)&&value>=0?value:undefined;
const fingerprint=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,256}$/.test(value);
const stateKey=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):validId(value)?value:null;
const strict=edge=>edge.observed===true&&edge.confidence==='observed'&&edge.type!=='candidate';

function projection(validation){
  const text=(value,limit=512)=>{
    if(typeof value!=='string')return undefined;
    const input=value.slice(0,8192);const safe=redactText(input)
      .replace(/\bBasic\s+[A-Za-z0-9+/_=-]+/gi,'Basic [REDACTED]')
      .replace(/((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi,'$1[REDACTED]')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
    if(value.length>8192||safe.length>limit)validation.truncatedFields++;
    return safe.slice(0,limit);
  };
  const url=value=>{
    if(typeof value!=='string'||!/^https?:\/\//i.test(value))return undefined;
    // Remove userinfo before shortening: cutting a long authority before its @
    // must not turn credentials into malformed-URL text that escapes redaction.
    const input=value.replace(/^(https?:\/\/)[^/?#]*@/i,'$1').slice(0,8192);
    let safe;try{safe=redactUrl(new URL(input).href)}catch{return undefined;}
    if(value.length>8192||safe.length>1024)validation.truncatedFields++;
    return safe.slice(0,1024);
  };
  const strings=(value,max=12)=>{
    if(!Array.isArray(value))return [];
    if(value.length>max)validation.truncatedFields++;
    return value.slice(0,max).filter(item=>typeof item==='string').map(item=>text(item,256));
  };
  const numbers=(value,keys,nullable=false)=>{
    const result={};if(!plain(value))return result;
    for(const key of keys){if(nullable&&value[key]===null)result[key]=null;else if(count(value[key])!==undefined)result[key]=value[key];}
    return result;
  };
  const stateId=value=>{const key=stateKey(value);return key===null?undefined:typeof value==='number'?value:text(value,128);};
  const frames=value=>{
    if(!Array.isArray(value))return [];
    if(value.length>8)validation.truncatedFields++;
    return value.slice(0,8).filter(plain).map(frame=>({url:url(frame.url),functionName:text(frame.functionName,160),
      line:count(frame.line),column:count(frame.column),lineNumber:count(frame.lineNumber),columnNumber:count(frame.columnNumber),
      stackDepth:count(frame.stackDepth),asyncDescription:text(frame.asyncDescription,160)}));
  };
  const source=value=>!plain(value)?undefined:{kind:text(value.kind,32),page:url(value.page),stateId:stateId(value.stateId),
    actionId:text(value.actionId,256),executionId:text(value.executionId,256)};
  const node=value=>{
    const before=validation.truncatedFields;
    const result={id:value.id,type:value.type,label:text(value.label),url:url(value.url),status:text(value.status,64),
      confidence:CONFIDENCE.has(value.confidence)?value.confidence:'context'};
    for(const key of ['observed','responseObserved','executionObserved','attemptObserved','requestObserved','inScope','navigationInScope','background','seed'])if(typeof value[key]==='boolean'||value[key]===null)result[key]=value[key];
    for(const key of ['stateId','parentId'])if(value[key]===null)result[key]=null;else if(stateId(value[key])!==undefined)result[key]=stateId(value[key]);
    for(const key of ['depth','executionCount','executionOmitted','evidenceOmitted','locationOmitted','capturedRequests'])if(count(value[key])!==undefined)result[key]=value[key];
    for(const key of ['actionId','kind','reason','resourceType','method'])if(typeof value[key]==='string')result[key]=text(value[key],key==='actionId'?256:160);
    result.evidenceIds=strings(value.evidenceIds);result.executionIds=strings(value.executionIds);result.locations=frames(value.locations);result.functions=frames(value.functions);
    if(typeof value.locationConvention==='string')result.locationConvention=text(value.locationConvention,160);
    if(validation.truncatedFields>before)result.fieldsTruncated=true;
    return result;
  };
  const edge=value=>{
    const before=validation.truncatedFields;
    const result={id:value.id,source:value.source,target:value.target,type:value.type,label:text(value.label),
      confidence:CONFIDENCE.has(value.confidence)?value.confidence:'context',observed:value.observed===true,responseObserved:value.responseObserved===true};
    for(const key of ['count','authEpoch','executionOmitted','evidenceOmitted'])if(count(value[key])!==undefined)result[key]=value[key];
    for(const key of ['status','method','outcome','reason'])if(typeof value[key]==='string')result[key]=text(value[key],160);else if(count(value[key])!==undefined)result[key]=value[key];
    for(const key of ['stateId','targetStateId'])if(stateId(value[key])!==undefined)result[key]=stateId(value[key]);
    for(const key of ['loop','merged','seed','callFramesUnavailable'])if(typeof value[key]==='boolean')result[key]=value[key];
    result.evidenceIds=strings(value.evidenceIds);result.executionIds=strings(value.executionIds);result.callFrames=frames(value.callFrames);result.sourceContext=source(value.sourceContext);
    if(typeof value.locationConvention==='string')result.locationConvention=text(value.locationConvention,160);
    if(validation.truncatedFields>before)result.fieldsTruncated=true;
    return result;
  };
  const gaps=value=>{
    if(!Array.isArray(value))return [];
    if(value.length>20)validation.truncatedFields++;
    return value.slice(0,20).filter(item=>typeof item==='string'||plain(item)).map(item=>typeof item==='string'?{reason:text(item,160)}:
      {reason:text(item.reason,160),count:count(item.count),stateId:stateId(item.stateId),url:url(item.url)});
  };
  const run=value=>{value=plain(value)?value:{};return {runId:text(value.runId,180),asset:url(value.asset),status:text(value.status,64),stopReason:text(value.stopReason,160),
    startedAt:text(value.startedAt,64),finishedAt:text(value.finishedAt,64),elapsedMs:count(value.elapsedMs)};};
  const coverage=value=>{value=plain(value)?value:{};return {status:text(value.status,64),stopReason:text(value.stopReason,160),
    counts:numbers(value.counts,COUNT_KEYS),limits:numbers(value.limits,LIMIT_KEYS,true),pending:numbers(value.pending,['states','actions','failed','seeds','bootstrap']),
    graph:numbers(value.graph,GRAPH_KEYS),gaps:gaps(value.gaps),totalGaps:Array.isArray(value.gaps)?value.gaps.length:0,
    gapsTruncated:Array.isArray(value.gaps)&&value.gaps.length>20,note:text(value.graph?.note,512)};};
  const step=value=>({stateId:stateId(value.stateId),actionId:validId(value.actionId)?value.actionId:null,label:text(value.label,256),
    kind:text(value.kind,64),targetStateId:stateId(value.targetStateId),status:text(value.status,64)});
  return {node,edge,run,coverage,step};
}

function indexGraph(raw){
  if(!plain(raw)||raw.schemaVersion!==1||!Array.isArray(raw.nodes)||!Array.isArray(raw.edges)||raw.nodes.length>MAX_NODES||raw.edges.length>MAX_EDGES||
    raw.flows!==undefined&&(!Array.isArray(raw.flows)||raw.flows.length>MAX_NODES))fail('GRAPH_INVALID','图格式或规模不受支持');
  const validation={invalidNodes:0,invalidEdges:0,danglingEdges:0,orphanActions:0,invalidFlows:0,invalidFlowSteps:0,truncatedFlows:0,truncatedFields:0,gaps:[]};
  const safe=projection(validation),nodes=[],edges=[],byId=new Map(),states=new Map(),byType=new Map(),adjacent=new Map(),flows=new Map(),proof=new Set(),seedProof=new Set();
  const ids=new Set();
  for(const row of raw.nodes){
    if(!plain(row)||!validId(row.id)||!NODE_TYPES.has(row.type)||row.type==='state'&&stateKey(row.stateId)===null){validation.invalidNodes++;continue;}
    if(ids.has(row.id))fail('GRAPH_INVALID','图节点标识重复');ids.add(row.id);
    const value=safe.node(row);nodes.push(value);byId.set(value.id,value);adjacent.set(value.id,[]);
    if(!byType.has(value.type))byType.set(value.type,[]);byType.get(value.type).push(value);
    if(value.type==='state'&&stateKey(value.stateId)!==null){const key=stateKey(value.stateId);if(states.has(key))fail('GRAPH_INVALID','图状态编号重复');states.set(key,value);}
  }
  for(const row of byType.get('action')||[])if(!states.has(stateKey(row.stateId)))validation.orphanActions++;
  ids.clear();
  for(const row of raw.edges){
    if(!plain(row)||!validId(row.id)||!validId(row.source)||!validId(row.target)||!EDGE_TYPES.has(row.type)){validation.invalidEdges++;continue;}
    if(ids.has(row.id)||byId.has(row.id))fail('GRAPH_INVALID','图关系标识重复');ids.add(row.id);
    if(!byId.has(row.source)||!byId.has(row.target)){validation.danglingEdges++;continue;}
    const value=safe.edge(row);edges.push(value);adjacent.get(value.source).push(value);if(value.target!==value.source)adjacent.get(value.target).push(value);
    if(strict(value)){proof.add(JSON.stringify([value.source,value.target,value.type]));if(value.seed&&value.type==='transition')seedProof.add(value.target);}
  }
  for(const row of raw.flows||[]){
    const key=plain(row)?stateKey(row.stateId):null;
    if(key===null||!states.has(key)||!Array.isArray(row.steps)){validation.invalidFlows++;continue;}
    if(flows.has(key))fail('GRAPH_INVALID','图到达路径的状态编号重复');
    if(row.steps.length>MAX_STEPS)validation.truncatedFlows++;
    const steps=[];let invalidSteps=0;
    for(const item of row.steps.slice(0,MAX_STEPS)){
      if(plain(item)&&stateKey(item.stateId)!==null&&stateKey(item.targetStateId)!==null)steps.push(safe.step(item));else invalidSteps++;
    }
    validation.invalidFlowSteps+=invalidSteps;
    flows.set(key,{steps,totalSteps:row.steps.length,complete:row.complete===true,invalidSteps,truncated:row.steps.length>MAX_STEPS});
  }
  for(const key of ['invalidNodes','invalidEdges','danglingEdges','orphanActions','invalidFlows','invalidFlowSteps','truncatedFlows'])if(validation[key])validation.gaps.push({reason:'graph_'+key,count:validation[key]});
  const run=safe.run(raw.run),coverage=safe.coverage(raw.coverage);
  if(run.status&&coverage.status&&run.status!==coverage.status)validation.gaps.push({reason:'graph_status_mismatch'});
  validation.incomplete=validation.gaps.length>0;
  const counts={nodes:nodes.length,edges:edges.length,rawNodes:raw.nodes.length,rawEdges:raw.edges.length,flows:flows.size,
    byType:Object.fromEntries([...byType].map(([type,rows])=>[type,rows.length])),respondedApis:nodes.filter(row=>row.type==='api'&&row.responseObserved).length};
  return {nodes,edges,byId,states,byType,adjacent,flows,proof,seedProof,validation,run,coverage,counts};
}

const integer=(value,min,max,name)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_ARGUMENT',name+' 超出允许范围');return value;};
const nodeId=value=>{if(!validId(value))fail('INVALID_ARGUMENT','nodeId 无效');return value;};
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
function appendWithin(items,candidates,limit,budget){let used=0;for(const item of candidates){if(items.length>=limit)break;const cost=bytes(item)+1;if(used+cost>budget)break;items.push(item);used+=cost;}return used;}
function result(value){const serialized=JSON.stringify(redact(value));if(Buffer.byteLength(serialized)>MAX_RESPONSE_BYTES)fail('GRAPH_RESULT_LIMIT','图查询结果超过响应上限');return JSON.parse(serialized);}
function paged(rows,{offset,limit},validation){
  const answer={items:[],total:rows.length,offset,limit,nextOffset:null,truncated:false,validation};
  appendWithin(answer.items,rows.slice(offset,offset+limit),limit,MAX_RESPONSE_BYTES-bytes(answer)-1024);
  answer.nextOffset=offset+answer.items.length<rows.length?offset+answer.items.length:null;
  answer.truncated=answer.nextOffset!==null||validation.truncatedFields>0||validation.incomplete;
  return result(answer);
}

/** Read-only, registered-run graph queries. Never opens private evidence files,
 * starts a browser, follows target URLs or returns arbitrary graph metadata. */
export function createGraphReader({getRunDir,maxBytes=134217728,maxEntries=2}={}){
  if(typeof getRunDir!=='function')fail('INVALID_ARGUMENT','getRunDir 必须为注册任务解析函数');
  integer(maxBytes,1,Number.MAX_SAFE_INTEGER,'maxBytes');integer(maxEntries,1,16,'maxEntries');
  const cache=new Map(),loading=new Map(),stats={loads:0,cacheHits:0,cacheMisses:0,evictions:0};
  const read=async(file,signature)=>{
    let handle;
    try{
      handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const first=await handle.stat();
      if(!first.isFile()||first.size>maxBytes||fingerprint(first)!==signature)fail('GRAPH_CHANGED','图文件读取期间发生变化');
      const chunks=[];let size=0,position=0;
      for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,maxBytes-size+1));const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;
        size+=bytesRead;position+=bytesRead;if(size>maxBytes)fail('GRAPH_TOO_LARGE','图文件超过读取上限');chunks.push(buffer.subarray(0,bytesRead));}
      const after=await handle.stat(),current=await lstat(file);
      if(!current.isFile()||current.isSymbolicLink()||fingerprint(after)!==signature||fingerprint(current)!==signature)fail('GRAPH_CHANGED','图文件读取期间发生变化');
      let parsed;try{parsed=JSON.parse(Buffer.concat(chunks,size).toString('utf8'))}catch{fail('GRAPH_INVALID','图JSON损坏或不受支持');}
      return indexGraph(parsed);
    }finally{await handle?.close();}
  };
  const load=async runId=>{
    if(typeof runId!=='string'||!runId||runId.length>200||/[\x00-\x20/\\\x7f]/.test(runId))fail('INVALID_ARGUMENT','runId 无效');
    let registered;try{registered=await getRunDir(runId)}catch{fail('RUN_NOT_FOUND','未找到已注册任务');}
    if(typeof registered!=='string'||!registered)fail('RUN_NOT_FOUND','未找到已注册任务');
    let directory;try{directory=await realpath(registered)}catch{fail('RUN_NOT_FOUND','已注册任务目录不可用');}
    const file=path.join(directory,'graph.json');let stat;
    try{stat=await lstat(file)}catch{fail('GRAPH_NOT_FOUND','任务尚无可读取的图');}
    if(stat.isSymbolicLink()||!stat.isFile())fail('GRAPH_INVALID_FILE','图必须为任务目录内的普通文件');
    if(stat.size>maxBytes)fail('GRAPH_TOO_LARGE','图文件超过读取上限');
    const signature=fingerprint(stat),known=cache.get(directory);
    if(known?.signature===signature){stats.cacheHits++;cache.delete(directory);cache.set(directory,known);return known.graph;}
    stats.cacheMisses++;const key=JSON.stringify([directory,signature]);
    if(loading.has(key))return loading.get(key);
    const pending=(async()=>{
      try{const graph=await read(file,signature);stats.loads++;cache.delete(directory);cache.set(directory,{signature,graph});
        while(cache.size>maxEntries){cache.delete(cache.keys().next().value);stats.evictions++;}return graph;
      }catch(error){if(error.code?.startsWith('GRAPH_'))throw error;fail('GRAPH_UNAVAILABLE','图文件不可读取');}
      finally{loading.delete(key);}
    })();loading.set(key,pending);return pending;
  };
  const pagination=({offset=0,limit=50})=>({offset:integer(offset,0,Number.MAX_SAFE_INTEGER,'offset'),limit:integer(limit,1,100,'limit')});
  return {
    get stats(){return {...stats,cachedEntries:cache.size,pendingLoads:loading.size};},
    async summary({runId}){const graph=await load(runId);return result({run:graph.run,counts:graph.counts,coverage:graph.coverage,validation:graph.validation,
      truncated:graph.validation.truncatedFields>0||graph.validation.incomplete||graph.coverage.gapsTruncated});},
    async nodes({runId,type,search,offset=0,limit=50}){
      const page=pagination({offset,limit});if(type!==undefined&&!NODE_TYPES.has(type))fail('INVALID_ARGUMENT','节点类型无效');
      if(search!==undefined&&(typeof search!=='string'||search.length>256))fail('INVALID_ARGUMENT','search 必须为至多256字符的文本');
      const graph=await load(runId);let rows=type?graph.byType.get(type)||[]:graph.nodes;
      if(search){const query=search.toLocaleLowerCase();rows=rows.filter(row=>[row.label,row.url,row.id,row.method].some(value=>typeof value==='string'&&value.toLocaleLowerCase().includes(query)));}
      return paged(rows,page,graph.validation);
    },
    async edges({runId,nodeId:at,kind,offset=0,limit=50}){
      const page=pagination({offset,limit});if(kind!==undefined&&!EDGE_TYPES.has(kind))fail('INVALID_ARGUMENT','关系类型无效');
      if(at!==undefined)nodeId(at);const graph=await load(runId);if(at!==undefined&&!graph.byId.has(at))fail('NODE_NOT_FOUND','图中没有该节点');
      let rows=at!==undefined?graph.adjacent.get(at):graph.edges;if(kind)rows=rows.filter(row=>row.type===kind);
      return paged(rows,page,graph.validation);
    },
    async neighborhood({runId,nodeId:at,depth=1,limit=100}){
      nodeId(at);integer(depth,1,3,'depth');integer(limit,1,200,'limit');const graph=await load(runId);
      if(!graph.byId.has(at))fail('NODE_NOT_FOUND','图中没有该节点');
      const visited=new Set([at]),order=[at];let frontier=[at];
      for(let level=0;level<depth;level++){
        const next=[];for(const id of frontier)for(const edge of graph.adjacent.get(id)){const other=edge.source===id?edge.target:edge.source;if(!visited.has(other)){visited.add(other);order.push(other);next.push(other);}}
        frontier=next;
      }
      const related=new Set();for(const id of visited)for(const edge of graph.adjacent.get(id))if(visited.has(edge.source)&&visited.has(edge.target))related.add(edge);
      const answer={rootId:at,depth,nodes:[],edges:[],totalNodes:visited.size,totalEdges:related.size,limit,edgeLimit:200,truncated:false,gaps:[],validation:graph.validation};
      const budget=MAX_RESPONSE_BYTES-bytes(answer)-1024;
      const used=appendWithin(answer.nodes,order.slice(0,limit).map(id=>graph.byId.get(id)),limit,Math.floor(budget*.6));
      const shown=new Set(answer.nodes.map(row=>row.id));
      appendWithin(answer.edges,[...related].filter(edge=>shown.has(edge.source)&&shown.has(edge.target)),200,budget-used);
      answer.truncated=answer.nodes.length<visited.size||answer.edges.length<related.size||graph.validation.incomplete||graph.validation.truncatedFields>0;
      if(answer.nodes.length<visited.size||answer.edges.length<related.size)answer.gaps.push({reason:'neighborhood_result_limit'});
      return result(answer);
    },
    async path({runId,stateId}){
      const key=stateKey(stateId);if(key===null)fail('INVALID_ARGUMENT','stateId 无效');const graph=await load(runId);
      const state=graph.states.get(key)||(graph.byId.get(key)?.type==='state'?graph.byId.get(key):null),flow=state?graph.flows.get(String(state.stateId)):null;
      const answer={stateId:state?.stateId??stateId,stateNodeId:state?.id??null,runStatus:graph.run.status,steps:[],totalSteps:flow?.totalSteps??0,
        complete:false,observed:false,truncated:false,gaps:[],validation:graph.validation};
      if(graph.run.status!=='completed')answer.gaps.push({reason:'run_'+(graph.run.status||'unknown')});
      if(!state)answer.gaps.push({reason:'state_not_found'});
      else if(!flow)answer.gaps.push({reason:'path_not_recorded'});
      else{
        if(!flow.complete||flow.invalidSteps)answer.gaps.push({reason:'flow_incomplete'});
        if(flow.truncated)answer.gaps.push({reason:'path_step_limit'});
        let prior=null,valid=state.observed===true;const seen=new Set(),verified=[];
        if(!valid)answer.gaps.push({reason:'state_not_observed'});
        for(const step of flow.steps){
          const from=graph.states.get(String(step.stateId)),to=graph.states.get(String(step.targetStateId)),action=graph.byId.get(step.actionId);
          if(!from||!to||!from.observed||!to.observed||prior!==null&&prior!==String(step.stateId)){valid=false;answer.gaps.push({reason:'path_missing_state_or_disconnected'});break;}
          if(prior===null){seen.add(String(step.stateId));if(from.parentId!=null){valid=false;answer.gaps.push({reason:'path_missing_entry'});}}
          if(seen.has(String(step.targetStateId))){valid=false;answer.gaps.push({reason:'path_cycle'});break;}seen.add(String(step.targetStateId));
          const proof=step.kind==='seed'?graph.seedProof.has(to.id):action?.type==='action'&&String(action.stateId)===String(step.stateId)&&
            graph.proof.has(JSON.stringify([from.id,action.id,'action']))&&graph.proof.has(JSON.stringify([action.id,to.id,'transition']));
          if(!proof){valid=false;answer.gaps.push({reason:'path_not_observed'});break;}prior=String(step.targetStateId);verified.push({...step,observed:true});
        }
        if(flow.steps.length&&prior!==String(state.stateId)){valid=false;answer.gaps.push({reason:'path_target_mismatch'});}
        if(!flow.steps.length&&state.parentId!=null){valid=false;answer.gaps.push({reason:'path_missing_entry'});}
        appendWithin(answer.steps,verified,MAX_STEPS,MAX_RESPONSE_BYTES-bytes(answer)-1024);
        answer.truncated=flow.truncated||answer.steps.length<flow.totalSteps;
        answer.unverifiedSteps=flow.steps.length-verified.length;
        if(answer.steps.length<verified.length)answer.gaps.push({reason:'path_response_limit'});
        answer.complete=flow.complete&&valid&&!flow.invalidSteps&&!answer.truncated&&!graph.validation.incomplete;
        answer.observed=valid&&!flow.invalidSteps&&!answer.truncated;
      }
      return result(answer);
    },
  };
}
