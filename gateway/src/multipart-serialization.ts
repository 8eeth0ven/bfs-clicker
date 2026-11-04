import {randomBytes} from 'node:crypto';
import {GatewayError, type MultipartField, type MultipartSerialization} from './types.js';

export const MULTIPART_LIMITS=Object.freeze({fields:16,parts:32,files:8,fileBytes:262144,totalFileBytes:524288,textBytes:65536,bodyBytes:1048576,textArrayItems:16,fileArrayItems:8});
const plain=(v:any):v is Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const FIELD=/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const FILENAME=/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const MIME=/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const forbidden=new Set(['__proto__','constructor','prototype']);
const invalid=()=>{throw new GatewayError('MULTIPART_CONTRACT_INVALID','multipart编码契约不受支持');};
const params=()=>{throw new GatewayError('PARAMS_INVALID','multipart字段或文件格式无效');};
const large=()=>{throw new GatewayError('REQUEST_TOO_LARGE','multipart请求超过固定预算');};
export function multipartRules(value:any):MultipartSerialization {
  if(!plain(value)||Object.keys(value).some(k=>!['schemaVersion','fields'].includes(k))||value.schemaVersion!==1||!plain(value.fields)||!Object.keys(value.fields).length||Object.keys(value.fields).length>MULTIPART_LIMITS.fields)invalid();
  const fields:Record<string,MultipartField>=Object.create(null);
  for(const name of Object.keys(value.fields).sort()){
    if(!FIELD.test(name)||forbidden.has(name))invalid();
    const field=value.fields[name];
    if(!plain(field)||typeof field.array!=='boolean')invalid();
    if(field.kind==='text'){
      if(Object.keys(field).some(k=>!['kind','valueType','contentType','array'].includes(k))||!['string','number','integer','boolean'].includes(field.valueType)||field.contentType!=='text/plain')invalid();
      fields[name]={kind:'text',valueType:field.valueType,contentType:'text/plain',array:field.array};
    }else if(field.kind==='file'){
      if(Object.keys(field).some(k=>!['kind','contentType','array'].includes(k))||typeof field.contentType!=='string'||field.contentType.length>127||!MIME.test(field.contentType)||/^multipart\//i.test(field.contentType))invalid();
      fields[name]={kind:'file',contentType:field.contentType.toLowerCase(),array:field.array};
    }else invalid();
  }
  return {schemaVersion:1,fields};
}
function fileValue(value:any):{filename:string;bytes:Buffer}{
  if(!plain(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'filename')||!Object.hasOwn(value,'base64')||typeof value.filename!=='string'||!FILENAME.test(value.filename)||typeof value.base64!=='string')params();
  const encoded=value.base64;
  if(encoded.length>4*Math.ceil(MULTIPART_LIMITS.fileBytes/3))large();
  if(encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))params();
  const estimated=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
  if(estimated>MULTIPART_LIMITS.fileBytes)large();
  const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)params();
  if(bytes.length>MULTIPART_LIMITS.fileBytes)large();
  return {filename:value.filename,bytes};
}
export function serializeMultipart(value:any,rawContract:MultipartSerialization):{body:Buffer;contentType:string;sensitiveValues:{value:string;exact:boolean}[]}{
  const contract=multipartRules(rawContract);
  if(!plain(value)||!Object.keys(value).length||Object.keys(value).length>MULTIPART_LIMITS.fields)params();
  const parts:{header:string;bytes:Buffer}[]=[],sensitiveValues:{value:string;exact:boolean}[]=[];let files=0,fileBytes=0,payloadBytes=0;
  for(const name of Object.keys(value).sort()){
    if(!Object.hasOwn(contract.fields,name))params();
    const field=contract.fields[name],item=value[name],items=field.array?item:[item];
    if(!Array.isArray(items)||!items.length||items.length>(field.array?(field.kind==='file'?MULTIPART_LIMITS.fileArrayItems:MULTIPART_LIMITS.textArrayItems):1))params();
    for(const part of items){
      if(parts.length>=MULTIPART_LIMITS.parts)large();
      let bytes:Buffer,filename:string|undefined;
      if(field.kind==='file'){
        const file=fileValue(part);bytes=file.bytes;filename=file.filename;files++;fileBytes+=bytes.length;
        if(files>MULTIPART_LIMITS.files||fileBytes>MULTIPART_LIMITS.totalFileBytes)large();
        if(bytes.length){sensitiveValues.push({value:part.base64,exact:false});try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);if(text)sensitiveValues.push({value:text,exact:text.length<8});}catch{/* Non-UTF8 bytes have no raw text representation. */}}
      }else{
        if(field.valueType==='string'?typeof part!=='string':field.valueType==='boolean'?typeof part!=='boolean':typeof part!=='number'||!Number.isFinite(part)||field.valueType==='integer'&&!Number.isInteger(part))params();
        const text=String(part);if(text.length>MULTIPART_LIMITS.textBytes)large();bytes=Buffer.from(text,'utf8');
        if(bytes.toString('utf8')!==text)params();if(bytes.length>MULTIPART_LIMITS.textBytes)large();
      }
      payloadBytes+=bytes.length;if(payloadBytes>MULTIPART_LIMITS.bodyBytes)large();
      const header='Content-Disposition: form-data; name="'+name+'"'+(filename===undefined?'':'; filename="'+filename+'"')+'\r\nContent-Type: '+(field.kind==='text'?'text/plain; charset=utf-8':field.contentType)+'\r\n\r\n';
      parts.push({header,bytes});
    }
  }
  let boundary='';
  for(let attempt=0;attempt<4;attempt++){
    boundary='bfs-mcp-'+randomBytes(24).toString('hex');
    if(parts.every(part=>!part.bytes.includes(boundary)))break;
    boundary='';
  }
  if(!boundary)throw new GatewayError('MULTIPART_BOUNDARY_FAILED','无法生成无冲突边界');
  const chunks:Buffer[]=[];let total=0;
  const add=(chunk:Buffer)=>{total+=chunk.length;if(total>MULTIPART_LIMITS.bodyBytes)large();chunks.push(chunk);};
  for(const part of parts){add(Buffer.from('--'+boundary+'\r\n'+part.header));add(part.bytes);add(Buffer.from('\r\n'));}
  add(Buffer.from('--'+boundary+'--\r\n'));
  return {body:Buffer.concat(chunks,total),contentType:'multipart/form-data; boundary='+boundary,sensitiveValues};
}
