#!/usr/bin/env node
// Offline, local-only canvas fixture for the documented visual workflow.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{port:{type:'string',default:'3102'}}});
const port=Number(values.port);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
const html=readFileSync(new URL('../examples/software/visual-canvas-demo.html',import.meta.url));let count=0;
const server=createServer(async(req,res)=>{
 try{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method==='GET'&&pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;}
  if(req.method==='POST'&&pathname==='/query'){
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){res.writeHead(413);res.end();return;}}
   const value=JSON.parse(body);if(typeof value.query!=='string'||!/^[a-z]{2,20}$/.test(value.query)){res.writeHead(400);res.end();return;}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({query:value.query,count:++count}));return;
  }
  res.writeHead(404);res.end();
 }catch{if(!res.headersSent)res.writeHead(400);res.end();}
});
server.listen(port,'127.0.0.1',()=>process.stdout.write('Canvas demo: http://127.0.0.1:'+server.address().port+'\n'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close();});
