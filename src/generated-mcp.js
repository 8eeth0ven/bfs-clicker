import {readFileSync} from 'node:fs';
import {McpServer,fromJsonSchema} from '@modelcontextprotocol/server';
import {StdioServerTransport,serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod/v4';
import {createSoftwareRuntime} from './software-runtime.js';
import {createSoftwareOperations} from './software-operations.js';
import {redactText} from './redact.js';
export async function startGeneratedMcp({runtimeFile,sourceId,sourceRevision}){
 const runtime=createSoftwareRuntime(JSON.parse(readFileSync(runtimeFile,'utf8'))),operations=createSoftwareOperations(runtime),servers=[];
 const wrap=fn=>async args=>{try{if(runtime.getSource(sourceId).revision!==sourceRevision)throw new Error('SOURCE_CHANGED：请重新生成MCP入口');const value=await fn(args);return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}catch(e){return {isError:true,content:[{type:'text',text:redactText(e.message)}]}}};
 const factory=()=>{
  const server=new McpServer({name:'bfs-'+sourceId,version:'0.1.0'},{instructions:'此服务由BFS Clicker根据来源证据生成。先查询能力参数和revision；调用返回operationId，通过operation_status读取结果。候选和上下文不是已验证业务。写流程若返回writeOutcome.status=unknown，应核对目标实际状态，勿因断言失败或连接中断直接重复调用。'});servers.push(server);
  server.registerTool('list_capabilities',{description:'分页读取当前来源能力与参数契约',inputSchema:z.object({offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()}).strict()},wrap(args=>runtime.listCapabilities({sourceId,...args})));
  server.registerTool('call_capability',{description:'按capabilityId与当前revision调用任意已就绪能力',inputSchema:z.object({capabilityId:z.string(),expectedRevision:z.string(),params:z.record(z.string(),z.json()).optional()}).strict()},wrap(args=>operations.start('execute',{sourceId,...args})));
  server.registerTool('operation_status',{description:'查询本服务调用的后台操作状态',inputSchema:z.object({operationId:z.string().uuid()}).strict()},async args=>{const value=operations.status(args);return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}});
  if(runtime.config.nativeVisual?.[sourceId]&&['apk','ios'].includes(runtime.getSource(sourceId).kind))server.registerTool('observe_mobile',{description:'对已绑定设备截屏并返回本地OCR观察，不执行界面动作',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(()=>operations.start('observe-mobile',{sourceId,expectedRevision:sourceRevision})));
  const caps=runtime.listCapabilities({sourceId,limit:100}).items.filter(c=>c.readiness==='ready').slice(0,80);
  for(const cap of caps)server.registerTool('cap_'+cap.id.slice(4,24),{description:(cap.name+' · '+cap.description).slice(0,1500),inputSchema:fromJsonSchema(cap.inputSchema),annotations:{readOnlyHint:false,destructiveHint:cap.effect!=='read',idempotentHint:false,openWorldHint:true}},wrap(params=>operations.start('execute',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params})));
  return server;
 };
 const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:524288});const handle=serveStdio(factory,{transport});let closing;
 const close=()=>closing||=(async()=>{await operations.shutdown();await Promise.all(servers.map(s=>s.close()));await handle.close()})();const onclose=transport.onclose;transport.onclose=()=>{onclose?.();void close()};process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
}
