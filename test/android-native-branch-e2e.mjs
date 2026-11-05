#!/usr/bin/env node
// Opt-in real Android acceptance. Requires existing SDK tools/API36 image.
// Creates a private AVD, ADB server and key; never reuses a user device.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {existsSync, openSync, closeSync} from 'node:fs';
import {mkdir, readFile, writeFile, rm, readdir, stat, chmod, statfs} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

process.umask(0o077);
const root = path.resolve(import.meta.dirname, '..');
const {values} = parseArgs({options: {
  sdk: {type:'string'}, python: {type:'string'}, output: {type:'string'},
  'production-baseline': {type:'string'},
}});
const output = path.resolve(values.output || path.join(root, 'output-vision-implementation', 'native-branch-android-' + Date.now()));
const sdk = path.resolve(values.sdk || path.join(os.homedir(), 'Library/Android/sdk'));
const python = path.resolve(values.python || path.join(root, '.venv/bin/python'));
const adb = path.join(sdk, 'platform-tools/adb');
const app = 'com.bfs.mcp.nativebranches', imeApp = 'com.bfs.mcp.ime', component = imeApp + '/.UnicodeIme';
const uiBudget = 900000, reserve = 10 * 2**30;
const digest = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const record = {schemaVersion:1, startedAt:new Date().toISOString(), status:'running',
  kind:'real_owned_android_native_branch', output, commands:[], steps:[], operations:[],
  ledgers:[], clients:[], storage:[], scope:{ownsNewDeviceOnly:true, existingAvdWiped:false,
    newSystemImageDownloaded:false, globalAdbServerRestarted:false, appInternetPermission:false,
    syntheticFixtureDoesNotProveArbitraryApps:true, historicalFullDoesNotCoverThisNewHarness:true}, cleanup:{}};
const clients = [];
let emulator, emulatorReceipt, serial, ownedAdbPort, originalIme, appInstalled=false, imeInstalled=false;
let interrupted=false, originalAvds, productionBefore, productionRows, sourceBefore, unicodeImeBefore, monitor, storageFailure;
const log = (phase, detail={}) => {
  record.steps.push({at:new Date().toISOString(), phase, ...detail});
  process.stdout.write(JSON.stringify({phase, ...detail}) + '\n');
};
async function save(file, value) {
  await mkdir(path.dirname(file), {recursive:true, mode:0o700});
  await writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value,null,2)+'\n', {mode:0o600});
  await chmod(file, 0o600);
}
async function freeSpace(phase, minimum=reserve) {
  const value = await statfs(output), bytes = Number(value.bavail) * Number(value.bsize);
  record.storage.push({at:new Date().toISOString(), phase, availableBytes:bytes});
  if(bytes < minimum) throw Error('Storage reserve reached at ' + phase + ': ' + bytes);
  return bytes;
}
function checkState() {
  if(interrupted) throw Error('Interrupted; UI operations are not retried');
  if(storageFailure) throw storageFailure;
}
async function run(executable, args, {timeout=120000, allowFailure=false, binary=false}={}) {
  const startedAt=new Date().toISOString(), start=Date.now();
  const child=spawn(executable,args,{cwd:root,env:{...process.env,
    PYTHONPATH:path.join(root,'apk_tools'), PYTHONDONTWRITEBYTECODE:'1', TMPDIR:path.join(output,'tmp')},stdio:['ignore','pipe','pipe']});
  let stdout=[],stderr=[],bytes=0,large=false,timedOut=false;
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>16*1024*1024){large=true;child.kill('SIGTERM');}else stdout.push(b);});
  child.stderr.on('data',b=>{stderr.push(b);if(Buffer.concat(stderr).length>131072)stderr=stderr.slice(-4);});
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  let signal;
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,sig)=>{signal=sig;resolve(code);});}).finally(()=>clearTimeout(timer));
  const out=Buffer.concat(stdout),err=Buffer.concat(stderr);
  record.commands.push({executable,args,startedAt,durationMs:Date.now()-start,pid:child.pid,code,signal,timedOut,
    stdoutBytes:out.length,stdoutSha256:digest(out),stderrBytes:err.length,stderrSha256:digest(err)});
  const result={code,signal,stdout:binary?out:out.toString(),stderr:err.toString(),timedOut};
  if(!allowFailure&&(code!==0||large||timedOut))throw Error(path.basename(executable)+' failed ('+code+'): '+result.stderr.slice(-2000));
  return result;
}
const device=(...args)=>run(adb,['-P',String(ownedAdbPort),'-s',serial,...args]);
const sh=(...args)=>device('shell',args.map(shellQuote).join(' '));
async function until(fn,label,timeout=120000) {
  const deadline=Date.now()+timeout;let last=0;
  while(Date.now()<deadline){checkState();const value=await fn();if(value)return value;
    if(Date.now()-last>15000){log('waiting',{for:label});last=Date.now();await freeSpace(label);}
    await delay(500);
  }
  throw Error('Timeout: '+label+'; no automatic UI replay');
}
async function availablePort(port) {
  return new Promise(resolve=>{const server=createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});
}
function processCommand(pid) {
  try{return execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}).trim();}catch{return '';}
}
function emulatorOwned() {
  return emulatorReceipt?.isolatedNewData===true && emulatorReceipt.avd.startsWith(output+path.sep)
    && processCommand(emulatorReceipt.pid).includes(emulatorReceipt.name);
}
async function avdSnapshot() {
  const dir=path.join(os.homedir(),'.android','avd'), rows={};
  if(!existsSync(dir))return rows;
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const file=entry.isFile()&&entry.name.endsWith('.ini')?path.join(dir,entry.name):
      entry.isDirectory()&&entry.name.endsWith('.avd')?path.join(dir,entry.name,'config.ini'):null;
    if(file&&existsSync(file)){const info=await stat(file);rows[file]={sha256:digest(await readFile(file)),bytes:info.size,mode:info.mode&0o777};}
  }
  return rows;
}
async function filesSnapshot(files) {
  const rows={};
  for(const file of [...files].sort()) {
    const absolute=path.join(root,file),info=await stat(absolute);
    rows[file]={sha256:digest(await readFile(absolute)),bytes:info.size,mode:info.mode&0o777};
  }
  return rows;
}
async function sourceSnapshot() {
  const files=['test/android-native-branch-e2e.mjs'];
  async function visit(dir) {for(const row of await readdir(path.join(root,dir),{withFileTypes:true})) {
    const file=path.join(dir,row.name);if(row.isDirectory())await visit(file);else if(row.isFile())files.push(file);
  }}
  await visit('apk_tools/examples/native-branch-android');return filesSnapshot(files);
}
async function unicodeImeSourceSnapshot() {
  const directory='apk_tools/examples/unicode-ime', files=[];
  const generatedTopLevel=new Set(['out','output','build','cache','.cache','.gradle','.pytest_cache']);
  async function visit(dir) {for(const row of await readdir(path.join(root,dir),{withFileTypes:true})) {
    const file=path.join(dir,row.name);
    if(row.isDirectory()&&(row.name==='__pycache__'||dir===directory&&
      (generatedTopLevel.has(row.name)||row.name.startsWith('output-'))))continue;
    assert.ok(!row.isSymbolicLink(),'IME source must be an ordinary in-tree file or directory: '+file);
    if(row.isDirectory())await visit(file);else if(row.isFile()&&!/\.py[co]$/.test(row.name))files.push(file);
  }}
  await visit(directory);
  assert.ok(files.includes(directory+'/build.py')&&files.includes(directory+'/AndroidManifest.xml'),
    'The actual Unicode IME build source is incomplete');
  return filesSnapshot(files);
}
async function sourceFreeze() {
  if(values['production-baseline']) {
    const baselinePath=path.resolve(values['production-baseline']), baseline=await json(baselinePath);
    productionRows=baseline.productionRows;
    assert.ok(productionRows&&Object.keys(productionRows).length>0,'Production baseline has no productionRows');
    record.productionBaseline={path:baselinePath,sha256:digest(await readFile(baselinePath)),parent:baseline.parent};
  } else {
    const names=execFileSync('git',['ls-files','-z','src','apk_tools/apk_inventory','gateway/src','scripts','dist'],{cwd:root}).toString().split('\0').filter(Boolean);
    productionRows=await filesSnapshot(names);
    record.productionBaseline={parent:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),localSnapshot:true};
  }
  const baselineProductionFiles=Object.keys(productionRows).length;
  unicodeImeBefore=await unicodeImeSourceSnapshot();
  const addedUnicodeImeFiles=Object.keys(unicodeImeBefore).filter(file=>!Object.hasOwn(productionRows,file));
  // Keep every supplied baseline row, including any IME row. Supplement missing
  // build inputs in both baseline modes; never replace an expected baseline hash.
  productionRows={...unicodeImeBefore,...productionRows};
  productionBefore=await filesSnapshot(Object.keys(productionRows));
  assert.deepEqual(productionBefore,productionRows,'Production differs from the approved baseline');
  sourceBefore=await sourceSnapshot();
  await save(path.join(output,'source-before.json'),{production:productionBefore,newFixtureAndHarness:sourceBefore,
    buildDependencies:{unicodeIme:unicodeImeBefore}});
  record.sourceFreeze={productionFiles:Object.keys(productionBefore).length,
    productionSha256:digest(JSON.stringify(productionBefore)),newFiles:Object.keys(sourceBefore).length,
    newSha256:digest(JSON.stringify(sourceBefore)),baselineProductionFiles,
    addedUnicodeImeFiles,unicodeImeDirectory:'apk_tools/examples/unicode-ime',
    unicodeImeFiles:Object.keys(unicodeImeBefore).length,unicodeImeSha256:digest(JSON.stringify(unicodeImeBefore))};
}
async function startEmulator() {
  const image='system-images/android-36/google_apis_playstore/arm64-v8a/';
  assert.ok(existsSync(path.join(sdk,image,'system.img')),'Existing API36 arm64 image is required; no download attempted');
  const name='BFS_NATIVE_BRANCH_'+digest(output).slice(0,12), avdHome=path.join(output,'avd'),avd=path.join(avdHome,name+'.avd');
  await mkdir(avd,{recursive:true,mode:0o700});
  const config={AvdId:name,'avd.ini.displayname':'BFS owned native branch acceptance','avd.ini.encoding':'UTF-8',
    'abi.type':'arm64-v8a','hw.cpu.arch':'arm64','hw.cpu.ncore':'2','hw.ramSize':'1536','disk.dataPartition.size':'2G',
    'hw.lcd.width':'720','hw.lcd.height':'1280','hw.lcd.density':'320','hw.keyboard':'yes','hw.mainKeys':'no',
    'hw.gpu.enabled':'yes','hw.gpu.mode':'swiftshader_indirect','hw.audioInput':'no','hw.camera.back':'none',
    'hw.camera.front':'none','hw.sdCard':'no','showDeviceFrame':'no','fastboot.forceColdBoot':'yes','fastboot.forceFastBoot':'no',
    'image.sysdir.1':image,'tag.id':'google_apis_playstore',target:'android-36'};
  await save(path.join(avd,'config.ini'),Object.entries(config).map(([k,v])=>k+'='+v).join('\n')+'\n');
  await save(path.join(avdHome,name+'.ini'),`avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-36\n`);
  let port=5680;while(!await availablePort(port)||!await availablePort(port+1))port+=2;
  ownedAdbPort=6157;while(!await availablePort(ownedAdbPort))ownedAdbPort++;
  assert.notEqual(ownedAdbPort,5037);
  const key=path.join(output,'emulator-home','adbkey');await mkdir(path.dirname(key),{recursive:true,mode:0o700});
  Object.assign(process.env,{ADB_SERVER_SOCKET:'tcp:127.0.0.1:'+ownedAdbPort,ANDROID_ADB_SERVER_PORT:String(ownedAdbPort),
    ADB_VENDOR_KEYS:key,ANDROID_USER_HOME:path.join(output,'android-user')});
  await run(adb,['keygen',key]);await run(adb,['-P',String(ownedAdbPort),'start-server']);
  const executable=path.join(sdk,'emulator','emulator'),args=['-avd',name,'-port',String(port),'-no-window','-no-audio',
    '-no-boot-anim','-no-snapshot','-no-metrics','-skip-adb-auth','-memory','1536','-gpu','swiftshader_indirect','-adb-path',adb];
  await freeSpace('before_owned_emulator_start',14*2**30);
  // The parent coordinates this preflight notice with other owned device jobs.
  log('preflight',{name,port,adbServerPort:ownedAdbPort,ramMiB:1536,dataPartitionGiB:2,image,sourceFreeze:record.sourceFreeze});
  const fd=openSync(path.join(output,'emulator.log'),'a',0o600);
  emulator=spawn(executable,args,{cwd:root,env:{...process.env,ANDROID_SDK_ROOT:sdk,ANDROID_AVD_HOME:avdHome,
    ANDROID_EMULATOR_HOME:path.join(output,'emulator-home'),TMPDIR:path.join(output,'tmp')},stdio:['ignore',fd,fd],detached:true});
  closeSync(fd);emulator.unref();serial='emulator-'+port;
  emulatorReceipt={name,pid:emulator.pid,serial,port,avd,avdHome,adbServerPort:ownedAdbPort,adbKey:key,
    command:[executable,...args],createdAt:new Date().toISOString(),isolatedNewData:true,existingAvdUntouched:true};
  record.deviceOwner=emulatorReceipt;await save(path.join(output,'emulator-receipt.json'),emulatorReceipt);
  monitor=setInterval(()=>{void freeSpace('running_reserve_monitor').catch(error=>{storageFailure=error;});},15000);
  monitor.unref();
  await until(async()=>{
    if(!emulatorOwned())throw Error('Owned emulator exited before boot');
    const result=await run(adb,['-P',String(ownedAdbPort),'-s',serial,'shell','getprop','sys.boot_completed'],{timeout:8000,allowFailure:true});
    return result.code===0&&result.stdout.trim()==='1';
  },'owned emulator boot',240000);
  record.device={serial,api:(await sh('getprop','ro.build.version.sdk')).stdout.trim(),
    release:(await sh('getprop','ro.build.version.release')).stdout.trim(),abi:(await sh('getprop','ro.product.cpu.abi')).stdout.trim(),
    avd:(await sh('getprop','ro.boot.qemu.avd_name')).stdout.trim(),shell:(await sh('id')).stdout.trim()};
  assert.equal(record.device.avd,name);assert.equal(record.device.api,'36');
  record.proxyBefore=(await sh('settings','get','global','http_proxy')).stdout.trim();
  for(const key of ['window_animation_scale','transition_animation_scale','animator_duration_scale'])await sh('settings','put','global',key,'0');
  log('owned_emulator_ready',{api:record.device.api,abi:record.device.abi});
}
const decodeXml=text=>text.replace(/&#x([0-9a-f]+);/gi,(_,c)=>String.fromCodePoint(parseInt(c,16)))
  .replace(/&#([0-9]+);/g,(_,c)=>String.fromCodePoint(Number(c))).replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
async function ledger(phase, expected) {
  const raw=(await device('exec-out','run-as',app,'cat','files/ledger.json')).stdout;
  const prefs=(await device('exec-out','run-as',app,'cat','shared_prefs/submissions.xml')).stdout;
  const value=JSON.parse(raw), string=prefs.match(/<string name="entries">([\s\S]*?)<\/string>/);
  const integer=(name,fallback=0)=>Number(prefs.match(new RegExp('<int name="'+name+'" value="(\\d+)"'))?.[1]??fallback);
  assert.equal(value.count,integer('count'));assert.equal(value.nextCount,integer('nextCount'));
  assert.equal(value.detailChanges,integer('detailChanges'));
  assert.deepEqual(value.entries,string?JSON.parse(decodeXml(string[1])):[]);
  assert.equal(value.count,value.entries.length);
  if(expected)assert.deepEqual(value.entries,expected.map((row,i)=>({number:i+1,...row})));
  const index=record.ledgers.length;
  await save(path.join(output,'ledger-'+index+'-'+phase+'.json'),raw);
  await save(path.join(output,'prefs-'+index+'-'+phase+'.xml'),prefs);
  record.ledgers.push({phase,count:value.count,nextCount:value.nextCount,detailChanges:value.detailChanges,
    faultArmed:value.faultArmed,ledgerSha256:digest(raw),sharedPreferencesSha256:digest(prefs),independentPrivateStoreAgrees:true,entries:value.entries});
  await freeSpace('ledger_'+phase);log('ledger_verified',{phase,count:value.count,nextCount:value.nextCount});return value;
}
async function installedHash(packageName) {
  const result=await sh('pm','path',packageName),base=result.stdout.trim().split('\n').find(row=>row.endsWith('/base.apk'));
  assert.ok(base,'Installed APK path is missing');const file=base.replace(/^package:/,'');
  const hash=(await sh('sha256sum',file)).stdout.trim().split(/\s+/)[0];assert.match(hash,/^[a-f0-9]{64}$/);return hash;
}
function initialPrivateStateReady(raw, prefs) {
  const missing=(text,file)=>text==='cat: '+file+': No such file or directory\n';
  let ledgerReady=false,prefsReady=false;
  if(!missing(raw,'files/ledger.json')&&raw.trim()) {
    assert.ok(!raw.startsWith('cat:'),'INITIAL_LEDGER_READ_FAILED');
    let value;try{value=JSON.parse(raw);}catch{}
    if(value!==undefined) {
      assert.deepEqual(value,{count:0,nextCount:0,detailChanges:0,faultArmed:false,entries:[]},
        'INITIAL_LEDGER_UNEXPECTED_STATE');ledgerReady=true;
    }
  }
  if(!missing(prefs,'shared_prefs/submissions.xml')&&prefs.trim()) {
    assert.ok(!prefs.startsWith('cat:'),'INITIAL_PREFS_READ_FAILED');
    const xml=prefs.replace(/^<\?xml[^>]*>\s*/,''),map=xml.match(/^<map>\s*([\s\S]*?)\s*<\/map>\s*$/);
    if(map) {
      const child=/\s*(?:<int name="(count|nextCount|detailChanges)" value="(\d+)"\s*\/>|<boolean name="(faultArmed)" value="(true|false)"\s*\/>|<string name="(entries)">([\s\S]*?)<\/string>)\s*/gy;
      const seen=new Set();let offset=0;
      while(offset<map[1].length) {
        child.lastIndex=offset;const row=child.exec(map[1]);
        assert.ok(row,'INITIAL_PREFS_UNEXPECTED_XML');offset=child.lastIndex;
        const name=row[1]||row[3]||row[5];assert.ok(!seen.has(name),'INITIAL_PREFS_DUPLICATE_FIELD');seen.add(name);
        if(row[1])assert.equal(Number(row[2]),0,'INITIAL_PREFS_UNEXPECTED_STATE');
        else if(row[3])assert.equal(row[4],'false','INITIAL_PREFS_UNEXPECTED_STATE');
        else assert.deepEqual(JSON.parse(decodeXml(row[6])),[],'INITIAL_PREFS_UNEXPECTED_STATE');
      }
      prefsReady=seen.size===5;
    }
  }
  return ledgerReady&&prefsReady;
}
async function waitInitialPrivateState(timeout=15000) {
  const deadline=Date.now()+timeout;let probes=0;
  async function readOnly(label,args) {
    checkState();assert.ok(emulatorOwned(),'INITIAL_FIXTURE_OWNER_CHANGED');
    const remaining=deadline-Date.now();assert.ok(remaining>0,'INITIAL_FIXTURE_READINESS_DEADLINE');
    const result=await run(adb,['-P',String(ownedAdbPort),'-s',serial,...args],
      {timeout:Math.min(2000,remaining),allowFailure:true});
    await save(path.join(output,'initial-readiness-'+probes+'-'+label+'.json'),result);
    assert.ok(!result.timedOut&&result.code===0&&result.stderr==='', 'INITIAL_FIXTURE_READ_FAILED: '+label);
    assert.ok(Date.now()<=deadline,'INITIAL_FIXTURE_READINESS_DEADLINE');return result.stdout;
  }
  while(Date.now()<deadline) {
    probes++;await freeSpace('initial_fixture_readiness_'+probes);
    const raw=await readOnly('ledger',['exec-out','run-as',app,'cat','files/ledger.json']);
    const prefs=await readOnly('prefs',['exec-out','run-as',app,'cat','shared_prefs/submissions.xml']);
    if(initialPrivateStateReady(raw,prefs)) {
      const avd=(await readOnly('avd',['shell','getprop','ro.boot.qemu.avd_name'])).trim();
      assert.equal(avd,emulatorReceipt.name,'INITIAL_FIXTURE_AVD_CHANGED');
      for(const [name,expected]of [[app,record.artifacts.apk.sha256],[imeApp,record.artifacts.ime.sha256]]) {
        const paths=(await readOnly('package-path-'+name,['shell','pm','path',name])).trim().split('\n').filter(row=>row.endsWith('/base.apk'));
        assert.equal(paths.length,1,'INITIAL_FIXTURE_PACKAGE_PATH_CHANGED');
        const file=paths[0].replace(/^package:/,''),text=await readOnly('package-sha-'+name,
          ['shell',['sha256sum',file].map(shellQuote).join(' ')]);
        assert.equal(text.trim().split(/\s+/)[0],expected,'INITIAL_FIXTURE_APK_CHANGED');
      }
      record.initialFixtureReadiness={probes,budgetMs:timeout,readOnly:true,initialPrivateStateVerified:true,
        sameOwnedAvdAndInstalledApksVerified:true,appRestarted:false,appDataCleared:false,businessOrMcpReplayed:false};
      log('initial_fixture_ready',{probes});return;
    }
    const remaining=deadline-Date.now();if(remaining<=0)break;await delay(Math.min(250,remaining));
  }
  throw Error('INITIAL_FIXTURE_READINESS_DEADLINE; no App restart, data reset or MCP replay');
}
const content=reply=>reply.structuredContent??JSON.parse(reply.content.find(row=>row.type==='text').text);
async function call(connection,name,args={}) {
  checkState();const reply=await connection.client.callTool({name,arguments:args});
  assert.ok(!reply.isError,JSON.stringify(reply));return content(reply);
}
async function completed(connection,started,name='software_operation',expectedStatus='completed') {
  assert.ok(started.operationId);connection.active.add(started.operationId);
  const value=await until(async()=>{
    const value=await call(connection,name,{operationId:started.operationId});
    return ['completed','failed','cancelled','interrupted'].includes(value.status)?value:null;
  },'MCP operation '+started.operationId,uiBudget+32000);
  connection.active.delete(started.operationId);record.operations.push(value);
  await save(path.join(output,'operation-'+record.operations.length+'.json'),value);
  assert.equal(value.status,expectedStatus,JSON.stringify(value));return value;
}
async function connect(entry,args=[],label='unified') {
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,...args],cwd:root,stderr:'pipe',env:{...process.env,
    PYTHONDONTWRITEBYTECODE:'1',TMPDIR:path.join(output,'tmp')}});
  let stderr='';transport.stderr?.on('data',b=>{stderr+=b;});
  const client=new Client({name:'bfs-owned-native-branch-acceptance',version:'1'});await client.connect(transport);
  const connection={client,transport,child:transport._process,label,active:new Set(),stderr:()=>stderr};clients.push(connection);
  record.clients.push({label,pid:connection.child?.pid,entry,args});return connection;
}
async function captureUi(phase) {
  const destination='/sdcard/bfs-owned-native-branch-'+phase+'.xml';
  const result=await sh('uiautomator','dump',destination);assert.equal(result.code,0);
  const xml=(await sh('cat',destination)).stdout;await sh('rm','-f',destination);await save(path.join(output,phase+'-ui.xml'),xml);
  const screen=await run(adb,['-P',String(ownedAdbPort),'-s',serial,'exec-out','screencap','-p'],{binary:true});
  await save(path.join(output,phase+'-screen.png'),screen.stdout);return xml;
}
const params=(route,query,detail)=>({query,route,detail});
const outputText=(value,count)=>'RESULT '+value.query+' / '+value.detail+' / '+value.route+' ;COUNT:'+count;
async function acceptance(apk, imeApk) {
  record.artifacts={apk:{sha256:digest(await readFile(apk)),bytes:(await stat(apk)).size},
    ime:{sha256:digest(await readFile(imeApk)),bytes:(await stat(imeApk)).size}};
  await device('install','-r',apk);appInstalled=true;await device('install','-r',imeApk);imeInstalled=true;
  record.artifacts.apk.installedSha256=await installedHash(app);record.artifacts.ime.installedSha256=await installedHash(imeApp);
  assert.equal(record.artifacts.apk.installedSha256,record.artifacts.apk.sha256);
  assert.equal(record.artifacts.ime.installedSha256,record.artifacts.ime.sha256);
  originalIme=(await sh('settings','get','secure','default_input_method')).stdout.trim();record.originalIme=originalIme;
  await until(async()=>(await sh('ime','list','-a','-s')).stdout.includes(component),'owned IME registration',60000);
  await sh('ime','enable',component);await sh('ime','set',component);await sh('am','start','-n',app+'/.BranchActivity');
  await until(async()=>{const result=await run(adb,['-P',String(ownedAdbPort),'-s',serial,'shell','pidof',app],{allowFailure:true});return result.code===0&&result.stdout.trim();},'owned App startup',30000);
  await waitInitialPrivateState();
  const expected=[];const baseline=await ledger('initial',expected);assert.equal(baseline.count,0);assert.equal(baseline.nextCount,0);
  const initialXml=await captureUi('initial');assert.ok(initialXml.includes(app+':id/query'));assert.ok(initialXml.includes(app+':id/route'));
  const inventory=path.join(output,'inventory');await run(python,['-m','apk_inventory.extract',apk,'--out',inventory]);
  const descriptor=await json(path.join(inventory,'source.json')),sourceId=descriptor.source_id;
  assert.equal(descriptor.app.package_name,app);assert.equal(descriptor.app.apk_sha256,record.artifacts.apk.sha256);
  const identify=name=>({resourceId:app+':id/'+name});
  const actions=[['type','query'],['select','route'],['check','left'],['check','right'],['click','next'],
    ['type','detail'],['type','alternate_detail'],['click','left_search'],['click','right_search']];
  const deviceFile=path.join(output,'device.json');
  await save(deviceFile,{source:{id:sourceId,kind:'apk'},backend:{type:'adb',adb,deviceId:serial,appId:app,
    unicodeInput:{component,apkSha256:record.artifacts.ime.sha256}},limits:{maxActions:200,maxDepth:5,maxDurationMs:uiBudget},
    actionAllowlist:actions.map(([kind,name])=>({kind,selector:identify(name),effect:'read'})),
    nativeBranchPlanning:{workflowId:'native_branch_lookup',forkInput:{kind:'select',selector:identify('route')},
      arms:['left','right'].map(route=>({id:route,value:route,seedInputs:[{kind:'type',selector:identify('query'),value:'seed-query'},
        {kind:'select',selector:identify('route'),value:route},
        {kind:'type',selector:identify(route==='left'?'detail':'alternate_detail'),value:'seed-'+route+'-detail'}]}))}});
  const runtimeFile=path.join(output,'runtime.json');await save(runtimeFile,{outputRoot:path.join(output,'software'),artifactRoots:[output],
    python,devices:{owned_branch:deviceFile},bindings:{[sourceId]:{allowed_origins:[]}}});
  const unified=await connect(path.join(root,'src/software-mcp.js'),['--config',runtimeFile]);
  const discovery=await completed(unified,await call(unified,'software_discover',{kind:'apk',input:apk,deviceName:'owned_branch'}));
  record.discovery=discovery;
  expected.push(params('left','seed-query','seed-left-detail'),params('right','seed-query','seed-right-detail'));
  const afterDiscovery=await ledger('discover_two_arms',expected);assert.equal(afterDiscovery.nextCount,2);
  const plan=await call(unified,'software_workflows',{sourceId,limit:100}),again=await call(unified,'software_workflows',{sourceId,limit:100});
  await save(path.join(output,'workflow-plan.json'),plan);
  const candidate=plan.items.find(row=>row.planningMode==='native-branch-stages-v1');assert.ok(candidate,JSON.stringify(plan));
  assert.deepEqual(Object.keys(candidate.inputSchema.properties).sort(),['detail','query','route']);
  assert.equal(again.items.find(row=>row.planningMode==='native-branch-stages-v1')?.id,candidate.id);
  assert.equal(candidate.readiness,'candidate');assert.equal(candidate.outputTargets.length,1,'Synthetic terminal must expose exactly one result region');
  assert.ok(!JSON.stringify(plan).includes('seed-query'));assert.ok(!JSON.stringify(plan).includes('selector'));
  const planned=await ledger('planning_is_read_only',expected);assert.equal(planned.nextCount,afterDiscovery.nextCount);
  const assertions=['query','route','detail'].map(param=>({outputTargetId:candidate.outputTargets[0].id,param,changedFromBefore:true}));
  const samples=[params('left','上海','第一项'),params('left','上 海','第二 项'),params('right','广州','三'),params('right','广 州','四')];
  const denied=await completed(unified,await call(unified,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,
    candidateId:candidate.id,samples:samples.slice(0,3),resultAssertions:assertions}),'software_operation','failed');
  assert.ok(JSON.stringify(denied).includes('NATIVE_BRANCH'));
  const deniedLedger=await ledger('incomplete_arm_samples_rejected',expected);assert.equal(deniedLedger.nextCount,planned.nextCount);
  record.learning=await completed(unified,await call(unified,'software_bind_workflow',{sourceId,expectedRevision:plan.source.revision,
    candidateId:candidate.id,samples,resultAssertions:assertions}));
  expected.push(...samples);await ledger('learning_four_samples',expected);
  const catalog=await call(unified,'software_capabilities',{sourceId,kind:'mobile',limit:100});await save(path.join(output,'capabilities.json'),catalog);
  const cap=catalog.items.find(row=>row.inputSchema.properties.detail&&row.readiness==='ready');assert.ok(cap,JSON.stringify(catalog));
  assert.deepEqual(cap.modality.channels,['fixed_ui_actions','native_semantic']);
  assert.deepEqual(cap.fidelity.inputText.map(row=>row.parameter).sort(),['detail','query']);
  assert.ok(cap.fidelity.limits.includes('native_branch_each_arm_requires_two_observed_samples'));
  record.capability=cap;record.sourceId=sourceId;
  const unifiedSamples=[params('left',' 上  海 ','海🙂e\u0301'),params('right',' 深圳 ','右路 e\u0301🙂')];
  for(const value of unifiedSamples) {
    const outcome=await completed(unified,await call(unified,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,params:value}));
    assert.equal(outcome.result.result.ok,true,JSON.stringify(outcome));
    assert.equal(outcome.result.result.outputs.result,outputText(value,expected.length+1));expected.push(value);
    await ledger('unified_'+value.route,expected);
  }
  const generated=await completed(unified,await call(unified,'software_generate',{sourceId,expectedRevision:catalog.source.revision}));record.generation=generated;
  const independent=await connect(generated.result.entry,[],'generated');
  const generatedCatalog=await call(independent,'list_capabilities');
  assert.deepEqual(generatedCatalog.items.map(row=>[row.id,row.revision,row.readiness,row.modality,row.fidelity]),catalog.items.map(row=>[row.id,row.revision,row.readiness,row.modality,row.fidelity]));
  const tool='cap_'+cap.id.slice(4,24),tools=await independent.client.listTools();assert.ok(tools.tools.some(row=>row.name===tool));
  const generatedSamples=[params('left',' 北京  ','🙂e\u0301 终 '),params('right',' 成都 ','末e\u0301🙂')];
  for(const value of generatedSamples) {
    const outcome=await completed(independent,await call(independent,tool,value),'operation_status');
    assert.equal(outcome.result.result.ok,true,JSON.stringify(outcome));
    assert.equal(outcome.result.result.outputs.result,outputText(value,expected.length+1));expected.push(value);
    await ledger('generated_'+value.route,expected);
  }
  record.positiveBusinessEntries=expected;assert.equal(expected.length,10);
  for(const value of [...unifiedSamples,...generatedSamples])assert.notEqual(value.detail.normalize('NFC'),value.detail,'NFD sample must retain combining code points');
  const invalid=await completed(unified,await call(unified,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,
    params:params('third','invalid','no-submit')}),'software_operation','failed');assert.equal(invalid.errorCode,'INPUT_INVALID');
  const beforeFault=await ledger('invalid_enum_rejected',expected);assert.equal(beforeFault.nextCount,10);
  await sh('am','start','-n',app+'/.BranchActivity','--ez','flip_next_route','true');
  const armed=await ledger('fault_armed',expected);assert.equal(armed.faultArmed,true);assert.equal(armed.nextCount,beforeFault.nextCount);
  const wrong=await completed(unified,await call(unified,'software_call',{sourceId,capabilityId:cap.id,expectedRevision:cap.revision,
    params:params('left','must-stop','no-submit')}));
  assert.equal(wrong.result.result.ok,false,JSON.stringify(wrong));assert.ok(JSON.stringify(wrong).includes('NATIVE_BRANCH_ROUTE_INPUT_MISMATCH'));
  const stopped=await ledger('wrong_arm_stopped_without_search',expected);assert.equal(stopped.nextCount,armed.nextCount+1);
  assert.equal(stopped.detailChanges,armed.detailChanges,'Wrong arm must not receive text input');
  assert.equal(stopped.faultArmed,false);
  const finalXml=await captureUi('final_wrong_arm');assert.ok(finalXml.includes(app+':id/right_form'));assert.ok(!finalXml.includes('no-submit'));
  record.negatives={incompleteSamplesNoBusinessOrForkDispatch:true,invalidEnumNoBusinessOrForkDispatch:true,wrongArmFreshUiMismatch:true,
    wrongArmNextCountDelta:1,wrongArmBusinessDelta:0,wrongArmDetailChangeDelta:0,automaticUiRetry:false};
  assert.equal(await installedHash(app),record.artifacts.apk.sha256);assert.equal(await installedHash(imeApp),record.artifacts.ime.sha256);
  record.proxyAfter=(await sh('settings','get','global','http_proxy')).stdout.trim();assert.equal(record.proxyAfter,record.proxyBefore);
  record.status='passed';
}
async function protectArtifacts(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);if(entry.isDirectory()){await chmod(file,0o700);await protectArtifacts(file);}
    else if(entry.isFile())await chmod(file,0o600);
  }
}
async function closeClient(connection) {
  const row=record.clients.find(row=>row.pid===connection.child?.pid);
  for(const operationId of connection.active) {
    if(connection.label==='generated'){row.activeShutdownUsesServerLifecycle=true;continue;}
    try{row.stop=content(await connection.client.callTool({name:'software_stop',arguments:{operationId}}));}
    catch(error){row.stopError=String(error.message);}
  }
  const child=connection.child;let timer;
  await Promise.race([connection.client.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('MCP close timeout')),20000);})]).finally(()=>clearTimeout(timer));
  for(let n=0;n<100&&child?.exitCode===null&&child.signalCode===null;n++)await delay(100);
  row.exitCode=child?.exitCode;row.signalCode=child?.signalCode;row.stderr=connection.stderr();
  row.cleanExit=row.exitCode===0&&row.signalCode===null&&row.stderr==='';
  await save(path.join(output,'mcp-'+connection.label+'-stderr.txt'),row.stderr);
}
async function cleanup() {
  if(monitor)clearInterval(monitor);
  for(const connection of [...clients].reverse())try{await closeClient(connection);}catch(error){record.cleanup.clientCloseError=String(error.message);}
  record.cleanup.mcpClientsExited=record.clients.every(row=>row.cleanExit===true);
  if(emulatorOwned()) {
    try {
      if(originalIme&&originalIme!=='null'){
        await sh('ime','set',originalIme);record.cleanup.originalImeRestored=(await sh('settings','get','secure','default_input_method')).stdout.trim()===originalIme;
      } else record.cleanup.originalImeRestored=!imeInstalled;
      if(imeInstalled)await sh('ime','disable',component);
      if(appInstalled)record.cleanup.fixtureUninstalled=(await device('uninstall',app)).stdout.includes('Success');
      if(imeInstalled)record.cleanup.imeUninstalled=(await device('uninstall',imeApp)).stdout.includes('Success');
    } catch(error){record.cleanup.deviceCleanupError=String(error.message);}
    await run(adb,['-P',String(ownedAdbPort),'-s',serial,'emu','kill'],{allowFailure:true,timeout:15000});
    for(let n=0;n<100&&emulatorOwned();n++)await delay(100);
    if(emulatorOwned()){process.kill(emulatorReceipt.pid,'SIGTERM');for(let n=0;n<50&&emulatorOwned();n++)await delay(100);}
    if(emulatorOwned()){process.kill(emulatorReceipt.pid,'SIGKILL');await delay(200);}
  }
  record.cleanup.emulatorStopped=emulatorReceipt?!emulatorOwned():true;
  if(emulatorReceipt) {
    record.cleanup.ownedEmulatorPortsClosed=await availablePort(emulatorReceipt.port)&&await availablePort(emulatorReceipt.port+1);
    if(record.cleanup.emulatorStopped&&record.cleanup.ownedEmulatorPortsClosed&&emulatorReceipt.avd.startsWith(output+path.sep)) {
      await rm(emulatorReceipt.avd,{recursive:true,force:true});await rm(path.join(emulatorReceipt.avdHome,emulatorReceipt.name+'.ini'),{force:true});
      record.cleanup.ownedAvdDataRemoved=!existsSync(emulatorReceipt.avd);
    }
  }
  if(ownedAdbPort){await run(adb,['-P',String(ownedAdbPort),'kill-server'],{timeout:10000,allowFailure:true});
    record.cleanup.ownedAdbPortClosed=await availablePort(ownedAdbPort);}
  record.cleanup.existingAvdConfigsUnchanged=JSON.stringify(await avdSnapshot())===JSON.stringify(originalAvds);
  const productionAfter=await filesSnapshot(Object.keys(productionRows)),sourceAfter=await sourceSnapshot();
  const unicodeImeAfter=await unicodeImeSourceSnapshot();
  await save(path.join(output,'source-after.json'),{production:productionAfter,newFixtureAndHarness:sourceAfter,
    buildDependencies:{unicodeIme:unicodeImeAfter}});
  record.cleanup.productionUnchanged=JSON.stringify(productionBefore)===JSON.stringify(productionAfter);
  record.cleanup.newSourceUnchanged=JSON.stringify(sourceBefore)===JSON.stringify(sourceAfter);
  record.cleanup.unicodeImeSourceUnchanged=JSON.stringify(unicodeImeBefore)===JSON.stringify(unicodeImeAfter);
  record.sourceAfter={productionSha256:digest(JSON.stringify(productionAfter)),newSha256:digest(JSON.stringify(sourceAfter)),
    unicodeImeSha256:digest(JSON.stringify(unicodeImeAfter))};
  record.availableBytesAfter=await freeSpace('after_cleanup');
  const required=['mcpClientsExited','emulatorStopped','ownedEmulatorPortsClosed','ownedAvdDataRemoved','ownedAdbPortClosed',
    'originalImeRestored','fixtureUninstalled','imeUninstalled','existingAvdConfigsUnchanged','productionUnchanged','newSourceUnchanged',
    'unicodeImeSourceUnchanged'];
  if(record.status==='passed'&&required.some(key=>record.cleanup[key]!==true)){record.status='failed';record.error={message:'Required cleanup verification failed'};}
}
async function main() {
  assert.ok(!existsSync(output),'Use a fresh output directory; no automatic device or UI reuse');
  await mkdir(output,{recursive:true,mode:0o700});await mkdir(path.join(output,'tmp'),{mode:0o700});
  originalAvds=await avdSnapshot();record.existingAvdConfigsBefore=originalAvds;
  try {
    await freeSpace('entry',14*2**30);await sourceFreeze();
    const apk=path.join(output,'native-branch.apk'),imeApk=path.join(output,'unicode-ime.apk');
    await run(python,[path.join(root,'apk_tools/examples/native-branch-android/build.py'),'--out',apk,'--sdk',sdk]);
    await run(python,[path.join(root,'apk_tools/examples/unicode-ime/build.py'),'--out',imeApk,'--sdk',sdk]);
    log('build_complete',{appSha256:digest(await readFile(apk)),imeSha256:digest(await readFile(imeApk)),sourceFreeze:record.sourceFreeze});
    await startEmulator();await acceptance(apk,imeApk);
  } catch(error) {
    record.status='failed';record.error={message:String(error.message),stack:String(error.stack)};log('failed',{message:record.error.message.slice(0,1500)});
    if(appInstalled&&emulatorOwned()) {
      try{await ledger('failure_independent_actual');}catch(error){record.failureLedgerError=String(error.message);}
      try{await captureUi('failed');}catch(error){record.failureUiError=String(error.message);}
      for(const name of ['activity','input_method'])try{await save(path.join(output,'failed-'+name+'.txt'),(await sh('dumpsys',name)).stdout);}catch{}
    }
  } finally {
    try{await cleanup();}catch(error){record.cleanup.error=String(error.message);record.status='failed';}
    record.finishedAt=new Date().toISOString();await save(path.join(output,'report.json'),record);
    await save(path.join(output,'report.md'),'# Android 原生两路径实际验收\n\n状态：'+record.status+'\n\n'+JSON.stringify({
      positiveBusinessCount:record.positiveBusinessEntries?.length,negatives:record.negatives,cleanup:record.cleanup,
      sourceFreeze:record.sourceFreeze,availableBytesAfter:record.availableBytesAfter,error:record.error},null,2)+'\n');
    await protectArtifacts(output);log('finished',{status:record.status,cleanup:record.cleanup,availableBytesAfter:record.availableBytesAfter});
    if(record.status!=='passed')process.exitCode=1;
  }
}
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
await main();
