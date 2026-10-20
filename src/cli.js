import { parseArgs } from 'node:util';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { normalizeConfig, DEFAULTS, EXPLORATION_LIMITS } from './asset.js';
import { runAsset } from './runner.js';
import { doctor } from './doctor.js';
import { readAtomic } from './store.js';

const options={asset:{type:'string'},output:{type:'string'},run:{type:'string'},config:{type:'string'},
  profile:{type:'string'},'browser-profile':{type:'string'},session:{type:'string'},proxy:{type:'string'},
  channel:{type:'string'},'resource-policy':{type:'string'},'scope-origin':{type:'string',multiple:true},
  'request-origin':{type:'string',multiple:true},'credential-origin':{type:'string',multiple:true},
  'max-states':{type:'string'},'max-depth':{type:'string'},'max-duration':{type:'string'},
  'max-requests':{type:'string'},'max-actions':{type:'string'},'max-states-per-host':{type:'string'},'max-tabs':{type:'string'},'max-retries':{type:'string'},
  'limit-mode':{type:'string'},unlimited:{type:'boolean'},
  'request-delay':{type:'string'},'logged-in-selector':{type:'string'},'logged-in-url':{type:'string'},
  'auth-probe':{type:'string'},'exclude-selector':{type:'string',multiple:true},
  'action-allow':{type:'string',multiple:true},'request-allow':{type:'string',multiple:true},
  headed:{type:'boolean'},'agree-consent':{type:'boolean'},'no-screenshots':{type:'boolean'},
  help:{type:'boolean'},json:{type:'boolean'}};
export async function main(args=process.argv.slice(2)) {
  const mode=args[0]&&!args[0].startsWith('-')?args.shift():'run';
  const {values}=parseArgs({args,options,strict:true});
  if(values.help){console.log('用法: npm run run -- --asset http://localhost:3100/ [--output output-example] [--profile safe]\n      npm run run -- --asset URL --unlimited\n      npm run resume -- --run output-example [--max-depth 5 | --unlimited]\n      npm run view\n      npm run doctor\n      npm run login -- --asset URL --logged-in-selector SELECTOR\n预算模式: --limit-mode default|custom|unlimited；--max-duration 单位秒，max-depth=0 仅探索根状态。');return;}
  if(!['run','crawl','resume','demo','login','doctor'].includes(mode))throw new Error('未知命令: '+mode);
  let input={};
  if(values.run){
    if(mode!=='resume')throw new Error('--run 仅用于 resume；查看请使用 npm run view');
    const runDir=path.resolve(values.run);const snapshot=path.join(runDir,'private','config.json');
    input=readAtomic(snapshot);delete input._policy;delete input._runtime;input.outputDir=runDir;
  }else if(values.config){const file=path.resolve(values.config);input=JSON.parse(readFileSync(file,'utf8'));input._configPath=file;}
  else if(['crawl','demo','login','resume'].includes(mode)&&!values.asset)input=loadConfig(mode);
  if(values.asset)input.startUrl=values.asset;
  if(values.output)input.outputDir=path.resolve(values.output);
  if(values.profile)input.actionProfile=values.profile;
  if(values['browser-profile'])input.persistentProfile=path.resolve(values['browser-profile']);
  if(values.session)input.storageState=path.resolve(values.session);
  if(values.proxy){input.useProxy=true;input.proxy={server:values.proxy};}
  if(values.channel)input.channel=values.channel;
  if(values['resource-policy'])input.resourcePolicy=values['resource-policy'];
  if(values['scope-origin'])input.navigationOrigins=values['scope-origin'];
  if(values['request-origin'])input.requestOrigins=values['request-origin'];
  if(values['credential-origin'])input.credentialOrigins=values['credential-origin'];
  if(values.unlimited&&values['limit-mode']&&values['limit-mode']!=='unlimited')throw new Error('--unlimited 与 --limit-mode 冲突');
  if(values['limit-mode'])input.limitMode=values['limit-mode'];
  if(values.unlimited)input.limitMode='unlimited';
  const limitFlags=['max-states','max-depth','max-requests','max-actions','max-states-per-host','max-duration'];
  if(limitFlags.some(flag=>values[flag]!=null)&&input.limitMode!=='unlimited')input.limitMode='custom';
  if(input.limitMode==='default')for(const key of EXPLORATION_LIMITS)delete input[key];
  if(input.limitMode==='custom')for(const key of EXPLORATION_LIMITS)if(input[key]==null)input[key]=DEFAULTS[key];
  for(const [flag,key] of Object.entries({'max-states':'maxStates','max-depth':'maxDepth','max-requests':'maxRequests','max-actions':'maxActions','max-states-per-host':'maxStatesPerHost','max-tabs':'maxTabs','max-retries':'maxRetries','request-delay':'requestDelayMs'}))if(values[flag]!=null)input[key]=Number(values[flag]);
  if(values['max-duration']!=null)input.maxDurationMs=Math.round(Number(values['max-duration'])*1000);
  if(values.headed)input.headless=false;
  if(values['agree-consent'])input.autoAgreeConsent=true;
  if(values['no-screenshots'])input.shotFormat='none';
  input.auth={...input.auth};
  if(values['logged-in-selector'])input.auth.loggedInSelector=values['logged-in-selector'];
  if(values['logged-in-url'])input.auth.loggedInUrlPattern=values['logged-in-url'];
  if(values['auth-probe'])input.auth.probeUrl=values['auth-probe'];
  if(values['exclude-selector'])input.excludeSelectors=values['exclude-selector'];
  if(values['action-allow'])input.actionAllowlist=values['action-allow'];
  if(values['request-allow'])input.requestAllowlist=values['request-allow'].map(raw=>{const match=raw.match(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (https?:\/\/\S+)$/);if(!match)throw new Error('--request-allow 格式: "POST http://localhost/api/query"');return {method:match[1],url:match[2]}});
  if(mode==='doctor'){const result=await doctor(input);if(values.json)console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;return result;}
  if(!input.startUrl)throw new Error('请提供 --asset HTTP(S) URL');
  if(mode==='login'){input.authMode='manual';input.headless=false;input.maxDurationMs=input.loginTimeoutMs||600000;}
  const config=normalizeConfig(input,{baseDir:PROJECT_ROOT,legacy:!!input._legacy});
  if(process.env.BFS_PIDFILE)writeFileSync(process.env.BFS_PIDFILE,String(process.pid));
  let demo=null;
  try{
    if(mode==='demo'){
      demo=spawn(process.execPath,[path.join(PROJECT_ROOT,'demo','server.js')],{stdio:['ignore','pipe','inherit'],windowsHide:true});
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('demo 启动超时')),5000);demo.stdout.on('data',chunk=>{if(String(chunk).includes('listening')){clearTimeout(timer);resolve()}});demo.once('exit',()=>{clearTimeout(timer);reject(new Error('demo 服务退出'))})});
    }
    console.log('[任务] '+config.runId+' · '+config.startUrl+'\n[输出] '+config.outputDir);
    const result=await runAsset(config,{resume:mode==='resume'||process.env.RESUME==='1',manualLogin:mode==='login'});
    console.log(JSON.stringify({runId:result.runId,status:result.status,stopReason:result.stopReason,pending:result.pending,outputDir:config.outputDir}));
    process.exitCode=result.status==='failed'?1:result.stopReason==='consecutive_failures'?42:0;return result;
  }finally{demo?.kill();}
}
