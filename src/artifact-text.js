import {constants,openSync,fstatSync,readSync,closeSync} from 'node:fs';

const fail=code=>{throw Object.assign(new Error(code+'：规范文档不可用、改变或超出读取预算'),{code});};
const sameFile=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);

// The caller resolves this filename inside its trusted artifact roots. Read a
// regular descriptor only, with a byte ceiling independent of pathname stat.
export function readArtifactTextSnapshot(file,maxBytes){
 if(typeof file!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>8*1024*1024)fail('DOCUMENT_LIMIT');
 let fd;
 try{
  fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size>BigInt(maxBytes))fail('DOCUMENT_LIMIT');
  const buffer=Buffer.alloc(Number(before.size)+1);let bytes=0;
  while(bytes<buffer.length){
   const count=readSync(fd,buffer,bytes,Math.min(65536,buffer.length-bytes),null);
   if(!count)break;
   bytes+=count;
  }
  const after=fstatSync(fd,{bigint:true});
  if(bytes>maxBytes)fail('DOCUMENT_LIMIT');
  if(bytes!==Number(before.size)||!sameFile(before,after))fail('DOCUMENT_CHANGED');
  let document;
  try{document=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,bytes));}
  catch{fail('DOCUMENT_ENCODING_INVALID');}
  return {document,bytes,stamp:before};
 }catch(error){
  if(/^DOCUMENT_(?:LIMIT|CHANGED|ENCODING_INVALID)$/.test(error.code||''))throw error;
  fail('DOCUMENT_UNAVAILABLE');
 }finally{if(fd!==undefined)closeSync(fd);}
}

// Preserve the original public reader shape for existing callers.
export function readArtifactText(file,maxBytes){
 const {document,bytes}=readArtifactTextSnapshot(file,maxBytes);return {document,bytes};
}
