#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const at=process.argv.indexOf('--config');
const config=at>=0?path.resolve(process.argv[at+1]):path.join(root,'examples/gateway.yaml');
const server={command:process.execPath,args:[path.join(root,'dist/server.js'),'--config',config]};
if(process.argv.includes('--cursor'))server.type='stdio';
process.stdout.write(JSON.stringify({mcpServers:{'endpoint-inventory':server}},null,2)+'\n');
