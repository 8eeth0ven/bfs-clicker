#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {values}=parseArgs({options:{format:{type:'string',default:'json'},'output-root':{type:'string'},config:{type:'string'}},strict:true});
if(!['json','toml'].includes(values.format))throw new Error('--format 只能是 json 或 toml');
const args=[path.join(root,'src/mcp.js'),'--output-root',path.resolve(values['output-root']||path.join(root,'output-runs'))];
if(values.config)args.push('--config',path.resolve(values.config));
const config={command:process.execPath,args,cwd:root};
if(values.format==='json')console.log(JSON.stringify({mcpServers:{'bfs-clicker':config}},null,2));
else console.log('[mcp_servers.bfs-clicker]\ncommand = '+JSON.stringify(config.command)+'\nargs = '+JSON.stringify(args)+'\ncwd = '+JSON.stringify(root)+'\nstartup_timeout_sec = 20\ntool_timeout_sec = 60');
