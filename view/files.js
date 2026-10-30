import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPORT_CSP, GRAPH_CSP } from '../src/redact.js';

const PUBLIC_FILES = new Set(['report.html','overview.html','report.md','tree.json','run.json',
  'manifest.json','routes.json','apis.json','requests.json','unexplored-actions.json',
  'api_routes.txt','js_endpoints.txt','events.jsonl','graph.html','graph.json','graph.js','graph.css','graph.dot']);

export function sendText(res,status,message) {
  res.writeHead(status,{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-store'});
  res.end(message);
}

export function serveRunFile(req,res,runDir,name='report.html') {
  if(!PUBLIC_FILES.has(name)&&!/^states\/\d+\.(png|jpg)$/.test(name))return sendText(res,404,'not available');
  const root=realpathSync(runDir),target=path.resolve(root,name);
  if(!existsSync(target))return sendText(res,404,'not found');
  const real=realpathSync(target),relative=path.relative(root,real);
  if(relative.startsWith('..')||path.isAbsolute(relative)||relative.split(path.sep).includes('private')||!statSync(real).isFile())return sendText(res,403,'outside run');
  const types={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
  res.writeHead(200,{'content-type':types[path.extname(real)]||'text/plain; charset=utf-8',
    'content-security-policy':(name.startsWith('graph.')?GRAPH_CSP:REPORT_CSP)+"; frame-ancestors 'self'",'x-content-type-options':'nosniff',
    'cache-control':'no-store','referrer-policy':'no-referrer'});
  if(req.method==='HEAD')return res.end();
  createReadStream(real).on('error',()=>res.destroy()).pipe(res);
}
