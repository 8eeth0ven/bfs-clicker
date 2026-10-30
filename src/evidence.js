import { appendFileSync, writeFileSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import path from 'node:path';
import { createApiLedger, observeApi, ledgerView, interestingRequest } from './cdpnet.js';
import { extractApiSurface, extractEndpoints, isApiPath } from './urlshape.js';
import { graphqlOperation } from './policy.js';
import { redact } from './redact.js';
import { ensureAppendBoundary } from './store.js';
const boundedBody=(body,limit)=>{
  if(!body||Buffer.byteLength(body)<=limit)return body;
  // Slice bytes, not UTF-16 characters, and omit an incomplete trailing codepoint.
  const bytes=Buffer.from(body);let end=limit;
  while(end>0&&(bytes[end]&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8');
};

const digest=buf=>createHash('sha256').update(buf).digest('hex');
export async function eachJsonLine(file,onRecord,onError=()=>{}) {
  if(!existsSync(file))return;
  const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});let n=0;
  for await(const line of lines){n++;if(!line.trim())continue;try{await onRecord(JSON.parse(line),n)}catch(error){onError(error,n)}}
}
async function streamArray(file,iterable){
  const temp=`${file}.tmp`;const out=createWriteStream(temp,{mode:0o600});out.on('error',()=>{});
  const write=async value=>{if(!out.write(value))await once(out,'drain')};
  await write('[\n');let first=true;
  for await(const row of iterable){await write((first?'':',\n')+JSON.stringify(row));first=false;}
  out.end('\n]\n');await finished(out);const {renameSync}=await import('node:fs');renameSync(temp,file);
}
export function createEvidence(config,store,budget,policy) {
  const ledger=createApiLedger(store.checkpoint?.apis||[]);const endpoints=new Set(store.checkpoint?.endpoints||[]);
  const seeds=new Set(store.checkpoint?.seeds||[]);const mining=new Set();
  const tasks=new Set(),reads=new Set(),bodyItems=new Set();const queue=[];
  let active=0,requestCounter=Number(store.checkpoint?.requestCounter||0);
  const requestIds=new WeakMap(),sources=new WeakMap(),seenFailed=new WeakSet();
  const trafficFile=path.join(store.privateDir,'traffic.jsonl');
  if(ensureAppendBoundary(trafficFile))store.emit('log_tail_separated',{file:'traffic.jsonl',reason:'missing_final_newline'});
  // A timeout finishes the metadata record, not the underlying Playwright read.
  // Keep its physical slot until body() settles; Promise.race must not create
  // unbounded abandoned reads when a server sends a slow or unfinished body.
  const pump=()=>{
    while(active<config.maxBodyConcurrency&&queue.length){
      const item=queue.shift();if(item.done)continue;
      item.started=true;active++;
      const read=Promise.resolve().then(item.fn).then(
        buf=>item.finish({buf,reason:null}),
        error=>{if(!item.done)store.emit('body_error',{message:error.message,url:item.url});item.finish({buf:null,reason:'body_read_failed'});},
      ).finally(()=>{active--;reads.delete(read);pump();});
      reads.add(read);
    }
  };
  const limited=(fn,{url,priority})=>new Promise(resolve=>{
    if(queue.length>=config.maxPendingBodies){
      // Prefer evidence-bearing HTML/JS/API text over queued binary archives.
      // Active reads are never interrupted or released early.
      let victim=-1;
      for(let i=queue.length-1;i>=0;i--)if(queue[i].priority>priority&&(victim<0||queue[i].priority>queue[victim].priority))victim=i;
      if(victim<0){resolve({buf:null,reason:'body_queue_limit'});return;}
      queue[victim].finish({buf:null,reason:'body_queue_preempted'});
    }
    const item={fn,url,priority,started:false,done:false,timer:null,finish(result){
      if(item.done)return;item.done=true;clearTimeout(item.timer);bodyItems.delete(item);
      const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);
      resolve(result);
    }};
    bodyItems.add(item);
    const timeout=Math.min(config.bodyTimeoutMs,Math.max(1,budget.remainingMs));
    item.timer=setTimeout(()=>item.finish({buf:null,reason:item.started?'body_timeout':'body_queue_timeout'}),timeout);
    const index=queue.findIndex(other=>other.priority>priority);
    if(index<0)queue.push(item);else queue.splice(index,0,item);
    pump();
  });
  const track=promise=>{tasks.add(promise);promise.finally(()=>tasks.delete(promise)).catch(()=>{})};
  const sourceFor=req=>{
    const runtime=config._runtime||{};
    const context={kind:'page',control:runtime.currentControl||'',actionId:runtime.currentActionId||null,stateId:runtime.currentStateId??null,executionId:runtime.currentExecutionId||null};
    try{return {...context,page:req.frame().page().url()}}catch{return {...context,page:''}}
  };
  const mine=(url,text,ct,sourceId)=>{
    const key=`${url}:${digest(text)}`;if(mining.has(key))return;mining.add(key);
    const surface=extractApiSurface(text,url);
    for(const raw of surface.all){
      let candidate;try{candidate=new URL(raw,url).href}catch{continue}
      endpoints.add(candidate);const evidenceId=store.emit('static_candidate',{url:candidate,method:'unknown',document:url,sourceId});
      observeApi(ledger,{method:'unknown',url:candidate,source:{kind:'document',document:url},evidenceId,category:'static_candidate',maxSamples:config.maxApiSamples});
      if(config.discoverySeeds && !isApiPath(candidate) && policy.navigation(candidate).allow && seeds.size<config.discoverySeedCap)seeds.add(candidate);
    }
    if(config.jsEndpointHarvest && /javascript|ecmascript/i.test(ct))for(const raw of extractEndpoints(text)){
      try{const candidate=new URL(raw,url).href;if(!endpoints.has(candidate)){endpoints.add(candidate);store.emit('endpoint_discovered',{url:candidate,document:url,sourceId});}}catch{}
    }
  };
  const onRequest=req=>{
    const originalBody=req.postData();const postData=boundedBody(originalBody,config.maxRequestBodyBytes);
    const info={url:req.url(),method:req.method(),type:req.resourceType(),navigation:req.isNavigationRequest(),postData,contentType:req.headers()['content-type']||'',requestBodyTruncated:postData!==originalBody,
      redirectedFrom:req.redirectedFrom?.()?.url()||null};
    if(info.requestBodyTruncated)store.emit('coverage_gap',{reason:'request_body_limit',url:info.url});
    const source=sourceFor(req);const evidenceId=store.emit('request',{requestId:++requestCounter,...info,source});requestIds.set(req,evidenceId);sources.set(req,source);
    if(interestingRequest(info.method,info.url,info.type))observeApi(ledger,{...info,evidenceId,source,authEpoch:store.meta.authEpoch,category:'attempted_request',maxSamples:config.maxApiSamples,operation:/graphql|gql/.test(info.url)?graphqlOperation(info.postData):null});
  };
  const onResponse=async resp=>{
    const req=resp.request();const url=req.url(),headers=await resp.allHeaders(),status=resp.status();
    // The Fetch response guard applies Retry-After before the page receives it.
    const contentType=headers['content-type']||'';const cl=/^\d+$/.test(headers['content-length']||'')?Number(headers['content-length']):null;
    const evidenceId=store.emit('response',{requestEvidenceId:requestIds.get(req)||null,url,status,contentType,method:req.method(),type:req.resourceType(),source:sources.get(req)||sourceFor(req)});
    const readLimit=config.trafficHarvestMaxBytes;
    // Playwright buffers response.body(). Unknown or oversized length is deliberately
    // metadata-only, so chunked downloads cannot defeat the memory budget.
    const type=req.resourceType().toLowerCase();
    const text=isText(contentType),binaryResource=['image','font','media'].includes(type)||!text;
    const mineable=!binaryResource&&text&&/html|javascript|ecmascript|json|graphql/i.test(contentType);
    const priority=binaryResource?2:mineable||text&&['fetch','xhr','document','script'].includes(type)?0:1;
    let buf=null,bodyReason=null;
    if(binaryResource&&!config.captureBinaryBodies)bodyReason='binary_body_not_captured';
    else if(!mineable&&!config.captureTraffic)bodyReason='capture_disabled';
    else if(cl==null)bodyReason='unknown_length_not_buffered';
    else if(cl>readLimit)bodyReason='body_limit';
    else if(cl===0)buf=Buffer.alloc(0);
    else {const result=await limited(()=>resp.body(),{url,priority});buf=result.buf;bodyReason=result.reason;}
    if(buf && buf.length>readLimit){bodyReason='decoded_body_limit';buf=null;}
    const source=sources.get(req)||sourceFor(req);const responseDigest=buf?digest(buf):null;
    const reqHeaders=await req.allHeaders().catch(()=>req.headers());const postData=boundedBody(req.postData(),config.maxRequestBodyBytes);
    const entry={evidenceId,requestEvidenceId:requestIds.get(req)||null,ts:Date.now(),session_id:store.meta.runId,authEpoch:store.meta.authEpoch,
      method:req.method(),url,status,contentType,resourceType:type,respBytes:buf?.length??cl??0,reqHeaders,postData,respHeaders:headers,source,responseDigest,
      body:buf && buf.length<=config.trafficMaxBodyBytes?(text?buf.toString('utf8'):buf.toString('base64')):undefined,
      bodyEncoding:text?'utf8':'base64',bodyOmitted:!buf||buf.length>config.trafficMaxBodyBytes,bodyReason:bodyReason||(!buf?'unavailable':buf.length>config.trafficMaxBodyBytes?'storage_body_limit':null)};
    store.emit('response_body',{requestEvidenceId:entry.requestEvidenceId,responseEvidenceId:evidenceId,url,responseDigest,respBytes:entry.respBytes,bodyOmitted:entry.bodyOmitted,bodyReason:entry.bodyReason});
    if(config.captureTraffic)appendFileSync(trafficFile,JSON.stringify(entry)+'\n',{mode:0o600});
    if(interestingRequest(entry.method,url,req.resourceType()))observeApi(ledger,{...entry,source,category:'observed_request',maxSamples:config.maxApiSamples,operation:/graphql|gql/.test(url)?graphqlOperation(postData):null});
    if(buf && mineable)mine(url,buf.toString('utf8'),contentType,evidenceId);
    if(bodyReason)store.emit('coverage_gap',{reason:bodyReason,url,evidenceId});
  };
  const onFailed=req=>{
    if(seenFailed.has(req))return;seenFailed.add(req);
    const evidenceId=store.emit('request_failed',{requestEvidenceId:requestIds.get(req)||null,url:req.url(),method:req.method(),type:req.resourceType(),source:sources.get(req)||sourceFor(req),error:req.failure()?.errorText||'failed'});
    const category=/BLOCKED_BY_CLIENT|aborted/i.test(req.failure()?.errorText||'')?'blocked_request':'failed_request';
    if(interestingRequest(req.method(),req.url(),req.resourceType()))observeApi(ledger,{method:req.method(),url:req.url(),evidenceId,category,source:sources.get(req)||sourceFor(req),status:0,maxSamples:config.maxApiSamples});
    if(config.captureTraffic)appendFileSync(trafficFile,JSON.stringify({evidenceId,requestEvidenceId:requestIds.get(req)||null,ts:Date.now(),session_id:store.meta.runId,authEpoch:store.meta.authEpoch,method:req.method(),url:req.url(),resourceType:req.resourceType(),source:sources.get(req)||sourceFor(req),status:0,respBytes:0,reqHeaders:req.headers(),postData:boundedBody(req.postData(),config.maxRequestBodyBytes),respHeaders:{},failed:req.failure()?.errorText,bodyOmitted:true})+'\n',{mode:0o600});
  };
  const restore=async()=>{
    const eventsFile=path.join(store.privateDir,'events.jsonl');
    const stats={events:0,traffic:0,malformedEvents:0,malformedTraffic:0,missingRequestRecords:0};
    if(!existsSync(eventsFile)&&!existsSync(trafficFile)){
      store.emit('coverage_gap',{reason:'evidence_recovery_logs_missing'});store.emit('evidence_restored',{...stats,fromCheckpoint:true});return stats;
    }
    // Rebuild from complete append logs, never from a response-id cutoff: body
    // records can arrive after a checkpoint containing their response event.
    ledger.records.clear();
    const pendingRequests=new Map(),counts=new Map();
    const countFor=rec=>{const key=`${rec.method} ${rec.url}`;if(!counts.has(key))counts.set(key,{events:{},traffic:{}});return counts.get(key);};
    const observe=info=>{
      const rec=observeApi(ledger,{...info,maxSamples:config.maxApiSamples});
      if(rec){const n=countFor(rec);n.events[info.category]=(n.events[info.category]||0)+1;}return rec;
    };
    const finishResponse=(request,response,body={})=>{
      observe({...request,...body,url:response.url||request.url,method:request.method||response.method||'GET',type:request.type||response.type,
        contentType:request.contentType||response.contentType,source:request.source||response.source,
        evidenceId:response.evidenceId,status:response.status,responseDigest:body.responseDigest||null,
        authEpoch:response.authEpoch??request.authEpoch??0,category:'observed_request',
        operation:/graphql|gql/.test(response.url||request.url||'')?graphqlOperation(request.postData):null});
    };
    await eachJsonLine(eventsFile,row=>{
      stats.events++;
      if(row.kind==='request'){
        requestCounter=Math.max(requestCounter,Number(row.requestId)||0);
        pendingRequests.set(row.evidenceId,{...row});
        observe({...row,category:'attempted_request',operation:/graphql|gql/.test(row.url||'')?graphqlOperation(row.postData):null});
      }else if(row.kind==='response'){
        const key=row.requestEvidenceId||row.evidenceId;
        const request=pendingRequests.get(key)||{url:row.url,method:row.method||'GET',type:row.type,source:row.source};
        if(!pendingRequests.has(key))stats.missingRequestRecords++;
        request.response=row;pendingRequests.set(key,request);
      }else if(row.kind==='response_body'){
        const key=row.requestEvidenceId||row.responseEvidenceId;const request=pendingRequests.get(key);
        if(request?.response){finishResponse(request,request.response,row);pendingRequests.delete(key);}
      }else if(row.kind==='request_failed'){
        const request=pendingRequests.get(row.requestEvidenceId)||{};
        const category=/BLOCKED_BY_CLIENT|aborted/i.test(row.error||'')?'blocked_request':'failed_request';
        observe({...request,...row,evidenceId:row.evidenceId,source:request.source,category,status:0});pendingRequests.delete(row.requestEvidenceId);
      }else if(row.kind==='static_candidate'){
        endpoints.add(row.url);observe({method:row.method||'unknown',url:row.url,source:{kind:'document',document:row.document},evidenceId:row.evidenceId,category:'static_candidate'});
        if(config.discoverySeeds&&!isApiPath(row.url)&&policy.navigation(row.url).allow&&seeds.size<config.discoverySeedCap)seeds.add(row.url);
      }else if(row.kind==='endpoint_discovered')endpoints.add(row.url);
    },()=>{stats.malformedEvents++;});
    // A crash between response and response_body still leaves a real observed
    // HTTP response. Its missing body remains honestly metadata-only.
    for(const request of pendingRequests.values())if(request.response)finishResponse(request,request.response);
    pendingRequests.clear();
    await eachJsonLine(trafficFile,row=>{
      stats.traffic++;
      const category=row.failed?(/BLOCKED_BY_CLIENT|aborted/i.test(row.failed)?'blocked_request':'failed_request'):'observed_request';
      const key=`${row.method||'GET'} ${canonicalUrl(row.url)}`;const previous=ledger.records.get(key);
      const previousSamples=previous?[...previous.samples]:[];
      const duplicate=previousSamples.find(sample=>sample.evidenceId===row.evidenceId);
      const resourceType=row.resourceType||row.type||legacyResourceType(row.contentType);
      const rec=observeApi(ledger,{...row,type:resourceType,contentType:row.reqHeaders?.['content-type']||row.contentType,source:row.source,category,maxSamples:config.maxApiSamples,
        operation:/graphql|gql/.test(row.url||'')?graphqlOperation(row.postData):null});
      if(!rec)return;
      const n=countFor(rec);n.traffic[category]=(n.traffic[category]||0)+1;
      if(duplicate){
        rec.samples=previousSamples;
        Object.assign(duplicate,{responseDigest:row.responseDigest??duplicate.responseDigest,status:row.status??duplicate.status,
          postData:row.postData??duplicate.postData,authEpoch:row.authEpoch??duplicate.authEpoch,actionId:row.source?.actionId??duplicate.actionId,
          stateId:row.source?.stateId??duplicate.stateId,executionId:row.source?.executionId??duplicate.executionId});
      }
    },()=>{stats.malformedTraffic++;});
    // Traffic repeats the same terminal evidence; it enriches rather than counts
    // it twice. Only counters per endpoint are retained, not an all-log ID set.
    for(const [key,rec] of ledger.records){
      const n=counts.get(key);if(!n)continue;
      const categories=new Set([...Object.keys(n.events),...Object.keys(n.traffic)]);
      const total=[...categories].reduce((sum,category)=>sum+Math.max(n.events[category]||0,n.traffic[category]||0),0);
      rec.samplesTruncated=Math.max(0,total-rec.samples.length);
    }
    if(stats.malformedEvents||stats.malformedTraffic)store.emit('coverage_gap',{reason:'evidence_recovery_malformed_lines',...stats});
    store.emit('evidence_restored',{...stats,apis:ledger.size,endpoints:endpoints.size,seeds:seeds.size});
    return stats;
  };
  return {ledger,endpoints,seeds,mine,get requestCounter(){return requestCounter},
    restore,
    attach(context){context.on('request',onRequest);context.on('response',resp=>track(onResponse(resp).catch(e=>store.emit('evidence_error',{message:e.message,url:resp.url()}))));context.on('requestfailed',onFailed);},
    async drain(){
      const deadline=Date.now()+config.drainTimeoutMs;
      while((tasks.size||reads.size)&&Date.now()<deadline){
        let timer;
        try{await Promise.race([Promise.allSettled([...tasks,...reads]),new Promise(r=>{timer=setTimeout(r,Math.min(50,Math.max(1,deadline-Date.now())))})]);}
        finally{clearTimeout(timer);}
      }
      if(tasks.size||reads.size){
        // Finalization remains bounded even if body() never settles. Preserve
        // metadata for queued/in-flight records and keep tracking physical reads
        // so the post-browser-close drain can see their eventual cancellation.
        for(const item of [...bodyItems])item.finish({buf:null,reason:'body_drain_timeout'});
        await Promise.resolve();await Promise.resolve();
        store.emit('coverage_gap',{reason:'evidence_drain_timeout',pending:tasks.size,pendingBodyReads:reads.size});
      }
    },
    get bodyStats(){return {activeReads:active,queued:queue.length,pendingRecords:bodyItems.size};},
    snapshot(){return {apis:ledgerView(ledger),endpoints:[...endpoints],seeds:[...seeds],requestCounter}},
    async export(){
      const view=ledgerView(ledger);writeFileSync(path.join(store.privateDir,'apis.json'),JSON.stringify(view,null,2),{mode:0o600});
      writeFileSync(path.join(store.dir,'apis.json'),JSON.stringify(redact(view),null,2));
      writeFileSync(path.join(store.dir,'api_routes.txt'),view.map(row=>row.method+' '+redact(row.url)+'\n'+row.sources.map(s=>'source\t'+s.kind+'\t'+redact(s.page||s.document)+'\t'+redact(s.control||'')).join('\n')+'\n').join(''));
      writeFileSync(path.join(store.dir,'js_endpoints.txt'),[...endpoints].sort().map(u=>redact(u)).join('\n')+'\n');
      async function* requests(){
        if(!existsSync(trafficFile))return;
        const lines=createInterface({input:createReadStream(trafficFile),crlfDelay:Infinity});
        for await(const line of lines){if(!line.trim())continue;let row;try{row=JSON.parse(line)}catch{store.emit('export_error',{file:'traffic.jsonl',reason:'malformed_line'});continue}
          yield redact({...row,body:undefined,reqHeaders:undefined,respHeaders:undefined});}
      }
      await streamArray(path.join(store.dir,'requests.json'),requests());
      const out=path.join(store.dir,'events.jsonl');const stream=createWriteStream(out);stream.on('error',()=>{});
      const errors=[];
      await eachJsonLine(path.join(store.privateDir,'events.jsonl'),async row=>{if(!stream.write(JSON.stringify(redact(row))+'\n'))await once(stream,'drain')},(e,n)=>errors.push({file:'events.jsonl',line:n,message:e.message}));
      for(const error of errors){const evidenceId=store.emit('export_error',error);stream.write(JSON.stringify({kind:'export_error',...error,evidenceId})+'\n');}
      stream.end();await finished(stream);
    },trafficFile,
  };
}
function isText(ct){return /text\/|json|javascript|ecmascript|xml|graphql|x-www-form-urlencoded/i.test(ct)}
function canonicalUrl(value){try{const url=new URL(value);url.hash='';return url.href;}catch{return String(value||'').split('#')[0];}}
function legacyResourceType(ct=''){if(/^image\//i.test(ct))return 'image';if(/^(audio|video)\//i.test(ct))return 'media';if(/font|woff/i.test(ct))return 'font';if(/^text\/css/i.test(ct))return 'stylesheet';return '';}
