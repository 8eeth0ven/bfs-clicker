// Streaming HAR export; append-only traffic is retained across resume.
import { existsSync, openSync, closeSync, writeSync, renameSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { redact } from './redact.js';
function entry(e){
  const headers=h=>Object.entries(h||{}).map(([name,value])=>({name,value:String(value)}));
  let queryString=[];try{queryString=[...new URL(e.url).searchParams].map(([name,value])=>({name,value}))}catch{}
  const request={method:e.method,url:e.url,httpVersion:'HTTP/1.1',headers:headers(e.reqHeaders),queryString,headersSize:-1,bodySize:Buffer.byteLength(e.postData||'')};
  if(e.postData)request.postData={mimeType:e.reqHeaders?.['content-type']||'',text:e.postData};
  const content={size:e.respBytes||0,mimeType:e.contentType||'',_bodyOmitted:!!e.bodyOmitted,_bodyReason:e.bodyReason||null};
  if(e.body!==undefined&&!e.bodyOmitted){content.text=e.body;if(e.bodyEncoding==='base64')content.encoding='base64'}
  return {startedDateTime:e.ts?new Date(e.ts).toISOString():new Date(0).toISOString(),time:0,request,
    response:{status:e.status||0,statusText:'',httpVersion:'HTTP/1.1',headers:headers(e.respHeaders),content,redirectURL:'',headersSize:-1,bodySize:e.respBytes||0},
    cache:{},timings:{send:0,wait:0,receive:0},_evidenceId:e.evidenceId||null,_requestEvidenceId:e.requestEvidenceId||null,
    _responseDigest:e.responseDigest||null,_source:e.source||null,_failed:e.failed||null};
}
export async function buildHarFromTraffic(trafficFile,harFile,{redacted=false,onError=()=>{}}={}){
  const temp=harFile+'.tmp';const fd=openSync(temp,'w',0o600);let n=0;
  try{
    writeSync(fd,'{"log":{"version":"1.2","creator":{"name":"bfs-clicker","version":"2.0"},"entries":[');
    if(existsSync(trafficFile)){
      const lines=createInterface({input:createReadStream(trafficFile),crlfDelay:Infinity});let lineNo=0;
      for await(const line of lines){lineNo++;if(!line.trim())continue;
        let row;try{row=entry(JSON.parse(line))}catch(error){onError(error,lineNo);continue}
        if(redacted){row=redact(row);delete row.response.content.text;delete row.response.content.encoding;row.response.content._bodyOmittedForSharing=true;}
        writeSync(fd,(n?',':'')+JSON.stringify(row));n++;
      }
    }
    writeSync(fd,']}}');closeSync(fd);renameSync(temp,harFile);return n;
  }catch(error){try{closeSync(fd)}catch{}throw error}
}
