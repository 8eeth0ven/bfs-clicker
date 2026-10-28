#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Registry } from './registry.js';
import { Discovery } from './discovery.js';
import { LearningStore } from './learning.js';
import { CredentialProvider } from './credentials.js';
import { Executor } from './executor.js';
import { GatewayError, METHODS, SOURCE_KINDS, EXTRACTION_SOURCES, type GatewayResult, type Method } from './types.js';

const methods=z.enum(METHODS);
const limit=z.number().int().min(1).max(100);
const pageInput={source:z.string().default('*'),limit:limit.optional(),cursor:z.string().max(1024).optional()};
const filter=z.object({endpoint_id:z.string().optional(),path:z.string().max(2048).optional(),method:methods.optional(),provenance:z.enum(['static_candidate','observed']).optional(),category:z.string().optional(),kind:z.enum(SOURCE_KINDS).optional(),extraction_source:z.enum(EXTRACTION_SOURCES).optional()}).strict();
const scalar=z.union([z.string(),z.number().finite(),z.boolean()]);
const callParams=z.object({method:methods.optional(),path:z.record(z.string(),z.union([z.string(),z.number().finite()])).optional(),query:z.record(z.string(),z.union([scalar,z.null(),z.array(scalar)])).optional(),body:z.json().optional()}).strict();
const errorSchema=z.object({code:z.string(),message:z.string(),details:z.json().optional()}).strict();
const healthSchema=z.object({state:z.enum(['unverified','http_verified','not_found_suspected']),success_streak:z.number().int().nonnegative(),missing_streak:z.number().int().nonnegative(),last_status:z.number().nullable(),evidence_scope:z.literal('request_observations'),updated_at:z.string().optional()}).strict();
const parameterSummary=z.object({in:z.enum(['path','query','body','header']),name:z.string(),type:z.union([z.string(),z.array(z.string())]),required:z.boolean(),managed:z.boolean().optional()}).strict();
const operationSummary=z.object({method:methods,description:z.string(),categories:z.array(z.string()),provenance:z.array(z.enum(['static_candidate','observed'])),extraction_sources:z.array(z.string()),locations:z.array(z.string()),allowed:z.boolean(),blocked_reason:z.string().nullable(),parameter_summary:z.array(parameterSummary),health:healthSchema,quality_label:z.string(),params_schema:z.record(z.string(),z.json()).optional()}).strict();
const unresolvedSummary=z.object({provenance:z.array(z.enum(['static_candidate','observed'])),extraction_source:z.string().nullable(),location:z.string().nullable(),reason:z.string(),description:z.string(),categories:z.array(z.string()),extraction_sources:z.array(z.string()),locations:z.array(z.string()),parameter_summary:z.array(parameterSummary),params_schema:z.record(z.string(),z.json()).optional()}).strict();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const appSchema=z.object({package_name:z.string(),version_name:z.string(),apk_sha256:hash.optional(),bundle_id:z.string().optional(),artifact_sha256:hash.optional(),ipa_sha256:hash.optional(),artifact_type:z.enum(['ipa','app','apk']).optional()}).strict();
const sourceSummary=z.object({source:z.string(),kind:z.enum(SOURCE_KINDS),revision:z.string(),origins:z.array(z.string()),endpoint_count:z.number().int(),auth_configured:z.boolean(),app:appSchema.nullable(),resource_uri:z.string()}).strict();
const endpointSummary=z.object({id:z.string(),source:z.string(),source_revision:z.string(),origin:z.string(),path:z.string(),methods:z.array(methods),operations:z.record(z.string(),operationSummary),unresolved_candidates:z.array(unresolvedSummary),allowed:z.boolean(),kind:z.enum(SOURCE_KINDS),matched_methods:z.array(methods).optional(),score:z.number().optional()}).strict();
const pageData=z.object({sources:z.array(sourceSummary),items:z.array(endpointSummary),snapshot_id:z.string(),next_cursor:z.string().nullable(),total:z.number().int()}).strict();
const responseBody=z.object({format:z.enum(['json','text','binary_summary','empty']),value:z.json(),truncated:z.boolean(),limit_bytes:z.number().int().nonnegative(),bytes_read:z.number().int().nonnegative(),returned_bytes:z.number().int().nonnegative()}).strict();
const callData=z.object({source:z.string(),endpoint_id:z.string(),method:methods,source_revision:z.string(),provenance:z.array(z.string()),observation_status:z.number().nullable(),response:z.object({status:z.number().nullable(),duration_ms:z.number(),attempts:z.number().int(),content_type:z.string().nullable(),body:responseBody}).strict(),health:healthSchema,learning_persisted:z.boolean()}).strict();
const addData=z.object({source:z.string(),source_revision:z.string(),endpoint_count:z.number().int(),action:z.enum(['added','reloaded','unchanged']),resource_uri:z.string()}).strict();
const output=(data:z.ZodType)=>z.object({ok:z.boolean(),data:data.nullable(),error:errorSchema.nullable(),warnings:z.array(z.string())}).strict();
const readOnly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};

export async function createGateway(configPath:string) {
  const config=await loadConfig(configPath);
  const credentials=new CredentialProvider();
  // Register secrets before projecting any inventory into a client-visible catalog.
  for(const binding of config.sources)await credentials.load(binding);
  const registry=new Registry(config);await registry.initialize();
  const learning=new LearningStore(config);await learning.initialize();
  const discovery=new Discovery(registry,learning,config,credentials.redactor);
  const executor=new Executor(config,credentials);
  const server=new McpServer({name:'endpoint-inventory-gateway',version:'0.1.0-beta.1'});
  const ok=(data:any,warnings:string[]=[]):GatewayResult=>({ok:true,data,error:null,warnings});
  async function run(fn:()=>Promise<GatewayResult>|GatewayResult) {
    let value:GatewayResult;
    try{value=await fn();}
    catch(e){value={ok:false,data:null,error:e instanceof GatewayError?{code:e.code,message:e.message,...(e.details===undefined?{}:{details:e.details})}:{code:'INTERNAL_ERROR',message:'网关内部错误'},warnings:[]};}
    const clean=credentials.redactor.result(value);
    return {structuredContent:clean as any,content:[{type:'text' as const,text:JSON.stringify(clean)}],isError:!clean.ok};
  }
  const resources=new Set<string>();
  function registerResource(source:string){
    if(resources.has(source))return;
    resources.add(source);
    const uri=`inventory://sources/${encodeURIComponent(source)}/manifest.json`;
    server.registerResource(`inventory-${source}`,uri,{mimeType:'application/json',description:'只读归一化清单，含参数 schema、采集溯源与健康状态'},async()=>({contents:[{uri,mimeType:'application/json',text:JSON.stringify(discovery.resource(source))}]}));
  }
  for(const source of registry.all())registerResource(source.id);
  server.registerTool('list_endpoints',{
    description:'分页浏览站点接口目录。source=* 为所有来源；可按路径、方法、来源分类过滤。未知方法仅供发现。include_schema=true 获取完整逐方法参数 schema。继续分页必须使用相同查询条件。',
    inputSchema:z.object({...pageInput,filter:filter.optional(),include_schema:z.boolean().default(false)}).strict(),outputSchema:output(pageData),annotations:readOnly
  },async args=>run(()=>ok(discovery.list(args))));
  server.registerTool('search_endpoints',{
    description:'跨站点搜索路径、描述、参数名、分类和资源定位。默认前5条并返回完整参数 schema，随后用 call_endpoint 调用；分页必须保持原查询条件。',
    inputSchema:z.object({...pageInput,keyword:z.string().min(1).max(256),include_schema:z.boolean().default(true)}).strict(),outputSchema:output(pageData),annotations:readOnly
  },async args=>run(()=>ok(discovery.search(args))));
  server.registerTool('call_endpoint',{
    description:'按已注册端点调用 HTTP API。先 list/search 获取 schema；多方法端点必须 params.method。认证自动注入，客户端不能指定 URL 或 headers。默认仅已知 GET；写方法须可信配置逐端点放行。',
    inputSchema:z.object({source:z.string(),endpoint_id:z.string().regex(/^ep_[a-f0-9]{64}$/),expected_revision:z.string().optional(),params:callParams.optional()}).strict(),outputSchema:output(callData),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}
  },async(args,extra)=>run(async()=>{
    const source=registry.get(args.source);
    if(args.expected_revision&&source.revision!==args.expected_revision)throw new GatewayError('SOURCE_CHANGED','清单版本已变化，请重新发现参数');
    const endpoint=source.endpoints.find(x=>x.id===args.endpoint_id);
    if(!endpoint)throw new GatewayError('ENDPOINT_NOT_FOUND','当前清单中无此端点');
    if(!endpoint.methods.length)throw new GatewayError('METHOD_UNRESOLVED','静态候选的 HTTP 方法尚未解析');
    const method=args.params?.method || (endpoint.methods.length===1?endpoint.methods[0]:undefined);
    if(!method)throw new GatewayError('METHOD_REQUIRED','多方法端点必须显式 params.method',{methods:endpoint.methods});
    const op=endpoint.operations[method as Method];
    if(!op)throw new GatewayError('METHOD_NOT_FOUND','该端点没有指定方法',{methods:endpoint.methods});
    if(!op.allowed)throw new GatewayError(op.blocked_reason || 'METHOD_BLOCKED','该操作被来源配置或beta能力护栏阻止');
    const result=await executor.execute(source,endpoint,op,args.params||{},extra.signal);
    if(result.data){
      const observed=await learning.observe(source.id,endpoint.id,op,result.data.observation_status ?? null);
      result.data.health=observed.health;result.data.learning_persisted=observed.persisted;
      result.warnings.push(...observed.warnings);
      if(op.provenance.includes('static_candidate')&&!op.provenance.includes('observed')&&observed.health.state!=='http_verified')result.warnings.push('未验证：此操作原始来源为静态候选');
      if(observed.health.state==='not_found_suspected')result.warnings.push('连续404/410仅表示请求观察疑似失效，不证明路由已删除');
    }
    return result;
  }));
  server.registerTool('add_source',{
    description:'热加载本地可信绑定中的清单文件或 APK/iOS 产出目录。目录固定读取 source.json；不会执行 APK、安装工具或接受清单提供的凭据路径。全局护栏保持启动配置。',
    inputSchema:z.object({manifest_path:z.string().min(1)}).strict(),outputSchema:output(addData),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },async args=>run(async()=>{
    const refreshed=await loadConfig(configPath);
    const result=await registry.addSource(args.manifest_path,refreshed,async candidate=>{await credentials.load(candidate.binding);});
    registerResource(result.source.id);
    return ok({source:result.source.id,source_revision:result.source.revision,endpoint_count:result.source.endpoints.length,action:result.action,resource_uri:`inventory://sources/${encodeURIComponent(result.source.id)}/manifest.json`},result.source.warnings);
  }));
  return {server,registry,discovery,learning,credentials,config};
}

async function main(){
  const index=process.argv.indexOf('--config');
  if(index<0||!process.argv[index+1])throw new GatewayError('CONFIG_REQUIRED','用法: node dist/server.js --config /absolute/path/gateway.yaml');
  const {server}=await createGateway(path.resolve(process.argv[index+1]));
  await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(e=>{process.stderr.write(JSON.stringify({ok:false,error:{code:e instanceof GatewayError?e.code:'STARTUP_FAILED',message:e instanceof GatewayError?e.message:'网关启动失败'}})+'\n');process.exitCode=1;});
}
