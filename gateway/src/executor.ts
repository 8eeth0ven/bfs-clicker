import {Ajv2020} from 'ajv/dist/2020.js';
import {setTimeout as delay} from 'node:timers/promises';
import {CredentialProvider} from './credentials.js';
import {truncateUtf8} from './redact.js';
import {serializeQuery} from './query-serialization.js';
import {serializeForm} from './form-serialization.js';
import {GatewayError, type GatewayConfig, type SourceSnapshot, type Endpoint, type Operation, type CallParams, type GatewayResult} from './types.js';

const SESSION = /(?:^|[^a-z0-9])(?:log[_-]?(?:out|off)|sign[_-]?out|revoke|注销|登出|退出登录)(?:$|[^a-z0-9])/i;
const SELECTOR = /^(?:action|op|operation|method|cmd|command|function|do|event|intent|type)(?:[_-]?name)?$/i;
const FORBIDDEN_STATIC = /^(?:host|:authority|cookie|authorization|proxy-.+|connection|transfer-encoding|content-length)$/i;
function decoded(value: string): string {
  for(let i=0;i<3;i++){try{const next=decodeURIComponent(value);if(next===value)break;value=next;}catch{break;}}
  return value;
}
function assertSessionSafe(path:string, params:CallParams):void {
  const sessionAction=(text:string)=>SESSION.test(decoded(text).replace(/([a-z])([A-Z])/g,'$1_$2')) || /(?:^|[^a-z0-9])(?:logout|signout|logoff)(?:all|everyone|everywhere|others|devices|sessions)(?:$|[^a-z0-9])/i.test(decoded(text));
  if(sessionAction(path)) throw new GatewayError('SESSION_ACTION_BLOCKED','禁止会话退出或撤销动作');
  const walk=(value:any,depth:number)=>{
    if(depth>24) throw new GatewayError('PARAMS_INVALID','参数嵌套过深');
    if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
    if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
      const selectorKey=decoded(key).split(/[.\[\]]+/).some(part=>SELECTOR.test(part));
      if(selectorKey && (typeof item==='string'||Array.isArray(item)) && sessionAction(String(item))) throw new GatewayError('SESSION_ACTION_BLOCKED','禁止会话退出或撤销动作');
      walk(item,depth+1);
    }
  };
  walk(params.query,0);walk(params.body,0);
}
function pathValue(value: string|number):string {
  if(typeof value==='number'&&!Number.isFinite(value)) throw new GatewayError('PARAMS_INVALID','路径参数不是有限数值');
  const text=String(value), expanded=decoded(text);
  if(!text || expanded==='.' || expanded==='..' || /[\/\\\x00-\x1f\x7f]/.test(expanded)) throw new GatewayError('PATH_BLOCKED','路径参数只能是单个非点路径段');
  return encodeURIComponent(text);
}
function failure(code:string,message:string,data:any,warnings:string[]=[]):GatewayResult {return {ok:false,data,error:{code,message},warnings};}

export class Executor {
  private ajv = new Ajv2020({allErrors:true,strict:false,allowUnionTypes:true,validateFormats:false});
  private validators=new WeakMap<object,any>();
  constructor(private config:GatewayConfig, private provider:CredentialProvider) {}
  async execute(source:SourceSnapshot, endpoint:Endpoint, op:Operation, params:CallParams={}, signal?:AbortSignal):Promise<GatewayResult> {
    if(op.body_encoding==='unsupported')throw new GatewayError('UNSUPPORTED_BODY_ENCODING','该操作的请求体编码未获支持');
    if(op.query_serialization_conflict)throw new GatewayError('QUERY_SERIALIZATION_CONFLICT','查询编码声明冲突，需重新确认契约');
    if(op.form_serialization_conflict)throw new GatewayError('FORM_SERIALIZATION_CONFLICT','表单编码声明冲突，需重新确认契约');
    if(op.method!=='GET' && (!this.config.methods.allow_non_get || !this.config.methods.allow.some(a=>a.source===source.id&&a.endpoint_id===endpoint.id&&a.method===op.method)))
      throw new GatewayError('METHOD_BLOCKED','该方法未在配置与逐端点白名单同时启用');
    if(params.method && params.method!==op.method)throw new GatewayError('PARAMS_INVALID','选择的方法与端点操作不一致');
    const defaults=source.binding.defaults?.[endpoint.id]??{};
    const call:CallParams={...defaults,...params,path:{...(defaults.path??{}),...(params.path??{})},query:{...(defaults.query??{}),...(params.query??{})}};
    const validationInput:any={...call};delete validationInput.method;
    // Empty containers are optional; do not insert fields absent from the contract.
    if(!Object.keys(validationInput.path??{}).length)delete validationInput.path;
    if(!Object.keys(validationInput.query??{}).length)delete validationInput.query;
    let validate;
    try {
      validate=this.validators.get(op.params_schema);
      if(!validate){validate=this.ajv.compile(op.params_schema);this.ajv.removeSchema(op.params_schema);this.validators.set(op.params_schema,validate);}
    }catch{throw new GatewayError('ENDPOINT_SCHEMA_INVALID','端点参数 schema 无法编译');}
    if(!validate(validationInput))throw new GatewayError('PARAMS_INVALID','参数不符合选定方法的 schema',{issues:validate.errors?.map((e:any)=>({path:e.instancePath,keyword:e.keyword,message:e.message}))});
    if((op.method==='GET'||op.method==='HEAD') && Object.hasOwn(call,'body'))throw new GatewayError('PARAMS_INVALID','GET/HEAD 不允许请求体');
    let actualPath=endpoint.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,name:string)=>{
      const value=call.path?.[name];if(value===undefined)throw new GatewayError('PARAMS_INVALID','缺少路径参数',{parameter:name});return pathValue(value);
    });
    if(/[{}]/.test(actualPath))throw new GatewayError('PATH_BLOCKED','路径模板未完整解析');
    let url:URL;
    try {url=new URL(endpoint.origin+actualPath);}catch{throw new GatewayError('ORIGIN_BLOCKED','无法构造端点 URL');}
    if(!/^https?:$/.test(url.protocol)||url.username||url.password||url.hash||url.origin!==endpoint.origin||url.pathname!==actualPath||!source.origins.includes(url.origin)||(source.binding.allowed_origins&&!source.binding.allowed_origins.includes(url.origin)))
      throw new GatewayError('ORIGIN_BLOCKED','请求 URL 不符合清单和来源的 origin/路径约束');
    url.search=serializeQuery(call.query??{},op.query_serialization);
    assertSessionSafe(url.pathname,call);
    const credentials=await this.provider.load(source.binding);
    const headers=new Headers();
    for(const [key,value] of Object.entries(source.binding.static_headers??{})){
      if(FORBIDDEN_STATIC.test(key)||/[\r\n\0]/.test(value))throw new GatewayError('HEADERS_BLOCKED','静态配置中含不允许的请求头');
      if(/^origin$/i.test(key)){try {if(new URL(value).origin!==value)throw new Error();}catch{throw new GatewayError('HEADERS_BLOCKED','Origin 头配置不正确');}}
      headers.set(key,value);
    }
    for(const [key,value] of Object.entries(credentials.headersFor(url)))headers.set(key,value);
    let body:string|undefined;
    if(Object.hasOwn(call,'body')){
      if(op.body_encoding==='json'){body=JSON.stringify(call.body);headers.set('content-type','application/json');}
      else if(op.body_encoding==='text'){if(typeof call.body!=='string')throw new GatewayError('PARAMS_INVALID','文本请求体必须为字符串');body=call.body;headers.set('content-type','text/plain; charset=utf-8');}
      else if(op.form_serialization){body=serializeForm(call.body,op.form_serialization);headers.set('content-type','application/x-www-form-urlencoded');}
      else {
        if(!call.body||typeof call.body!=='object'||Array.isArray(call.body))throw new GatewayError('PARAMS_INVALID','表单请求体必须为对象');
        const form=new URLSearchParams();
        for(const [key,value]of Object.entries(call.body)){for(const item of Array.isArray(value)?value:[value]){if(item===null)continue;if(!['string','number','boolean'].includes(typeof item))throw new GatewayError('PARAMS_INVALID','表单仅支持标量与标量数组');form.append(key,String(item));}}
        body=form.toString();headers.set('content-type','application/x-www-form-urlencoded');
      }
      if(Buffer.byteLength(body??'')>1024*1024)throw new GatewayError('REQUEST_TOO_LARGE','请求体超过 1MiB');
    }
    const started=performance.now(), controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(new Error('deadline')),this.config.timeout_ms);
    const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
    let attempts=0,status:number|null=null,contentType:string|null=null;
    const base=()=>({source:source.id,endpoint_id:endpoint.id,method:op.method,source_revision:source.revision,provenance:op.provenance,observation_status:null as number|null,response:{status,duration_ms:Math.round(performance.now()-started),attempts,content_type:contentType,body:{format:'empty',value:null as any,truncated:false,limit_bytes:this.config.max_body_bytes,bytes_read:0,returned_bytes:0}}});
    const warnings=[...credentials.warnings];
    if(op.provenance.includes('static_candidate')&&!op.provenance.includes('observed'))warnings.push('来源为静态候选；HTTP 成功与业务有效性分别记录');
    try {
      let response:Response|undefined;
      while(attempts<2){
        attempts++;
        try {response=await fetch(url,{method:op.method,headers,body,redirect:'manual',signal:combined});}
        catch(err:any){
          const code=err?.cause?.code??'';
          if(op.method==='GET'&&attempts===1&&!combined.aborted&&['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT'].includes(code)) {await delay(50,undefined,{signal:combined});continue;}
          throw err;
        }
        status=response.status;contentType=response.headers.get('content-type');
        if(op.method==='GET'&&attempts===1&&[502,503,504].includes(status)){await response.body?.cancel();await delay(50,undefined,{signal:combined});continue;}
        break;
      }
      if(!response)throw new Error('no response');
      if(status! >= 300 && status! < 400){
        await response.body?.cancel();const data=base();data.observation_status=status;
        return failure('REDIRECT_BLOCKED','beta 不自动跟随重定向',data,warnings);
      }
      const limit=this.config.max_body_bytes, captureLimit=limit+credentials.redactor.maxLookaheadBytes+8;
      const parts:Uint8Array[]=[];let captured=0,bytesRead=0,complete=!response.body;
      const reader=response.body?.getReader();
      try {
        while(reader&&captured<captureLimit){
          const chunk=await reader.read();if(chunk.done){complete=true;break;}
          bytesRead+=chunk.value.length;
          const selected=chunk.value.subarray(0,captureLimit-captured);parts.push(selected.slice());captured+=selected.length;
        }
      } finally {if(reader&&!complete)await reader.cancel().catch(()=>{});reader?.releaseLock();}
      const raw=Buffer.concat(parts), truncated=!complete||bytesRead>limit;
      const data=base();data.observation_status=status;
      const output=data.response.body;output.bytes_read=bytesRead;output.truncated=truncated;
      if(raw.length){
        const textual=!contentType||/^(?:text\/)|json|xml|javascript|x-www-form-urlencoded/i.test(contentType);
        if(!textual){output.format='binary_summary';output.value=null;}
        else if(!truncated && /(?:\/|\+)json(?:\s*;|$)/i.test(contentType??'')){
          try {
            output.value=credentials.redactor.value(JSON.parse(raw.toString('utf8')));output.format='json';
            const serialized=JSON.stringify(output.value);
            if(Buffer.byteLength(serialized)>limit){output.value=truncateUtf8(serialized,limit);output.format='text';output.truncated=true;}
          } catch {output.format='text';output.value=credentials.redactor.prefix(raw,limit);warnings.push('INVALID_JSON_RESPONSE');}
        } else {output.format='text';output.value=credentials.redactor.prefix(raw,limit);}
      }
      output.returned_bytes=output.value===null?0:Buffer.byteLength(output.format==='json'?JSON.stringify(output.value):String(output.value));
      data.response.duration_ms=Math.round(performance.now()-started);
      if(status! < 200 || status! >= 300)return failure('UPSTREAM_HTTP_ERROR','上游返回非成功状态',data,warnings);
      return {ok:true,data,error:null,warnings};
    }catch{
      const data=base();
      return failure(signal?.aborted?'CANCELLED':controller.signal.aborted?'TIMEOUT':'UPSTREAM_NETWORK_ERROR',signal?.aborted?'调用已取消':controller.signal.aborted?'整次请求超过超时预算':'上游网络请求失败',data,warnings);
    }finally{clearTimeout(timeout);}
  }
}
