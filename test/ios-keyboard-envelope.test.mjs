import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync,realpathSync,symlinkSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import CrcCalculator from 'pngjs/lib/crc.js';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import * as calibration from './ios-keyboard-envelope.mjs';

const valueRegion={x:.1,y:.1,width:.8,height:.1},resultRegion={x:.1,y:.35,width:.8,height:.1};
function fixture(t){
 const dir=mkdtempSync(path.join(realpathSync(tmpdir()),'bfs-shell-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const before=path.join(dir,'before.png'),visible=path.join(dir,'visible.png'),source=path.join(dir,'source.xml');
 const a=new PNG({width:100,height:200});a.data.fill(255);writeFileSync(before,PNG.sync.write(a));
 const make=(extra)=>{const b=PNG.sync.read(PNG.sync.write(a));for(let y=125;y<200;y++)for(let x=0;x<100;x++){const i=(y*100+x)*4;b.data[i]=180;b.data[i+1]=180;}if(extra){const i=(extra[1]*100+extra[0])*4;b.data[i]=0;}writeFileSync(visible,PNG.sync.write(b));};make();
 writeFileSync(source,'<AppiumAUT><Keyboard/></AppiumAUT>');
 const options={valueRegion,resultRegion,sourceRegion:{x:0,y:.65,width:1,height:.25},geometry:{x:0,y:0,width:100,height:200},visibleSourcePath:source,
  approval:{appId:'com.example.fixture',visualEnvelope:{x:0,y:125,width:100,height:75}}};
 return {before,visible,source,options,make};
}
test('split calibration requires explicit owner bounds and does not change legacy refusal',t=>{
 const f=fixture(t);assert.throws(()=>calibration.keyboardEnvelope(f.before,f.visible,f.options),/CALIBRATION_UNRELATED_PIXELS_CHANGED/);
 const p=calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options);
 assert.equal(p.authorization,false);assert.equal(p.geometryEvidence.authority,'local_config');assert.equal(p.changedPixels,7500);
 assert.deepEqual(p.geometryEvidence.keyPlane,{x:0,y:130,width:100,height:50});
 assert.deepEqual(p.region,{x:0,y:.625,width:1,height:.375});
 assert.equal(p.geometryEvidence.calibration.visibleSourceSha256.length,64);
});
test('split calibration rejects any change outside explicit shell including both ROIs',t=>{
 const f=fixture(t);
 for(const point of [[2,2],[20,25],[20,75],[10,124]]){f.make(point);assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options),/CALIBRATION_UNRELATED_PIXELS_CHANGED/);}
});
test('split calibration rejects unapproved or broad geometry without auto-expansion',t=>{
 const f=fixture(t);
 for(const r of [null,{x:0,y:99,width:100,height:101},{x:0,y:126,width:100,height:74},{x:0,y:125,width:100,height:76},{x:1,y:125,width:99,height:75}]){
  assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,{...f.options,approval:{appId:'com.example.fixture',visualEnvelope:r}}));
 }
 assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,{...f.options,approval:{...f.options.approval,authority:'mcp'}}));
});
test('split calibration never accepts no-change, changed dimensions, symlink or FIFO originals',t=>{
 const f=fixture(t);
 writeFileSync(f.visible,readFileSync(f.before));assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options),/CALIBRATION_KEYBOARD_UNVERIFIED/);
 const small=new PNG({width:100,height:199});small.data.fill(255);writeFileSync(f.visible,PNG.sync.write(small));
 assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options),/CALIBRATION_DIMENSIONS_CHANGED/);
 const link=f.before+'.link';symlinkSync(f.before,link);assert.throws(()=>calibration.approvedKeyboardEnvelope(link,f.visible,f.options));
 if(process.platform!=='win32'){
  const fifo=f.before+'.fifo';execFileSync('mkfifo',[fifo]);const start=performance.now();
  assert.throws(()=>calibration.approvedKeyboardEnvelope(fifo,f.visible,f.options));assert(performance.now()-start<1000);
 }
});
test('approved frame validation, decode and encoded SHA consume one identical bounded snapshot',()=>{
 const source=readFileSync(new URL('./ios-keyboard-envelope.mjs',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('function frame(file){'),source.indexOf('\nfunction rect('));
 let snapshots=0;const checked={width:100,height:200,data:Buffer.alloc(80000),imageSha256:'a'.repeat(64)};
 const result=vm.runInNewContext(body+'\nframe("owned-image");',{
  decodeBoundedPngSnapshot(file){assert.equal(file,'owned-image');snapshots++;return checked;},
  boundedOriginal(){throw Error('separate unvalidated read forbidden');},visualPixelFingerprint(){throw Error('path-reopen validation forbidden');},
  PNG:{sync:{read(){throw Error('independent decode forbidden');}}},sha(){throw Error('independent encoded digest forbidden');},invalid(){throw Error('invalid');},
 });
 assert.equal(snapshots,1);assert.equal(result.decoded,checked);assert.equal(result.imageSha256,checked.imageSha256);
});
test('approved snapshot rejects oversized pixel headers and broken streams before pngjs decode',t=>{
 const f=fixture(t),bytes=readFileSync(f.before),original=PNG.sync.read;let decodes=0;
 PNG.sync.read=(...args)=>{decodes++;return original(...args);};
 try{
  const huge=Buffer.from(bytes);huge.writeUInt32BE(17000,16);huge.writeUInt32BE(CrcCalculator.crc32(huge.subarray(12,29))>>>0,29);writeFileSync(f.before,huge);
  assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options),{code:'VISUAL_PIXELS_INVALID'});assert.equal(decodes,0);
  const damaged=Buffer.from(bytes);damaged[damaged.length-1]^=1;writeFileSync(f.before,damaged);
  assert.throws(()=>calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options),{code:'VISUAL_PIXELS_INVALID'});assert.equal(decodes,0);
 }finally{PNG.sync.read=original;}
 f.make();writeFileSync(f.before,bytes);const p=calibration.approvedKeyboardEnvelope(f.before,f.visible,f.options);
 assert.equal(p.geometryEvidence.calibration.beforeImageSha256,createHash('sha256').update(bytes).digest('hex'));
});
test('original seventeenth frame pair stays legacy-red and explicit owner proposal is only offline-green',t=>{
 const run=path.resolve('output-vision-implementation/ios-key-sampling-compiler17-seventeenth-postfix-source-20261102/output-vision-implementation/ios-keyboard-compiler17-seventeenth-20261102');
 if(!existsSync(path.join(run,'calibration-before.png'))){t.skip('private archived images absent');return;}
 const before=path.join(run,'calibration-before.png'),visible=path.join(run,'calibration-keyboard.png');
 const opts={valueRegion:{x:.05,y:.2,width:.9,height:.08},resultRegion:{x:.05,y:.47,width:.9,height:.12},sourceRegion:{x:0,y:590/874,width:1,height:226/874},geometry:{x:0,y:0,width:402,height:874},
  visibleSourcePath:path.join(run,'calibration-visible.xml'),approval:{appId:'com.example.bfsmcp.iosvisualkeyboard',visualEnvelope:{x:0,y:572,width:402,height:302}}};
 assert.throws(()=>calibration.keyboardEnvelope(before,visible,opts),/CALIBRATION_UNRELATED_PIXELS_CHANGED/);
 const p=calibration.approvedKeyboardEnvelope(before,visible,opts);assert.equal(p.changedPixels,597837);assert.equal(p.authorization,false);
 assert.deepEqual(p.geometryEvidence.keyPlane,{x:0,y:590,width:402,height:226});
 assert.throws(()=>calibration.approvedKeyboardEnvelope(before,visible,{...opts,approval:{...opts.approval,visualEnvelope:{x:0,y:573,width:402,height:301}}}),/CALIBRATION_UNRELATED_PIXELS_CHANGED/);
});
