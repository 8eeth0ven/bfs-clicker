#!/usr/bin/env node
// Explicit, opt-in device acceptance: node test/native-visual-device-e2e.mjs.
// Creates its own AVD/data, installs only this repo's synthetic APK, and never
// edits global proxy/CA/settings or wipes an existing AVD.
import assert from 'node:assert/strict';
import {observeNativeImage} from '../src/native-visual-observation.js';
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

const project=path.resolve(process.cwd());
const {values}=parseArgs({options:{sdk:{type:'string'},python:{type:'string'},output:{type:'string'},'reuse-owned-emulator':{type:'boolean'},'keep-emulator-data':{type:'boolean'}}});
const sdk=path.resolve(values.sdk||path.join(os.homedir(),'Library/Android/sdk'));
const python=path.resolve(values.python||path.join(project,'.venv/bin/python'));
const output=path.resolve(values.output||path.join(project,'output-vision-implementation','native-visual-device-'+Date.now()));
const reportDir=path.join(project,'output-vision-implementation');
const app='com.bfs.mcp.ime',realAdb=existsSync('/opt/homebrew/bin/adb')?'/opt/homebrew/bin/adb':path.join(sdk,'platform-tools/adb');
let adb=realAdb;
const targetOrigin='http://127.0.0.1:8765';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record={date:new Date().toISOString(),status:'running',kind:'real_android_native_visual',outputDir:output,steps:[],apiRequests:[],scope:{existingAvdWiped:false,userAppUninstalled:false,globalProxyChanged:false,caInstalled:false},cleanup:{}};
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


async function main(){await mkdir(output,{recursive:true});try{
 await startEmulator();await waitBoot();
 const apk=path.join(output,'probe.apk');await run(python,[path.join(project,'apk_tools/examples/native-visual-demo/build.py'),'--out',apk,'--sdk',sdk]);await device('install',apk);installed=true;await sh('am','start','-n','com.bfs.probe/.Main');await delay(3000);
 await sh('uiautomator','dump','/sdcard/bfs-visual-probe.xml');const xml=(await sh('cat','/sdcard/bfs-visual-probe.xml')).stdout;await sh('rm','-f','/sdcard/bfs-visual-probe.xml');await writeFile(path.join(output,'ui.xml'),xml);assert(!xml.includes('Alpha')&&!xml.includes('Beta'),'canvas controls must have no semantic labels');record.noSemanticLabels=true;
 const helper=path.join(output,'targettap.jar');await run(python,[path.join(project,'apk_tools/visual_helper/build.py'),'--sdk',sdk,'--out',helper]);
 const adbTrace=path.join(output,'adb-trace.jsonl'),adbWrapper=path.join(output,'adb-trace.cjs');await writeFile(adbWrapper,`#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');const a=process.argv.slice(2),c=spawn(${JSON.stringify(realAdb)},a,{stdio:'inherit'});c.on('error',()=>{fs.appendFileSync(${JSON.stringify(adbTrace)},JSON.stringify({args:a,error:'spawn_failed'})+'\\n');process.exitCode=1});c.on('close',code=>{fs.appendFileSync(${JSON.stringify(adbTrace)},JSON.stringify({args:a,code})+'\\n');process.exitCode=code??1});`,{mode:0o700});
 const inventory=path.join(output,'inventory');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);const sourceId=(await json(path.join(inventory,'source.json'))).source_id;
 const config={source:{id:sourceId,kind:'apk'},backend:{type:'adb',adb:adbWrapper,deviceId:serial,appId:'com.bfs.probe'},expectedArtifact:{kind:'apk',sha256:hash(await readFile(apk))},limits:{maxActions:10,maxDepth:0,maxDurationMs:120000},actionAllowlist:[],nativeVisualWorkflow:{enabled:true,node:process.execPath,helperJar:helper,helperSha256:hash(await readFile(helper)),allowedWorkflows:['choose'],approvedDefinitions:{choose:path.join(output,'definition.json')}}};
 const definition={kind:'native-visual-workflow',schemaVersion:1,id:'choose',name:'Choose result',effect:'read',activity:'com.bfs.probe.Main',inputName:'choice',choices:{alpha:{anchor:'Alpha',expected:'ALPHA'},beta:{anchor:'Beta',expected:'BETA'},untested:{anchor:'Unused',expected:'UNUSED'}},resultRegion:{x:0.05,y:0.50,width:0.85,height:0.20},resultPrefix:'RESULT'};
 const cfg=path.join(output,'device.json'),def=path.join(output,'definition.json'),runtime=path.join(output,'runtime.json');await save(cfg,config);await save(def,definition);await save(runtime,{outputRoot:path.join(output,'software'),artifactRoots:[output],python,devices:{owned:cfg}});
 async function connect(entry,args=[]){const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:project,stderr:'pipe',env:{...process.env}});transport.stderr?.on('data',chunk=>record.mcpStderr=((record.mcpStderr||'')+chunk).slice(-16384));const c=new Client({name:'bfs-android-visual-acceptance',version:'1'});await c.connect(transport);return c;}
 async function call(c,name,args={}){const reply=await c.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent??JSON.parse(reply.content.find(x=>x.type==='text').text);}
 async function finish(c,started,statusName='software_operation',expected='completed'){const value=await until(async()=>{const v=await call(c,statusName,{operationId:started.operationId});return ['completed','failed','cancelled','interrupted'].includes(v.status)?v:null;},'MCP operation',180000);assert.equal(value.status,expected,JSON.stringify(value));return value;}
 client=await connect(path.join(project,'src/software-mcp.js'),['--config',runtime]);record.discovery=await finish(client,await call(client,'software_discover',{kind:'apk',input:apk,deviceName:'owned'}));
 const initial=await call(client,'software_capabilities',{sourceId});record.learning=await finish(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:initial.source.revision,specPath:def,samples:[{choice:'alpha'},{choice:'beta'}]}));log('learning',{status:record.learning.status});
 const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(x=>x.name==='Choose result');assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');assert.deepEqual(cap.inputSchema.properties.choice.enum,['alpha','beta']);record.capability=cap;
 record.wrongRevision=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:'0'.repeat(64),params:{choice:'alpha'}}),'software_operation','failed');log('wrong_revision',{status:record.wrongRevision.status});
 record.execution=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{choice:'alpha'}}));assert.equal(record.execution.result.result.ok,true,JSON.stringify(record.execution));assert.match(record.execution.result.result.outputs.text,/ALPHA/);log('execution',{outputs:record.execution.result.result.outputs});
 record.generated=await finish(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));generatedClient=await connect(record.generated.result.entry);const tool='cap_'+cap.id.slice(4,24);assert((await generatedClient.listTools()).tools.some(x=>x.name===tool));
 record.generatedExecution=await finish(generatedClient,await call(generatedClient,tool,{choice:'beta'}),'operation_status');assert.equal(record.generatedExecution.result.result.ok,true,JSON.stringify(record.generatedExecution));assert.match(record.generatedExecution.result.result.outputs.text,/BETA/);log('generated_execution',{outputs:record.generatedExecution.result.result.outputs});
 record.unchanged=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{choice:'beta'}}));assert.equal(record.unchanged.result.result.error.code,'VISUAL_RESULT_NOT_VERIFIED');assert.equal(record.unchanged.result.result.writeOutcome.status,'unknown');log('unchanged_result',{result:record.unchanged.result.result});
 await sh('am','start','-n','com.bfs.probe/.Overlay');await delay(2000);await sh('logcat','-c');record.overlay=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{choice:'alpha'}}));record.overlayLogs=(await sh('logcat','-d','-s','BFS-PROBE:I','*:S')).stdout;assert.equal(record.overlay.result.result.error.code,'VISUAL_WINDOW_FOCUS_CHANGED');assert.equal(record.overlay.result.result.writeOutcome.status,'not_started');assert(!record.overlayLogs.includes('OVERLAY_DOWN'));log('overlay_blocked',{result:record.overlay.result.result});record.status='passed';
 }catch(e){record.status='failed';record.error=String(e.stack||e);process.exitCode=1;log('failed',{message:String(e)});}
 finally{await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});if(installed&&ownedProcess(emulatorReceipt)){const result=await run(adb,['-s',serial,'uninstall','com.bfs.probe'],{allowFailure:true});record.cleanup.fixtureUninstalled=result.code===0;record.cleanup.uninstallCode=result.code;record.cleanup.uninstallError=result.stderr.slice(-2000);}if(ownedProcess(emulatorReceipt)){await run(adb,['-s',serial,'emu','kill'],{allowFailure:true});for(let n=0;n<30&&ownedProcess(emulatorReceipt);n++)await delay(200);if(ownedProcess(emulatorReceipt))process.kill(emulatorReceipt.pid,'SIGTERM');await delay(300);record.cleanup.emulatorStopped=!ownedProcess(emulatorReceipt);}if(record.cleanup.emulatorStopped&&emulatorReceipt?.avd.startsWith(output+path.sep)){await rm(emulatorReceipt.avd,{recursive:true,force:true});record.cleanup.ownedAvdDataRemoved=true;}if(ownedAdbPort){const result=await run(adb,['-P',String(ownedAdbPort),'kill-server'],{allowFailure:true});record.cleanup.isolatedAdbServerStopped=result.code===0&&await portFree(ownedAdbPort);}record.finishedAt=new Date().toISOString();await save(path.join(output,'results.json'),record);}}
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});await main();
