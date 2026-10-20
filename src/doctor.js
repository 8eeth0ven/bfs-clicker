import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, unlinkSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { readSession } from './asset.js';
export async function doctor(options={},log=console.log) {
  const checks=[];const add=(name,ok,detail,optional=false)=>{checks.push({name,ok,detail,optional});log((ok?'✓ ':'✗ ')+name+' · '+detail)};
  const major=Number(process.versions.node.split('.')[0]);add('Node',major>=20,process.version+' (要求 >=20)');
  try{const browser=await chromium.launch({headless:true,channel:options.channel||undefined,timeout:15000});add('Chromium',true,browser.version());await browser.close()}
  catch(e){add('Chromium',false,'安装: npx playwright install chromium；'+e.message.split('\n')[0])}
  const output=path.resolve(options.outputDir||'output-doctor');
  try{mkdirSync(output,{recursive:true});const file=path.join(output,'.doctor-'+randomUUID());writeFileSync(file,'ok');unlinkSync(file);const disk=statfsSync(output);add('输出目录',true,output+' · 可用 '+Math.round(disk.bavail*disk.bsize/1024/1024)+' MB')}
  catch(e){add('输出目录',false,e.message)}
  if(options.storageState){try{const session=readSession(options.storageState);add('Session',true,session.cookies.length+' cookies / '+session.origins.length+' origins')}catch(e){add('Session',false,e.message)}}
  if(options.useProxy){
    try{const url=new URL(options.proxy.server);await new Promise((resolve,reject)=>{const socket=net.connect(Number(url.port||80),url.hostname);socket.setTimeout(2000);socket.once('connect',()=>{socket.destroy();resolve()});socket.once('error',reject);socket.once('timeout',()=>{socket.destroy();reject(new Error('代理连接超时'))})});add('代理端口',true,'TCP 连通，实际 HTTPS 转发需运行验证')}
    catch(e){add('代理端口',false,e.message)}
  }
  add('Python',true,'可选：完整 Python 测试需要 python3；核心爬虫和查看器无需 Python',true);
  return {ok:checks.filter(c=>!c.optional).every(c=>c.ok),checks};
}
