#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBfsMcpServer } from './mcp-server.js';
import { createJobManager } from './mcp-jobs.js';
import { PROJECT_ROOT } from './config.js';
import { redactText } from './redact.js';

async function main() {
  const {values}=parseArgs({options:{'output-root':{type:'string'},config:{type:'string'},help:{type:'boolean'}},strict:true});
  if(values.help){process.stderr.write('用法: bfs-clicker-mcp [--output-root DIR] [--config FILE]\n仅 stdio MCP；stdout 为协议消息，日志在 stderr。\n');return;}
  let baseConfig={};
  if(values.config){
    const file=path.resolve(values.config);baseConfig=JSON.parse(readFileSync(file,'utf8'));
    if(!baseConfig||typeof baseConfig!=='object'||Array.isArray(baseConfig))throw new Error('config 必须是对象');
    for(const key of ['storageState','persistentProfile','sessionWritebackTo'])if(baseConfig[key])baseConfig[key]=path.resolve(path.dirname(file),baseConfig[key]);
  }
  const manager=createJobManager({outputRoot:path.resolve(values['output-root']||process.env.BFS_MCP_OUTPUT_ROOT||path.join(PROJECT_ROOT,'output-runs')),baseConfig});
  const apps=new Set(); let finishing=false;
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:262144});
  // The official entry point negotiates modern and legacy clients. A discovery
  // probe may be discarded, so only closure of the physical pipe stops jobs.
  const handle=serveStdio(()=>{const app=createBfsMcpServer({manager});apps.add(app);return app.server;},
    {transport,onerror:error=>process.stderr.write('[MCP] '+redactText(error.message).slice(0,2000)+'\n')});
  const finish=async()=>{if(finishing)return;finishing=true;try{
    await manager.shutdown(); await Promise.all([...apps].map(app=>app.shutdown())); await handle.close();
  }catch(error){process.stderr.write('[MCP] '+redactText(error.message)+'\n');process.exitCode=1;}};
  const onclose=transport.onclose;
  transport.onclose=()=>{onclose?.();void finish();};
  process.once('SIGINT',()=>{void finish();});process.once('SIGTERM',()=>{void finish();});
}
await main().catch(error=>{process.stderr.write('[MCP] '+redactText(error.message)+'\n');process.exitCode=1;});
