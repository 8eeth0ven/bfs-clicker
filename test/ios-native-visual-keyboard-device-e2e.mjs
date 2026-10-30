#!/usr/bin/env node
// Opt-in real iOS system keyboard and ordinary UITextField acceptance via MCP.
// Prepared script only: its existence is not device acceptance evidence.
// Own app, simulator UUID, Appium home, WDA derived data, and service ports only.
import assert from 'node:assert/strict';
import {keyboardEnvelope} from './ios-keyboard-envelope.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,appendFile,cp} from 'node:fs/promises';
import {createServer as createHttpServer,request as httpRequest} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const project=path.resolve(import.meta.dirname,'..'),reportDir=path.join(project,'output-vision-implementation');
const {values}=parseArgs({options:{output:{type:'string'},python:{type:'string'},'appium-prefix':{type:'string'},runtime:{type:'string'},'device-type':{type:'string'},'prepare-only':{type:'boolean'},'await-ocr-ready':{type:'string'},'prebuilt-wda-from':{type:'string'}}});
const output=path.resolve(values.output||path.join(reportDir,'ios-text-next-device-'+Date.now())),python=path.resolve(values.python||path.join(project,'.venv/bin/python'));
const appiumPrefix=path.resolve(values['appium-prefix']||path.join(reportDir,'ios-appium-owned-20261029')),appiumHome=path.join(appiumPrefix,'appium-home'),appiumEntry=path.join(appiumPrefix,'node_modules/appium/build/lib/main.js');
const appId='com.example.bfsmcp.iosvisualkeyboard',hash=value=>createHash('sha256').update(value).digest('hex'),record={date:new Date().toISOString(),kind:'real_ios_simulator',interface:'unified_and_generated_mcp',status:'running',outputDir:output,scope:{userDevicesErased:false,userAppsTouched:false,licensesAccepted:false,developerDirectoryChanged:false,globalAppiumInstalled:false,runtimeDownloadedByThisScript:false},steps:[],cleanup:{}};
let ownedUdid,ownedName,ownedRuntime,appiumChild,appiumPort,wdaPort,mjpegPort,proxy,proxyPort,sessionId,client,generatedClient,installed=false,interrupted=false;
const requests=[],ownedCommands=new Set(),evidenceTasks=new Set();
const save=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});};
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const log=(phase,fields={})=>{const row={phase,at:new Date().toISOString(),...fields};record.steps.push(row);process.stdout.write(JSON.stringify(row)+'\n')};
async function run(exe,args,{timeout=180000,allowFailure=false,env={}}={}){
 const child=spawn(exe,args,{cwd:project,env:{...process.env,PYTHONPATH:path.join(project,'apk_tools'),PYTHONDONTWRITEBYTECODE:'1',...env},stdio:['ignore','pipe','pipe']});ownedCommands.add(child);let stdout=[],stderr=[],bytes=0;
 child.stdout.on('data',part=>{bytes+=part.length;if(bytes>8*1024*1024)child.kill('SIGTERM');else stdout.push(part)});child.stderr.on('data',part=>{stderr.push(part);if(Buffer.concat(stderr).length>131072)stderr=stderr.slice(-4)});
 let killTimer;const timer=setTimeout(()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1500)},timeout);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}).finally(()=>{clearTimeout(timer);clearTimeout(killTimer);ownedCommands.delete(child)});const result={code,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()};
 await appendFile(path.join(output,'host-commands.jsonl'),JSON.stringify({at:new Date().toISOString(),exe,args,code,stderr:result.stderr.slice(-4000)})+'\n');
 if(!allowFailure&&(code!==0||bytes>8*1024*1024))throw Error(path.basename(exe)+' failed ('+code+'): '+result.stderr.slice(-3000));return result;
}
const simctl=(...args)=>run('/usr/bin/xcrun',['simctl',...args]);
async function until(fn,label,timeout=180000){const deadline=Date.now()+timeout;let last=0;while(Date.now()<deadline){if(interrupted)throw Error('interrupted');const result=await fn();if(result)return result;if(Date.now()-last>15000){log('waiting',{for:label});last=Date.now()}await delay(500)}throw Error('Timeout: '+label)}
async function portFree(port){return new Promise(resolve=>{const server=createNetServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)))})}
async function choosePort(start){while(!await portFree(start))start++;return start}
async function httpJson(method,route,body,{timeout=180000,allowError=false,port=appiumPort}={}){
 const raw=body===undefined?undefined:JSON.stringify(body);
 const response=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>request.destroy(Object.assign(new Error('HTTP_RESPONSE_TIMEOUT'),{code:'HTTP_RESPONSE_TIMEOUT'})),timeout);const request=httpRequest({hostname:'127.0.0.1',port,path:route,method,headers:{'content-type':'application/json',...(raw===undefined?{}:{'content-length':Buffer.byteLength(raw)})}},reply=>{let chunks=[],size=0;reply.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)request.destroy(new Error('HTTP_RESPONSE_LIMIT'));else chunks.push(chunk)});reply.on('end',()=>{clearTimeout(timer);resolve({status:reply.statusCode,text:Buffer.concat(chunks).toString()})});reply.on('error',error=>{clearTimeout(timer);reject(error)})});request.on('error',error=>{clearTimeout(timer);reject(error)});request.end(raw)});
 const text=response.text;let value;try{value=JSON.parse(text)}catch{throw Error('Non-JSON actual Appium reply: '+text.slice(0,500))}if(!allowError&&(response.status<200||response.status>=300||value.value?.error))throw Error('Actual Appium '+method+' '+route+' ('+response.status+'): '+text.slice(0,3000));return {status:response.status,...value};
}
function ownedAppiumAlive(){if(!appiumChild?.pid)return false;try{const cmd=execFileSync('ps',['-p',String(appiumChild.pid),'-o','command='],{encoding:'utf8'});return cmd.includes(appiumEntry)&&cmd.includes(String(appiumPort))}catch{return false}}
async function startAppium(){
 appiumPort=await choosePort(4725);wdaPort=await choosePort(8101);mjpegPort=await choosePort(9101);record.ports={appium:appiumPort,wda:wdaPort,mjpeg:mjpegPort};
 const fd=openSync(path.join(output,'appium.log'),'a');appiumChild=spawn(process.execPath,[appiumEntry,'--address','127.0.0.1','--port',String(appiumPort),'--base-path','/','--log-timestamp','--log-no-colors'],{cwd:output,env:{...process.env,APPIUM_HOME:appiumHome},stdio:['ignore',fd,fd],detached:true});closeSync(fd);appiumChild.unref();await save(path.join(output,'appium-receipt.json'),{pid:appiumChild.pid,entry:appiumEntry,appiumHome,port:appiumPort,ownedOutput:output});
 await until(async()=>{if(!ownedAppiumAlive())throw Error('Owned Appium exited; inspect appium.log');try{const status=await httpJson('GET','/status',undefined,{timeout:3000});return status.value?.ready}catch{return false}},'owned real Appium server',60000);
}
async function startTransparentProxy(){
 proxy=createHttpServer((req,res)=>{
  const row={id:requests.length,started:Date.now(),method:req.method,path:req.url,body:'',responseStatus:null};requests.push(row);
  const upstream=httpRequest({hostname:'127.0.0.1',port:appiumPort,method:req.method,path:req.url,headers:{...req.headers,host:'127.0.0.1:'+appiumPort}},reply=>{
   row.responseStatus=reply.statusCode;
   const keepSource=req.method==='GET'&&/\/source$/.test(req.url),chunks=[];let bytes=0,overflow=false;
   if(keepSource)reply.on('data',part=>{bytes+=part.length;if(bytes<=8*1024*1024)chunks.push(part);else{overflow=true;chunks.length=0}});
   // Diagnostic capture observes the actual response stream without changing
   // its status, bytes or timing-dependent application assertions.
   res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
   reply.once('end',()=>{
    row.finished=Date.now();
    const task=(async()=>{
     try{
      if(keepSource){
       row.sourceResponseBytes=bytes;
       if(overflow)row.sourceCaptureError='diagnostic_response_limit';
       else{
        const value=JSON.parse(Buffer.concat(chunks).toString()).value;
        if(typeof value==='string'&&Buffer.byteLength(value)<=4*1024*1024){
         const name='source-response-'+row.id+'.xml';await writeFile(path.join(output,name),value,{mode:0o600});
         row.sourceArtifact={file:name,sha256:hash(value),bytes:Buffer.byteLength(value)};
        }else row.sourceCaptureError='diagnostic_source_shape_or_size';
       }
      }
     }catch{row.sourceCaptureError='diagnostic_capture_failed'}
     await appendFile(path.join(output,'webdriver-forwarded.jsonl'),JSON.stringify(row)+'\n').catch(()=>{});
    })();evidenceTasks.add(task);task.finally(()=>evidenceTasks.delete(task));
   });
  });
  req.on('data',part=>{if(row.body.length<65536)row.body+=part.toString()});req.pipe(upstream);upstream.on('error',error=>{row.error=String(error);if(!res.headersSent)res.writeHead(502);res.end('Owned diagnostic forwarding error')});req.on('aborted',()=>upstream.destroy());
 });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));proxyPort=proxy.address().port;record.ports.proxy=proxyPort;record.transparentProxy={onlyForwardsActualAppium:true,generatedProtocolReplies:false,port:proxyPort};
}
async function existingDeviceSnapshot(){const raw=JSON.parse((await simctl('list','devices','-j')).stdout);return Object.fromEntries(Object.entries(raw.devices).flatMap(([runtime,devices])=>devices.map(device=>[device.udid,{runtime,name:device.name,state:device.state}])))}
async function stopOwnedXcode(){
 const lines=execFileSync('ps',['-axo','pid=,pgid=,command='],{encoding:'utf8'}).split('\n');const targets=lines.map(row=>row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(row=>row&&row[3].includes('xcodebuild')&&row[3].includes(path.join(output,'wda-derived-data'))&&row[3].includes('id='+ownedUdid));
 for(const row of targets){const pid=Number(row[1]),group=Number(row[2]);try{process.kill(group===pid?-pid:pid,'SIGTERM')}catch{}}
 if(targets.length)await delay(800);
 for(const row of targets){const pid=Number(row[1]);try{const cmd=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});if(cmd.includes(path.join(output,'wda-derived-data'))&&cmd.includes('id='+ownedUdid))process.kill(Number(row[2])===pid?-pid:pid,'SIGKILL')}catch{}}
 record.cleanup.ownedXcodeStopped=true;
}
async function checkCleanup(){
 const cmd=execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(.+)$/)).filter(Boolean);record.processCleanupAudit={ownedProcessesRemaining:cmd.filter(row=>row[2].includes(output+path.sep)&&/xcodebuild|WebDriverAgent|appium|ios-device-e2e/.test(row[2])).map(row=>({pid:Number(row[1]),command:row[2]})),ports:{}};
 for(const port of Object.values(record.ports||{})){const value=await run('/usr/sbin/lsof',['-nP','-t','-iTCP:'+port,'-sTCP:LISTEN'],{allowFailure:true});record.processCleanupAudit.ports[port]={listening:!!value.stdout.trim(),pids:value.stdout.trim().split('\n').filter(Boolean)}}
}
const driver = path.join(project, 'test', 'ios-visual-text-inspect.py');
async function moduleOperation(operation,label,extra=[],timeout=300000){
 const target=path.join(output,label);
 await run(python,[driver,'--operation',operation,'--config',path.join(output,'device.json'),'--output',target,...extra],{timeout});
 return json(path.join(target,'result.json'));
}
const content=reply=>reply.structuredContent??JSON.parse(reply.content.find(item=>item.type==='text').text);
async function call(c,name,args={}){
 const reply=await c.callTool({name,arguments:args});assert.ok(!reply.isError,JSON.stringify(reply));return content(reply);
}
async function connect(entry,args=[]){
 const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:project,stderr:'pipe',env:{...process.env}});
 transport.stderr.on('data',part=>record.mcpStderr=((record.mcpStderr||'')+part).slice(-16000));
 const c=new Client({name:'bfs-real-ios-text',version:'1'});await c.connect(transport);return c;
}
async function operation(c,started,statusTool='software_operation'){
 return until(async()=>{
  const value=await call(c,statusTool,{operationId:started.operationId});
  return ['completed','failed','cancelled','interrupted'].includes(value.status)?value:null;
 },'MCP '+started.operationId,300000);
}
async function completed(c,started,statusTool='software_operation'){
 const value=await operation(c,started,statusTool);assert.equal(value.status,'completed',JSON.stringify(value));return value;
}
const executionResult=op=>op.result?.result;
async function main(){
 await mkdir(output,{recursive:true,mode:0o700});
 assert.ok(!existsSync(path.join(output,'ios-keyboard-results.json')),'Use a fresh --output');
 try{
  record.xcode=(await run('/usr/bin/xcodebuild',['-version'])).stdout.trim();
  await run('/usr/bin/xcodebuild',['-checkFirstLaunchStatus']);
  record.sdk=(await run('/usr/bin/xcrun',['--sdk','iphonesimulator','--show-sdk-path'])).stdout.trim();
  const built=await run(python,[path.join(project,'apk_tools/examples/ios-visual-keyboard/build_demo.py'),'--out',path.join(output,'BFSMCPDemo.app')]);
  record.fixture=JSON.parse(built.stdout);
  record.fixture.executableSha256=hash(await readFile(path.join(record.fixture.app,'BFSMCPDemo')));
  if(values['prepare-only']){
   record.status='compiled_only';record.deviceAcceptancePassed=false;record.moduleAcceptancePassed=false;record.mcpAcceptancePassed=false;
   record.gaps=['real_device_run_pending','mcp_runtime_integration_pending'];
   log('compiled_only',{app:record.fixture.app});return;
  }
  assert.ok(existsSync(appiumEntry),'Owned Appium dependencies missing; this script never installs global software');
  assert.ok(existsSync(driver),'Private Python module test bridge missing');
  record.appiumVersion=(await json(path.join(appiumPrefix,'node_modules/appium/package.json'))).version;
  record.xcuitestVersion=(await json(path.join(appiumPrefix,'node_modules/appium-xcuitest-driver/package.json'))).version;
  if(values['prebuilt-wda-from']){
   const source=path.resolve(values['prebuilt-wda-from']),relative=path.relative(reportDir,source);
   assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Only owned test output can supply a cached WDA build');
   const prior=await json(path.join(path.dirname(source),'ios-keyboard-results.json'));
   assert.equal(prior.xcode,record.xcode);assert.equal(prior.appiumVersion,record.appiumVersion);assert.equal(prior.xcuitestVersion,record.xcuitestVersion);
   assert(prior.cleanup?.ownedXcodeStopped&&prior.cleanup?.ownedSimulatorDeleted,'Cached WDA producer must be terminal and cleaned');
   const app=path.join(source,'Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app');
   const executable=(await run('/usr/bin/plutil',['-extract','CFBundleExecutable','raw',path.join(app,'Info.plist')])).stdout.trim();assert.match(executable,/^[A-Za-z0-9_.-]+$/);
   await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);const binarySha256=hash(await readFile(path.join(app,executable)));
   await cp(path.join(source,'Build/Products'),path.join(output,'wda-derived-data/Build/Products'),{recursive:true,errorOnExist:true});
   const copied=path.join(output,'wda-derived-data/Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app',executable);
   assert.equal(hash(await readFile(copied)),binarySha256);record.prebuiltWda={source,producerStatus:prior.status,binarySha256,identicalSoftwareVersions:true,copyVerified:true};
  }
  const runtimes=JSON.parse((await simctl('list','runtimes','-j')).stdout).runtimes.filter(r=>r.isAvailable&&r.identifier.includes('.iOS-'));
  record.availableRuntimes=runtimes.map(({identifier,name,version,buildversion})=>({identifier,name,version,buildversion}));
  ownedRuntime=values.runtime?runtimes.find(r=>r.identifier===values.runtime):runtimes.sort((a,b)=>a.version.localeCompare(b.version,undefined,{numeric:true})).at(-1);
  if(!ownedRuntime)throw Error('IOS_RUNTIME_UNAVAILABLE; no automatic download or license acceptance');
  record.devicesBefore=await existingDeviceSnapshot();
  const types=JSON.parse((await simctl('list','devicetypes','-j')).stdout).devicetypes;
  const supported=new Set((ownedRuntime.supportedDeviceTypes||[]).map(t=>t.identifier));
  const compatible=types.filter(t=>!supported.size||supported.has(t.identifier));
  const type=values['device-type']?compatible.find(t=>t.identifier===values['device-type']):compatible.find(t=>t.identifier.endsWith('.iPhone-17-Pro'))||compatible.find(t=>t.identifier.includes('.iPhone-'));
  assert.ok(type,'No compatible iPhone device type');
  ownedName='BFS_MCP_iOS_Text_'+hash(output).slice(0,12);
  ownedUdid=(await simctl('create',ownedName,type.identifier,ownedRuntime.identifier)).stdout.trim();
  assert.match(ownedUdid,/^[A-Fa-f0-9-]{36}$/);
  record.device={udid:ownedUdid,name:ownedName,runtime:ownedRuntime.identifier,version:ownedRuntime.version,type:type.identifier};
  await save(path.join(output,'simulator-receipt.json'),{...record.device,ownedOutput:output,createdByThisRun:true});
  log('simulator_created',record.device);
  await simctl('boot',ownedUdid);
  await run('/usr/bin/xcrun',['simctl','bootstatus',ownedUdid,'-b'],{timeout:360000});
  await simctl('install',ownedUdid,record.fixture.app);installed=true;
  const container=(await simctl('get_app_container',ownedUdid,appId,'app')).stdout.trim();
  assert.ok(container.toUpperCase().includes(ownedUdid.toUpperCase())&&container.endsWith('.app'),'Installed container outside owned simulator');
  record.fixture.installedExecutableSha256=hash(await readFile(path.join(container,'BFSMCPDemo')));
  assert.equal(record.fixture.installedExecutableSha256,record.fixture.executableSha256);
  // This independent fixture setup hash is not substituted for runtime identity.
  record.runtimeInstalledArtifactVerification='unverified';
  await simctl('launch',ownedUdid,appId);
  await startAppium();log('appium_ready',{pid:appiumChild.pid,port:appiumPort});
  const capabilities={platformName:'iOS','appium:automationName':'XCUITest','appium:udid':ownedUdid,'appium:deviceName':ownedName,'appium:platformVersion':ownedRuntime.version,'appium:bundleId':appId,'appium:noReset':true,'appium:shouldTerminateApp':false,'appium:newCommandTimeout':300,'appium:useNewWDA':true,'appium:usePrebuiltWDA':!!values['prebuilt-wda-from'],'appium:wdaLaunchTimeout':600000,'appium:wdaLocalPort':wdaPort,'appium:mjpegServerPort':mjpegPort,'appium:derivedDataPath':path.join(output,'wda-derived-data'),'appium:showXcodeLog':true,'appium:clearSystemFiles':true,'appium:preventWDAAttachments':true};
  record.sessionCapabilities=capabilities;
  const started=await httpJson('POST','/session',{capabilities:{alwaysMatch:capabilities,firstMatch:[{}]}},{timeout:900000});
  sessionId=started.value?.sessionId||started.sessionId;assert.equal(typeof sessionId,'string');
  record.realSessionId=sessionId;record.returnedCapabilities=started.value?.capabilities;
  await startTransparentProxy();
  // This fixture uses a real system keyboard. The workflow checks visibility
  // explicitly around each input command rather than relying on WDA's wait.
  // Change only the owned session and verify the real settings readback.
  const settingsRoute='/session/'+sessionId+'/appium/settings';
  const beforeSettings=await httpJson('GET',settingsRoute,undefined,{port:proxyPort});
  await httpJson('POST',settingsRoute,{settings:{keyboardWaitTimeout:0}},{port:proxyPort});
  const afterSettings=await httpJson('GET',settingsRoute,undefined,{port:proxyPort});
  assert.equal(afterSettings.value?.keyboardWaitTimeout,0,'Real WDA keyboardWaitTimeout setting not confirmed');
  record.keyboardSettings={route:settingsRoute,before:beforeSettings.value?.keyboardWaitTimeout??null,requested:0,observed:afterSettings.value.keyboardWaitTimeout,scope:'newly_owned_disposable_session',readbackVerified:true};
  const xml=(await httpJson('GET','/session/'+sessionId+'/source')).value;
  await writeFile(path.join(output,'initial-ui.xml'),xml);
  record.semanticTreeHasTextControls=/Query|Search|RESULT/.test(xml);
  record.semanticTreeHasEditableControls=/XCUIElementType(?:TextField|TextView|SecureTextField)/.test(xml);assert.equal(record.semanticTreeHasEditableControls,false,'Fixture must not expose editable AX controls');
  assert.equal(record.semanticTreeHasTextControls,false,'Fixture must not expose the painted controls');
  const definition=await json(path.join(project,'apk_tools/examples/ios-visual-keyboard/workflow.example.json'));
  const spec=path.join(output,'approved-definition.json');await save(spec,definition);
  const inventory=path.join(output,'inventory');
  await run(python,['-m','apk_inventory.ios',record.fixture.app,'--out',inventory]);
  const descriptor=await json(path.join(inventory,'source.json'));
  assert.equal(descriptor.app.bundle_id||descriptor.app.package_name,appId);
  record.staticArtifact=descriptor.app;const sourceId=descriptor.source_id;
  // Fixture-owner calibration, before public workflow learning. It only
  // focuses/dismisses the owned field; no search or result assertion is granted.
  const rect=(await httpJson('GET','/session/'+sessionId+'/window/rect')).value;
  assert.equal(rect.x,0);assert.equal(rect.y,0);assert(rect.width>0&&rect.height>0);
  const tap=async(x,y)=>httpJson('POST','/session/'+sessionId+'/actions',{actions:[{type:'pointer',id:'calibration',parameters:{pointerType:'touch'},actions:[{type:'pointerMove',duration:0,x:Math.round(x*rect.width),y:Math.round(y*rect.height),origin:'viewport'},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});
  const proposal=async(label)=>{const xml=(await httpJson('GET','/session/'+sessionId+'/source')).value,file=path.join(output,label+'.xml');await writeFile(file,xml);const result=await run(python,[path.join(project,'test/ios-keyboard-inspect.py'),'--source',file,'--width',String(rect.width),'--height',String(rect.height),'--app-id',appId]);return JSON.parse(result.stdout).proposal};
  assert.equal(await proposal('calibration-before'),null);
  const calibrationBefore=path.join(output,'calibration-before.png');await writeFile(calibrationBefore,Buffer.from((await httpJson('GET','/session/'+sessionId+'/screenshot')).value,'base64'));
  await tap(.22,.15);
  const measured=await until(()=>proposal('calibration-visible'),'actual system keyboard calibration',60000);
  assert(measured.keyCount>0);assert.equal(measured.region.x,0);assert.equal(measured.region.width,1);
  const calibrationPng=Buffer.from((await httpJson('GET','/session/'+sessionId+'/screenshot')).value,'base64');
  await writeFile(path.join(output,'calibration-keyboard.png'),calibrationPng);
  const envelope=keyboardEnvelope(calibrationBefore,path.join(output,'calibration-keyboard.png'),{valueRegion:definition.valueRegion,resultRegion:definition.resultRegion,sourceRegion:measured.region,geometry:rect});
  record.keyboardCalibration={observation:measured,visualEnvelopeProposal:envelope,ownerApproved:true,configuredRegion:envelope.region,configuredSourceRegion:measured.region,publicMcpAuthorization:false,preparationTouches:2};
  await tap(.72,.36);await delay(700);
  assert.equal(await proposal('calibration-restored'),null,'Dismiss must actually remove Keyboard before learning');
  log('keyboard_calibrated',{region:measured.region,keyCount:measured.keyCount});
  const caretPolicy={enabled:true,color:[66,107,242],background:[255,255,255],colorTolerance:2,maxWidthPoints:3,minHeightPoints:8,maxHeightPoints:48,maxAreaPoints:144};
  // The fixture owner explicitly grants this narrow pixel exception. Geometry
  // calibration and OCR cannot establish that a thin blue glyph is an OS caret.
  const keyboardPolicy={enabled:true,region:envelope.region,sourceRegion:measured.region,dismissAnchor:'Dismiss',caret:caretPolicy};
  record.keyboardCalibration.ownerApprovedCaretPolicy=caretPolicy;
  const deviceFile=path.join(output,'device.json');
  await save(deviceFile,{source:{id:sourceId,kind:'ios'},backend:{type:'webdriver',platform:'ios',appId,commandTimeoutMs:60000,url:'http://127.0.0.1:'+proxyPort,sessionId},limits:{maxDepth:0,maxActions:50,maxDurationMs:480000},actionAllowlist:[],nativeVisualWorkflow:{keyboard:keyboardPolicy,enabled:true,node:process.execPath,allowedWorkflows:[definition.id],approvedDefinitions:{[definition.id]:spec}}});
  const configFile=path.join(output,'runtime.json');
  await save(configFile,{outputRoot:path.join(output,'software'),artifactRoots:[output],python,devices:{owned_ios:deviceFile},bindings:{[sourceId]:{allowed_origins:[]}}});
  if(values['await-ocr-ready']){
   const gate=path.resolve(values['await-ocr-ready']);
   let pingAt=0;const frozen=await until(async()=>{if(Date.now()-pingAt>10000){await httpJson('GET','/session/'+sessionId+'/window/rect',undefined,{timeout:3000});pingAt=Date.now();}if(!existsSync(gate))return null;try{return await json(gate)}catch{return null}},'shared OCR source freeze',600000);
   const required=['src/visual-observation.js','src/native-visual-ocr-cli.js','scripts/visual-vision.swift','src/visual-caret.js','apk_tools/apk_inventory/mobile_visual_ios_keyboard.py','apk_tools/apk_inventory/mobile_visual_ios_text.py','apk_tools/apk_inventory/mobile_visual_workflow.py'];
   for(const file of required)assert.equal(hash(await readFile(path.join(project,file))),frozen.sourceSha256?.[file],'OCR source changed after freeze: '+file);
   record.sharedOcrFreeze={path:gate,sourceSha256:frozen.sourceSha256};log('shared_ocr_source_frozen');
  }
  client=await connect(path.join(project,'src/software-mcp.js'),['--config',configFile]);
  const list=await client.listTools();record.unifiedTools=list.tools.map(tool=>tool.name);
  assert(record.unifiedTools.includes('software_bind_workflow')&&record.unifiedTools.includes('software_generate'));
  record.discovery=await completed(client,await call(client,'software_discover',{kind:'ios',input:inventory,deviceName:'owned_ios'}));
  const sources=await call(client,'software_sources'),source=sources.sources.find(item=>item.id===sourceId);
  assert.ok(source,JSON.stringify(sources));
  record.learning=await completed(client,await call(client,'software_bind_workflow',{sourceId,expectedRevision:source.revision,specPath:spec,samples:[{query:'alpha'},{query:'beta'}]}));
  const catalog=await call(client,'software_capabilities',{sourceId,kind:'mobile',limit:100});
  record.runtimeArtifactVerification={appArtifactVerified:catalog.source.appArtifactVerified,artifactVerification:catalog.source.artifactVerification,gaps:catalog.source.gaps};
  const cap=catalog.items.find(item=>item.readiness==='ready'&&item.inputSchema?.properties?.query);
  assert.ok(cap,JSON.stringify(catalog));record.capability=cap;
  assert.equal(catalog.source.appArtifactVerified,false);
  const execute=async(value)=>operation(client,await call(client,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:{query:value}}));
  record.gamma=await execute('gamma');
  assert.equal(record.gamma.status,'completed',JSON.stringify(record.gamma));
  assert.equal(executionResult(record.gamma)?.ok,true,JSON.stringify(record.gamma));
  assert.match(executionResult(record.gamma).outputs.text,/(?:^|\s)gamma(?:$|\s)/);
  record.generation=await completed(client,await call(client,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));
  generatedClient=await connect(record.generation.result.entry);
  record.delta=await operation(generatedClient,await call(generatedClient,'cap_'+cap.id.slice(4,24),{query:'delta'}),'operation_status');
  assert.equal(record.delta.status,'completed',JSON.stringify(record.delta));
  assert.equal(executionResult(record.delta)?.ok,true,JSON.stringify(record.delta));
  assert.match(executionResult(record.delta).outputs.text,/(?:^|\s)delta(?:$|\s)/);
  for(const op of [record.gamma,record.delta]){
   assert.equal(executionResult(op).appArtifactVerified,false);
   assert.equal(executionResult(op).untrusted,true);
   assert.equal(executionResult(op).provenance,'device_screenshot_and_local_ocr');
   assert(!JSON.stringify(executionResult(op)).includes(output),'Private paths escaped through MCP execution result');
  }
  const actionCount=rows=>rows.filter(r=>r.method==='POST'&&/\/actions$/.test(r.path)).length;
  const publicKeys=rows=>rows.filter(r=>r.method==='POST'&&/\/keys$/.test(r.path)&&!r.path.includes('/wda/'));
  const keyCount=rows=>publicKeys(rows).filter(r=>!(JSON.parse(r.body).value||[]).join('').includes('\b')).length;
  const backspaceCount=rows=>publicKeys(rows).filter(r=>(JSON.parse(r.body).value||[]).join('')==='\b'.repeat(definition.inputSchema.maxLength)).length;
  const clearCount=rows=>rows.filter(r=>r.method==='POST'&&/\/execute\/sync$/.test(r.path)&&JSON.parse(r.body).script==='mobile: keys').length;
  let start=requests.length;
  record.invalid=await execute('bad value');
  assert.equal(record.invalid.status,'failed',JSON.stringify(record.invalid));
  assert.equal(record.invalid.errorCode,'INPUT_INVALID',JSON.stringify(record.invalid));
  assert.equal(actionCount(requests.slice(start)),0);assert.equal(keyCount(requests.slice(start)),0);assert.equal(clearCount(requests.slice(start)),0);assert.equal(publicKeys(requests.slice(start)).length,0);record.invalidInputRequests={pointerActions:actionCount(requests.slice(start)),allPublicKeys:publicKeys(requests.slice(start)).length,clearCommands:clearCount(requests.slice(start))};
  const mode=async(name,marker)=>{
   const preparation={name,marker,observations:[],alerts:[],startedAt:Date.now()};
   (record.modePreparations??=[]).push(preparation);
   const url='bfsmcpvisualkeyboard://mode/'+name+'?request='+hash(output+name+Date.now()).slice(0,16);
   preparation.url=url;
   // One mode-only request; neither typing nor submission is retried here.
   const opened=await simctl('openurl',ownedUdid,url);preparation.openUrlExitCode=opened.code;
   const deadline=Date.now()+60000;
   try{
    for(let attempt=1;attempt<=5&&Date.now()<deadline;attempt++){
     // Custom-scheme launch may show a system Open-in confirmation. The only
     // alert this harness can accept belongs to this freshly owned session,
     // names the fixture, and explicitly asks to open it. Never auto-accept
     // general alerts or relax production workflow checks.
     const alert=await httpJson('GET','/session/'+sessionId+'/alert/text',undefined,{port:proxyPort,timeout:10000,allowError:true});
     if(alert.status===200&&typeof alert.value==='string'){
      const entry={at:Date.now(),text:alert.value,readStatus:alert.status,accepted:false};preparation.alerts.push(entry);
      assert.equal(preparation.alerts.filter(row=>row.accepted).length,0,'More than one mode confirmation is unexpected');
      assert.ok(alert.value.includes('BFS Keyboard Demo')&&/(?:打开|open)/i.test(alert.value),'Unexpected alert; fixture launch confirmation required: '+alert.value);
      const accepted=await httpJson('POST','/session/'+sessionId+'/alert/accept',{}, {port:proxyPort,timeout:10000});
      entry.acceptStatus=accepted.status;entry.accepted=true;
     }else{
      assert.ok(alert.value?.error==='no such alert','Cannot identify a safe mode confirmation: '+JSON.stringify(alert));
     }
     await delay(500);
     // These are bounded read-only observations. Success always requires both
     // the exact empty input and the full painted marker in actual local OCR.
     const remaining=deadline-Date.now();if(remaining<=0)break;
     let observed;
     try{
      observed=await moduleOperation('inspect','mode-'+name+'-'+attempt,['--definition',spec],Math.min(20000,remaining));
     }catch(error){
      preparation.observations.push({attempt,error:String(error.message).slice(0,2000)});continue;
     }
     preparation.observations.push({attempt,ok:observed.ok,status:observed.status,outputs:observed.outputs,error:observed.error});
     if(observed.ok===true&&observed.outputs?.value===''&&observed.outputs?.text===marker){
      preparation.confirmedByScreenshotOcr=true;preparation.finishedAt=Date.now();return observed;
     }
    }
    throw Error('Fixture mode not confirmed by exact screenshot/OCR: '+JSON.stringify(preparation));
   }finally{
    // Local mode-only NSLog messages diagnose URL delivery; they never replace
    // actual screenshot/OCR assertions and contain no input values.
    const logs=await run('/usr/bin/xcrun',['simctl','spawn',ownedUdid,'log','show','--style','compact','--last','3m','--predicate','process == "BFSMCPDemo" AND eventMessage BEGINSWITH "BFS_MODE_"'],{timeout:15000,allowFailure:true});
    const logName='mode-'+name+'-app.log';await writeFile(path.join(output,logName),logs.stdout);
    preparation.appLog={file:logName,exitCode:logs.code,bytes:Buffer.byteLength(logs.stdout)};
   }
  };
  record.ignoreMode=await mode('ignore_input','RESULT IGNORE');start=requests.length;
  record.ignoredInput=await execute('epsilon');
  const ignored=requests.slice(start);record.ignoredInputRequests={focusAndSubmitActions:actionCount(ignored),textInputCommands:keyCount(ignored),backspaceClearCommands:backspaceCount(ignored),clearCommands:clearCount(ignored)};
  assert.equal(executionResult(record.ignoredInput)?.error?.code,'VISUAL_INPUT_NOT_VERIFIED',JSON.stringify(record.ignoredInput));
  assert.deepEqual(executionResult(record.ignoredInput).writeOutcome,{status:'unknown',automaticRetry:false});
  assert.equal(record.ignoredInput.canResume,false);assert.equal(actionCount(ignored),1);assert.equal(keyCount(ignored),1);assert.equal(clearCount(ignored),0);assert.equal(backspaceCount(ignored),1);
  record.autoMode=await mode('autoupdate_noop','RESULT AUTO');start=requests.length;
  record.noopSubmit=await execute('epsilon');
  const noop=requests.slice(start);record.noopSubmitRequests={focusAndSubmitActions:actionCount(noop),textInputCommands:keyCount(noop),backspaceClearCommands:backspaceCount(noop),clearCommands:clearCount(noop)};
  assert.equal(executionResult(record.noopSubmit)?.error?.code,'VISUAL_RESULT_NOT_VERIFIED',JSON.stringify(record.noopSubmit));
  assert.deepEqual(executionResult(record.noopSubmit).writeOutcome,{status:'unknown',automaticRetry:false});
  assert.equal(record.noopSubmit.canResume,false);assert.equal(actionCount(noop),3);assert.equal(keyCount(noop),1);assert.equal(clearCount(noop),0);assert.equal(backspaceCount(noop),1);
  assert.equal(requests.filter(row=>/\/wda\/keys$/.test(row.path)).length,0,'Internal WDA path must never be sent to Appium public session');
  const png=Buffer.from((await httpJson('GET','/session/'+sessionId+'/screenshot')).value,'base64');
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  await writeFile(path.join(output,'final-screen.png'),png);
  record.screenshot={source:'actual WDA /screenshot',bytes:png.length};
  record.status='passed';record.moduleAcceptancePassed=true;record.deviceAcceptancePassed=true;
  record.mcpAcceptancePassed=true;record.gaps=['app_artifact_not_verified','physical_device_not_tested','third_party_apps_not_tested','other_soft_keyboard_layouts_not_tested','caret_identity_is_owner_permission'];
  log('ios_text_mcp_passed',{udid:ownedUdid,realAppium:true,realWDA:true,mcp:true});
 }catch(error){
  record.status=ownedUdid?'failed':'blocked';record.deviceAcceptancePassed=false;record.moduleAcceptancePassed=false;record.mcpAcceptancePassed=false;
  record.error={message:String(error.message).slice(0,7000),stack:String(error.stack).slice(0,9000),cause:String(error.cause?.message||''),code:error.code||error.cause?.code||null};
  log('ios_text_module_failed',{error:record.error});process.exitCode=1;
 }finally{
  await generatedClient?.close().catch(()=>{});await client?.close().catch(()=>{});
  if(sessionId&&ownedAppiumAlive())try{await httpJson('DELETE','/session/'+sessionId,undefined,{timeout:60000});record.cleanup.realSessionDeleted=true}catch(e){record.cleanup.sessionError=String(e.message)}
  if(proxy){await new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve)});record.cleanup.proxyStopped=true}
  if(ownedAppiumAlive()){
   process.kill(-appiumChild.pid,'SIGTERM');for(let n=0;n<30&&ownedAppiumAlive();n++)await delay(100);
   if(ownedAppiumAlive())process.kill(-appiumChild.pid,'SIGKILL');await delay(200);
  }
  if(appiumChild)record.cleanup.appiumStopped=!ownedAppiumAlive();
  if(ownedUdid)await stopOwnedXcode();
  if(ownedUdid)try{
   const devices=await existingDeviceSnapshot();
   assert.equal(devices[ownedUdid]?.name,ownedName,'Owned simulator name changed; refuse cleanup');
   assert.equal(devices[ownedUdid]?.runtime,ownedRuntime.identifier,'Owned simulator runtime changed; refuse cleanup');
   if(installed){await run('/usr/bin/xcrun',['simctl','terminate',ownedUdid,appId],{allowFailure:true});record.cleanup.fixtureUninstalled=(await run('/usr/bin/xcrun',['simctl','uninstall',ownedUdid,appId],{allowFailure:true})).code===0}
   await run('/usr/bin/xcrun',['simctl','shutdown',ownedUdid],{allowFailure:true});await simctl('delete',ownedUdid);
   const after=await existingDeviceSnapshot();record.cleanup.ownedSimulatorDeleted=!after[ownedUdid];
   record.existingDeviceIdsPreserved=Object.keys(record.devicesBefore).every(id=>after[id]&&after[id].name===record.devicesBefore[id].name&&after[id].runtime===record.devicesBefore[id].runtime);
  }catch(e){record.cleanup.simulatorCleanupError=String(e.message);record.status='failed';record.moduleAcceptancePassed=false;record.deviceAcceptancePassed=false;record.mcpAcceptancePassed=false;process.exitCode=1}
  record.webdriverAudit={scope:'only forwards actual Appium; no generated protocol replies',requests:requests.length,unfinished:requests.filter(r=>!r.finished),uiCommands:requests.filter(r=>r.method==='POST'&&/\/(?:actions|keys|execute\/sync)$/.test(r.path)).map(r=>({path:r.path,body:r.body,status:r.responseStatus})),failures:requests.filter(r=>r.responseStatus>=400||r.error)};
  await Promise.allSettled([...evidenceTasks]);
  await save(path.join(output,'forwarded-requests.json'),requests);
  if(ownedUdid||appiumChild)await checkCleanup();
  if(record.status==='passed'&&(['realSessionDeleted','proxyStopped','appiumStopped','fixtureUninstalled','ownedSimulatorDeleted'].some(k=>record.cleanup[k]!==true)||record.processCleanupAudit.ownedProcessesRemaining.length||Object.values(record.processCleanupAudit.ports).some(r=>r.listening)||!record.existingDeviceIdsPreserved)){
   record.status='failed';record.moduleAcceptancePassed=false;record.deviceAcceptancePassed=false;record.mcpAcceptancePassed=false;process.exitCode=1;
  }
  record.finishedAt=new Date().toISOString();await save(path.join(output,'ios-keyboard-results.json'),record);
  process.stdout.write(JSON.stringify({status:record.status,report:path.join(output,'ios-keyboard-results.json'),mcp:record.mcpAcceptancePassed===true})+'\n');
 }
}
const interrupt=()=>{interrupted=true;for(const child of ownedCommands)child.kill('SIGTERM')};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);await main();
