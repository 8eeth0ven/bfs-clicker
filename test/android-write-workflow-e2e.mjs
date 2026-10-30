#!/usr/bin/env node
// Explicit, opt-in device acceptance: node test/android-write-workflow-e2e.mjs.
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
const output=path.resolve(values.output||path.join(project,'output-vision-implementation','android-write-workflow-'+Date.now()));
const reportDir=path.join(project,'output-vision-implementation');
const app='com.example.inventorydemo',adb=existsSync('/opt/homebrew/bin/adb')?'/opt/homebrew/bin/adb':path.join(sdk,'platform-tools/adb');
const targetOrigin='http://127.0.0.1:8765';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record={date:new Date().toISOString(),status:'running',kind:'real_android_write_workflow',outputDir:output,steps:[],apiRequests:[],scope:{existingAvdWiped:false,userAppUninstalled:false,globalProxyChanged:false,caInstalled:false},cleanup:{}};
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
 const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
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
 const command=[executable,'-avd',name,'-port',String(port),'-no-window','-no-audio','-no-boot-anim','-no-snapshot','-no-metrics','-skip-adb-auth','-gpu','swiftshader_indirect','-adb-path',adb];
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
async function launchFixture(proxyPort){
 // Exact package is compiled by this repo and installed only on our isolated AVD.
 assert.equal(app,'com.example.inventorydemo');
 await sh('am','force-stop',app);
 await sh('am','start','-n',app+'/.DemoActivity','--es','base_url',targetOrigin,'--es','proxy_host','10.0.2.2','--ei','proxy_port',String(proxyPort),'--ez','notes_mode','true');
 await until(async()=>/mResumedActivity|topResumedActivity/.test((await sh('dumpsys','activity','activities')).stdout)&& (await sh('dumpsys','activity','activities')).stdout.includes(app), 'fixture foreground',15000);
}
async function workflowUi(label){
 const remote='/sdcard/bfs-workflow-'+hash(label+Date.now()).slice(0,20)+'.xml';let xml;
 try{await sh('uiautomator','dump',remote);xml=(await sh('cat',remote)).stdout;}finally{await sh('rm','-f',remote).catch(()=>{});}
 await writeFile(path.join(output,label+'.xml'),xml);
 const tags=[...xml.matchAll(/<node\b[^>]*>/g)].map(row=>row[0]);
 const textFor=name=>{const tag=tags.find(tag=>tag.includes('content-desc="'+name+'"'));assert.ok(tag,'Native control missing: '+name);return tag.match(/\btext="([^"]*)"/)?.[1];};
 return {quantity:textFor('Quantity'),total:textFor('total'),clicks:Number(textFor('clicks').replace('CLICKS:','')),history:textFor('history')};
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
async function ownUi(label){
 const remote='/sdcard/bfs-notes-'+hash(label+Date.now()).slice(0,20)+'.xml';let xml;
 try{await sh('uiautomator','dump',remote);xml=(await sh('cat',remote)).stdout;}finally{await sh('rm','-f',remote).catch(()=>{});}
 await writeFile(path.join(output,label+'.xml'),xml);
 const tags=[...xml.matchAll(/<node\b[^>]*>/g)].map(row=>row[0]);
 const get=name=>{const tag=tags.find(tag=>tag.includes('content-desc="'+name+'"'));assert.ok(tag,'Owned notes UI control missing: '+name);return decodeXml(tag.match(/\btext="([^"]*)"/)?.[1]||'');};
 return {status:get('noteStatus'),count:Number(get('noteCount').replace('COUNT:','')),writes:Number(get('writeCount').replace('WRITES:',''))};
}
async function persistedNotes(){
 const args=['run-as',app,'cat','shared_prefs/workflow_notes.xml'];const data=await run(adb,['-s',serial,'shell',args.map(shellQuote).join(' ')],{allowFailure:true});
 if(data.code!==0){assert.match(data.stderr+data.stdout,/No such file/);return {records:[],writes:0,status:'READY',filePresent:false};}
 const xml=data.stdout;const strings=[...xml.matchAll(/<string name="([^"]+)">([\s\S]*?)<\/string>/g)];const value=name=>decodeXml(strings.find(match=>match[1]===name)?.[2]||'');
 return {records:JSON.parse(value('records')||'[]'),writes:Number(xml.match(/<int name="write_count" value="([0-9]+)"\s*\/>/)?.[1]||'0'),status:value('last_status'),filePresent:true};
}
async function clearOwnedNotes(){
 await launchFixture(record.proxyPort||0);
 const remote='/sdcard/bfs-notes-cleanup-'+Date.now()+'.xml';let xml;
 try{await sh('uiautomator','dump',remote);xml=(await sh('cat',remote)).stdout;}finally{await sh('rm','-f',remote).catch(()=>{});}
 const tag=[...xml.matchAll(/<node\b[^>]*>/g)].map(row=>row[0]).find(tag=>tag.includes('content-desc="ClearNotes"'));assert.ok(tag,'Owned clear button missing');
 const box=tag.match(/bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/);assert.ok(box);await sh('input','tap',String(Math.floor((Number(box[1])+Number(box[3]))/2)),String(Math.floor((Number(box[2])+Number(box[4]))/2)));
 const disk=await persistedNotes();assert.deepEqual(disk.records,[]);assert.equal(disk.status,'CLEARED');return disk;
}
async function terminal(sdkClient,id,name='software_operation'){
 return until(async()=>{const status=await mcpCall(sdkClient,name,{operationId:id});return ['completed','failed','cancelled','interrupted'].includes(status.status)?status:null;},'write MCP '+id,180000);
}
const outcome=status=>status.writeOutcome||status.result?.writeOutcome||status.result?.result?.writeOutcome;
async function auditAdbTrace(){
 if(!record.adbTrace||!existsSync(record.adbTrace))return;
 const rows=(await readFile(record.adbTrace,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const starts=rows.filter(row=>row.event==='start'),finished=rows.filter(row=>row.event==='finish'),done=new Set(finished.map(row=>row.pid));
 const commands={};const groups=[['uiautomatorDump','uiautomator dump '],['tap','input tap '],['text','input text '],['keyevent','input keyevent '],['foreground','dumpsys activity '],['packagePath','pm path '],['artifactHash','sha256sum ']];
 for(const row of starts){const command=row.args[3]||row.args.join(' ');for(const[name,prefix]of groups)if(command.startsWith(prefix))commands[name]=(commands[name]||0)+1;}
 record.adbCommandAudit={scope:'product mobile module only; fixture install/read/cleanup commands excluded',starts:starts.length,finished:finished.length,unmatched:starts.filter(row=>!done.has(row.pid)),failures:finished.filter(row=>row.code!==0),commands};
}

async function tracedAdb(){
 const wrapper=path.join(output,'adb-traced.cjs'),trace=path.join(output,'adb-commands.jsonl');
 const code=`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs');
const started=Date.now(),args=process.argv.slice(2),trace=${JSON.stringify(trace)};
const child=spawn(${JSON.stringify(adb)},args,{stdio:['ignore','pipe','pipe']});
fs.appendFileSync(trace,JSON.stringify({event:'start',pid:process.pid,childPid:child.pid,started,args})+'\\n');
let stderr='';child.stdout.pipe(process.stdout);child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);process.stderr.write(chunk)});
child.on('error',error=>{fs.appendFileSync(trace,JSON.stringify({event:'error',pid:process.pid,args,error:String(error)})+'\\n');process.exitCode=127});
child.on('close',(code,signal)=>{fs.appendFileSync(trace,JSON.stringify({event:'finish',pid:process.pid,started,elapsedMs:Date.now()-started,args,code,signal,stderr})+'\\n');process.exitCode=code??1});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
`;
 await writeFile(wrapper,code,{mode:0o700});record.adbTrace=trace;return wrapper;
}

async function main(){
 await mkdir(output,{recursive:true});await mkdir(reportDir,{recursive:true});record.ownedNotesSnapshots=[];record.sourceSnapshot={};for(const file of ['apk_tools/apk_inventory/mobile_ui.py','apk_tools/apk_inventory/mobile_workflows.py','src/software-runtime.js','src/software-operations.js','src/software-worker.js','src/write-outcome.js'])record.sourceSnapshot[file]=hash(await readFile(path.join(project,file)));
 const existingFiles=[path.join(os.homedir(),'.android/avd/Medium_Phone.avd/config.ini'),path.join(os.homedir(),'.android/avd/Medium_Phone_API_36.0.ini')];record.originalAvdHashes={};for(const file of existingFiles)if(existsSync(file))record.originalAvdHashes[file]=hash(await readFile(file));
 let deniedClient;
 try{
  await startEmulator();log('emulator_started',{serial,pid:emulatorReceipt.pid});await waitBoot();
  const apk=path.join(output,'notes-demo.apk');await run(python,[path.join(project,'apk_tools/examples/build_demo.py'),'--out',apk,'--sdk',sdk]);record.apk={path:apk,sha256:hash(await readFile(apk)),package:app};
  const inventory=path.join(output,'inventory');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);const descriptor=await json(path.join(inventory,'source.json'));assert.equal(descriptor.app.package_name,app);assert.equal(descriptor.app.apk_sha256,record.apk.sha256);
  await device('install','-r',apk);installed=true;const installedPath=(await sh('pm','path',app)).stdout.trim().split('\n').find(line=>line.startsWith('package:'))?.slice(8);assert.ok(installedPath);record.apk.installedSha256=(await sh('sha256sum',installedPath)).stdout.trim().split(/\s+/)[0];assert.equal(record.apk.installedSha256,record.apk.sha256);
  http=createServer(async(req,res)=>{let bytes=0;for await(const chunk of req)bytes+=chunk.length;record.apiRequests.push({method:req.method,url:req.url,bodyBytes:bytes});res.writeHead(403);res.end('owned notes must stay local');});await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));record.proxyPort=http.address().port;
  await launchFixture(record.proxyPort);record.initialDisk=await persistedNotes();assert.deepEqual(record.initialDisk.records,[]);assert.equal(record.initialDisk.writes,0);
  const permissions={allowWrite:['create_note','update_note'],allowWriteLearning:['create_note','update_note']};
  const observedAdb=await tracedAdb();const deviceFile=path.join(output,'device.json');await save(deviceFile,{source:{id:descriptor.source_id,kind:'apk'},backend:{type:'adb',adb:observedAdb,deviceId:serial,appId:app},limits:{maxActions:30,maxDepth:0,maxDurationMs:240000},workflowPermissions:permissions,actionAllowlist:[{kind:'type',selector:{accessibilityId:'NoteBody'},effect:'read'},{kind:'click',selector:{accessibilityId:'CreateNote'},effect:'write'},{kind:'click',selector:{accessibilityId:'UpdateLastNote'},effect:'write'}]});
  const cfg={outputRoot:path.join(output,'software'),artifactRoots:[output],python,devices:{owned_notes:deviceFile},bindings:{[descriptor.source_id]:{allowed_origins:[]}},workflowPermissions:{[descriptor.source_id]:permissions}};const configFile=path.join(output,'runtime.json');await save(configFile,cfg);
  client=await connect(path.join(project,'src/software-mcp.js'),['--config',configFile]);record.discovery=await completed(client,(await mcpCall(client,'software_discover',{kind:'apk',input:apk,deviceName:'owned_notes'})).operationId);
  const sourceId=descriptor.source_id;let catalog=await mcpCall(client,'software_capabilities',{sourceId,kind:'mobile',limit:100});assert.equal(catalog.source.appArtifactVerified,true);record.productArtifactVerification=catalog.source.artifactVerification;assert.equal((await persistedNotes()).writes,0);
  const definition=(id,button)=>({schemaVersion:1,id,name:id==='create_note'?'Create owned note':'Update owned note',effect:'write',inputSchema:{type:'object',properties:{body:{type:'string',minLength:1,maxLength:40}},required:['body'],additionalProperties:false},steps:[{kind:'type',selector:{accessibilityId:'NoteBody'},input:'body',replace:true},{kind:'click',selector:{accessibilityId:button}},{kind:'assert',selector:{accessibilityId:'noteStatus'},expect:{containsInput:'body',changed:true},timeoutMs:800},{kind:'extract',selector:{accessibilityId:'noteStatus'},output:'saved',valueType:'string'}]});
  const createSpec=path.join(output,'create.json');await save(createSpec,definition('create_note','CreateNote'));
  const deniedConfig=path.join(output,'denied-runtime.json');await save(deniedConfig,{...cfg,workflowPermissions:{[sourceId]:{allowWrite:['create_note'],allowWriteLearning:[]}}});deniedClient=await connect(path.join(project,'src/software-mcp.js'),['--config',deniedConfig]);
  const denied=await terminal(deniedClient,(await mcpCall(deniedClient,'software_bind_workflow',{sourceId,expectedRevision:catalog.source.revision,specPath:createSpec,samples:[{body:'deniedA'},{body:'deniedB'}]})).operationId);assert.equal(denied.status,'failed');assert.equal((await persistedNotes()).writes,0);record.learningPermissionDenied=denied;await deniedClient.close();deniedClient=null;
  log('write_learning_started',{workflow:'create_note',samples:['alpha','beta']});record.learning=await completed(client,(await mcpCall(client,'software_bind_workflow',{sourceId,expectedRevision:catalog.source.revision,specPath:createSpec,samples:[{body:'alpha'},{body:'beta'}]})).operationId);
  assert.deepEqual(outcome(record.learning),{status:'observed',automaticRetry:false});record.afterLearning=await persistedNotes();assert.deepEqual(record.afterLearning.records,['alpha','beta']);assert.equal(record.afterLearning.writes,2);record.ownedNotesSnapshots.push(record.afterLearning);
  catalog=await mcpCall(client,'software_capabilities',{sourceId,kind:'mobile',limit:100});const createCap=catalog.items.find(cap=>cap.name==='Create owned note');assert.ok(createCap);assert.equal(createCap.effect,'write');assert.equal(createCap.readiness,'ready');
  record.execution=await completed(client,(await mcpCall(client,'software_call',{sourceId,capabilityId:createCap.id,expectedRevision:createCap.revision,params:{body:'gamma'}})).operationId);assert.equal(record.execution.result.result.ok,true);assert.deepEqual(outcome(record.execution),{status:'observed',automaticRetry:false});record.afterCall=await persistedNotes();assert.deepEqual(record.afterCall.records,['alpha','beta','gamma']);assert.equal(record.afterCall.writes,3);
  record.generation=await completed(client,(await mcpCall(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision})).operationId);generatedClient=await connect(record.generation.result.entry);const tool='cap_'+createCap.id.slice(4,24);record.generatedExecution=await completed(generatedClient,(await mcpCall(generatedClient,tool,{body:'epsilon'})).operationId,'operation_status');assert.equal(record.generatedExecution.result.result.ok,true);assert.deepEqual(outcome(record.generatedExecution),{status:'observed',automaticRetry:false});record.afterGenerated=await persistedNotes();assert.deepEqual(record.afterGenerated.records,['alpha','beta','gamma','epsilon']);assert.equal(record.afterGenerated.writes,4);
  log('intentional_assertion_failure_started',{persistedBefore:record.afterGenerated.writes});const failedStart=await mcpCall(client,'software_call',{sourceId,capabilityId:createCap.id,expectedRevision:createCap.revision,params:{body:'unacknowledged'}});record.failedExecution=await terminal(client,failedStart.operationId);assert.equal(record.failedExecution.result?.result?.ok,false);assert.deepEqual(outcome(record.failedExecution),{status:'unknown',automaticRetry:false});record.afterFailure=await persistedNotes();assert.deepEqual(record.afterFailure.records,['alpha','beta','gamma','epsilon','unacknowledged']);assert.equal(record.afterFailure.writes,5);
  const refusedResume=await client.callTool({name:'software_resume',arguments:{operationId:failedStart.operationId}});assert.equal(refusedResume.isError,true);record.resumeRefused=true;await delay(1200);record.afterFailureWait=await persistedNotes();assert.deepEqual(record.afterFailureWait,record.afterFailure);record.failedCallNewWrites=1;
  const updateSpec=path.join(output,'update.json');await save(updateSpec,definition('update_note','UpdateLastNote'));record.updateLearning=await completed(client,(await mcpCall(client,'software_bind_workflow',{sourceId,expectedRevision:catalog.source.revision,specPath:updateSpec,samples:[{body:'revisionA'},{body:'revisionB'}]})).operationId);record.afterUpdateLearning=await persistedNotes();assert.equal(record.afterUpdateLearning.records.length,5);assert.equal(record.afterUpdateLearning.records[4],'revisionB');assert.equal(record.afterUpdateLearning.writes,7);
  catalog=await mcpCall(client,'software_capabilities',{sourceId,kind:'mobile',limit:100});const updateCap=catalog.items.find(cap=>cap.name==='Update owned note');assert.ok(updateCap);record.updateExecution=await completed(client,(await mcpCall(client,'software_call',{sourceId,capabilityId:updateCap.id,expectedRevision:updateCap.revision,params:{body:'finaledit'}})).operationId);assert.equal(record.updateExecution.result.result.ok,true);assert.deepEqual(outcome(record.updateExecution),{status:'observed',automaticRetry:false});record.finalDisk=await persistedNotes();assert.deepEqual(record.finalDisk.records,['alpha','beta','gamma','epsilon','finaledit']);assert.equal(record.finalDisk.writes,8);
  await launchFixture(record.proxyPort);record.reopenedDisk=await persistedNotes();assert.deepEqual(record.reopenedDisk,record.finalDisk);record.finalUi=await ownUi('final-notes-ui');assert.equal(record.finalUi.status,'UPDATED:finaledit');assert.equal(record.finalUi.count,5);assert.equal(record.finalUi.writes,8);
  const screen=await run(adb,['-s',serial,'exec-out','screencap','-p'],{binary:true});await writeFile(path.join(output,'final-screen.png'),screen.stdout);await writeFile(path.join(reportDir,'android-write-workflow.png'),screen.stdout);
  assert.equal(record.apiRequests.length,0);record.proxyAfter=(await sh('settings','get','global','http_proxy')).stdout.trim();assert.equal(record.proxyAfter,record.proxyBefore);record.status='passed';log('android_write_workflow_passed',{writes:8,notes:5,failedCallWrites:1,automaticRetry:false,httpRequests:0});
 }catch(error){record.status=installed?'failed':'blocked';record.error={name:error.name,message:String(error.message).slice(0,5000)};log('android_write_workflow_failed',{error:record.error});process.exitCode=1;}
 finally{
  await deniedClient?.close().catch(()=>{});await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});
  if(http)await new Promise(resolve=>{http.closeAllConnections();http.close(resolve)});
  if(installed&&ownedProcess(emulatorReceipt)){try{record.notesAfterCleanup=await clearOwnedNotes();record.cleanup.ownedNotesCleared=true;}catch(error){record.cleanup.notesCleanupError=String(error.message).slice(0,500)}const uninstalled=await run(adb,['-s',serial,'uninstall',app],{allowFailure:true,timeout:20000});record.cleanup.fixtureUninstalled=uninstalled.code===0;}
  if(ownedProcess(emulatorReceipt)){await run(adb,['-s',serial,'emu','kill'],{allowFailure:true,timeout:10000});for(let count=0;count<30&&ownedProcess(emulatorReceipt);count++)await delay(200);if(ownedProcess(emulatorReceipt)){process.kill(emulatorReceipt.pid,'SIGTERM');await delay(500)}record.cleanup.emulatorStopped=!ownedProcess(emulatorReceipt);}
  if(record.cleanup.emulatorStopped&&!values['keep-emulator-data']&&emulatorReceipt?.isolatedNewData&&emulatorReceipt.avd.startsWith(output+path.sep)){await rm(emulatorReceipt.avd,{recursive:true,force:true});record.cleanup.ownedAvdDataRemoved=true;}
  if(ownedAdbPort&&emulatorReceipt?.adbServerOwned){const stopped=await run(adb,['-P',String(ownedAdbPort),'kill-server'],{allowFailure:true,timeout:10000});record.cleanup.isolatedAdbServerStopped=stopped.code===0;}
  record.existingAvdConfigUntouched=true;for(const[file,before]of Object.entries(record.originalAvdHashes))if(hash(await readFile(file))!==before)record.existingAvdConfigUntouched=false;
  await auditAdbTrace();if(!record.existingAvdConfigUntouched||record.status==='passed'&&(['ownedNotesCleared','fixtureUninstalled','emulatorStopped','ownedAvdDataRemoved','isolatedAdbServerStopped'].some(key=>record.cleanup[key]!==true)||record.adbCommandAudit?.unmatched.length||record.adbCommandAudit?.failures.length)){record.status='failed';process.exitCode=1;}record.finishedAt=new Date().toISOString();await save(path.join(output,'write-results.json'),record);await save(path.join(reportDir,'android-write-workflow.json'),record);
  const text=`# Android 可信授权写 workflow 验收\n\n状态：**${record.status}**；日期：${record.date}。\n\n实际隔离Android设备：${JSON.stringify(record.device||{})}。APK SHA：${record.apk?.sha256||'未完成'}，设备文件一致：${record.apk?.installedSha256===record.apk?.sha256}。\n\n- 写学习单独授权：拒绝时写次数0；显式批准后alpha/beta两样本真实落盘。\n- 调用gamma及独立生成入口epsilon后4次创建。\n- 故意unacknowledged已落盘但UI不给匹配ack：writeOutcome=${JSON.stringify(outcome(record.failedExecution||{}))}，只新增${record.failedCallNewWrites??'未完成'}次，不自动重试；resume拒绝。\n- 更新学习revisionA/revisionB，再调用finaledit：${JSON.stringify(record.finalDisk||{})}。\n- Activity重启后持久数据一致：${record.reopenedDisk&&JSON.stringify(record.reopenedDisk)===JSON.stringify(record.finalDisk)}。通过own debug App run-as读取SharedPreferences XML核对，不仅信任界面文字。\n- 产品ADB命令审计（fixture安装/读取/清理不计入）：${JSON.stringify(record.adbCommandAudit||{})}。\n- 清理：${JSON.stringify(record.cleanup)}；清理记录：${JSON.stringify(record.notesAfterCleanup||{})}；原AVD配置未变：${record.existingAvdConfigUntouched}。\n\n${record.error?'具体失败：'+record.error.message:'测试仅使用仓库自建debug App的本地notes；创建、修改、清理均限定本轮记录，HTTP0。observed只表示配置UI断言/结果已观察，不证明任意业务语义或exactly-once。'}\n\n![落盘结果](android-write-workflow.png)\n\n复验：\n\n\`\`\`sh\nnode test/android-write-workflow-e2e.mjs --output /absolute/new-output\n\`\`\`\n`;
  await writeFile(path.join(reportDir,'android-write-workflow.md'),text);process.stdout.write(JSON.stringify({status:record.status,report:path.join(reportDir,'android-write-workflow.json')})+'\n');
 }
}
process.once('SIGINT',()=>{interrupted=true});process.once('SIGTERM',()=>{interrupted=true});await main();
