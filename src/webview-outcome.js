import {constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {atomicJson} from './store.js';

const SCOPE_FILE='webview-outcome-scope.json';
const STATUSES=new Set(['not_started','observed','unknown']);
const WARNINGS=new Set(['matching_completion_receipt_published_before_storage_error','result_persistence_failed_after_observed_scope']);
const OUTCOME_KEYS=new Set(['status','automaticRetry','storageWarning','completionReceipt']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const owned=info=>typeof process.getuid!=='function'||info.uid===process.getuid();
const scopeError=()=>Object.assign(new Error('WEBVIEW_OUTCOME_SCOPE_INVALID'),{code:'WEBVIEW_OUTCOME_SCOPE_INVALID'});

// completionReceipt is a private producer field. It is never interpreted or
// copied into this diagnostic projection; schema2 remains Python's contract.
export function publicWebviewOutcome(value){
 if(!plain(value))return undefined;
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 if(keys.some(key=>typeof key!=='string'||!OUTCOME_KEYS.has(key)||!Object.hasOwn(descriptors[key],'value')))return undefined;
 if(!STATUSES.has(descriptors.status?.value)||descriptors.automaticRetry?.value!==false)return undefined;
 const warning=descriptors.storageWarning?.value;
 if(Object.hasOwn(descriptors,'storageWarning')&&!WARNINGS.has(warning))return undefined;
 return {status:descriptors.status.value,automaticRetry:false,...(warning===undefined?{}:{storageWarning:warning})};
}

export function mergeWebviewOutcomes(...values){
 const outcomes=values.map(publicWebviewOutcome).filter(Boolean);
 for(const status of ['unknown','observed','not_started']){
  const matches=outcomes.filter(value=>value.status===status);
  if(matches.length){const warning=matches.find(value=>value.storageWarning)?.storageWarning;return {status,automaticRetry:false,...(warning?{storageWarning:warning}:{})};}
 }
 return undefined;
}

function rootDirectory(directory){
 try{const info=lstatSync(directory);if(info.isSymbolicLink()||!info.isDirectory()||!owned(info)||info.mode&0o022)return null;return realpathSync(directory);}catch{return null;}
}

// Fixed relative names only. Bound the actual read, not just a prior stat, and
// reject linked files/directories rather than following artifact pointers.
function readFixed(root,relative,max){
 let fd;
 try{
  const parts=relative.split(path.sep),file=path.join(root,...parts);
  for(let index=1;index<parts.length;index++){const info=lstatSync(path.join(root,...parts.slice(0,index)));if(info.isSymbolicLink()||!info.isDirectory()||!owned(info)||info.mode&0o022)return null;}
  const info=lstatSync(file);if(info.isSymbolicLink()||!info.isFile()||info.nlink!==1||!owned(info)||info.mode&0o022||info.size>max)return null;
  fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=fstatSync(fd);
  if(!opened.isFile()||opened.dev!==info.dev||opened.ino!==info.ino||opened.nlink!==1||!owned(opened)||opened.size>max)return null;
  const buffer=Buffer.alloc(max+1);let bytes=0;
  while(bytes<buffer.length){const count=readSync(fd,buffer,bytes,buffer.length-bytes,null);if(!count)break;bytes+=count;}
  if(bytes>max)return null;
  return JSON.parse(buffer.subarray(0,bytes).toString('utf8'));
 }catch{return null;}finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
}

function validScope(value){
 return plain(value)&&Object.keys(value).sort().join(',')==='kind,operation,schemaVersion'&&value.schemaVersion===1&&value.kind==='appium-webview-outcome'&&['workflow-learn','execute'].includes(value.operation);
}

// Called only after runtime routing has selected the trusted WebView module.
// This marker identifies the producer; caller error codes or recipes do not.
export function markWebviewOperation(directory,operation){
 if(!['workflow-learn','execute'].includes(operation))throw scopeError();
 mkdirSync(directory,{recursive:true,mode:0o700});const root=rootDirectory(directory);if(!root)throw scopeError();
 const scope={schemaVersion:1,kind:'appium-webview-outcome',operation};
 let present=false;try{lstatSync(path.join(root,SCOPE_FILE));present=true;}catch(error){if(error.code!=='ENOENT')throw scopeError();}
 const existing=readFixed(root,SCOPE_FILE,1024);if(present&&(!validScope(existing)||existing.operation!==operation))throw scopeError();
 atomicJson(path.join(root,SCOPE_FILE),scope,false);
}

const LOCATIONS=['','execution','workflow'];
export function hasWebviewOperation(directory){
 const root=rootDirectory(directory);return !!root&&LOCATIONS.some(location=>validScope(readFixed(root,path.join(location,SCOPE_FILE),1024)));
}

export function persistedWebviewOutcome(directory){
 const root=rootDirectory(directory);if(!root)return undefined;const outcomes=[];
 for(const location of LOCATIONS){
  if(!validScope(readFixed(root,path.join(location,SCOPE_FILE),1024)))continue;
  for(const name of ['result.json','checkpoint.json'])outcomes.push(publicWebviewOutcome(readFixed(root,path.join(location,name),262144)?.webviewOutcome));
 }
 // No file, malformed file, or an abrupt kill is missing evidence, not proof
 // that execution never began. Existing producer unknown remains conservative.
 return mergeWebviewOutcomes(...outcomes);
}

// Reserve this diagnostic only at the operation/runtime result wrappers. User
// output values are not traversed, and existing nested API positions survive.
export function projectWebviewOutcomeFields(value,{trusted=false}={}){
 function project(current,depth){
  if(!plain(current))return current;const result={...current};
  if(Object.hasOwn(current,'webviewOutcome')){const outcome=trusted?publicWebviewOutcome(current.webviewOutcome):undefined;if(outcome)result.webviewOutcome=outcome;else delete result.webviewOutcome;}
  if(depth&&plain(current.result))result.result=project(current.result,depth-1);
  return result;
 }
 return project(value,2);
}
