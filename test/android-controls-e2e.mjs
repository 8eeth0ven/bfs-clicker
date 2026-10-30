#!/usr/bin/env node
// Explicit, opt-in device acceptance: node test/android-controls-e2e.mjs.
// Creates its own AVD/data, installs only this repo's synthetic APK, and never
// edits global proxy/CA/settings or wipes an existing AVD.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const project=path.resolve(import.meta.dirname,'..');
const {values}=parseArgs({options:{sdk:{type:'string'},python:{type:'string'},output:{type:'string'},'reuse-owned-emulator':{type:'boolean'},'keep-emulator-data':{type:'boolean'}}});
const sdk=path.resolve(values.sdk||path.join(os.homedir(),'Library/Android/sdk'));
const python=path.resolve(values.python||path.join(project,'.venv/bin/python'));
const output=path.resolve(values.output||path.join(project,'output-vision-implementation','android-controls-'+Date.now()));
const reportDir=path.join(project,'output-vision-implementation');
const app='com.example.inventorydemo',realAdb=existsSync('/opt/homebrew/bin/adb')?'/opt/homebrew/bin/adb':path.join(sdk,'platform-tools/adb');
let adb=realAdb;
const targetOrigin='http://127.0.0.1:8765';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record={date:new Date().toISOString(),status:'running',kind:'real_android_controls',outputDir:output,steps:[],apiRequests:[],scope:{existingAvdWiped:false,userAppUninstalled:false,globalProxyChanged:false,caInstalled:false},cleanup:{}};
let emulatorReceipt,emulatorChild,client,generatedClient,http,serial,installed=false,interrupted=false,ownedAdbPort;
const log=(phase,detail={})=>{record.steps.push({phase,at:new Date().toISOString(),...detail});process.stdout.write(JSON.stringify({phase,...detail})+'\n');};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const save=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
async function run(exe,args,{timeout=120000,allowFailure=false,binary=false}={}){
 const child=spawn(exe,args,{cwd:project,env:{...process.env,PYTHONPATH:path.join(project,'apk_tools'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
 let stdout=[],stderr=[],bytes=0,tooLarge=false;
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){tooLarge=true;child.kill('SIGTERM');}else stdout.push(chunk);});
 child.stderr.on('data',chunk=>{stderr.push(chunk);if(Buffer.concat(stderr).length>131072)stderr=stderr.slice(-4);});
 let killTimer;const timer=setTimeout(()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1500)},timeout);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>{clearTimeout(timer);clearTimeout(killTimer)});
 const result={code,stdout:binary?Buffer.concat(stdout):Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()};
 if(!allowFailure&&(code!==0||tooLarge))throw new Error(`${path.basename(exe)} failed (${code}): ${result.stderr.slice(-1500)}`);
 return result;
}
const device=(...args)=>run(adb,['-s',serial,...args]);
const sh=(...args)=>device('shell',args.map(shellQuote).join(' '));
async function until(fn,label,timeout=180000){
 const deadline=Date.now()+timeout;let lastLog=0;
 while(Date.now()<deadline){if(interrupted)throw new Error('interrupted');const value=await fn();if(value)return value;if(Date.now()-lastLog>15000){log('waiting',{for:label});lastLog=Date.now();}await delay(500);}
 throw new Error('Timeout: '+label);
}
function ownedProcess(receipt){
 if(!receipt?.isolatedNewData||!receipt?.avd?.startsWith(output+path.sep))return false;
 try{const command=execFileSync('ps',['-p',String(receipt.pid),'-o','command='],{encoding:'utf8'});return command.includes(path.basename(receipt.avd,'.avd'));}catch{return false;}
}
async function portFree(port){return await new Promise(resolve=>{const server=createNetServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});}
function adbEnvironment(port,key){
 assert.ok(Number.isInteger(port)&&port!==5037,'Never change the global ADB server');ownedAdbPort=port;
 Object.assign(process.env,{ADB_SERVER_SOCKET:'tcp:127.0.0.1:'+port,ANDROID_ADB_SERVER_PORT:String(port),ADB_VENDOR_KEYS:key,ANDROID_USER_HOME:path.join(output,'android-user')});
 record.scope.isolatedAdbServerPort=port;record.scope.globalAdbServerRestarted=false;
}
async function startEmulator(){
 const receiptFile=path.join(output,'emulator-receipt.json');
 if(values['reuse-owned-emulator']){
  emulatorReceipt=await json(receiptFile);assert.ok(ownedProcess(emulatorReceipt),'Only a live emulator owned by this output receipt may be reused');
  assert.ok(emulatorReceipt.adbServerOwned&&emulatorReceipt.adbKey?.startsWith(output+path.sep),'Reuse requires an owned isolated ADB server/key receipt');
  adbEnvironment(emulatorReceipt.adbServerPort,emulatorReceipt.adbKey);serial=emulatorReceipt.serial;return;
 }
 assert.ok(!existsSync(receiptFile),'Choose a new --output or explicitly --reuse-owned-emulator');
 const imageRoot=path.join(sdk,'system-images');
 const images=[];
 for(const api of await readdir(imageRoot))for(const vendor of await readdir(path.join(imageRoot,api)))for(const arch of await readdir(path.join(imageRoot,api,vendor)))if(arch==='arm64-v8a'&&existsSync(path.join(imageRoot,api,vendor,arch,'system.img')))images.push({api,vendor,arch});
 images.sort((a,b)=>Number(b.api.replace('android-',''))-Number(a.api.replace('android-','')));assert.ok(images[0],'No compatible local arm64 Android system image');
 const image=images[0],name='BFS_MCP_'+hash(output).slice(0,12),avdHome=path.join(output,'avd'),avd=path.join(avdHome,name+'.avd');
 await mkdir(avd,{recursive:true});
 const config={AvdId:name,'avd.ini.displayname':'BFS isolated Android acceptance','avd.ini.encoding':'UTF-8','abi.type':image.arch,'hw.cpu.arch':'arm64','hw.cpu.ncore':'2','hw.ramSize':'2048','disk.dataPartition.size':'2G','hw.lcd.width':'720','hw.lcd.height':'1280','hw.lcd.density':'320','hw.keyboard':'yes','hw.mainKeys':'no','hw.gpu.enabled':'yes','hw.gpu.mode':'swiftshader_indirect','hw.audioInput':'no','hw.camera.back':'none','hw.camera.front':'none','hw.sdCard':'no','showDeviceFrame':'no','fastboot.forceColdBoot':'yes','fastboot.forceFastBoot':'no','image.sysdir.1':`system-images/${image.api}/${image.vendor}/${image.arch}/`,'tag.id':image.vendor,target:image.api};
 await writeFile(path.join(avd,'config.ini'),Object.entries(config).map(([k,v])=>k+'='+v).join('\n')+'\n');
 await writeFile(path.join(avdHome,name+'.ini'),`avd.ini.encoding=UTF-8\npath=${avd}\ntarget=${image.api}\n`);
 let adbPort=5038;while(!await portFree(adbPort))adbPort++;
 const key=path.join(output,'emulator-home/adbkey');await mkdir(path.dirname(key),{recursive:true});await run(adb,['keygen',key]);adbEnvironment(adbPort,key);await run(adb,['-P',String(adbPort),'start-server']);
 // Outside the default ADB emulator auto-scan range, so the unrelated global
 // server does not race this isolated server's first authentication.
 let port=5650;while(!await portFree(port)||!await portFree(port+1))port+=2;
 const executable=path.join(sdk,'emulator/emulator');
 const command=[executable,'-avd',name,'-port',String(port),'-no-window','-no-audio','-no-boot-anim','-no-snapshot','-no-metrics','-skip-adb-auth','-gpu','swiftshader_indirect','-adb-path',realAdb];
 const fd=openSync(path.join(output,'emulator.log'),'a');
 emulatorChild=spawn(executable,command.slice(1),{cwd:project,env:{...process.env,ANDROID_SDK_ROOT:sdk,ANDROID_AVD_HOME:avdHome,ANDROID_EMULATOR_HOME:path.join(output,'emulator-home')},stdio:['ignore',fd,fd],detached:true});closeSync(fd);
 emulatorChild.unref();serial='emulator-'+port;
 emulatorReceipt={pid:emulatorChild.pid,serial,port,avd,avdHome,command,createdAt:Date.now(),existingAvdUntouched:true,isolatedNewData:true,adbServerPort:adbPort,adbServerOwned:true,adbKey:key};await save(receiptFile,emulatorReceipt);
}
async function waitBoot(){
 await until(async()=>{
  if(!ownedProcess(emulatorReceipt))throw new Error('Owned emulator exited before boot; inspect emulator.log');
  const result=await run(adb,['-s',serial,'shell','getprop','sys.boot_completed'],{timeout:8000,allowFailure:true});
  return result.code===0&&result.stdout.trim()==='1';
 },'isolated emulator boot',240000);
 record.device={serial,androidApi:(await sh('getprop','ro.build.version.sdk')).stdout.trim(),androidRelease:(await sh('getprop','ro.build.version.release')).stdout.trim(),abi:(await sh('getprop','ro.product.cpu.abi')).stdout.trim(),shellIdentity:(await sh('id')).stdout.trim(),avd:(await sh('getprop','ro.boot.qemu.avd_name')).stdout.trim()};
 record.proxyBefore=(await sh('settings','get','global','http_proxy')).stdout.trim();log('emulator_ready',{device:record.device});
}
async function launchFixture(proxyPort,drift=false){
 // Exact package is compiled by this repo and installed only on our isolated AVD.
 assert.equal(app,'com.example.inventorydemo');
 await sh('am','force-stop',app);
 await sh('am','start','-n',app+'/.DemoActivity','--es','base_url',targetOrigin,'--es','proxy_host','10.0.2.2','--ei','proxy_port',String(proxyPort),'--ez','controls_mode','true','--ez','controls_drift',String(drift));
 await until(async()=>/mResumedActivity|topResumedActivity/.test((await sh('dumpsys','activity','activities')).stdout)&& (await sh('dumpsys','activity','activities')).stdout.includes(app), 'fixture foreground',15000);
}
const content=reply=>reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
async function mcpCall(sdkClient,name,args={}){const reply=await sdkClient.callTool({name,arguments:args});assert.ok(!reply.isError,JSON.stringify(reply));return content(reply);}
async function completed(sdkClient,id,name='software_operation',expectedStatus='completed'){
 const result=await until(async()=>{const value=await mcpCall(sdkClient,name,{operationId:id});return ['completed','failed','cancelled','interrupted'].includes(value.status)?value:null;},'MCP '+id,180000);
 assert.equal(result.status,expectedStatus,JSON.stringify(result));return result;
}
async function connect(entry,args=[]){
 const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:project,stderr:'pipe',env:{...process.env}});
 transport.stderr?.on('data',chunk=>{record.mcpStderr=((record.mcpStderr||'')+chunk).slice(-16384);});
 const sdkClient=new Client({name:'bfs-real-android-emulator-acceptance',version:'1'});await sdkClient.connect(transport);return sdkClient;
}


const decodeXml=text=>text.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
async function tracedAdb(actor){
 const wrapper=path.join(output,'adb-'+actor+'-traced.cjs'),trace=path.join(output,'adb-commands.jsonl');
 const code=`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs');
const started=Date.now(),args=process.argv.slice(2),trace=${JSON.stringify(trace)},actor=${JSON.stringify(actor)},phase=process.env.BFS_ANDROID_PHASE||'acceptance';
const child=spawn(${JSON.stringify(realAdb)},args,{stdio:['ignore','pipe','pipe']});
fs.appendFileSync(trace,JSON.stringify({event:'start',pid:process.pid,childPid:child.pid,started,args,actor,phase})+'\\n');
let stderr='';child.stdout.pipe(process.stdout);child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);process.stderr.write(chunk)});
child.on('error',error=>{fs.appendFileSync(trace,JSON.stringify({event:'error',pid:process.pid,args,actor,phase,error:String(error)})+'\\n');process.exitCode=127});
child.on('close',(code,signal)=>{fs.appendFileSync(trace,JSON.stringify({event:'finish',pid:process.pid,started,elapsedMs:Date.now()-started,args,code,signal,stderr,actor,phase})+'\\n');process.exitCode=code??1});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
`;
 await writeFile(wrapper,code,{mode:0o700});record.adbTrace=trace;return wrapper;
}
async function traceRows(){if(!record.adbTrace||!existsSync(record.adbTrace))return [];return (await readFile(record.adbTrace,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}
async function productStarts(){return (await traceRows()).filter(row=>row.event==='start'&&row.actor==='product');}
async function traceSegment(before){return (await productStarts()).slice(before);}
const taps=rows=>rows.filter(row=>row.args[2]==='shell'&&row.args[3]?.startsWith('input tap '));
async function ownUi(label,{drift=false}={}){
 const remote='/sdcard/bfs-controls-'+hash(label+Date.now()).slice(0,20)+'.xml';let xml;
 try{await sh('uiautomator','dump',remote);xml=(await sh('cat',remote)).stdout;}finally{await sh('rm','-f',remote).catch(()=>{});}
 await writeFile(path.join(output,label+'.xml'),xml);
 const tags=[...xml.matchAll(/<node\b[^>]*>/g)].map(row=>row[0]);
 const attrs=tag=>Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(match=>[match[1],decodeXml(match[2])]));
 const nodes=tags.map(attrs),get=name=>{const matches=nodes.filter(node=>node['content-desc']===name);assert.equal(matches.length,1,'Owned control missing/ambiguous: '+name);return matches[0]};
 const archived=get(drift?'IncludeArchivedChanged':'IncludeArchived'),active=get('OnlyActive'),query=get('QueryText'),search=get('ControlsSearch'),result=get('ControlsResult');
 const count=nodes.find(node=>node.text?.startsWith('QUERIES:'));assert.ok(count);const values=count.text.match(/^QUERIES:(\d+);ARCHIVED_TAPS:(\d+);ACTIVE_TAPS:(\d+)$/);assert.ok(values);
 for(const node of [archived,active]){assert.equal(node.checkable,'true');assert.ok(['true','false'].includes(node.checked));}
 const center=node=>{const box=node.bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);assert.ok(box);return 'input tap '+Math.floor((Number(box[1])+Number(box[3]))/2)+' '+Math.floor((Number(box[2])+Number(box[4]))/2)};
 return {result:result.text,query:query.text,archived:archived.checked==='true',active:active.checked==='true',queries:Number(values[1]),archivedTaps:Number(values[2]),activeTaps:Number(values[3]),classes:{archived:archived.class,active:active.class},tapCommands:{archived:center(archived),active:center(active),query:center(query),search:center(search)}};
}
async function terminal(sdkClient,id,name='software_operation'){
 return until(async()=>{const value=await mcpCall(sdkClient,name,{operationId:id});return ['completed','failed','cancelled','interrupted'].includes(value.status)?value:null;},'controls MCP '+id,240000);
}
async function successful(sdkClient,started,name='software_operation'){
 const result=await terminal(sdkClient,started.operationId,name);assert.equal(result.status,'completed',JSON.stringify(result));if(result.type==='execute'||result.type==='validate')assert.equal(result.result?.result?.ok,true,JSON.stringify(result));return result;
}
function assertUi(state,{query,archived,active,queries,archivedTaps,activeTaps}){
 assert.equal(state.result,`RESULT:q=${query};archived=${archived};active=${active};queryId=${queries}`);assert.equal(state.query,query);assert.equal(state.archived,archived);assert.equal(state.active,active);assert.equal(state.queries,queries);if(archivedTaps!==undefined)assert.equal(state.archivedTaps,archivedTaps);if(activeTaps!==undefined)assert.equal(state.activeTaps,activeTaps);
}
async function audit(){
 const rows=await traceRows(),starts=rows.filter(row=>row.event==='start'),finished=rows.filter(row=>row.event==='finish'),done=new Set(finished.map(row=>row.pid));
 const groups=[['uiautomatorDump','uiautomator dump '],['tap','input tap '],['text','input text '],['keyevent','input keyevent '],['foreground','dumpsys activity '],['packagePath','pm path '],['artifactHash','sha256sum ']],counts={fixture:{},product:{}};
 for(const row of starts){const command=(row.args[3]||row.args.join(' ')).replaceAll("'",'');for(const[key,prefix]of groups)if(command.startsWith(prefix))counts[row.actor][key]=(counts[row.actor][key]||0)+1;}
 record.adbCommandAudit={scope:'fixture and product commands from startup, separately tagged; emulator internal -adb-path uses real adb',starts:starts.length,finished:finished.length,unmatched:starts.filter(row=>!done.has(row.pid)),failures:finished.filter(row=>row.code!==0),counts};
 const processList=execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean),knownPids=new Set(starts.flatMap(row=>[row.pid,row.childPid]));
 const owned=processList.filter(row=>knownPids.has(Number(row[1]))&&(row[2].includes(output+path.sep)||row[2].startsWith(realAdb+' ')&&row[2].includes(serial))).map(row=>({pid:Number(row[1]),command:row[2]}));
 const ports={};for(const port of [ownedAdbPort,emulatorReceipt?.port,emulatorReceipt?.port+1].filter(Number.isInteger)){const result=await run('/usr/sbin/lsof',['-nP','-t','-iTCP:'+port,'-sTCP:LISTEN'],{allowFailure:true});ports[port]={listening:!!result.stdout.trim(),pids:result.stdout.trim().split('\n').filter(Boolean)}}
 record.processCleanupAudit={ownedTracedProcessesRemaining:owned,ownedPorts:ports};
}
async function main(){
 await mkdir(output,{recursive:true});await mkdir(reportDir,{recursive:true});record.sourceSnapshot={};for(const file of ['apk_tools/apk_inventory/mobile_ui.py','apk_tools/apk_inventory/mobile_workflows.py','apk_tools/apk_inventory/mobile_planner.py','src/software-runtime.js','apk_tools/examples/demo/src/com/example/inventorydemo/DemoActivity.java'])record.sourceSnapshot[file]=hash(await readFile(path.join(project,file)));
 const existingFiles=[path.join(os.homedir(),'.android/avd/Medium_Phone.avd/config.ini'),path.join(os.homedir(),'.android/avd/Medium_Phone_API_36.0.ini')];record.originalAvdHashes={};for(const file of existingFiles)if(existsSync(file))record.originalAvdHashes[file]=hash(await readFile(file));
 try{
  process.env.BFS_ANDROID_PHASE='bootstrap';adb=await tracedAdb('fixture');const productAdb=await tracedAdb('product');
  await startEmulator();log('emulator_started',{serial,pid:emulatorReceipt.pid});await waitBoot();process.env.BFS_ANDROID_PHASE='acceptance';
  const apk=path.join(output,'controls-demo.apk');await run(python,[path.join(project,'apk_tools/examples/build_demo.py'),'--out',apk,'--sdk',sdk]);record.apk={path:apk,sha256:hash(await readFile(apk)),package:app};
  const inventory=path.join(output,'inventory');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);const descriptor=await json(path.join(inventory,'source.json'));assert.equal(descriptor.app.package_name,app);assert.equal(descriptor.app.apk_sha256,record.apk.sha256);
  await device('install','-r',apk);installed=true;const installedPath=(await sh('pm','path',app)).stdout.trim().split('\n').find(line=>line.startsWith('package:'))?.slice(8);assert.ok(installedPath);record.apk.installedSha256=(await sh('sha256sum',installedPath)).stdout.trim().split(/\s+/)[0];assert.equal(record.apk.installedSha256,record.apk.sha256);
  http=createServer(async(req,res)=>{let bytes=0;for await(const chunk of req)bytes+=chunk.length;record.apiRequests.push({method:req.method,url:req.url,bodyBytes:bytes});res.writeHead(403);res.end('owned controls stay local');});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));record.proxyPort=http.address().port;
  await launchFixture(record.proxyPort);record.initial=await ownUi('initial-controls');assert.equal(record.initial.queries,0);assert.equal(record.initial.archivedTaps,0);assert.equal(record.initial.activeTaps,0);assert.equal(record.initial.archived,false);assert.equal(record.initial.active,false);
  const deviceConfig={source:{id:descriptor.source_id,kind:'apk'},backend:{type:'adb',adb:productAdb,deviceId:serial,appId:app},limits:{maxActions:40,maxDepth:0,maxDurationMs:360000},actionAllowlist:[{kind:'type',selector:{accessibilityId:'QueryText'},effect:'read'},{kind:'check',selector:{accessibilityId:'IncludeArchived'},effect:'read'},{kind:'check',selector:{accessibilityId:'OnlyActive'},effect:'read'},{kind:'click',selector:{accessibilityId:'ControlsSearch'},effect:'read'}]};
  const deviceFile=path.join(output,'device.json');await save(deviceFile,deviceConfig);const cfg={outputRoot:path.join(output,'software'),artifactRoots:[output],python,devices:{owned_controls:deviceFile},bindings:{[descriptor.source_id]:{allowed_origins:[]}}};const configFile=path.join(output,'runtime.json');await save(configFile,cfg);
  client=await connect(path.join(project,'src/software-mcp.js'),['--config',configFile]);record.discovery=await successful(client,await mcpCall(client,'software_discover',{kind:'apk',input:apk,deviceName:'owned_controls'}));
  const sourceId=descriptor.source_id;let catalog=await mcpCall(client,'software_capabilities',{sourceId,kind:'mobile',limit:100});assert.equal(catalog.source.appArtifactVerified,true);record.artifactVerification=catalog.source.artifactVerification;
  const beforePlanning=(await productStarts()).length;record.plan=await mcpCall(client,'software_workflows',{sourceId,limit:100});assert.equal(taps(await traceSegment(beforePlanning)).length,0,'planning must be read-only');
  const candidate=record.plan.items.find(item=>Object.keys(item.inputSchema?.properties||{}).length===3&&Object.values(item.inputSchema.properties).filter(property=>property.type==='boolean').length===2);assert.ok(candidate,'Automatic mixed controls candidate missing: '+JSON.stringify(record.plan));assert.equal(candidate.outputTargets.length,1,JSON.stringify(candidate));assert.equal(candidate.readiness,'candidate');record.candidateCompleted=true;
  const properties=candidate.inputSchema.properties,keys=Object.keys(properties),queryKey=keys.find(key=>properties[key].type==='string'),archiveKey=keys.find(key=>/archived/i.test(key)),activeKey=keys.find(key=>/active/i.test(key));assert.ok(queryKey&&archiveKey&&activeKey);assert.equal(properties[archiveKey].type,'boolean');assert.equal(properties[activeKey].type,'boolean');record.paramKeys={query:queryKey,archived:archiveKey,active:activeKey};
  const params=(query,archived,active)=>({[queryKey]:query,[archiveKey]:archived,[activeKey]:active});const samples=[params('alpha',true,false),params('beta',false,true)];
  log('controls_learning_started',{candidateId:candidate.id,samples});record.learning=await successful(client,await mcpCall(client,'software_bind_workflow',{sourceId,expectedRevision:record.plan.source.revision,candidateId:candidate.id,samples,resultAssertions:keys.map(param=>({outputTargetId:candidate.outputTargets[0].id,param,changedFromBefore:true,timeoutMs:5000}))}));
  record.afterLearning=await ownUi('after-learning');assertUi(record.afterLearning,{query:'beta',archived:false,active:true,queries:2,archivedTaps:2,activeTaps:1});
  catalog=await mcpCall(client,'software_capabilities',{sourceId,kind:'mobile',limit:100});const capability=catalog.items.find(item=>Object.keys(item.inputSchema?.properties||{}).length===3&&item.inputSchema.properties[archiveKey]?.type==='boolean');assert.ok(capability);assert.equal(capability.readiness,'ready');record.capability=capability;
  record.third=await successful(client,await mcpCall(client,'software_call',{sourceId,capabilityId:capability.id,expectedRevision:capability.revision,params:params('gamma',true,true)}));record.afterThird=await ownUi('after-third');assertUi(record.afterThird,{query:'gamma',archived:true,active:true,queries:3,archivedTaps:3,activeTaps:1});
  record.generation=await successful(client,await mcpCall(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));generatedClient=await connect(record.generation.result.entry);const tool='cap_'+capability.id.slice(4,24);record.fourth=await successful(generatedClient,await mcpCall(generatedClient,tool,params('delta',false,false)),'operation_status');record.afterFourth=await ownUi('after-fourth');assertUi(record.afterFourth,{query:'delta',archived:false,active:false,queries:4,archivedTaps:4,activeTaps:2});
  const noopBefore=(await productStarts()).length;record.noop=await successful(client,await mcpCall(client,'software_call',{sourceId,capabilityId:capability.id,expectedRevision:capability.revision,params:params('epsilon',false,false)}));record.noopCommands=await traceSegment(noopBefore);record.afterNoop=await ownUi('after-same-bools');assertUi(record.afterNoop,{query:'epsilon',archived:false,active:false,queries:5,archivedTaps:4,activeTaps:2});
  const noopTaps=taps(record.noopCommands).map(row=>row.args[3]);assert.ok(!noopTaps.includes(record.afterFourth.tapCommands.archived));assert.ok(!noopTaps.includes(record.afterFourth.tapCommands.active));assert.equal(noopTaps.filter(value=>value===record.afterFourth.tapCommands.search).length,1);assert.equal(noopTaps.length,2,'same bool run only input focus + one query click');record.noopEvidence={archivedTapDelta:0,activeTapDelta:0,queryDelta:1,actualProductTapCommands:noopTaps};
  const badBefore=(await productStarts()).length;record.badBool=await terminal(client,(await mcpCall(client,'software_call',{sourceId,capabilityId:capability.id,expectedRevision:capability.revision,params:params('invalid','true',false)})).operationId);assert.equal(record.badBool.status,'failed',JSON.stringify(record.badBool));record.badBoolCommands=await traceSegment(badBefore);assert.equal(taps(record.badBoolCommands).length,0);record.afterBadBool=await ownUi('after-bad-bool');assert.deepEqual(record.afterBadBool,record.afterNoop);
  const deniedFile=path.join(output,'denied-device.json'),negativeSpec=path.join(output,'denied-check-spec.json'),negativeSamples=path.join(output,'denied-check-samples.json'),negativeOut=path.join(output,'denied-check');await save(deniedFile,{...deviceConfig,expectedArtifact:{kind:'apk',sha256:record.apk.sha256},actionAllowlist:deviceConfig.actionAllowlist.filter(rule=>rule.kind!=='check')});await save(negativeSpec,{schemaVersion:1,id:'denied_check',effect:'read',inputSchema:{type:'object',properties:{archived:{type:'boolean'}},required:['archived'],additionalProperties:false},steps:[{kind:'check',selector:{accessibilityId:'IncludeArchived'},input:'archived'},{kind:'assert',selector:{accessibilityId:'ControlsResult'},expect:{containsInput:'archived'}},{kind:'extract',selector:{accessibilityId:'ControlsResult'},output:'result',valueType:'string'}]});await save(negativeSamples,[{archived:true},{archived:false}]);const deniedBefore=(await productStarts()).length;await run(python,['-m','apk_inventory.mobile_ui','--config',deniedFile,'--operation','workflow-learn','--workflow',negativeSpec,'--samples',negativeSamples,'--output',negativeOut],{allowFailure:true});record.allowlistDenied=await json(path.join(negativeOut,'result.json'));assert.equal(record.allowlistDenied.ok,false);record.allowlistDeniedCommands=await traceSegment(deniedBefore);assert.equal(taps(record.allowlistDeniedCommands).length,0);record.afterDenied=await ownUi('after-missing-allowlist');assert.deepEqual(record.afterDenied,record.afterNoop);
  const screen=await run(adb,['-s',serial,'exec-out','screencap','-p'],{binary:true});await writeFile(path.join(output,'final-screen.png'),screen.stdout);await writeFile(path.join(reportDir,'android-controls.png'),screen.stdout);
  await launchFixture(record.proxyPort,true);record.driftBefore=await ownUi('drift-before',{drift:true});const driftStart=(await productStarts()).length;record.selectorDrift=await terminal(client,(await mcpCall(client,'software_call',{sourceId,capabilityId:capability.id,expectedRevision:capability.revision,params:params('zeta',true,false)})).operationId);assert.ok(record.selectorDrift.status==='failed'||record.selectorDrift.result?.result?.ok===false,JSON.stringify(record.selectorDrift));record.driftCommands=await traceSegment(driftStart);assert.equal(taps(record.driftCommands).length,0,'first control selector drift must send zero taps');record.driftAfter=await ownUi('drift-after',{drift:true});assert.deepEqual(record.driftAfter,record.driftBefore);record.negativeEvidence={badBoolProductTaps:0,missingAllowlistProductTaps:0,selectorDriftProductTaps:0,missingAllowlistThrough:'production native adapter CLI; positive flow/bad-bool/drift through official MCP SDK'};
  record.proxyAfter=(await sh('settings','get','global','http_proxy')).stdout.trim();assert.equal(record.proxyAfter,record.proxyBefore);assert.equal(record.apiRequests.length,0);record.status='passed';log('android_controls_passed',{candidateCompleted:true,queries:5,archivedTaps:4,activeTaps:2,noopBoolTaps:0,httpRequests:0});
 }catch(error){record.status=installed?'failed':'blocked';record.error={name:error.name,message:String(error.message).slice(0,8000),stack:String(error.stack).slice(0,10000)};log('android_controls_failed',{error:record.error});process.exitCode=1;}
 finally{
  await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});process.env.BFS_ANDROID_PHASE='cleanup';
  if(http)await new Promise(resolve=>{http.closeAllConnections();http.close(resolve)});
  if(installed&&ownedProcess(emulatorReceipt)){const result=await run(adb,['-s',serial,'uninstall',app],{allowFailure:true,timeout:20000});record.cleanup.fixtureUninstalled=result.code===0;record.cleanup.ownedFixtureDataRemoved=result.code===0;}
  if(ownedProcess(emulatorReceipt)){await run(adb,['-s',serial,'emu','kill'],{allowFailure:true,timeout:10000});for(let count=0;count<30&&ownedProcess(emulatorReceipt);count++)await delay(200);if(ownedProcess(emulatorReceipt)){process.kill(emulatorReceipt.pid,'SIGTERM');await delay(500)}record.cleanup.emulatorStopped=!ownedProcess(emulatorReceipt);}
  if(record.cleanup.emulatorStopped&&!values['keep-emulator-data']&&emulatorReceipt?.isolatedNewData&&emulatorReceipt.avd.startsWith(output+path.sep)){await rm(emulatorReceipt.avd,{recursive:true,force:true});record.cleanup.ownedAvdDataRemoved=true;}
  if(ownedAdbPort&&emulatorReceipt?.adbServerOwned){const stopped=await run(adb,['-P',String(ownedAdbPort),'kill-server'],{allowFailure:true,timeout:10000});record.cleanup.isolatedAdbServerStopped=stopped.code===0;}
  record.existingAvdConfigUntouched=true;for(const[file,before]of Object.entries(record.originalAvdHashes))if(hash(await readFile(file))!==before)record.existingAvdConfigUntouched=false;
  await audit();if(!record.existingAvdConfigUntouched||record.status==='passed'&&(['fixtureUninstalled','ownedFixtureDataRemoved','emulatorStopped','ownedAvdDataRemoved','isolatedAdbServerStopped'].some(key=>record.cleanup[key]!==true)||record.adbCommandAudit.unmatched.length||record.adbCommandAudit.failures.some(row=>row.phase!=='bootstrap')||record.processCleanupAudit.ownedTracedProcessesRemaining.length||Object.values(record.processCleanupAudit.ownedPorts).some(row=>row.listening))){record.status='failed';process.exitCode=1;}
  record.finishedAt=new Date().toISOString();await save(path.join(output,'controls-results.json'),record);await save(path.join(reportDir,'android-controls.json'),record);
  const text=`# Android 原生通用布尔控件验收\n\n状态：**${record.status}**。APK SHA256：${record.apk?.sha256||'未完成'}，设备安装文件一致：${record.apk?.sha256===record.apk?.installedSha256}。真实设备：${JSON.stringify(record.device||{})}。\n\n自动mixed candidate完成：${record.candidateCompleted===true}；通过official MCP SDK发现→候选→两样本学习alpha/true/false、beta/false/true→统一调用gamma/true/true→独立生成MCP调用delta/false/false。全部布尔参数与结果文字、Android原始checked属性及App独立点击计数逐次交叉核对。\n\n- 相同布尔再次调用epsilon：${JSON.stringify(record.noopEvidence||{})}；业务查询仍只点击1次。\n- 负例：${JSON.stringify(record.negativeEvidence||{})}。缺allowlist用同生产native adapter CLI，其余均通过统一MCP；不把协议模拟当真实设备。\n- 最后正向状态：${JSON.stringify(record.afterNoop||{})}。\n- ADB命令：${JSON.stringify(record.adbCommandAudit?{starts:record.adbCommandAudit.starts,finished:record.adbCommandAudit.finished,counts:record.adbCommandAudit.counts,unmatched:record.adbCommandAudit.unmatched.length,bootstrapProbeFailures:record.adbCommandAudit.failures.filter(row=>row.phase==='bootstrap').length,acceptanceOrCleanupFailures:record.adbCommandAudit.failures.filter(row=>row.phase!=='bootstrap').length}:{})}。\n- 清理：${JSON.stringify(record.cleanup)}；独立进程/端口审计${JSON.stringify(record.processCleanupAudit||{})}；用户AVD hash未变${record.existingAvdConfigUntouched}。\n\n${record.error?'失败：'+record.error.message:'HTTP 0，未改用户AVD、全局ADB/代理/CA；只安装本仓库自建App。候选仍以真实样本及控件合同验证后才ready。'}\n\n![真实Android结果](android-controls.png)\n\n复验：\n\n\`\`\`sh\nnode test/android-controls-e2e.mjs --output /absolute/new-output\n\`\`\`\n`;
  await writeFile(path.join(reportDir,'android-controls.md'),text);process.stdout.write(JSON.stringify({status:record.status,report:path.join(reportDir,'android-controls.json')})+'\n');
 }
}
process.once('SIGINT',()=>{interrupted=true});process.once('SIGTERM',()=>{interrupted=true});await main();
