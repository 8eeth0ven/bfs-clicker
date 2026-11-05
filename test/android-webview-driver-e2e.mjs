#!/usr/bin/env node
// Opt-in owned Android WebView proof. No user AVD/device/default ADB use.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer,createConnection} from 'node:net';
import {openSync,closeSync,existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,readdir,lstat,rm,statfs} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(import.meta.dirname,'..'),outRoot=path.join(root,'output-vision-implementation');
const sha=value=>createHash('sha256').update(value).digest('hex'),json=async file=>JSON.parse(await readFile(file,'utf8'));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const app='com.example.bfsmcp.webview',elementKey='element-6066-11e4-a52e-4f735466cecf';
const PROBE=String.raw`return (function(old){
 const ids=['query','detail','run','result'],group=document.getElementById('searchForm');
 const controls=ids.map(id=>document.getElementById(id));
 const refs=[document.documentElement,document.body,group];controls.forEach(el=>refs.push(el,el&&el.form||null,el&&el.parentElement));
 return {schema:'owned-android-webview-probe-1',url:document.URL,origin:location.origin,top:top===window,refs,
  same:old.map((el,i)=>el===refs[i]),connected:refs.map(el=>el===null||el.isConnected&&el.ownerDocument===document&&el.getRootNode()===document),
  rows:controls.map(el=>({id:el.id,tag:el.tagName,value:typeof el.value==='string'?el.value:null,attributeValue:el.getAttribute('value'),text:el.textContent,form:el.form&&el.form.id||null,visible:el.getClientRects().length>0})),events:{...window.bfsFixtureEvents}};
})(Array.prototype.slice.call(arguments));`;

export class OwnedAndroidWebView {
 constructor(values,kind='driver'){
  this.values=values;this.kind=kind;this.output=path.resolve(values.output);assert(this.output.startsWith(outRoot+path.sep));
  this.sdk=path.resolve(values.sdk||path.join(os.homedir(),'Library/Android/sdk'));this.adb=path.join(this.sdk,'platform-tools/adb');
  this.deps=path.resolve(values['dependency-dir']);this.appiumHome=path.join(this.deps,'appium-home');
  this.appiumPrefix=path.resolve(values['appium-prefix']||path.join(outRoot,'ios-appium-owned-20261029'));
  this.appiumEntry=path.join(this.appiumPrefix,'node_modules/appium/build/lib/main.js');this.rows=[];this.children=new Set();
  this.record={schemaVersion:1,kind:'actual_owned_android_webview_'+kind,startedAt:new Date().toISOString(),status:'running',mcpAcceptance:false,steps:[],http:[],commands:[],ledgers:[],cleanup:{},storage:[],scope:{ownsNewAvd:true,defaultAdbStarted:false,newSystemImageDownloaded:false,ordinaryNativeKeyboard:false,arbitraryApps:false,automaticBusinessRetry:false}};
 }
 async save(name,value){const file=path.join(this.output,name);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});return file;}
 log(phase,details={}){this.record.steps.push({phase,at:new Date().toISOString(),...details});console.log(JSON.stringify({phase,...details}));}
 async space(label,minimum=10*2**30){const fs=await statfs(this.output,{bigint:true}),bytes=Number(fs.bavail*fs.bsize);this.record.storage.push({label,availableBytes:bytes,at:new Date().toISOString()});assert(bytes>=minimum,'STORAGE_RESERVE');}
 async run(executable,args,{timeout=30000,allowFailure=false,env={}}={}){
  await this.space('command');const child=spawn(executable,args,{cwd:root,env:{...process.env,...this.env,...env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']});this.children.add(child);let stdout=[],stderr=[],n=0,m=0,timedOut=false;
  child.stdout.on('data',b=>{n+=b.length;if(n<=4*1024*1024)stdout.push(b);else child.kill('SIGKILL')});child.stderr.on('data',b=>{m+=b.length;if(m<=262144)stderr.push(b);else child.kill('SIGKILL')});
  let killTimer;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000)},timeout);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}).finally(()=>{clearTimeout(timer);clearTimeout(killTimer);this.children.delete(child)});
  const result={code,signalCode:child.signalCode,timedOut,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()};this.record.commands.push({executable,args,pid:child.pid,...result});
  assert(allowFailure||code===0&&!timedOut&&n<=4*1024*1024&&m<=262144,executable+' '+args[0]+' failed '+result.stderr.slice(-2000));return result;
 }
 device(...args){return this.run(this.adb,['-P',String(this.ports.adb),'-s',this.serial,...args])}
 shell(...args){return this.device('shell',...args)}
 async free(port=0){return new Promise(resolve=>{const server=createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n))})})}
 async avds(){const home=path.join(os.homedir(),'.android/avd'),rows={};for(const entry of await readdir(home,{withFileTypes:true})){const file=entry.name.endsWith('.ini')?path.join(home,entry.name):entry.isDirectory()&&entry.name.endsWith('.avd')?path.join(home,entry.name,'config.ini'):null;if(file&&existsSync(file)){const raw=await readFile(file),s=await lstat(file);assert(s.isFile()&&!s.isSymbolicLink());rows[file]={sha256:sha(raw),bytes:raw.length,mode:s.mode&0o777}}}return rows;}
 async sources(){const rows={};const visit=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const p=path.join(directory,entry.name);assert(!entry.isSymbolicLink());if(entry.isDirectory())await visit(p);else{const raw=await readFile(p),s=await lstat(p);rows[path.relative(root,p)]={sha256:sha(raw),bytes:raw.length,mode:s.mode&0o777}}}};await visit(path.join(root,'apk_tools/examples/webview-android'));for(const name of ['test/android-webview-driver-e2e.mjs',...(this.values['text-transport']?['apk_tools/apk_inventory/mobile_webview.py']:[])]){const file=path.join(root,name),raw=await readFile(file),s=await lstat(file);rows[name]={sha256:sha(raw),bytes:raw.length,mode:s.mode&0o777}}return rows;}
 async captureTransport(){
  assert.equal(this.values['text-transport'],'chromedriver_cdp_insert_text_v1');const file=path.join(root,'apk_tools/apk_inventory/mobile_webview.py');
  // Parse only literal assignments and string concatenation; do not import or
  // execute the production module merely to capture its fixed wire literals.
  const code="import ast,json,sys\nt=ast.parse(open(sys.argv[1]).read()); values={}\ndef literal(n):\n if isinstance(n,ast.Constant) and isinstance(n.value,str):return n.value\n if isinstance(n,ast.Name):return values[n.id]\n if isinstance(n,ast.BinOp) and isinstance(n.op,ast.Add):return literal(n.left)+literal(n.right)\n raise ValueError('nonliteral')\nfor n in t.body:\n if isinstance(n,ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name):\n  try:values[n.targets[0].id]=literal(n.value)\n  except (ValueError,KeyError):pass\nprint(json.dumps({k:values[k] for k in ['DOM_PROBE','FOCUS_WRITE_SCRIPT','FOCUS_READ_SCRIPT','TEXT_TRANSPORT_MODE','CDP_TEXT_ROUTE','CDP_TEXT_COMMAND']}))";
  const result=await this.run(this.values.python||path.join(root,'.venv/bin/python'),['-s','-B','-c',code,file]);const data=JSON.parse(result.stdout);
  assert.equal(data.TEXT_TRANSPORT_MODE,this.values['text-transport']);assert.equal(data.CDP_TEXT_ROUTE,'/goog/cdp/execute');assert.equal(data.CDP_TEXT_COMMAND,'Input.insertText');
  assert.equal(sha(data.DOM_PROBE),'439f5411f7fa90765586385c4c161794d093db74b1e6a10b35dd79e2acb5a32d');assert.equal(sha(data.FOCUS_WRITE_SCRIPT),'46c30fd206011a0b36d28dfb95f29808801f703b717d7835d533ede6e29dd08c');assert.equal(sha(data.FOCUS_READ_SCRIPT),'d8d73d8cf463120badffdaf0ebb3c5c0dc41284412e77a5297b7bf8e1db6ce22');
  const transportSha256=sha(JSON.stringify(canonical({schemaVersion:1,mode:data.TEXT_TRANSPORT_MODE,writeScript:data.FOCUS_WRITE_SCRIPT,readScript:data.FOCUS_READ_SCRIPT,route:data.CDP_TEXT_ROUTE,cdpCommand:data.CDP_TEXT_COMMAND})));assert.equal(transportSha256,'85ab71c438f534d7b7290546011f60b0940176929014ffe91d5060d5a438833f');return{sourcePath:path.relative(root,file),sourceSha256:sha(await readFile(file)),...data,transportSha256};
 }
 async prepare(){
  await mkdir(this.output,{recursive:true,mode:0o700});await this.space('prepare',14*2**30);assert(existsSync(this.appiumEntry));
  const driver=path.join(this.appiumHome,'node_modules/appium-uiautomator2-driver/package.json'),meta=await json(driver);assert.equal(meta.version,'8.7.3');
  const sources=await this.sources(),apk=path.resolve(this.values.apk||path.join(this.output,'fixture.apk'));assert(apk.startsWith(this.output+path.sep));
  const transport=this.values['text-transport']?await this.captureTransport():null;if(transport)assert.equal(transport.sourceSha256,sources[transport.sourcePath].sha256);
  const ready={schemaVersion:1,status:'prepared_not_executed',kind:this.kind,sources,transport,preparationCommands:this.record.commands,apk,apkSha256:sha(await readFile(apk)),driverManifest:{path:driver,sha256:sha(await readFile(driver)),version:meta.version},appiumManifest:{path:path.join(this.appiumPrefix,'node_modules/appium/package.json'),sha256:sha(await readFile(path.join(this.appiumPrefix,'node_modules/appium/package.json')))},existingAvds:await this.avds(),defaultAdbListening:!!await this.listening(5037),appiumHome:this.appiumHome};
  await this.save('preparation.json',ready);this.log('prepared',{sha256:sha(JSON.stringify(ready,null,2)+'\n'),apkSha256:ready.apkSha256});return ready;
 }
 async listening(port){return new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',error=>{if(error.code==='ECONNREFUSED')resolve(false);else reject(error)});socket.setTimeout(700,()=>{socket.destroy();reject(Error('Port-state observation timeout'))})})}
 owned(){if(!this.emulator?.pid)return false;try{return execFileSync('ps',['-p',String(this.emulator.pid),'-o','command='],{encoding:'utf8'}).includes(this.avdName)}catch{return false}}
 appiumOwned(){if(!this.appium?.pid)return false;try{const command=execFileSync('ps',['-p',String(this.appium.pid),'-o','command='],{encoding:'utf8'});return command.includes(this.appiumEntry)&&command.includes(String(this.ports.appium))}catch{return false}}
 async until(fn,label,timeout){const deadline=Date.now()+timeout;let last=0;while(Date.now()<deadline){assert(!this.interrupted,'INTERRUPTED');if(this.storageError)throw this.storageError;await this.space(label);const value=await fn();if(value)return value;if(Date.now()-last>15000){this.log('waiting',{for:label});last=Date.now()}await delay(300)}throw Error('DEADLINE '+label)}
 async startDevice(){
  await this.space('emulator-entry',14*2**30);this.ports={};let consolePort=5680;while(!await this.free(consolePort)||!await this.free(consolePort+1))consolePort+=2;this.ports.console=consolePort;this.ports.consoleAdb=consolePort+1;
  let adbPort=6157;while(!await this.free(adbPort))adbPort++;this.ports.adb=adbPort;assert.notEqual(adbPort,5037);this.serial='emulator-'+consolePort;
  this.avdName='BFS_WEBVIEW_'+sha(this.output).slice(0,12);this.avdHome=path.join(this.output,'avd');this.avd=path.join(this.avdHome,this.avdName+'.avd');await mkdir(this.avd,{recursive:true,mode:0o700});
  const image='system-images/android-36/google_apis_playstore/arm64-v8a/';assert(existsSync(path.join(this.sdk,image,'system.img')));
  const config={AvdId:this.avdName,'avd.ini.displayname':'BFS owned WebView','avd.ini.encoding':'UTF-8','abi.type':'arm64-v8a','hw.cpu.arch':'arm64','hw.cpu.ncore':'2','hw.ramSize':'1536','disk.dataPartition.size':'2G','hw.lcd.width':'720','hw.lcd.height':'1280','hw.lcd.density':'320','hw.keyboard':'yes','hw.mainKeys':'no','hw.gpu.enabled':'yes','hw.gpu.mode':'swiftshader_indirect','hw.audioInput':'no','hw.camera.back':'none','hw.camera.front':'none','hw.sdCard':'no','showDeviceFrame':'no','fastboot.forceColdBoot':'yes','image.sysdir.1':image,'tag.id':'google_apis_playstore',target:'android-36'};
  await this.save('avd/'+this.avdName+'.avd/config.ini',Object.entries(config).map(([k,v])=>k+'='+v).join('\n')+'\n');await this.save('avd/'+this.avdName+'.ini',`avd.ini.encoding=UTF-8\npath=${this.avd}\ntarget=android-36\n`);
  for(const dir of ['emulator-home','android-user','tmp'])await mkdir(path.join(this.output,dir),{mode:0o700});
  const key=path.join(this.output,'emulator-home/adbkey');this.env={ADB_SERVER_SOCKET:'tcp:127.0.0.1:'+adbPort,ANDROID_ADB_SERVER_PORT:String(adbPort),ADB_VENDOR_KEYS:key,ANDROID_SDK_ROOT:this.sdk,ANDROID_HOME:this.sdk,ANDROID_AVD_HOME:this.avdHome,ANDROID_EMULATOR_HOME:path.join(this.output,'emulator-home'),ANDROID_USER_HOME:path.join(this.output,'android-user'),TMPDIR:path.join(this.output,'tmp'),NO_PROXY:'127.0.0.1,localhost,::1',no_proxy:'127.0.0.1,localhost,::1'};
  await this.run(this.adb,['keygen',key]);await this.run(this.adb,['-P',String(adbPort),'start-server']);
  const executable=path.join(this.sdk,'emulator/emulator'),args=['-avd',this.avdName,'-port',String(consolePort),'-no-window','-no-audio','-no-boot-anim','-no-snapshot','-no-metrics','-skip-adb-auth','-memory','1536','-gpu','swiftshader_indirect','-adb-path',this.adb];
  this.log('device_preflight',{name:this.avdName,ports:this.ports,ramMiB:1536,dataGiB:2,sharedImage:image});const fd=openSync(path.join(this.output,'emulator.log'),'wx',0o600);this.emulator=spawn(executable,args,{cwd:root,env:{...process.env,...this.env},stdio:['ignore',fd,fd],detached:true});closeSync(fd);this.emulator.unref();
  await this.save('emulator-receipt.json',{pid:this.emulator.pid,serial:this.serial,name:this.avdName,avd:this.avd,ports:this.ports,args,isolatedNewData:true});
  this.monitor=setInterval(()=>{void this.space('running').catch(error=>{this.storageError=error})},10000);this.monitor.unref();
  await this.until(async()=>{assert(this.owned(),'Owned emulator exited');const row=await this.run(this.adb,['-P',String(adbPort),'-s',this.serial,'shell','getprop','sys.boot_completed'],{allowFailure:true,timeout:8000});return row.code===0&&row.stdout.trim()==='1'},'owned API36 boot',240000);
  assert.equal((await this.shell('getprop','ro.boot.qemu.avd_name')).stdout.trim(),this.avdName);assert.equal((await this.shell('getprop','ro.build.version.sdk')).stdout.trim(),'36');
  this.originalIme=(await this.shell('settings','get','secure','default_input_method')).stdout.trim();for(const key of ['window_animation_scale','transition_animation_scale','animator_duration_scale'])await this.shell('settings','put','global',key,'0');
  await this.shell('svc','wifi','disable');await this.shell('svc','data','disable');this.record.ownedNetworkSetup={wifiAndMobileDataDisabled:true,loopbackStillUsed:true,scope:'new owned emulator only; no host/user network settings changed'};
  this.record.device={serial:this.serial,name:this.avdName,api:36,abi:(await this.shell('getprop','ro.product.cpu.abi')).stdout.trim(),originalIme:this.originalIme};
  const webview=(await this.shell('dumpsys','webviewupdate')).stdout;this.record.webviewUpdate=webview;await this.save('webview-update.txt',webview);this.log('webview_version',{raw:webview.slice(0,500)});
  await this.device('install','-r',this.prepared.apk);this.installed=true;await this.shell('am','start','-W','-n',app+'/.WebViewActivity','--ei','fixturePort','20127');
  const ready=await this.until(async()=>{const result=await this.run(this.adb,['-P',String(adbPort),'-s',this.serial,'exec-out','run-as',app,'cat','files/fixture-ready.json'],{allowFailure:true});if(result.code!==0)return false;const value=JSON.parse(result.stdout);assert.equal(value.package,app);assert.equal(value.ledgerInitialized,true);return value},'fixture private readiness',15000);
  this.record.fixtureReady=ready;assert.equal((await this.shell('pidof',app)).stdout.trim(),String(ready.pid));this.url=ready.url;assert.equal(this.url,'http://127.0.0.1:20127/form');assert.deepEqual(await this.ledger('initial'),[]);
  this.log('owned_fixture_ready',{pid:ready.pid,url:this.url,webviewUpdatePath:path.join(this.output,'webview-update.txt')});
 }
 async ledger(label){const row=await this.device('exec-out','run-as',app,'cat','files/webview-ledger.json'),entries=JSON.parse(row.stdout);assert(Array.isArray(entries));entries.forEach((value,i)=>assert.equal(value.count,i+1));await this.save('ledger-'+label+'.json',row.stdout);this.record.ledgers.push({label,rows:entries,sha256:sha(row.stdout)});return entries;}
 async http(method,route,body,{timeout=30000,allowError=false}={}){
  await this.space('HTTP');const row={id:this.rows.length,startedAt:new Date().toISOString(),method,route,...(body===undefined?{}:{body})};this.rows.push(row);const began=performance.now();
  let mutation=method==='POST'&&/\/element\/[^/]+\/(clear|value|click)$/.test(route)?route.split('/').at(-1):null;
  if(method==='POST'&&this.transport&&route.endsWith('/execute/sync')&&body?.script===this.transport.FOCUS_WRITE_SCRIPT)mutation='focus';
  if(method==='POST'&&route.endsWith('/goog/cdp/execute')){assert(this.transport&&body?.cmd==='Input.insertText'&&Object.keys(body).sort().join(',')==='cmd,params'&&Object.keys(body.params).join(',')==='text'&&typeof body.params.text==='string');mutation='insertText';}
  let intent;if(mutation){this.record.driverOnlyEffects??=[];intent={id:this.record.driverOnlyEffects.length,kind:mutation,httpRequestId:row.id,status:'pending',automaticRetry:false,requestSha256:sha(JSON.stringify(body)),at:new Date().toISOString(),scope:'driver-only intent; not production session journal'};this.record.driverOnlyEffects.push(intent);await this.save('driver-intent-'+intent.id+'.json',intent);}
  try{const reply=await fetch('http://127.0.0.1:'+this.ports.appium+route,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});row.status=reply.status;row.responseText=await reply.text();assert(Buffer.byteLength(row.responseText)<=4*1024*1024);row.response=JSON.parse(row.responseText);row.durationMs=performance.now()-began;await this.save('http-'+String(row.id).padStart(5,'0')+'.json',row);if(!allowError)assert(reply.ok&&!row.response.value?.error,'Actual driver failure '+row.responseText.slice(0,2000));if(intent){intent.status='acknowledged';await this.save('driver-outcome-'+intent.id+'.json',intent);}return row.response.value}
  catch(error){row.error=String(error.message);row.durationMs=performance.now()-began;if(intent){intent.status='unknown';if(!existsSync(path.join(this.output,'driver-outcome-'+intent.id+'.json')))await this.save('driver-outcome-'+intent.id+'.json',intent);}if(!existsSync(path.join(this.output,'http-'+String(row.id).padStart(5,'0')+'.json')))await this.save('http-'+String(row.id).padStart(5,'0')+'.json',row);throw error}
 }
 execute(script,args=[]){return this.http('POST','/session/'+this.session+'/execute/sync',{script,args})}
 async startSession(){
  const readyFile=path.join(this.deps,'chromedriver-ready.json');this.log('waiting_chromedriver',{readyFile,actualWebviewUpdate:path.join(this.output,'webview-update.txt')});
  this.chrome=await this.until(async()=>existsSync(readyFile)?json(readyFile):false,'owner supplied matching Chromedriver',180000);assert(path.resolve(this.chrome.executable).startsWith(this.deps+path.sep));assert.equal(sha(await readFile(this.chrome.executable)),this.chrome.sha256);
  for(const name of ['appium','system','devtools','chromedriver'])this.ports[name]=await this.free();assert.equal(new Set(Object.values(this.ports)).size,Object.values(this.ports).length);
  const fd=openSync(path.join(this.output,'appium.log'),'wx',0o600);this.appium=spawn(process.execPath,[this.appiumEntry,'--address','127.0.0.1','--port',String(this.ports.appium),'--log-no-colors','--log-timestamp'],{cwd:this.output,env:{...process.env,...this.env,APPIUM_HOME:this.appiumHome,APPIUM_SKIP_CHROMEDRIVER_INSTALL:'1'},stdio:['ignore',fd,fd],detached:true});closeSync(fd);this.appium.unref();await this.save('appium-receipt.json',{pid:this.appium.pid,entry:this.appiumEntry,home:this.appiumHome,ports:this.ports});
  await this.until(async()=>{try{return (await this.http('GET','/status',undefined,{timeout:2000})).ready}catch{return false}},'owned Appium readiness',30000);
  const capabilities={platformName:'Android','appium:automationName':'UiAutomator2','appium:deviceName':'Owned isolated Android','appium:udid':this.serial,'appium:adbPort':this.ports.adb,'appium:systemPort':this.ports.system,'appium:webviewDevtoolsPort':this.ports.devtools,'appium:chromedriverPort':this.ports.chromedriver,'appium:chromedriverExecutable':this.chrome.executable,'appium:appPackage':app,'appium:autoLaunch':false,'appium:noReset':true,'appium:fullReset':false,'appium:suppressKillServer':true,'appium:skipUnlock':true,'appium:ensureWebviewsHavePages':true,'appium:enableWebviewDetailsCollection':true,'appium:showChromedriverLog':true,'appium:newCommandTimeout':600};
  const reply=await this.http('POST','/session',{capabilities:{alwaysMatch:capabilities,firstMatch:[{}]}},{timeout:90000});this.session=this.rows.at(-1).response.sessionId||reply?.sessionId;assert(this.session);this.record.session=this.session;this.record.capabilities=capabilities;
  const foreground=await this.http('GET','/session/'+this.session+'/appium/device/current_package');assert.equal(foreground,app);
  const contexts=await this.execute('mobile: getContexts',[{waitForWebviewMs:0}]);await this.save('actual-rich-contexts.json',contexts);this.record.actualRichContexts=contexts;this.log('actual_rich_contexts',{path:path.join(this.output,'actual-rich-contexts.json'),foreground});
  assert(Array.isArray(contexts));const matching=contexts.filter(row=>row.info?.['Android-Package']===app);assert.equal(matching.length,1,'Actual CDP package must uniquely match foreground');const selected=matching[0];assert.equal(selected.webviewName,'WEBVIEW_'+app);assert.equal(selected.proc,'@webview_devtools_remote_'+this.record.fixtureReady.pid);assert.equal(selected.webview,'WEBVIEW_'+this.record.fixtureReady.pid);
  await this.http('POST','/session/'+this.session+'/context',{name:selected.webviewName},{timeout:60000});
  const handle=await this.http('GET','/session/'+this.session+'/window'),handles=await this.http('GET','/session/'+this.session+'/window/handles'),url=await this.http('GET','/session/'+this.session+'/url');assert.deepEqual(handles,[handle]);assert.equal(url,this.url);
  this.record.selected={context:selected.webviewName,windowHandle:handle,url,raw:selected};await this.save('actual-selected-webview.json',this.record.selected);this.log('actual_selected_webview',{handle,url});
 }
 async proof(){
  if(this.transport)return this.proofCdp();
  const first=await this.execute(PROBE);assert.equal(first.schema,'owned-android-webview-probe-1');assert.equal(first.url,this.url);assert.equal(first.top,true);assert(first.connected.every(Boolean));assert.equal(first.refs.length,15);assert(first.refs.every(ref=>ref===null||typeof ref[elementKey]==='string'));
  const repeated=await this.execute(PROBE,first.refs);assert(repeated.same.every(value=>value===true));await this.save('probe-initial.json',repeated);
  const values={query:' 上  海🙂e\u0301 ',detail:'细 节🙂e\u0301'};assert(values.query.normalize('NFC')!==values.query);
  for(const [index,name] of ['query','detail'].entries()){
   const ref=first.refs[3+3*index][elementKey],prefix='/session/'+this.session+'/element/'+encodeURIComponent(ref);
   await this.http('POST',prefix+'/clear',{});const empty=await this.execute(PROBE,first.refs);assert.equal(empty.rows[index].value,'');assert(empty.same.every(value=>value===true));
   await this.http('POST',prefix+'/value',{text:values[name],value:Array.from(values[name])});const echo=await this.execute(PROBE,first.refs);assert.equal(echo.rows[index].value,values[name]);assert.equal(echo.rows[index].attributeValue,'ATTRIBUTE_DECOY_'+name.toUpperCase());assert(echo.same.every(value=>value===true));
  }
  const before=await this.execute(PROBE,first.refs);assert.deepEqual(before.rows.slice(0,2).map(row=>row.value),[values.query,values.detail]);
  await this.http('POST','/session/'+this.session+'/element/'+encodeURIComponent(first.refs[9][elementKey])+'/click',{});
  const entries=await this.until(async()=>{const rows=await this.device('exec-out','run-as',app,'cat','files/webview-ledger.json');const value=JSON.parse(rows.stdout);return value.length===1?value:false},'one independent native business',10000);assert.deepEqual(entries,[{query:values.query,detail:values.detail,count:1}]);
  const after=await this.execute(PROBE,first.refs);assert.equal(after.rows[3].text,'RESULT '+values.query+' / '+values.detail+' ;COUNT:1');assert(after.same.every(value=>value===true));assert.deepEqual(await this.ledger('business'),entries);await this.save('probe-business.json',after);this.record.proof={independentBusinessCount:1,values,liveDomVsAttribute:true,referenceEquality:true,generatedMcp:false};
 }
 async ambient(){
  const foreground=await this.http('GET','/session/'+this.session+'/appium/device/current_package');assert.equal(foreground,app);const contexts=await this.execute('mobile: getContexts',[{waitForWebviewMs:0}]);const matching=contexts.filter(row=>row.webviewName===this.record.selected.context);assert.equal(matching.length,1);const row=matching[0];assert.equal(row.proc,'@webview_devtools_remote_'+this.record.fixtureReady.pid);assert.equal(row.webview,'WEBVIEW_'+this.record.fixtureReady.pid);assert.equal(row.info?.['Android-Package'],app);assert.equal(row.pages?.length,1);assert.equal(row.pages[0].id,this.record.selected.windowHandle);assert.equal(row.pages[0].url,this.url);
  const context=await this.http('GET','/session/'+this.session+'/context'),handles=await this.http('GET','/session/'+this.session+'/window/handles'),window=await this.http('GET','/session/'+this.session+'/window'),url=await this.http('GET','/session/'+this.session+'/url');assert.equal(context,row.webviewName);assert.deepEqual(handles,[row.pages[0].id]);assert.equal(window,row.pages[0].id);assert.equal(url,this.url);return{foreground,context,window,url,proc:row.proc,webview:row.webview,page:row.pages[0].id};
 }
 async fullObservation(pins=null){
  const before=await this.ambient(),source=await this.http('GET','/session/'+this.session+'/source');assert.equal(typeof source,'string');assert(/<html(?:\s|>)/i.test(source));
  const controls=['query','detail','run','result'].map((id,index)=>({id,kind:index<2?'input':index===2?'button':'output',selector:'#'+id,group:'#searchForm'}));
  const first=await this.execute(this.transport.DOM_PROBE,[controls,pins]);assert.equal(first.probeVersion,'webview-dom-probe-2');assert.equal(first.url,this.url);assert.equal(first.top,true);assert.equal(first.pinsMatched,pins!==null);
  const refs=pins||first.refs,second=await this.execute(this.transport.DOM_PROBE,[controls,refs]);assert.equal(second.pinsMatched,true);assert.deepEqual(first.rows,second.rows);assert.deepEqual(first.groups,second.groups);assert.deepEqual(await this.ambient(),before);return{...second,refs};
 }
 focusArgs(name,refs){const offset=3+['query','detail'].indexOf(name)*3;return['#'+name,refs[offset],refs[0],refs[1],refs[offset+1],refs[offset+2],this.url,new URL(this.url).origin];}
 checkFocus(reply){assert.deepEqual(reply,{probeVersion:'webview-focus-1',focused:true,value:''});}
 async proofCdp(){
  this.record.textTransport={mode:this.transport.TEXT_TRANSPORT_MODE,sha256:this.transport.transportSha256,sourceSha256:this.transport.sourceSha256,focusWriteSha256:sha(this.transport.FOCUS_WRITE_SCRIPT),focusReadSha256:sha(this.transport.FOCUS_READ_SCRIPT),domProbeSha256:sha(this.transport.DOM_PROBE)};
  const initial=await this.fullObservation(),refs=initial.refs;assert.equal(refs.length,15);assert(refs.every(ref=>ref===null||typeof ref[elementKey]==='string'));await this.save('production-probe-initial.json',initial);
  const values={query:' 上  海🙂e\u0301 ',detail:'细 节🙂e\u0301'};assert(values.query.normalize('NFC')!==values.query);
  for(const [index,name]of ['query','detail'].entries()){
   const element=refs[3+index*3][elementKey];await this.http('POST','/session/'+this.session+'/element/'+encodeURIComponent(element)+'/clear',{});
   const cleared=await this.fullObservation(refs);assert.equal(cleared.rows[name].value,'');this.checkFocus(await this.execute(this.transport.FOCUS_WRITE_SCRIPT,this.focusArgs(name,refs)));
   const focused=await this.fullObservation(refs);assert.equal(focused.rows[name].value,'');this.checkFocus(await this.execute(this.transport.FOCUS_READ_SCRIPT,this.focusArgs(name,refs)));
   const ack=await this.http('POST','/session/'+this.session+this.transport.CDP_TEXT_ROUTE,{cmd:this.transport.CDP_TEXT_COMMAND,params:{text:values[name]}});assert.deepEqual(ack,{});
   const echoed=await this.fullObservation(refs);assert.equal(echoed.rows[name].value,values[name]);
  }
  const exact=await this.fullObservation(refs);for(const name of ['query','detail'])assert.equal(exact.rows[name].value,values[name]);
  const oracle=await this.execute(PROBE,refs);assert(oracle.same.every(value=>value===true));assert.deepEqual(oracle.rows.slice(0,2).map(row=>row.value),[values.query,values.detail]);assert.deepEqual(oracle.rows.slice(0,2).map(row=>row.attributeValue),['ATTRIBUTE_DECOY_QUERY','ATTRIBUTE_DECOY_DETAIL']);
  await this.http('POST','/session/'+this.session+'/element/'+encodeURIComponent(refs[9][elementKey])+'/click',{});
  await this.until(async()=>{const raw=await this.device('exec-out','run-as',app,'cat','files/webview-ledger.json');return JSON.parse(raw.stdout).length===1},'one native CDP business',10000);const entries=await this.ledger('business');assert.deepEqual(entries,[{query:values.query,detail:values.detail,count:1}]);
  const after=await this.fullObservation(refs);assert.equal(after.rows.result.text,'RESULT '+values.query+' / '+values.detail+' ;COUNT:1');await this.save('production-probe-business.json',after);assert.equal(this.record.driverOnlyEffects.length,7);assert(this.record.driverOnlyEffects.every(row=>row.status==='acknowledged'));
  this.record.driverOnlyUiOutcome={status:'observed',automaticRetry:false};this.record.proof={independentBusinessCount:1,values,fullUnicodeEcho:true,liveDomVsAttribute:true,referenceEquality:true,transport:'explicit_fixed_cdp_insertText',generatedMcp:false};
 }
 async cleanup(){
  clearInterval(this.monitor);this.record.cleanup.children=[];for(const child of this.children){child.kill('SIGTERM');this.record.cleanup.children.push(child.pid)}
  if(this.session&&this.appium?.pid)try{await this.http('DELETE','/session/'+this.session);this.record.cleanup.sessionDeleted=true}catch(error){this.record.cleanup.sessionDeleteError=String(error.message)}
  if(this.appiumOwned()){try{process.kill(-this.appium.pid,'SIGTERM')}catch{}for(let i=0;i<50&&this.appiumOwned();i++)await delay(100);if(this.appiumOwned()){try{process.kill(-this.appium.pid,'SIGKILL')}catch{}for(let i=0;i<20&&this.appiumOwned();i++)await delay(100)}}this.record.cleanup.appiumStopped=!this.appiumOwned();
  if(this.owned()){
   try{if(this.originalIme&&this.originalIme!=='null')await this.shell('ime','set',this.originalIme);if(this.installed)await this.device('uninstall',app);await this.run(this.adb,['-P',String(this.ports.adb),'-s',this.serial,'emu','kill'],{allowFailure:true})}catch(error){this.record.cleanup.deviceError=String(error.message)}
   for(let i=0;i<100&&this.owned();i++)await delay(100);if(this.owned()){try{process.kill(-this.emulator.pid,'SIGTERM')}catch{}for(let i=0;i<50&&this.owned();i++)await delay(100)}if(this.owned()){try{process.kill(-this.emulator.pid,'SIGKILL')}catch{}for(let i=0;i<20&&this.owned();i++)await delay(100)}
  }
  this.record.cleanup.emulatorStopped=!this.owned();if(this.record.cleanup.emulatorStopped&&this.avd){await rm(this.avd,{recursive:true,force:true});await rm(path.join(this.avdHome,this.avdName+'.ini'),{force:true});this.record.cleanup.ownedAvdRemoved=true}
  if(this.ports?.adb)await this.run(this.adb,['-P',String(this.ports.adb),'kill-server'],{allowFailure:true});
  this.record.cleanup.ports={};for(const [name,port] of Object.entries(this.ports||{}))this.record.cleanup.ports[name]={port,closed:!!await this.free(port)};
  this.record.cleanup.originalAvdConfigsExact=JSON.stringify(await this.avds())===JSON.stringify(this.prepared.existingAvds);this.record.cleanup.defaultAdbStateExact=!!await this.listening(5037)===this.prepared.defaultAdbListening;this.record.cleanup.sourcesExact=JSON.stringify(await this.sources())===JSON.stringify(this.prepared.sources);
  if(Object.values(this.record.cleanup.ports).some(row=>!row.closed)||!this.record.cleanup.originalAvdConfigsExact||!this.record.cleanup.defaultAdbStateExact||!this.record.cleanup.sourcesExact||!this.record.cleanup.emulatorStopped||!this.record.cleanup.appiumStopped)this.record.status='failed';await this.space('terminal');
 }
 async executeRun(body){
  this.prepared=await json(path.join(this.output,'preparation.json'));assert.equal(sha(await readFile(path.join(this.output,'preparation.json'))),this.values['prepared-sha256']);assert.deepEqual(await this.sources(),this.prepared.sources);assert.equal(sha(await readFile(this.prepared.apk)),this.prepared.apkSha256);this.transport=this.prepared.transport;if(this.transport)assert.deepEqual(await this.captureTransport(),this.transport);
  const interrupt=()=>{this.interrupted=true};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try{await this.startDevice();await this.startSession();await (body?body(this):this.proof());this.record.status='passed'}catch(error){this.record.status='failed';if(this.record.driverOnlyEffects?.length&&!this.record.driverOnlyUiOutcome)this.record.driverOnlyUiOutcome={status:'unknown',automaticRetry:false};this.record.error={message:String(error.message),stack:String(error.stack)};if(this.installed&&this.owned())try{await this.ledger('failure')}catch{}}
  finally{try{await this.cleanup()}catch(error){this.record.status='failed';this.record.cleanup.error=String(error.stack)}process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);this.record.http=this.rows;this.record.finishedAt=new Date().toISOString();await this.save('driver-results.json',this.record);this.log('terminal',{status:this.record.status,report:path.join(this.output,'driver-results.json')});if(this.record.status!=='passed')process.exitCode=1}
 }
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 process.umask(0o077);const {values}=parseArgs({options:{phase:{type:'string',default:'prepare'},output:{type:'string'},sdk:{type:'string'},apk:{type:'string'},python:{type:'string'},'text-transport':{type:'string'},'dependency-dir':{type:'string'},'appium-prefix':{type:'string'},'prepared-sha256':{type:'string'}}});assert(values.output&&values['dependency-dir']);const harness=new OwnedAndroidWebView(values);if(values.phase==='prepare')await harness.prepare();else{assert.equal(values.phase,'execute');await harness.executeRun()}
}
