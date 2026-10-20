import { createServer } from 'node:http';
import { realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createControlPanel } from './control.js';
import { sendText, serveRunFile } from './files.js';

export { createControlPanel };

// Kept for embedding a report-only server and security regression tests.
export function createViewer(runDir) {
  const root=realpathSync(path.resolve(runDir));
  return createServer((req,res)=>{
    if(!['GET','HEAD'].includes(req.method))return sendText(res,405,'read only');
    const port=res.socket?.localPort;
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host||''))return sendText(res,403,'invalid host');
    let name;
    try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'report.html';}
    catch{return sendText(res,400,'invalid path');}
    try{return serveRunFile(req,res,root,name);}catch{return sendText(res,404,'not found');}
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{
    run:{type:'string'},port:{type:'string',default:process.env.BFS_VIEW_PORT||'4177'},
    'output-root':{type:'string'},config:{type:'string'},'read-only':{type:'boolean'},help:{type:'boolean'},
  }});
  if(values.help){
    console.log('用法: npm run view [-- --port 4177 --run 运行目录 --config 配置.json]\n      npm run view -- --run 运行目录 --read-only');
  }else{
    const port=Number(values.port);
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error('port 无效');
    let panel,server;
    if(values['read-only']){
      if(!values.run)throw new Error('--read-only 需要 --run 运行目录');
      server=createViewer(values.run);
    }else{
      const baseConfig=values.config?JSON.parse(readFileSync(path.resolve(values.config),'utf8')):{};
      panel=createControlPanel({initialRun:values.run||null,outputRoot:values['output-root'],baseConfig});
      server=panel.server;
    }
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    console.log((panel?'本地操作面板':'只读查看器')+': http://127.0.0.1:'+server.address().port+'/');
    const shutdown=()=>{if(panel)panel.shutdown().catch(error=>{console.error(error.message);process.exitCode=1;});else{server.closeAllConnections();server.close();}};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  }
}
