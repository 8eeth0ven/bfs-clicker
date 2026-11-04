// Fixture-owner readonly sampling. A compatible caret only permits another READ.
// Success always requires the unchanged, complete approvedKeyboardEnvelope guard.
import {constants,openSync,closeSync,fstatSync,writeFileSync,readFileSync,lstatSync,statfsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {approvedKeyboardEnvelope} from './ios-keyboard-envelope.mjs';
import {decodeBoundedPngSnapshot,visualCaretEquivalent,validateCaretPolicy} from '../src/visual-caret.js';

export const CALIBRATION_SAMPLING=Object.freeze({maxCandidates:6,totalMs:12000,requestMs:1500,intervalMs:125,
  sourceBytes:2*1024**2,pngBytes:16*1024**2,outputBytes:128*1024**2,reserveBytes:10*1024**3});
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const clone=x=>JSON.parse(JSON.stringify(x));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function ordinaryFile(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))fail('CALIBRATION_SAMPLING_PATH_INVALID');
 let cursor=path.parse(file).root;
 for(const part of path.resolve(file).slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,part);if(lstatSync(cursor).isSymbolicLink())fail('CALIBRATION_SAMPLING_PATH_INVALID');
 }
}
function exactRect(value){return value&&Object.keys(value).sort().join(',')==='height,width,x,y'
 &&Object.values(value).every(Number.isFinite)&&value.x===0&&value.y===0
 &&Number.isSafeInteger(value.width)&&value.width>0&&Number.isSafeInteger(value.height)&&value.height>0;}

export async function sampleOwnerKeyboardCalibration({beforePath,output,appId,geometry,orientation,approval,
 valueRegion,resultRegion,caretPolicy,read,inspectSource,signal,
 clock={now:()=>performance.now(),sleep:(ms,options)=>sleep(ms,undefined,options)}}){
 const limits=CALIBRATION_SAMPLING,start=clock.now(),deadline=start+limits.totalMs;
 if(!exactRect(geometry)||!['PORTRAIT','LANDSCAPE'].includes(orientation)
  ||typeof appId!=='string'||approval?.appId!==appId||typeof read!=='function'||typeof inspectSource!=='function')fail('CALIBRATION_SAMPLING_CONFIG_INVALID');
 // No underlay or caller-added fields are admitted for calibration observation.
 validateCaretPolicy(caretPolicy);if(Object.keys(caretPolicy).length!==8)fail('CALIBRATION_SAMPLING_CONFIG_INVALID');
 const fixed=clone({appId,geometry,orientation,approval,valueRegion,resultRegion,caretPolicy});
 ordinaryFile(beforePath);ordinaryFile(output);
 if(!lstatSync(output).isDirectory())fail('CALIBRATION_SAMPLING_PATH_INVALID');
 const before=decodeBoundedPngSnapshot(beforePath),referenceSha=before.imageSha256;
 let bytesWritten=0,firstSource=null,firstContract=null,receiptError=null,primaryError=null;
 const receipt={schemaVersion:1,status:'sampling',maxCandidates:limits.maxCandidates,totalDeadlineMs:limits.totalMs,
  perRequestLimitMs:limits.requestMs,intervalMs:limits.intervalMs,candidates:[],readonlyRequests:[],uiActions:0,acceptedCandidate:null,
  scope:'readonly fixture calibration; caret compatibility is not calibration or OS ownership'};
 function check(){
  if(signal?.aborted)fail('CALIBRATION_SAMPLING_CANCELLED');
  if(clock.now()>=deadline)fail('CALIBRATION_SAMPLING_DEADLINE');
 }
 function floor(){const fs=statfsSync(output,{bigint:true});
  if(fs.bavail*fs.bsize-BigInt(limits.outputBytes-bytesWritten)<BigInt(limits.reserveBytes))fail('CALIBRATION_SAMPLING_STORAGE');}
 function persist(name,data){
  if(!Buffer.isBuffer(data))data=Buffer.from(data);
  if(bytesWritten+data.length>limits.outputBytes)fail('CALIBRATION_SAMPLING_OUTPUT_LIMIT');
  const target=path.join(output,name);let fd;
  try{fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   writeFileSync(fd,data);if((fstatSync(fd).mode&0o777)!==0o600)fail('CALIBRATION_SAMPLING_PRIVATE_MODE');
  }finally{if(fd!==undefined)closeSync(fd);}
  bytesWritten+=data.length;return target;
 }
 async function bounded(label,fn){
  check();const began=clock.now(),timeoutMs=Math.max(1,Math.min(limits.requestMs,Math.floor(deadline-began)));
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(Object.assign(Error('CALIBRATION_SAMPLING_REQUEST_TIMEOUT'),{code:'CALIBRATION_SAMPLING_REQUEST_TIMEOUT'})),timeoutMs);
  try{
   // Integrated transport/parser obey this abort and timeout and reap their own
   // work. Await their terminal response; never abandon a request and retry it.
   const result=await fn({timeoutMs,signal:controller.signal});check();
   if(controller.signal.aborted||clock.now()-began>=timeoutMs)fail('CALIBRATION_SAMPLING_REQUEST_TIMEOUT');
   return result;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async function observed(kind){return bounded(kind,async options=>{
  const row={kind,timeoutMs:options.timeoutMs,startedMs:clock.now()-start};receipt.readonlyRequests.push(row);
  try{const result=await read(kind,options);row.status='returned';return result;}
  catch(error){row.status='failed';throw error;}finally{row.finishedMs=clock.now()-start;}
 });}
 async function identity(){
  const app=await observed('app');if(app?.bundleId!==fixed.appId)fail('CALIBRATION_APP_CHANGED');
  const rect=await observed('window');if(!exactRect(rect)||Object.keys(fixed.geometry).some(k=>rect[k]!==fixed.geometry[k]))fail('CALIBRATION_WINDOW_CHANGED');
  if(await observed('orientation')!==fixed.orientation)fail('CALIBRATION_ORIENTATION_CHANGED');check();
 }
 async function source(name){
  const raw=await observed('source');if(typeof raw!=='string'||Buffer.byteLength(raw)>limits.sourceBytes
   ||Buffer.from(raw).toString('utf8')!==raw)fail('CALIBRATION_SOURCE_INVALID');
  const data=Buffer.from(raw),file=persist(name,data),digest=sha(data);
  const parsed=await bounded('inspect_source',options=>inspectSource(file,options));
  if(parsed?.sourceSha256!==digest||parsed?.appId!==fixed.appId||!parsed?.proposal||!Number.isSafeInteger(parsed.proposal.keyCount)
   ||parsed.proposal.keyCount<1||parsed.authorization!==false)fail('CALIBRATION_SOURCE_INVALID');
  if(firstSource===null){firstSource=digest;firstContract=clone(parsed);}
  else if(digest!==firstSource||!same(parsed,firstContract))fail('CALIBRATION_SOURCE_CHANGED');
  check();return {file,digest,proposal:parsed.proposal};
 }
 floor();check();
 try{
  for(let index=0;index<limits.maxCandidates;index++){
   if(index){const wakeAt=clock.now()+limits.intervalMs;
    await bounded('readonly_interval',async({signal:stop})=>{
     do{check();await clock.sleep(Math.max(1,Math.ceil(wakeAt-clock.now())),{signal:stop});check();}while(clock.now()<wakeAt);
    });check();
   }
   floor();check();const row={index:index+1,status:'observing',startedMs:clock.now()-start};receipt.candidates.push(row);
   const prefix='calibration-candidate-'+String(index+1).padStart(2,'0');
   await identity();const a=await source(prefix+'-source-before.xml');
   const encoded=await observed('screenshot');
   if(typeof encoded!=='string'||encoded.length>Math.ceil(limits.pngBytes/3)*4)fail('CALIBRATION_PNG_LIMIT');
   const png=Buffer.from(encoded,'base64');if(!png.length||png.length>limits.pngBytes||png.toString('base64')!==encoded)fail('CALIBRATION_PNG_INVALID');
   const pngPath=persist(prefix+'.png',png);row.pngSha256=sha(png);row.pngPath=pngPath;
   const decoded=decodeBoundedPngSnapshot(pngPath);check();
   if(decoded.width!==before.width||decoded.height!==before.height)fail('CALIBRATION_DIMENSIONS_CHANGED');
   const b=await source(prefix+'-source-after.xml');await identity();check();
   row.sourceBeforePath=a.file;row.sourceAfterPath=b.file;row.sourceSha256=a.digest;
   const pins=()=>{for(const file of [beforePath,pngPath,a.file,b.file])ordinaryFile(file);
    if(sha(readFileSync(beforePath))!==referenceSha||sha(readFileSync(pngPath))!==row.pngSha256
     ||sha(readFileSync(a.file))!==a.digest||sha(readFileSync(b.file))!==b.digest)fail('CALIBRATION_ORIGINAL_CHANGED');};
   pins();
   const options={valueRegion:fixed.valueRegion,resultRegion:fixed.resultRegion,sourceRegion:a.proposal.region,
    geometry:fixed.geometry,approval:fixed.approval,visibleSourcePath:a.file};
   let envelope;
   try{envelope=approvedKeyboardEnvelope(beforePath,pngPath,options);}
   catch(error){
    if(error.message!=='CALIBRATION_UNRELATED_PIXELS_CHANGED')throw error;
    // Only the approved shell is masked. Result/value ROIs are never masks.
    const shell=fixed.approval.visualEnvelope,region={x:shell.x/fixed.geometry.width,y:shell.y/fixed.geometry.height,
     width:shell.width/fixed.geometry.width,height:shell.height/fixed.geometry.height};
    const compatible=visualCaretEquivalent(beforePath,pngPath,{masks:[region],valueRegion:fixed.valueRegion,
     geometry:[fixed.geometry.width,fixed.geometry.height],policy:fixed.caretPolicy});check();
    if(!compatible.equivalent||compatible.mode!=='caret'||compatible.changedPixels<1)throw error;
    row.status='strict_envelope_rejected_caret_compatible_readonly_resample';row.changedPixels=compatible.changedPixels;
    row.finishedMs=clock.now()-start;
    pins();
    if(index===limits.maxCandidates-1)fail('CALIBRATION_SAMPLING_EXHAUSTED');continue;
   }
   check();floor();
   pins();
   row.status='original_full_envelope_passed';row.finishedMs=clock.now()-start;
   receipt.status='passed';receipt.acceptedCandidate=index+1;
   return {envelope,measured:a.proposal,pngPath,visibleSourcePath:a.file,pngSha256:row.pngSha256,sampling:receipt};
  }
  fail('CALIBRATION_SAMPLING_EXHAUSTED');
 }catch(error){primaryError=error;receipt.status='failed';receipt.errorCode=/^[A-Z][A-Z0-9_]+$/.test(error.code||error.message)?error.code||error.message:'CALIBRATION_SAMPLING_FAILED';throw error;}
 finally{
  receipt.elapsedMs=clock.now()-start;receipt.bytesWritten=bytesWritten;
  // Immutable evidence records comparison completion, not a future return after
  // local IO. Recheck the total completion deadline after the receipt write.
  const recorded=receipt.status==='passed'?{...receipt,status:'full_guard_passed_pending_final_deadline'}:receipt;
  try{persist('calibration-sampling.json',Buffer.from(JSON.stringify(recorded,null,2)+'\n'));if(receipt.status==='passed')check();}
  catch(error){receiptError=error;}
  // Receipt failure cannot turn a completed comparison into accepted evidence.
  if(receiptError&&!primaryError)throw receiptError;
 }
}
