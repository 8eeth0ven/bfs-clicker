#!/usr/bin/env node
// Explicit, opt-in device acceptance: node test/android-device-e2e.mjs.
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
const output=path.resolve(values.output||path.join(project,'output-vision-implementation','android-device-'+Date.now()));
const reportDir=path.join(project,'output-vision-implementation');
const app='com.example.inventorydemo',adb=existsSync('/opt/homebrew/bin/adb')?'/opt/homebrew/bin/adb':path.join(sdk,'platform-tools/adb');
const targetOrigin='http://127.0.0.1:8765';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record={date:new Date().toISOString(),status:'running',kind:'real_android_emulator',outputDir:output,steps:[],apiRequests:[],scope:{existingAvdWiped:false,userAppUninstalled:false,globalProxyChanged:false,caInstalled:false},cleanup:{}};
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
 await sh('am','start','-n',app+'/.DemoActivity','--es','base_url',targetOrigin,'--es','proxy_host','10.0.2.2','--ei','proxy_port',String(proxyPort));
 await until(async()=>/mResumedActivity|topResumedActivity/.test((await sh('dumpsys','activity','activities')).stdout)&& (await sh('dumpsys','activity','activities')).stdout.includes(app), 'fixture foreground',15000);
}
const content=reply=>reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
async function mcpCall(sdkClient,name,args={}){const reply=await sdkClient.callTool({name,arguments:args});assert.ok(!reply.isError,JSON.stringify(reply));return content(reply);}
async function completed(sdkClient,id,name='software_operation'){
 const result=await until(async()=>{const value=await mcpCall(sdkClient,name,{operationId:id});return ['completed','failed','cancelled','interrupted'].includes(value.status)?value:null;},'MCP '+id,180000);
 assert.equal(result.status,'completed',JSON.stringify(result));return result;
}
async function connect(entry,args=[]){
 const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:project,stderr:'pipe',env:{...process.env}});
 transport.stderr?.on('data',chunk=>{record.mcpStderr=((record.mcpStderr||'')+chunk).slice(-16384);});
 const sdkClient=new Client({name:'bfs-real-android-emulator-acceptance',version:'1'});await sdkClient.connect(transport);return sdkClient;
}
async function main(){
 await mkdir(output,{recursive:true});await mkdir(reportDir,{recursive:true});
 const existingConfig=path.join(os.homedir(),'.android/avd/Medium_Phone.avd/config.ini'),existingIndex=path.join(os.homedir(),'.android/avd/Medium_Phone_API_36.0.ini');
 record.originalAvdHashes={};for(const file of [existingConfig,existingIndex])if(existsSync(file))record.originalAvdHashes[file]=hash(await readFile(file));
 try{
  assert.ok(existsSync(python),'Python environment missing: '+python);assert.ok(existsSync(path.join(sdk,'emulator/emulator')),'Android emulator missing');
  await startEmulator();log('emulator_started',{serial,pid:emulatorReceipt.pid,isolatedNewData:true});await waitBoot();
  const apk=path.join(output,'demo.apk');
  if(!existsSync(apk))await run(python,[path.join(project,'apk_tools/examples/build_demo.py'),'--out',apk,'--sdk',sdk]);
  record.apk={path:apk,sha256:hash(await readFile(apk)),builder:'apk_tools/examples/build_demo.py',package:app};log('apk_built',{sha256:record.apk.sha256});
  const inventory=path.join(output,'inventory');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);
  const descriptor=await json(path.join(inventory,'source.json'));assert.equal(descriptor.app.package_name,app);assert.equal(descriptor.app.apk_sha256,record.apk.sha256);
  const staticEndpoints=await json(path.join(inventory,descriptor.inventory));record.staticDiscovery={sourceId:descriptor.source_id,endpoints:staticEndpoints.length,knownMethods:[...new Set(staticEndpoints.map(row=>row.method).filter(Boolean))],unknownMethodCandidates:staticEndpoints.filter(row=>row.method===null).length};
  await device('install','-r',apk);installed=true;
  const installedPath=(await sh('pm','path',app)).stdout.trim().split('\n').find(line=>line.startsWith('package:'))?.slice(8);assert.ok(installedPath);
  const installedHash=(await sh('sha256sum',installedPath)).stdout.trim().split(/\s+/)[0];assert.equal(installedHash,record.apk.sha256);record.apk.installedSha256=installedHash;
  http=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;let target;try{target=new URL(req.url,targetOrigin);}catch{res.writeHead(400);res.end();return;}
   const accepted=target.origin===targetOrigin&&target.pathname==='/items';record.apiRequests.push({method:req.method,url:target.href,bodyBytes:Buffer.byteLength(body),accepted,receivedAt:new Date().toISOString()});
   res.writeHead(accepted?(req.method==='GET'?200:201):403,{'content-type':'application/json'});res.end(JSON.stringify({items:[{id:'fixture',name:'local Android fixture'}],method:req.method}));});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const proxyPort=http.address().port;
  record.apiFixture={targetOrigin,explicitAppProxyHost:'10.0.2.2',explicitAppProxyPort:proxyPort,systemProxyUsed:false,publicTargetAccessed:false};
  const deviceConfig=path.join(output,'device.json');await save(deviceConfig,{source:{id:descriptor.source_id,kind:'apk'},backend:{type:'adb',adb,deviceId:serial,appId:app},limits:{maxActions:6,maxDepth:2,maxDurationMs:120000}});
  await launchFixture(proxyPort);log('direct_adb_explore_started');
  const directDir=path.join(output,'direct-ui');const direct=await run(python,['-m','apk_inventory.mobile_ui','--config',deviceConfig,'--operation','explore','--output',directDir],{timeout:150000});
  record.directUi=JSON.parse(direct.stdout);assert.equal(record.directUi.ok,true,JSON.stringify(record.directUi));
  const directManifest=await json(path.join(directDir,'manifest.json'));assert.ok(directManifest.capabilities.some(cap=>cap.readiness==='ready'));await until(()=>record.apiRequests.filter(row=>row.accepted).length>=1,'direct Android API request',10000);
  record.directApiRequestCount=record.apiRequests.length;log('direct_adb_explore_completed',{states:record.directUi.states,actions:record.directUi.actions,apiRequests:record.directApiRequestCount});
  await launchFixture(proxyPort);
  const runtimeConfig=path.join(output,'runtime.json'),softwareRoot=path.join(output,'software');
  await save(runtimeConfig,{outputRoot:softwareRoot,artifactRoots:[output],python,devices:{isolated_android:deviceConfig},bindings:{[descriptor.source_id]:{allowed_origins:[targetOrigin]}}});
  client=await connect(path.join(project,'src/software-mcp.js'),['--config',runtimeConfig]);
  const discoveryStart=await mcpCall(client,'software_discover',{kind:'apk',input:apk,deviceName:'isolated_android'});
  record.discovery=await completed(client,discoveryStart.operationId);
  const catalog=await mcpCall(client,'software_capabilities',{sourceId:descriptor.source_id,kind:'mobile',limit:100});
  assert.equal(catalog.source.appArtifactVerified,true,'Product adapter must bind the installed APK to the static source');
  assert.equal(catalog.source.artifactVerification.status,'verified');
  assert.equal(catalog.source.artifactVerification.expectedSha256,record.apk.sha256);
  assert.equal(catalog.source.artifactVerification.actualSha256,record.apk.sha256);
  assert.ok(!catalog.source.gaps.some(gap=>(typeof gap==='string'?gap:gap.reason)==='app_artifact_not_verified'));
  record.productArtifactVerification=catalog.source.artifactVerification;
  const mobile=catalog.items.find(cap=>cap.readiness==='ready');assert.ok(mobile,JSON.stringify(catalog));assert.equal(mobile.evidence.executionObserved,true);assert.equal(mobile.evidence.networkObserved,false);record.capability=mobile;
  record.apiAfterMcpDiscovery=record.apiRequests.length;
  await launchFixture(proxyPort);const beforeCall=record.apiRequests.length;
  const invocation=await mcpCall(client,'software_call',{sourceId:descriptor.source_id,capabilityId:mobile.id,expectedRevision:mobile.revision,params:{}});
  record.mcpExecution=await completed(client,invocation.operationId);assert.equal(record.mcpExecution.result.result.ok,true,JSON.stringify(record.mcpExecution));
  assert.equal(record.mcpExecution.result.result.appArtifactVerified,true);
  await until(()=>record.apiRequests.length>beforeCall,'official MCP Android UI-triggered API',10000);
  const generatedStart=await mcpCall(client,'software_generate',{sourceId:descriptor.source_id,expectedRevision:catalog.source.revision});record.generation=await completed(client,generatedStart.operationId);
  generatedClient=await connect(record.generation.result.entry);const tool='cap_'+mobile.id.slice(4,24);assert.ok((await generatedClient.listTools()).tools.some(row=>row.name===tool));
  await launchFixture(proxyPort);const beforeGenerated=record.apiRequests.length;
  const generatedCall=await mcpCall(generatedClient,tool,{});record.generatedExecution=await completed(generatedClient,generatedCall.operationId,'operation_status');
  assert.equal(record.generatedExecution.result.result.ok,true,JSON.stringify(record.generatedExecution));await until(()=>record.apiRequests.length>beforeGenerated,'generated MCP Android UI-triggered API',10000);
  assert.equal(record.generatedExecution.result.result.appArtifactVerified,true);
  assert.ok(record.apiRequests.every(row=>row.accepted&&row.method==='GET'),'Only the fixture read request may be executed; POST remains undispatched');
  const allCaps=await mcpCall(client,'software_capabilities',{sourceId:descriptor.source_id,limit:100});record.postCandidates=allCaps.items.filter(row=>row.name.startsWith('POST '));assert.ok(record.postCandidates.every(row=>row.readiness==='candidate'));
  const screen=await run(adb,['-s',serial,'exec-out','screencap','-p'],{binary:true});await writeFile(path.join(output,'final-screen.png'),screen.stdout);
  record.proxyAfter=(await sh('settings','get','global','http_proxy')).stdout.trim();assert.equal(record.proxyAfter,record.proxyBefore);
  record.status='passed';record.realDeviceEvidence={actualEmulator:true,fakeAdb:false,fakeWebDriver:false,installedArtifactHashMatches:true,uiCommandAndHttpObserved:true,serverResponseStatus:200,networkCausality:'isolated synthetic App operation plus exact mock API request, not a claim about arbitrary async app causality'};
  log('android_device_acceptance_passed',{apiRequests:record.apiRequests.length,sourceId:descriptor.source_id,mobileCapability:mobile.id});
 }catch(error){record.status=installed?'failed':'blocked';record.error={name:error.name,message:String(error.message).slice(0,4000)};log('android_device_acceptance_failed',{error:record.error});process.exitCode=1;}
 finally{
  await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});
  if(http)await new Promise(resolve=>{http.closeAllConnections();http.close(resolve);});
  if(installed&&ownedProcess(emulatorReceipt)){const uninstalled=await run(adb,['-s',serial,'uninstall',app],{allowFailure:true,timeout:20000});record.cleanup.fixtureUninstalled=uninstalled.code===0;}
  if(ownedProcess(emulatorReceipt)){
   await run(adb,['-s',serial,'emu','kill'],{allowFailure:true,timeout:10000});
   for(let count=0;count<30&&ownedProcess(emulatorReceipt);count++)await delay(200);
   if(ownedProcess(emulatorReceipt)){process.kill(emulatorReceipt.pid,'SIGTERM');await delay(500);}
   record.cleanup.emulatorStopped=!ownedProcess(emulatorReceipt);
  }
  if(record.cleanup.emulatorStopped&&!values['keep-emulator-data']&&emulatorReceipt?.isolatedNewData&&emulatorReceipt.avd.startsWith(output+path.sep)){
   await rm(emulatorReceipt.avd,{recursive:true,force:true});record.cleanup.ownedAvdDataRemoved=true;
  }
  if(ownedAdbPort&&emulatorReceipt?.adbServerOwned){const stopped=await run(adb,['-P',String(ownedAdbPort),'kill-server'],{allowFailure:true,timeout:10000});record.cleanup.isolatedAdbServerStopped=stopped.code===0;}
  record.existingAvdConfigUntouched=true;
  for(const [file,before] of Object.entries(record.originalAvdHashes))if(hash(await readFile(file))!==before)record.existingAvdConfigUntouched=false;
  if(!record.existingAvdConfigUntouched){record.status='failed';process.exitCode=1;}
  record.finishedAt=new Date().toISOString();await save(path.join(output,'device-results.json'),record);await save(path.join(reportDir,'android-device-results.json'),record);
  const document=`# Android 真实模拟器闭环验收\n\n日期：${record.date}。状态：**${record.status}**。\n\n使用独立新建AVD/data；没有wipe现有AVD、改全局代理/CA或操作用户App。仅安装并在结束时移除仓库自建com.example.inventorydemo。\n\n- 设备：${JSON.stringify(record.device||{})}\n- APK：${JSON.stringify(record.apk||{})}\n- 静态发现：${JSON.stringify(record.staticDiscovery||{})}\n- 真实ADB探索：${JSON.stringify(record.directUi||{})}\n- 实际本机HTTP请求：${record.apiRequests.length}次；仅GET：${record.apiRequests.every(row=>row.method==='GET')}。请求来自App自身显式代理设置，不是全局代理。\n- MCP链路：实际APK→提取→真实ADB探索→software_discover→software_call→software_generate独立入口→官方SDK再次调用。\n- 清理：${JSON.stringify(record.cleanup)}；原AVD配置未改：${record.existingAvdConfigUntouched}。\n\n产物：${output}。原始结构化记录见android-device-results.json与运行目录device-results.json；截图final-screen.png。\n\n${record.error?'具体阻碍：'+record.error.message:'此结论仅覆盖自建App、API36 arm64模拟器和本机HTTP夹具；不是物理手机、任意App、HTTPS/pinning或通用业务成功验收。本轮产品级artifactVerification已核对设备安装SHA、静态descriptor与expected hash一致；manifest不再保留app_artifact_not_verified，software_call与独立入口执行时也重新核对。'}\n\n复验：\n\n\`\`\`sh\nnode test/android-device-e2e.mjs --sdk /absolute/Android/sdk --python /absolute/python --output /absolute/new-output\n\`\`\`\n\n直接node运行，默认不加入无设备回归；缺SDK或无法启动明确失败并退出1。--reuse-owned-emulator只接受当前输出目录的所有权receipt；--keep-emulator-data保留本轮数据便于排查，仍停止模拟器。\n`;
  await writeFile(path.join(reportDir,'android-device.md'),document);process.stdout.write(JSON.stringify({status:record.status,report:path.join(reportDir,'android-device-results.json')})+'\n');
 }
}
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
await main();
