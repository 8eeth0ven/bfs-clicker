#!/usr/bin/env node
// Explicit, opt-in device acceptance: node test/android-workflow-e2e.mjs.
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
const output=path.resolve(values.output||path.join(project,'output-vision-implementation','android-workflow-'+Date.now()));
const reportDir=path.join(project,'output-vision-implementation');
const app='com.example.inventorydemo',adb=existsSync('/opt/homebrew/bin/adb')?'/opt/homebrew/bin/adb':path.join(sdk,'platform-tools/adb');
const targetOrigin='http://127.0.0.1:8765';
const hash=value=>createHash('sha256').update(value).digest('hex');
const record={date:new Date().toISOString(),status:'running',kind:'real_android_parameter_workflow',outputDir:output,steps:[],apiRequests:[],scope:{existingAvdWiped:false,userAppUninstalled:false,globalProxyChanged:false,caInstalled:false},cleanup:{}};
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
 await sh('am','start','-n',app+'/.DemoActivity','--es','base_url',targetOrigin,'--es','proxy_host','10.0.2.2','--ei','proxy_port',String(proxyPort),'--ez','workflow_mode','true');
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
  // This local listener is a tripwire for the fixture's old HTTP mode.
  // The workflow branch is pure native arithmetic and must never contact it.
  http=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;record.apiRequests.push({method:req.method,url:req.url,bodyBytes:Buffer.byteLength(body)});res.writeHead(403);res.end('HTTP not expected during native workflow');});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const proxyPort=http.address().port;
  record.apiFixture={targetOrigin,explicitAppProxyHost:'10.0.2.2',explicitAppProxyPort:proxyPort,systemProxyUsed:false,expectedRequests:0,allEmulatorBackgroundTrafficMonitored:false};
  const deviceConfig=path.join(output,'device.json');await save(deviceConfig,{source:{id:descriptor.source_id,kind:'apk'},backend:{type:'adb',adb,deviceId:serial,appId:app},limits:{maxActions:20,maxDepth:0,maxDurationMs:240000},actionAllowlist:[{kind:'type',selector:{accessibilityId:'Quantity'},effect:'read'},{kind:'click',selector:{accessibilityId:'Calculate'},effect:'read'}]});
  await launchFixture(proxyPort);record.initialUi=await workflowUi('initial-ui');assert.equal(record.initialUi.clicks,0);assert.equal(record.initialUi.quantity,'');
  const runtimeConfig=path.join(output,'runtime.json'),softwareRoot=path.join(output,'software');
  await save(runtimeConfig,{outputRoot:softwareRoot,artifactRoots:[output],python,devices:{isolated_android:deviceConfig},bindings:{[descriptor.source_id]:{allowed_origins:[]}}});
  client=await connect(path.join(project,'src/software-mcp.js'),['--config',runtimeConfig]);
  const discoveryStart=await mcpCall(client,'software_discover',{kind:'apk',input:apk,deviceName:'isolated_android'});
  record.discovery=await completed(client,discoveryStart.operationId);
  const beforeBinding=await mcpCall(client,'software_capabilities',{sourceId:descriptor.source_id,kind:'mobile',limit:100});
  assert.equal(beforeBinding.source.appArtifactVerified,true);assert.equal(beforeBinding.source.artifactVerification.actualSha256,record.apk.sha256);assert.equal(beforeBinding.source.artifactVerification.expectedSha256,record.apk.sha256);
  record.productArtifactVerification=beforeBinding.source.artifactVerification;record.afterDiscoveryUi=await workflowUi('after-discovery-ui');assert.equal(record.afterDiscoveryUi.clicks,0);
  const definition={schemaVersion:1,id:'native_square',name:'原生平方查询',effect:'read',inputSchema:{type:'object',properties:{quantity:{type:'integer',minimum:1,maximum:10}},required:['quantity'],additionalProperties:false},steps:[{kind:'type',selector:{accessibilityId:'Quantity'},input:'quantity',replace:true},{kind:'click',selector:{accessibilityId:'Calculate'}},{kind:'assert',selector:{accessibilityId:'total'},expect:{matches:'^TOTAL:[0-9]+$'},timeoutMs:3000},{kind:'extract',selector:{accessibilityId:'total'},output:'total',pattern:'^TOTAL:([0-9]+)$',group:1,valueType:'integer'}]};
  const definitionFile=path.join(output,'workflow.json');await save(definitionFile,definition);record.learningInputs=[{quantity:2},{quantity:3}];
  log('native_workflow_learning_started',{samples:[2,3]});
  const bindingStart=await mcpCall(client,'software_bind_workflow',{sourceId:descriptor.source_id,expectedRevision:beforeBinding.source.revision,specPath:definitionFile,samples:record.learningInputs});
  record.binding=await completed(client,bindingStart.operationId);
  record.afterLearningUi=await workflowUi('after-learning-ui');assert.equal(record.afterLearningUi.quantity,'3');assert.equal(record.afterLearningUi.total,'TOTAL:9');assert.equal(record.afterLearningUi.clicks,2);assert.equal(record.afterLearningUi.history,'HISTORY:2=4;3=9;');
  const catalog=await mcpCall(client,'software_capabilities',{sourceId:descriptor.source_id,kind:'mobile',limit:100});
  assert.equal(catalog.source.appArtifactVerified,true);assert.equal(catalog.source.artifactVerification.actualSha256,record.apk.sha256);
  const mobile=catalog.items.find(cap=>cap.inputSchema.properties?.quantity);assert.ok(mobile,JSON.stringify(catalog));assert.equal(mobile.readiness,'ready');assert.equal(mobile.evidence.controlContractsVerified,true);assert.equal(mobile.evidence.networkObserved,false);record.capability=mobile;
  assert.equal(mobile.inputSchema.properties.quantity.type,'integer');assert.equal(mobile.inputSchema.properties.quantity.maximum,10);
  log('native_workflow_learning_completed',{ui:record.afterLearningUi});
  const invalidStart=await mcpCall(client,'software_call',{sourceId:descriptor.source_id,capabilityId:mobile.id,expectedRevision:mobile.revision,params:{quantity:11}});
  record.invalidExecution=await completed(client,invalidStart.operationId,'software_operation','failed');record.afterInvalidUi=await workflowUi('after-invalid-ui');assert.deepEqual(record.afterInvalidUi,record.afterLearningUi);record.invalidInputAddedClicks=record.afterInvalidUi.clicks-record.afterLearningUi.clicks;
  const invocation=await mcpCall(client,'software_call',{sourceId:descriptor.source_id,capabilityId:mobile.id,expectedRevision:mobile.revision,params:{quantity:4}});
  record.mcpExecution=await completed(client,invocation.operationId);assert.equal(record.mcpExecution.result.result.ok,true,JSON.stringify(record.mcpExecution));assert.equal(record.mcpExecution.result.result.appArtifactVerified,true);assert.equal(record.mcpExecution.result.result.outputs.total,16);assert.equal(typeof record.mcpExecution.result.result.outputs.total,'number');
  record.afterCallUi=await workflowUi('after-call-ui');assert.deepEqual(record.afterCallUi,{quantity:'4',total:'TOTAL:16',clicks:3,history:'HISTORY:2=4;3=9;4=16;'});
  const generatedStart=await mcpCall(client,'software_generate',{sourceId:descriptor.source_id,expectedRevision:catalog.source.revision});record.generation=await completed(client,generatedStart.operationId);
  generatedClient=await connect(record.generation.result.entry);const tool='cap_'+mobile.id.slice(4,24);assert.ok((await generatedClient.listTools()).tools.some(row=>row.name===tool));
  const generatedCall=await mcpCall(generatedClient,tool,{quantity:5});record.generatedExecution=await completed(generatedClient,generatedCall.operationId,'operation_status');
  assert.equal(record.generatedExecution.result.result.ok,true,JSON.stringify(record.generatedExecution));assert.equal(record.generatedExecution.result.result.appArtifactVerified,true);assert.equal(record.generatedExecution.result.result.outputs.total,25);assert.equal(typeof record.generatedExecution.result.result.outputs.total,'number');
  record.finalUi=await workflowUi('final-ui');assert.deepEqual(record.finalUi,{quantity:'5',total:'TOTAL:25',clicks:4,history:'HISTORY:2=4;3=9;4=16;5=25;'});
  assert.equal(record.apiRequests.length,0,'The old HTTP demonstration branch must not run during this native workflow');
  const screen=await run(adb,['-s',serial,'exec-out','screencap','-p'],{binary:true});await writeFile(path.join(output,'final-screen.png'),screen.stdout);await writeFile(path.join(reportDir,'android-workflow.png'),screen.stdout);
  record.proxyAfter=(await sh('settings','get','global','http_proxy')).stdout.trim();assert.equal(record.proxyAfter,record.proxyBefore);
  record.status='passed';record.realDeviceEvidence={actualEmulator:true,fakeAdb:false,fakeWebDriver:false,installedArtifactHashMatches:true,typedIntegerInputs:[2,3,4,5],nativeComputedOutputs:[4,9,16,25],replacedPreviousValue:true,clicks:4,invalidInputAddedClicks:0,originalAppHttpRequests:0};
  log('android_workflow_acceptance_passed',{inputs:[2,3,4,5],outputs:[4,9,16,25],clicks:record.finalUi.clicks,httpRequests:record.apiRequests.length});
 }catch(error){record.status=installed?'failed':'blocked';record.error={name:error.name,message:String(error.message).slice(0,4000)};log('android_workflow_acceptance_failed',{error:record.error});process.exitCode=1;}
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
  record.finishedAt=new Date().toISOString();await save(path.join(output,'workflow-results.json'),record);await save(path.join(reportDir,'android-workflow.json'),record);
  const document=`# Android 原生参数化 workflow 验收\n\n日期：${record.date}。状态：**${record.status}**。\n\n设备：${JSON.stringify(record.device||{})}。只使用新建隔离AVD/data、独立ADB server、自建com.example.inventorydemo；不修改既有AVD、全局代理或CA。App仅通过workflow_mode intent进入计算UI，默认GET/POST演示分支保留。\n\n- APK SHA：${record.apk?.sha256||'未完成'}；设备安装包一致：${record.apk?.installedSha256===record.apk?.sha256}。\n- 产品身份：${JSON.stringify(record.productArtifactVerification||{})}。\n- 两组学习：${JSON.stringify(record.afterLearningUi||{})}。\n- 错误输入11：新增点击${record.invalidInputAddedClicks??'未完成'}次。\n- 统一MCP quantity=4：${JSON.stringify(record.afterCallUi||{})}。\n- 独立生成入口 quantity=5：${JSON.stringify(record.finalUi||{})}。\n- 原HTTP演示请求数：${record.apiRequests.length}。\n- 清理：${JSON.stringify(record.cleanup)}；原AVD配置未变：${record.existingAvdConfigUntouched}。\n\n${record.error?'具体失败：'+record.error.message:'真实ADB完成数字输入替换与原生运算，模块按结构控件合同执行并抽取integer结果；学习4/9、调用16、独立入口25均由App原生TextView和历史控件复核，不是协议回声。source和执行结果均保持artifact verified。'}\n\n产物目录：${output}；逐阶段UI XML及截图final-screen.png；完整JSON见android-workflow.json。\n\n![原生计算结果](android-workflow.png)\n\n复验：\n\n\`\`\`sh\nnode test/android-workflow-e2e.mjs --sdk /absolute/Android/sdk --python /absolute/python --output /absolute/new-output\n\`\`\`\n\n此脚本须显式运行，不混入无设备回归；缺SDK/启动失败明确退出1。参数同Android device验收脚本，可选择--keep-emulator-data保留本轮数据排查，默认清理自己创建的AVD。它不证明物理手机、任意App或整个业务链路覆盖，也没有监控全部模拟器后台网络。\n`;
  await writeFile(path.join(reportDir,'android-workflow.md'),document);process.stdout.write(JSON.stringify({status:record.status,report:path.join(reportDir,'android-workflow.json')})+'\n');
 }
}
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
await main();
