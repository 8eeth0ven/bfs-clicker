#!/usr/bin/env node
// Real Android Chinese visual text acceptance through unified and generated MCP.
// Reuses the unchanged offline drawn fixture; Vision/chi_sim+eng is trusted config.
// Creates its own AVD/data, installs only this repo's synthetic APK, and never
// edits global proxy/CA/settings or wipes an existing AVD.
import assert from 'node:assert/strict';
import {observeNativeImage} from '../src/native-visual-observation.js';
import {createServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,appendFile,rm,readdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const project=path.resolve(process.cwd());
const {values}=parseArgs({options:{sdk:{type:'string'},python:{type:'string'},output:{type:'string'},'emulator-cores':{type:'string',default:'2'},'reuse-owned-emulator':{type:'boolean'},'keep-emulator-data':{type:'boolean'}}});
const emulatorCores=values['emulator-cores'];assert(['2','4'].includes(emulatorCores),'--emulator-cores must be exactly 2 or 4');
const sdk=path.resolve(values.sdk||path.join(os.homedir(),'Library/Android/sdk'));
const python=path.resolve(values.python||path.join(project,'.venv/bin/python'));
const output=path.resolve(values.output||path.join(project,'output-vision-implementation','native-visual-chinese-'+Date.now()));
const reportDir=path.join(project,'output-vision-implementation');
const app='com.bfs.mcp.ime',realAdb=existsSync('/opt/homebrew/bin/adb')?'/opt/homebrew/bin/adb':path.join(sdk,'platform-tools/adb');
let adb=realAdb;
const targetOrigin='http://127.0.0.1:8765';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record={date:new Date().toISOString(),status:'running',kind:'real_android_native_visual_chinese',outputDir:output,emulator:{requestedCores:Number(emulatorCores),avdConfiguredCores:2,selection:'explicit -cores override',ramMiB:2048,gpu:'swiftshader_indirect'},steps:[],apiRequests:[],scope:{existingAvdWiped:false,userAppUninstalled:false,globalProxyChanged:false,caInstalled:false},cleanup:{}};
let emulatorReceipt,emulatorChild,client,generatedClient,http,serial,installed=false,interrupted=false,ownedAdbPort;
const log=(phase,detail={})=>{record.steps.push({phase,at:new Date().toISOString(),...detail});process.stdout.write(JSON.stringify({phase,...detail})+'\n');};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const save=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
async function run(exe,args,{timeout=120000,allowFailure=false,binary=false}={}){
 const started=Date.now();let timedOut=false,exitSignal=null;const child=spawn(exe,args,{cwd:project,env:{...process.env,PYTHONPATH:path.join(project,'apk_tools'),PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});
 let stdout=[],stderr=[],bytes=0,tooLarge=false;
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>8*1024*1024){tooLarge=true;child.kill('SIGTERM');}else stdout.push(chunk);});
 child.stderr.on('data',chunk=>{stderr.push(chunk);if(Buffer.concat(stderr).length>131072)stderr=stderr.slice(-4);});
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},timeout);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{exitSignal=signal;resolve(code)});}).finally(()=>clearTimeout(timer));
 const result={code,stdout:binary?Buffer.concat(stdout):Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()};
 await appendFile(path.join(output,'host-commands.jsonl'),JSON.stringify({startedAt:new Date(started).toISOString(),exe,args,code,signal:exitSignal,timedOut,durationMs:Date.now()-started,stdoutBytes:bytes,stdoutPreview:binary?'[binary]':result.stdout.slice(0,400),stderr:result.stderr.slice(-1500)})+'\n');
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
async function removeStoppedOwnedAvd(receipt){
 const name='BFS_MCP_'+hash(output).slice(0,12),home=path.join(output,'avd'),avd=path.join(home,name+'.avd');
 if(!receipt?.isolatedNewData||receipt.avd!==avd||receipt.avdHome!==home||ownedProcess(receipt))return false;
 let rootReal,homeReal,entry;
 try{rootReal=await realpath(output);homeReal=await realpath(home);entry=await lstat(avd).catch(e=>{if(e.code==='ENOENT')return null;throw e;});}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(homeReal!==path.join(rootReal,'avd')||entry&&(entry.isSymbolicLink()||!entry.isDirectory()||await realpath(avd)!==path.join(homeReal,name+'.avd')))return false;
 if(entry)await rm(avd,{recursive:true,force:true});
 record.cleanup.emulatorStopped=true;record.cleanup.ownedAvdDataRemoved=true;return true;
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
  const coreArg=emulatorReceipt.command.indexOf('-cores'),existingCores=coreArg<0?'2':emulatorReceipt.command[coreArg+1];assert.equal(existingCores,emulatorCores,'Reused owned emulator must already have the requested core count');
  adbEnvironment(emulatorReceipt.adbServerPort,emulatorReceipt.adbKey);serial=emulatorReceipt.serial;return;
 }
 assert.ok(!existsSync(receiptFile),'Choose a new --output or explicitly --reuse-owned-emulator');
 const imageRoot=path.join(sdk,'system-images');
 const images=[];
 for(const api of await readdir(imageRoot))for(const vendor of await readdir(path.join(imageRoot,api)))for(const arch of await readdir(path.join(imageRoot,api,vendor)))if(arch==='arm64-v8a'&&existsSync(path.join(imageRoot,api,vendor,arch,'system.img')))images.push({api,vendor,arch});
 const image=images.find(item=>item.api==='android-36');assert.ok(image,'No local Android API36 arm64 system image; no download attempted');
 const name='BFS_MCP_'+hash(output).slice(0,12),avdHome=path.join(output,'avd'),avd=path.join(avdHome,name+'.avd');
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
 const command=[executable,'-avd',name,'-port',String(port),'-cores',emulatorCores,'-no-window','-no-audio','-no-boot-anim','-no-snapshot','-no-metrics','-skip-adb-auth','-gpu','swiftshader_indirect','-adb-path',adb];
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


async function waitBroadcastIdle(phase){
 const started=Date.now();log('waiting',{for:'owned emulator broadcast queue idle: '+phase});
 const result=await run(adb,['-s',serial,'shell','am','wait-for-broadcast-idle'],{timeout:420000});
 assert.match(result.stdout,/All broadcast queues are idle!/,'Android queue-idle proof missing');
 (record.bootReadiness??=[]).push({phase,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-started,command:'am wait-for-broadcast-idle',stdout:result.stdout,timeoutMs:420000,scope:'owned emulator setup only; production workflow budget unchanged'});
 log('broadcast_idle',{phase,durationMs:Date.now()-started});
}

async function main(){await mkdir(output,{recursive:true});let imeInstalled=false,originalIme;try{
 const vision=path.join(output,'vision-ocr');await run('/usr/bin/xcrun',['swiftc',path.join(project,'scripts/visual-vision.swift'),'-o',vision]);record.ocr={engine:'Apple Vision local',language:'chi_sim+eng',executableSha256:hash(await readFile(vision)),sourceSha256:hash(await readFile(path.join(project,'scripts/visual-vision.swift'))),reportedLanguages:(await run(vision,['--list-langs'])).stdout.trim().split('\n')};assert(record.ocr.reportedLanguages.includes('chi_sim')&&record.ocr.reportedLanguages.includes('eng'));await startEmulator();await waitBoot();await waitBroadcastIdle('after_cold_boot');
 const apk=path.join(output,'visual-text.apk'),ime=path.join(output,'ime.apk');await run(python,[path.join(project,'apk_tools/examples/native-visual-text/build.py'),'--out',apk,'--sdk',sdk]);await run(python,[path.join(project,'apk_tools/examples/unicode-ime/build.py'),'--out',ime,'--sdk',sdk]);
 await device('install',apk);installed=true;await device('install',ime);imeInstalled=true;await waitBroadcastIdle('after_owned_apk_install');originalIme=(await sh('settings','get','secure','default_input_method')).stdout.trim();await until(async()=>(await sh('ime','list','-a','-s')).stdout.includes('com.bfs.mcp.ime/.UnicodeIme'),'fixture IME registration',60000);await sh('ime','enable','com.bfs.mcp.ime/.UnicodeIme');await sh('ime','set','com.bfs.mcp.ime/.UnicodeIme');await sh('am','start','-n','com.bfs.visualtext/.Main');await delay(3000);
 await sh('uiautomator','dump','/sdcard/bfs-visual-text.xml');const xml=(await sh('cat','/sdcard/bfs-visual-text.xml')).stdout;await sh('rm','-f','/sdcard/bfs-visual-text.xml');await writeFile(path.join(output,'ui.xml'),xml);assert(!xml.includes('Query')&&!xml.includes('Search')&&!xml.includes('OLDVALUE'));record.noSemanticLabels=true;
 const helper=path.join(output,'targettap.jar');await run(python,[path.join(project,'apk_tools/visual_helper/build.py'),'--sdk',sdk,'--out',helper]);
 const adbTrace=path.join(output,'adb-trace.jsonl'),adbWrapper=path.join(output,'adb-trace.cjs');await writeFile(adbWrapper,`#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');const a=process.argv.slice(2),id=randomUUID(),started=Date.now(),log=row=>fs.appendFileSync(${JSON.stringify(adbTrace)},JSON.stringify({id,args:a,...row})+'\\n',{mode:0o600});log({phase:'start',at:started});const c=spawn(${JSON.stringify(realAdb)},a,{stdio:'inherit'});c.on('error',()=>{log({phase:'error',error:'spawn_failed',at:Date.now()});process.exitCode=1});c.on('close',(code,signal)=>{log({phase:'close',code,signal,at:Date.now(),durationMs:Date.now()-started});process.exitCode=code??1});`,{mode:0o700});
 const inventory=path.join(output,'inventory');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);const sourceId=(await json(path.join(inventory,'source.json'))).source_id;
 const config={source:{id:sourceId,kind:'apk'},backend:{type:'adb',adb:adbWrapper,deviceId:serial,appId:'com.bfs.visualtext',unicodeInput:{component:'com.bfs.mcp.ime/.UnicodeIme',apkSha256:hash(await readFile(ime))}},expectedArtifact:{kind:'apk',sha256:hash(await readFile(apk))},limits:{maxActions:12,maxDepth:0,maxDurationMs:280000},actionAllowlist:[],nativeVisualWorkflow:{enabled:true,node:process.execPath,helperJar:helper,helperSha256:hash(await readFile(helper)),allowedWorkflows:['query'],approvedDefinitions:{query:path.join(output,'definition.json')},ocr:{engine:{type:'vision',executable:vision,regions:[{"x":0.04861111111111111,"y":0.1015625,"width":0.30833333333333335,"height":0.0625},{"x":0.3597222222222222,"y":0.0796875,"width":0.6111111111111112,"height":0.1109375},{"x":0.041666666666666664,"y":0.5,"width":0.32916666666666666,"height":0.0703125},{"x":0.375,"y":0.5,"width":0.5833333333333334,"height":0.0703125}]},language:'chi_sim+eng'}}};
 const definition={kind:'native-visual-workflow',schemaVersion:1,mode:'text-replace',id:'query',name:'Visual Chinese query',effect:'read',activity:'com.bfs.visualtext.Main',inputName:'query',inputSchema:{type:'string',minLength:1,maxLength:16,pattern:'^[\u4e00-\u9fff]+$'},focusAnchor:'Query',submitAnchor:'Search',valueRegion:{x:.36,y:.08,width:.61,height:.11},resultRegion:{x:.04,y:.48,width:.9,height:.13},resultPrefix:'RESULT'};
 const cfg=path.join(output,'device.json'),def=path.join(output,'definition.json'),runtime=path.join(output,'runtime.json');await save(cfg,config);await save(def,definition);await save(runtime,{outputRoot:path.join(output,'software'),artifactRoots:[output],python,devices:{owned:cfg}});
 async function connect(entry,args=[]){const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:project,stderr:'pipe',env:{...process.env}});transport.stderr?.on('data',chunk=>record.mcpStderr=((record.mcpStderr||'')+chunk).slice(-16384));const c=new Client({name:'bfs-android-visual-text-acceptance',version:'1'});await c.connect(transport);return c;}
 async function call(c,name,args={}){const reply=await c.callTool({name,arguments:args});assert(!reply.isError,JSON.stringify(reply));return reply.structuredContent??JSON.parse(reply.content.find(x=>x.type==='text').text);}
 async function finish(c,started,statusName='software_operation',expected='completed'){const value=await until(async()=>{const v=await call(c,statusName,{operationId:started.operationId});return ['completed','failed','cancelled','interrupted'].includes(v.status)?v:null;},'MCP operation',320000);assert.equal(value.status,expected,JSON.stringify(value));return value;}
 client=await connect(path.join(project,'src/software-mcp.js'),['--config',runtime]);record.discovery=await finish(client,await call(client,'software_discover',{kind:'apk',input:apk,deviceName:'owned'}));
 const initial=await call(client,'software_capabilities',{sourceId});record.learning=await finish(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:initial.source.revision,specPath:def,samples:[{query:'北京'},{query:'上海'}]}));log('learning',{status:record.learning.status});
 const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile'}),cap=catalog.items.find(x=>x.name==='Visual Chinese query');assert(cap,JSON.stringify(catalog));assert.equal(cap.readiness,'ready');assert.equal(cap.inputSchema.properties.query.pattern,'^[\u4e00-\u9fff]+$');record.capability=cap;
 record.execution=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'广州'}}));assert.equal(record.execution.result.result.ok,true,JSON.stringify(record.execution));assert.match(record.execution.result.result.outputs.text,/广州/);log('execution',{outputs:record.execution.result.result.outputs});
 record.generated=await finish(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));generatedClient=await connect(record.generated.result.entry);const tool='cap_'+cap.id.slice(4,24);assert((await generatedClient.listTools()).tools.some(x=>x.name===tool));record.generatedExecution=await finish(generatedClient,await call(generatedClient,tool,{query:'深圳'}),'operation_status');assert.equal(record.generatedExecution.result.result.ok,true,JSON.stringify(record.generatedExecution));assert.match(record.generatedExecution.result.result.outputs.text,/深圳/);log('generated_execution',{outputs:record.generatedExecution.result.result.outputs});
 const beforeInvalid=(await readFile(adbTrace,'utf8')).trim().split('\n').filter(Boolean).length;record.invalidInput=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'bad value'}}),'software_operation','failed');assert.equal(record.invalidInput.errorCode,'INPUT_INVALID');record.invalidAdbCommands=(await readFile(adbTrace,'utf8')).trim().split('\n').filter(Boolean).length-beforeInvalid;assert.equal(record.invalidAdbCommands,0);log('invalid_input_blocked',{adbCommands:record.invalidAdbCommands});
 assert.match((await sh('am','broadcast','--receiver-foreground','-a','com.bfs.visualtext.MODE','-p','com.bfs.visualtext','--es','mode','ignore')).stdout,/result=-1/);await delay(500);await sh('logcat','-c');record.ignoredInput=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'杭州'}}));record.ignoredLogs=(await sh('logcat','-d','-s','BFS-TEXT-PROBE:I','*:S')).stdout;assert(record.ignoredLogs.includes('IGNORED_COMMIT'),'negative fixture must ignore commit');assert.equal(record.ignoredInput.result.result.error.code,'VISUAL_INPUT_NOT_VERIFIED');assert.equal(record.ignoredInput.result.result.writeOutcome.status,'unknown');assert(record.ignoredLogs.includes('IGNORED_COMMIT'));assert(!record.ignoredLogs.includes('SEARCH'));log('ignored_input_blocked',{result:record.ignoredInput.result.result});
 assert.match((await sh('am','broadcast','--receiver-foreground','-a','com.bfs.visualtext.MODE','-p','com.bfs.visualtext','--es','mode','auto')).stdout,/result=-1/);await delay(500);await sh('logcat','-c');record.noopSubmit=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'南京'}}));record.noopLogs=(await sh('logcat','-d','-s','BFS-TEXT-PROBE:I','*:S')).stdout;assert(record.noopLogs.includes('IGNORED_SEARCH'),'negative fixture must ignore submit');assert.equal(record.noopSubmit.result.result.error.code,'VISUAL_RESULT_NOT_VERIFIED');assert.equal(record.noopSubmit.result.result.writeOutcome.status,'unknown');log('noop_submit_blocked',{result:record.noopSubmit.result.result});
 await sh('am','start','-n','com.bfs.visualtext/.Overlay');await delay(1500);await sh('logcat','-c');record.overlay=await finish(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:'重庆'}}));record.overlayLogs=(await sh('logcat','-d','-s','BFS-TEXT-PROBE:I','*:S')).stdout;assert.equal(record.overlay.result.result.writeOutcome.status,'not_started');assert(!record.overlayLogs.includes('OVERLAY_DOWN'));log('overlay_blocked',{result:record.overlay.result.result});record.status='passed';record.acceptance={realDeviceKind:'owned Android API36 emulator',physicalDevice:false,unifiedAndGenerated:true,semanticTree:false,input:'Unicode IME actual replacement plus OCR echo',ocrEngine:'local Apple Vision chi_sim+eng',twoLearningSamples:['北京','上海'],unifiedValue:'广州',generatedValue:'深圳'};
 }catch(e){record.status='failed';record.error=String(e.stack||e);process.exitCode=1;log('failed',{message:String(e)});if(ownedProcess(emulatorReceipt)){for(const [label,args]of [['input-method',['dumpsys','input_method']],['activity',['dumpsys','activity','activities']],['window',['dumpsys','window','windows']],['system-log',['logcat','-d','-t','200']]]){const reply=await run(adb,['-s',serial,'shell',args.map(shellQuote).join(' ')],{timeout:8000,allowFailure:true});await writeFile(path.join(output,'failed-'+label+'.txt'),reply.stdout+reply.stderr)}}}
 finally{await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});if(ownedProcess(emulatorReceipt)){if(originalIme&&originalIme!=='null'){const restored=await sh('ime','set',originalIme).catch(()=>null);record.cleanup.originalImeRestored=!!restored&&(await sh('settings','get','secure','default_input_method')).stdout.trim()===originalIme;}if(installed){const d=await run(adb,['-s',serial,'uninstall','com.bfs.visualtext'],{allowFailure:true});record.cleanup.fixtureUninstalled=d.code===0;}if(imeInstalled){const d=await run(adb,['-s',serial,'uninstall','com.bfs.mcp.ime'],{allowFailure:true});record.cleanup.imeUninstalled=d.code===0;}await run(adb,['-s',serial,'emu','kill'],{allowFailure:true});for(let n=0;n<30&&ownedProcess(emulatorReceipt);n++)await delay(200);if(ownedProcess(emulatorReceipt))process.kill(emulatorReceipt.pid,'SIGTERM');await delay(300);record.cleanup.emulatorStopped=!ownedProcess(emulatorReceipt);}await removeStoppedOwnedAvd(emulatorReceipt);if(ownedAdbPort){const stopped=await run(adb,['-P',String(ownedAdbPort),'kill-server'],{allowFailure:true});record.cleanup.isolatedAdbServerStopped=stopped.code===0&&await portFree(ownedAdbPort);}if(record.status==='passed'&&['originalImeRestored','fixtureUninstalled','imeUninstalled','emulatorStopped','ownedAvdDataRemoved','isolatedAdbServerStopped'].some(k=>record.cleanup[k]!==true)){record.status='failed';record.error='OWNED_CLEANUP_NOT_VERIFIED';process.exitCode=1;}record.finishedAt=new Date().toISOString();await save(path.join(output,'results.json'),record);}}
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});await main();
