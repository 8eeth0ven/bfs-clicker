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

const project=path.resolve(import.meta.dirname,'..');
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
const decodeXml=text=>text.replace(/&#x([0-9a-f]+);/gi,(_,code)=>String.fromCodePoint(parseInt(code,16))).replace(/&#([0-9]+);/g,(_,code)=>String.fromCodePoint(Number(code))).replace(/&quot;/g,'\"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
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
async function main(){
 await mkdir(output,{recursive:true});record.originalAvdHashes={};for(const file of [path.join(os.homedir(),'.android/avd/Medium_Phone.avd/config.ini'),path.join(os.homedir(),'.android/avd/Medium_Phone_API_36.0.ini')])if(existsSync(file))record.originalAvdHashes[file]=hash(await readFile(file));let originalIme;
 try{
  await startEmulator();await waitBoot();
  const apk=path.join(output,'ime.apk');await run(python,[path.join(project,'apk_tools/examples/unicode-ime/build.py'),'--out',apk,'--sdk',sdk]);
  record.apk={path:apk,sha256:hash(await readFile(apk))};await device('install','-r',apk);installed=true;
  originalIme=(await sh('settings','get','secure','default_input_method')).stdout.trim();record.originalIme=originalIme;
  await until(async()=> (await sh('ime','list','-a','-s')).stdout.includes(app+'/.UnicodeIme'),'owned IME registration',60000);
  await sh('ime','enable',app+'/.UnicodeIme');await sh('ime','set',app+'/.UnicodeIme');await sh('am','start','-n',app+'/.UnicodeActivity');
  await until(async()=>{const target='/sdcard/bfs-unicode-bootstrap.xml';const dump=await run(realAdb,['-s',serial,'shell','uiautomator dump '+target],{timeout:20000,allowFailure:true});if(dump.code!==0)return false;const xml=(await sh('cat',target)).stdout;await sh('rm','-f',target);return xml.includes('UnicodeQuery')&&xml.includes('COUNT:0');},'owned fixture XML idle',120000);
  const wrapper=path.join(output,'adb-visual-trace.cjs'),trace=path.join(output,'adb-visual-trace.jsonl');await writeFile(wrapper,`#!${process.execPath}
const {spawn}=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+String.fromCharCode(10));const child=spawn(${JSON.stringify(realAdb)},args,{stdio:'inherit'});child.on('error',()=>process.exitCode=1);child.on('close',code=>process.exitCode=code??1);`,{mode:0o700});
  const inventory=path.join(output,'inventory'),deviceFile=path.join(output,'device.json');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);const descriptor=await json(path.join(inventory,'source.json')),sourceId=descriptor.source_id;
  await save(deviceFile,{source:{id:sourceId,kind:'apk'},backend:{type:'adb',adb:wrapper,deviceId:serial,appId:app},limits:{maxActions:0,maxDepth:0,maxDurationMs:120000},actionAllowlist:[]});const configFile=path.join(output,'runtime.json');await save(configFile,{outputRoot:path.join(output,'software'),artifactRoots:[output],python,devices:{owned:deviceFile},nativeVisual:{[sourceId]:{language:'eng'}},bindings:{[sourceId]:{allowed_origins:[]}}});
  client=await connect(path.join(project,'src/software-mcp.js'),['--config',configFile]);record.discovery=await completed(client,(await mcpCall(client,'software_discover',{kind:'apk',input:apk,deviceName:'owned'})).operationId);const catalog=await mcpCall(client,'software_capabilities',{sourceId});assert.equal(catalog.source.appArtifactVerified,true,JSON.stringify(catalog.source));
  const initial=(await readFile(trace,'utf8')).trim().split('\n').length;record.observation=await completed(client,(await mcpCall(client,'software_observe_mobile',{sourceId,expectedRevision:catalog.source.revision})).operationId);assert.match(record.observation.result.text,/Search/i);assert.match(record.observation.result.capturedAt,/^\d{4}-\d\d-\d\dT.*Z$/);assert.equal(record.observation.result.appArtifactVerified,true);assert(!JSON.stringify(record.observation).includes('privateArtifacts'));assert(!JSON.stringify(record.observation).includes('/capture/'));
  record.generated=await completed(client,(await mcpCall(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision})).operationId);generatedClient=await connect(record.generated.result.entry);assert((await generatedClient.listTools()).tools.some(tool=>tool.name==='observe_mobile'));record.generatedObservation=await completed(generatedClient,(await mcpCall(generatedClient,'observe_mobile')).operationId,'operation_status');assert.match(record.generatedObservation.result.text,/Search/i);assert.match(record.generatedObservation.result.capturedAt,/^\d{4}-\d\d-\d\dT.*Z$/);assert(!JSON.stringify(record.generatedObservation).includes('privateArtifacts'));assert(!JSON.stringify(record.generatedObservation).includes('/capture/'));
  const actions=(await readFile(trace,'utf8')).trim().split('\n').slice(initial).map(line=>JSON.parse(line));record.observationCommands=actions;assert.equal(actions.filter(args=>args.includes('exec-out')&&args.includes('screencap')).length,2);assert(!actions.some(args=>args.some(arg=>/(?:^|\s)(?:input|am start)(?:\s|$)/.test(arg))));log('actual_mcp_and_generated_ocr_passed',{screenshots:2,uiActions:0});
  record.status='passed';
 }catch(error){if(installed&&ownedProcess(emulatorReceipt)){for(const name of ['input_method','activity'])try{await writeFile(path.join(output,'failed-'+name+'.txt'),(await sh('dumpsys',name)).stdout);}catch{}try{const target='/sdcard/bfs-unicode-failed.xml';await sh('uiautomator','dump',target);await writeFile(path.join(output,'failed-ui.xml'),(await sh('cat',target)).stdout);await sh('rm','-f',target);}catch{}}record.status='failed';record.error={message:String(error.message).slice(0,6000)};process.exitCode=1;log('failed',record.error);}
 finally{
  await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});
  if(installed&&ownedProcess(emulatorReceipt)){
   if(originalIme&&originalIme!=='null'){await sh('ime','set',originalIme);record.cleanup.originalImeRestored=(await sh('settings','get','secure','default_input_method')).stdout.trim()===originalIme;}
   const removed=await run(adb,['-s',serial,'uninstall',app],{allowFailure:true});record.cleanup.fixtureUninstalled=removed.code===0;
  }
  if(ownedProcess(emulatorReceipt)){await run(adb,['-s',serial,'emu','kill'],{allowFailure:true});for(let n=0;n<30&&ownedProcess(emulatorReceipt);n++)await delay(200);if(ownedProcess(emulatorReceipt))process.kill(emulatorReceipt.pid,'SIGTERM');await delay(300);record.cleanup.emulatorStopped=!ownedProcess(emulatorReceipt);}
  if(record.cleanup.emulatorStopped&&emulatorReceipt?.avd.startsWith(output+path.sep)){await rm(emulatorReceipt.avd,{recursive:true,force:true});record.cleanup.ownedAvdDataRemoved=true;}
  if(ownedAdbPort){const stopped=await run(adb,['-P',String(ownedAdbPort),'kill-server'],{allowFailure:true});record.cleanup.isolatedAdbServerStopped=stopped.code===0&&await portFree(ownedAdbPort);}
  record.existingAvdConfigUntouched=true;for(const [file,value] of Object.entries(record.originalAvdHashes))if(hash(await readFile(file))!==value)record.existingAvdConfigUntouched=false;
  if(record.status==='passed'&&(!record.existingAvdConfigUntouched||['originalImeRestored','fixtureUninstalled','emulatorStopped','ownedAvdDataRemoved','isolatedAdbServerStopped'].some(key=>record.cleanup[key]!==true))){record.status='failed';process.exitCode=1;}
  record.finishedAt=new Date().toISOString();await save(path.join(output,'results.json'),record);await save(path.join(reportDir,'native-visual-mcp-final-device.json'),record);await writeFile(path.join(reportDir,'native-visual-mcp-final-device.md'),'# Android 移动视觉 MCP 实际模拟器验收\n\n状态：'+record.status+'\n\n'+JSON.stringify({observation:record.observation?.result,generatedObservation:record.generatedObservation?.result,cleanup:record.cleanup,error:record.error},null,2));
 }
}
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
await main();
