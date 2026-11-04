// Bounded, scope-local readonly operations. Each operation rereads the original
// PNG through its existing validator; no file, decoder, pixel or digest cache.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {visualPixelFingerprint} from './visual-pixels.js';
import {visualCaretEquivalent} from './visual-caret.js';

const MAX_INPUT=16384,MAX_OUTPUT=4096,MAX_OPERATIONS=3;
const invalid=()=>{throw Object.assign(new Error('Invalid readonly pixel task'),{code:'VISUAL_PIXEL_TASK_INVALID'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

export function performPixelOperation(request){
 if(!request||!Number.isSafeInteger(request.id)||request.id<1||request.id>MAX_OPERATIONS)invalid();
 if(request.operation==='fingerprint'){
  if(!exact(request,['id','operation','path','masks']))invalid();
  return visualPixelFingerprint(request.path,{masks:request.masks});
 }
 if(request.operation==='caret'){
  if(!exact(request,['id','operation','before','after','options']))invalid();
  return visualCaretEquivalent(request.before,request.after,request.options);
 }
 invalid();
}

// JSON.parse validates syntax first; this bounded walk additionally rejects
// duplicate object keys at every level, rather than silently choosing one.
function uniqueKeys(text){
 let cursor=0;
 const space=()=>{while(/\s/.test(text[cursor]||'')&&cursor<text.length)cursor++;};
 const string=()=>{const start=cursor++;while(cursor<text.length){const c=text[cursor++];if(c==='\\')cursor++;else if(c==='"')return JSON.parse(text.slice(start,cursor));}invalid();};
 function value(depth){
  if(depth>64)invalid();space();
  if(text[cursor]==='{'){
   cursor++;space();const seen=new Set();if(text[cursor]==='}'){cursor++;return;}
   for(;;){space();const key=string();if(seen.has(key))invalid();seen.add(key);space();cursor++;value(depth+1);space();if(text[cursor++]==='}')return;}
  }
  if(text[cursor]==='['){cursor++;space();if(text[cursor]===']'){cursor++;return;}for(;;){value(depth+1);space();if(text[cursor++]===']')return;}}
  if(text[cursor]==='"'){string();return;}
  while(cursor<text.length&&!/[\s,}\]]/.test(text[cursor]))cursor++;
 }
 value(0);space();if(cursor!==text.length)invalid();
}

async function main(){
 let pending=Buffer.alloc(0),next=1;
 for await(const chunk of process.stdin){
  pending=Buffer.concat([pending,chunk]);
  for(let end;(end=pending.indexOf(10))!==-1;){
   if(end>MAX_INPUT)invalid();
   const text=new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(0,end));
   pending=pending.subarray(end+1);const request=JSON.parse(text);uniqueKeys(text);
   if(request?.id!==next||next>MAX_OPERATIONS)invalid();
   const value=performPixelOperation(request),response=JSON.stringify({id:next,operation:request.operation,ok:true,value});
   if(Buffer.byteLength(response)>MAX_OUTPUT)invalid();
   process.stdout.write(response+'\n');next++;
  }
  if(pending.length>MAX_INPUT)invalid();
 }
 if(pending.length)invalid();
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await main();}catch{process.exitCode=1;}
}
