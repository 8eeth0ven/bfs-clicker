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
  const tasks=new Set();const queue=[];let active=0,requestCounter=Number(store.checkpoint?.requestCounter||0);
  const requestIds=new WeakMap(),sources=new WeakMap(),seenFailed=new WeakSet();
  const trafficFile=path.join(store.privateDir,'traffic.jsonl');
  if(ensureAppendBoundary(trafficFile))store.emit('log_tail_separated',{file:'traffic.jsonl',reason:'missing_final_newline'});
  const limited=(fn)=>new Promise(resolve=>{
    if(queue.length>=config.maxPendingBodies){store.emit('coverage_gap',{reason:'body_queue_limit'});resolve(null);return;}
    queue.push({fn,resolve});pump();
  });
  const pump=()=>{while(active<config.maxBodyConcurrency&&queue.length){const item=queue.shift();active++;Promise.resolve().then(item.fn).then(item.resolve,error=>{store.emit('body_error',{message:error.message});item.resolve(null)}).finally(()=>{active--;pump()})}};
  const track=promise=>{tasks.add(promise);promise.finally(()=>tasks.delete(promise)).catch(()=>{})};
  const sourceFor=req=>{try{const page=req.frame().page();return {kind:'page',page:page.url(),control:config._runtime?.currentControl||'',actionId:config._runtime?.currentActionId||null}}catch{return {kind:'page',page:'',control:''}}};
  const mine=(url,text,ct,sourceId)=>{
    const key=`${url}:${digest(text)}`;if(mining.has(key))return;mining.add(key);
    const surface=extractApiSurface(text,url);
    for(const raw of surface.all){
      let candidate;try{candidate=new URL(raw,url).href}catch{continue}
      endpoints.add(candidate);const evidenceId=store.emit('static_candidate',{url:candidate,method:'unknown',document:url,sourceId});
      observeApi(ledger,{method:'unknown',url:candidate,source:{kind:'document',document:url},evidenceId,category:'static_candidate',maxSamples:config.maxApiSamples});
      if(config.discoverySeeds && !isApiPath(candidate) && policy.navigation(candidate).allow && seeds.size<config.discoverySeedCap)seeds.add(candidate);
    }
    if(config.jsEndpointHarvest && /javascript|ecmascript/i.test(ct))for(const raw of extractEndpoints(text)){try{endpoints.add(new URL(raw,url).href)}catch{}}
  };
  const onRequest=req=>{
    const originalBody=req.postData();const postData=boundedBody(originalBody,config.maxRequestBodyBytes);
    const info={url:req.url(),method:req.method(),type:req.resourceType(),navigation:req.isNavigationRequest(),postData,requestBodyTruncated:postData!==originalBody};
    if(info.requestBodyTruncated)store.emit('coverage_gap',{reason:'request_body_limit',url:info.url});
    const source=sourceFor(req);const evidenceId=store.emit('request',{requestId:++requestCounter,...info,source});requestIds.set(req,evidenceId);sources.set(req,source);
    if(interestingRequest(info.method,info.url,info.type))observeApi(ledger,{...info,evidenceId,source,authEpoch:store.meta.authEpoch,category:'attempted_request',maxSamples:config.maxApiSamples,operation:/graphql|gql/.test(info.url)?graphqlOperation(info.postData):null});
  };
  const onResponse=async resp=>{
    const req=resp.request();const url=req.url(),headers=await resp.allHeaders(),status=resp.status();
    // The Fetch response guard applies Retry-After before the page receives it.
    const contentType=headers['content-type']||'';const cl=/^\d+$/.test(headers['content-length']||'')?Number(headers['content-length']):null;
    const evidenceId=store.emit('response',{requestEvidenceId:requestIds.get(req)||null,url,status,contentType});
    const readLimit=config.trafficHarvestMaxBytes;
    // Playwright buffers response.body(). Unknown or oversized length is deliberately
    // metadata-only, so chunked downloads cannot defeat the memory budget.
    let buf=null,bodyReason=null;
    if(cl==null)bodyReason='unknown_length_not_buffered';
    else if(cl>readLimit)bodyReason='body_limit';
    else if(cl===0)buf=Buffer.alloc(0);
    else buf=await limited(async()=>{
      const timeout=Math.min(config.bodyTimeoutMs,Math.max(1,budget.remainingMs));
      let timer;
      try{return await Promise.race([resp.body(),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeout)})])}catch{return null}finally{clearTimeout(timer)}
    });
    if(buf && buf.length>readLimit){bodyReason='decoded_body_limit';buf=null;}
    const source=sources.get(req)||sourceFor(req);const responseDigest=buf?digest(buf):null;
    const reqHeaders=await req.allHeaders().catch(()=>req.headers());const postData=boundedBody(req.postData(),config.maxRequestBodyBytes);
    const entry={evidenceId,requestEvidenceId:requestIds.get(req)||null,ts:Date.now(),session_id:store.meta.runId,authEpoch:store.meta.authEpoch,
      method:req.method(),url,status,contentType,respBytes:buf?.length??cl??0,reqHeaders,postData,respHeaders:headers,source,responseDigest,
      body:buf && buf.length<=config.trafficMaxBodyBytes?(isText(contentType)?buf.toString('utf8'):buf.toString('base64')):undefined,
      bodyEncoding:isText(contentType)?'utf8':'base64',bodyOmitted:!buf||buf.length>config.trafficMaxBodyBytes,bodyReason:bodyReason||(!buf?'unavailable':buf.length>config.trafficMaxBodyBytes?'storage_body_limit':null)};
    store.emit('response_body',{requestEvidenceId:entry.requestEvidenceId,responseEvidenceId:evidenceId,url,responseDigest,respBytes:entry.respBytes,bodyOmitted:entry.bodyOmitted,bodyReason:entry.bodyReason});
    if(config.captureTraffic)appendFileSync(trafficFile,JSON.stringify(entry)+'\n',{mode:0o600});
    if(interestingRequest(entry.method,url,req.resourceType()))observeApi(ledger,{...entry,source,category:'observed_request',maxSamples:config.maxApiSamples,operation:/graphql|gql/.test(url)?graphqlOperation(postData):null});
    if(buf && isText(contentType) && /html|javascript|ecmascript|json|graphql/.test(contentType))mine(url,buf.toString('utf8'),contentType,evidenceId);
    if(bodyReason)store.emit('coverage_gap',{reason:bodyReason,url,evidenceId});
  };
  const onFailed=req=>{
    if(seenFailed.has(req))return;seenFailed.add(req);
    const evidenceId=store.emit('request_failed',{requestEvidenceId:requestIds.get(req)||null,url:req.url(),method:req.method(),error:req.failure()?.errorText||'failed'});
    const category=/BLOCKED_BY_CLIENT|aborted/i.test(req.failure()?.errorText||'')?'blocked_request':'failed_request';
    if(interestingRequest(req.method(),req.url(),req.resourceType()))observeApi(ledger,{method:req.method(),url:req.url(),evidenceId,category,source:sources.get(req)||sourceFor(req),status:0,maxSamples:config.maxApiSamples});
    if(config.captureTraffic)appendFileSync(trafficFile,JSON.stringify({evidenceId,requestEvidenceId:requestIds.get(req)||null,ts:Date.now(),session_id:store.meta.runId,authEpoch:store.meta.authEpoch,method:req.method(),url:req.url(),status:0,respBytes:0,reqHeaders:req.headers(),postData:boundedBody(req.postData(),config.maxRequestBodyBytes),respHeaders:{},failed:req.failure()?.errorText,bodyOmitted:true})+'\n',{mode:0o600});
  };
  return {ledger,endpoints,seeds,mine,get requestCounter(){return requestCounter},
    attach(context){context.on('request',onRequest);context.on('response',resp=>track(onResponse(resp).catch(e=>store.emit('evidence_error',{message:e.message,url:resp.url()}))));context.on('requestfailed',onFailed);},
    async drain(){const start=Date.now();while(tasks.size&&Date.now()-start<config.drainTimeoutMs){await Promise.race([Promise.allSettled([...tasks]),new Promise(r=>setTimeout(r,50))])}if(tasks.size)store.emit('coverage_gap',{reason:'evidence_drain_timeout',pending:tasks.size});},
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
function isText(ct){return /text\/|json|javascript|ecmascript|xml|graphql|x-www-form-urlencoded/.test(ct)}
