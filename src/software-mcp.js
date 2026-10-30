#!/usr/bin/env node
import path from 'node:path';
import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {z} from 'zod/v4';
import {StdioServerTransport,serveStdio} from '@modelcontextprotocol/server/stdio';
import {createBfsMcpServer} from './mcp-server.js';
import {createSoftwareRuntime} from './software-runtime.js';
import {createSoftwareOperations} from './software-operations.js';
import {redactText} from './redact.js';
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),revision=z.string().regex(/^[a-f0-9]{64}$/);
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
export function createSoftwareServer(options={}){
 const runtime=createSoftwareRuntime(options),operations=createSoftwareOperations(runtime);
 const apps=new Set();
 const factory=()=>{
  const app=createBfsMcpServer({outputRoot:path.join(runtime.root,'runs'),baseConfig:runtime.config.webConfig||{}});apps.add(app);const server=app.server;
  const tool=(name,description,shape,read,fn)=>server.registerTool(name,{description,inputSchema:z.object(shape).strict(),annotations:{readOnlyHint:read,destructiveHint:!read,idempotentHint:read,openWorldHint:!read}},async args=>{try{return result(await fn(args))}catch(e){return {isError:true,content:[{type:'text',text:redactText(e.message).slice(0,2000)}]}}});
  tool('software_discover','探索网站、提取APK/IPA/App Bundle或导入已有移动清单，自动编译HTTP与可执行UI能力。耗时操作返回operationId。deviceName仅引用启动时绑定的设备配置。',{kind:z.enum(['web','apk','ios']),input:z.string().min(1).max(8192),sourceId:id.optional(),deviceName:id.optional(),webOptions:z.object({limitMode:z.enum(['default','custom','unlimited']).optional(),maxStates:z.number().int().positive().optional(),maxDepth:z.number().int().nonnegative().optional(),maxDurationMs:z.number().int().positive().optional(),maxRequests:z.number().int().positive().optional(),maxActions:z.number().int().positive().optional(),maxStatesPerHost:z.number().int().positive().optional(),requestDelayMs:z.number().int().nonnegative().optional(),shotFormat:z.enum(['none','png','jpeg','jpg']).optional(),order:z.enum(['bfs','dfs']).optional(),resourcePolicy:z.enum(['strict','flexible']).optional(),navigationOrigins:z.array(z.string()).optional(),requestOrigins:z.array(z.string()).optional(),credentialOrigins:z.array(z.string()).optional(),seedRoutes:z.array(z.string()).optional(),excludeSelectors:z.array(z.string()).optional(),actionAllowlist:z.array(z.string()).optional(),requestAllowlist:z.array(z.json()).optional()}).strict().optional()},false,args=>operations.start('discover',args));
  tool('software_import','从可信artifactRoots导入归一化接口文件或APK/iOS清单目录并编译能力；调用范围取启动配置bindings。',{sourceId:id,kind:z.enum(['web','apk','ios']),inventoryPath:z.string().min(1).max(8192),expectedRevision:revision.optional()},false,args=>operations.start('compile',args));
  tool('software_import_openapi','从artifactRoots中的OpenAPI/Swagger JSON/YAML文档生成参数契约与MCP能力；只处理文档本地引用，范围仍取可信来源配置。',{sourceId:id,documentPath:z.string().min(1).max(8192),documentUrl:z.string().url().optional(),expectedRevision:revision.optional(),merge:z.boolean().optional()},false,args=>operations.start('import-openapi',args));
  tool('software_workflows','从已探索Web或当前原生App识别参数化查询候选；返回输入schema与结果区域标识。原生读取使用已绑定设备，候选仍须变化样本验证。',{sourceId:id,offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()},true,args=>runtime.planWorkflows(args));
  tool('software_bind_workflow','用可信本地spec或已发现候选加至少两组样本实际执行并验证参数化流程。写入spec须在启动配置分别批准执行和学习，学习会产生真实写入。候选模式须选择结果断言，验证成功后加入来源能力。',{sourceId:id,expectedRevision:revision,specPath:z.string().min(1).max(8192).optional(),candidateId:id.optional(),samples:z.array(z.record(z.string(),z.json())).min(2).max(5).optional(),outputTargetId:id.optional(),assertParam:z.string().min(1).max(128).optional(),resultAssertions:z.array(z.object({outputTargetId:id,param:z.string().min(1).max(128),representation:z.enum(['value','optionLabel']).optional(),valueMap:z.record(z.string().max(128),z.string().max(512)).optional(),separator:z.string().max(32).optional(),timeoutMs:z.number().int().min(0).max(10000).optional(),changedFromBefore:z.boolean().optional()}).strict()).min(1).max(32).optional()},false,args=>operations.start('bind-workflow',args));
  tool('software_observe_mobile','读取启动配置批准的移动设备截图，并用本地 OCR 返回有界、不可信的视觉观察；不执行界面动作。',{sourceId:id,expectedRevision:revision},true,args=>operations.start('observe-mobile',args));
  tool('software_sources','读取已编译来源与当前revision。',{},true,()=>({sources:runtime.listSources()}));
  tool('software_capabilities','按来源浏览已生成能力的参数schema、证据和执行状态；候选不冒充可调用。',{sourceId:id,kind:z.enum(['http','browser','mobile']).optional(),search:z.string().max(256).optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()},true,args=>runtime.listCapabilities(args));
  tool('software_call','调用已生成能力；必须使用发现时返回的capability revision。HTTP/浏览器/移动UI分别通过已有后端执行，返回后台operationId。',{sourceId:id,capabilityId:z.string().regex(/^cap_[a-f0-9]{64}$/),expectedRevision:revision,params:z.record(z.string(),z.json()).optional()},false,args=>operations.start('execute',args));
  tool('software_validate','实际执行一次能力并保存验证记录；HTTP响应不自动证明业务语义成功。',{sourceId:id,capabilityId:z.string().regex(/^cap_[a-f0-9]{64}$/),expectedRevision:revision,params:z.record(z.string(),z.json()).optional()},false,args=>operations.start('validate',args));
  tool('software_refresh','重新读取原来源证据，生成修订与差异；旧入口会明确拒绝过期revision。',{sourceId:id,expectedRevision:revision},false,args=>operations.start('refresh',args));
  tool('software_generate','生成某来源的独立MCP入口、能力manifest和客户端配置；必须核对来源revision。',{sourceId:id,expectedRevision:revision},false,args=>operations.start('generate',args));
  tool('software_operation','读取后台软件探索、执行、验证和生成状态。',{operationId:z.string().uuid()},true,args=>operations.status(args));
  tool('software_stop','停止本连接启动的后台操作。',{operationId:z.string().uuid()},false,args=>operations.stop(args));
  tool('software_resume','继续已保存的探索任务。',{operationId:z.string().uuid()},false,args=>operations.resume(args));
  tool('software_compile_web','将同一服务bfs工具生成的run编译为可调用HTTP/浏览器能力。',{runId:id,sourceId:id},false,({runId,sourceId})=>{const dir=app.manager.getRunDir(runId);if(app.manager.status({runId}).active)throw new Error('请等待探索结束');return operations.start('compile',{sourceId,runDir:dir,kind:'web'});});
  return server;
 };
 return {runtime,operations,factory,async shutdown(){await operations.shutdown();await Promise.all([...apps].map(a=>a.shutdown()));}};
}
export async function startSoftwareMcp(options={}){
 const app=createSoftwareServer(options);const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:524288});
 const handle=serveStdio(app.factory,{transport,onerror:e=>process.stderr.write('[software-mcp] '+redactText(e.message)+'\n')});let closing;
 const close=()=>closing||=(async()=>{await app.shutdown();await handle.close()})();const original=transport.onclose;transport.onclose=()=>{original?.();void close();};process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());return app;
}
async function main(){const{values}=parseArgs({options:{config:{type:'string'},'output-root':{type:'string'},'artifact-root':{type:'string',multiple:true},python:{type:'string'}}});const config=values.config?JSON.parse(readFileSync(path.resolve(values.config),'utf8')):{};if(values['output-root'])config.outputRoot=path.resolve(values['output-root']);if(values['artifact-root'])config.artifactRoots=values['artifact-root'].map(p=>path.resolve(p));if(values.python)config.python=path.resolve(values.python);await startSoftwareMcp(config);}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main().catch(e=>{process.stderr.write(redactText(e.message)+'\n');process.exitCode=1});
