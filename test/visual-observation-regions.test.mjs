import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,readFile,realpath,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {PNG} from 'pngjs';
import {observeImage} from '../src/visual-observation.js';
import {temp} from './helpers.mjs';

const token=(text,confidence,x,y,width=20,height=10)=>({text,confidence,bounds:{x,y,width,height}});
const regions=[{x:.05,y:.05,width:.3,height:.2},{x:.55,y:.05,width:.35,height:.2}];
async function fixture(t,patch={}){
 const dir=await realpath(temp(t)),imagePath=path.join(dir,'source.png'),executable=path.join(dir,'engine.mjs'),calls=path.join(dir,'calls.jsonl'),cfg=path.join(dir,'engine.json');
 const png=new PNG({width:100,height:100});png.data.fill(255);await writeFile(imagePath,PNG.sync.write(png));
 const settings={full:[token('Query',.5,10,10),token('北京',.5,60,10),token('OUTSIDE',.2,10,70),token('CROSS',1,85,10,15)],roi:{'.05':[token('Query',1,10,10)],'.55':[token('北京',1,60,10)]},...patch};await writeFile(cfg,JSON.stringify(settings));
 await writeFile(executable,`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2),c=JSON.parse(fs.readFileSync(${JSON.stringify(cfg)}));if(a[0]==='--list-langs'){console.log('eng');process.exit(0)}fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');let region=a[2]==='--region'?JSON.parse(a[3]):null;if(region&&c.delayRegion)await new Promise(r=>setTimeout(r,c.delayRegion));const key=region?String(region.x).replace(/^0/,''):null;console.log(JSON.stringify({width:100,height:100,tokens:region?(c.roi[key]||[]):c.full,...(region?{region:c.wrongRegion?{...region,x:.9}:region}:{})}));`,{mode:0o700});
 return {dir,calls,cfg,imagePath,settings,invoke:extra=>observeImage({imagePath,outputDir:path.join(dir,'ocr'),engine:{type:'vision',executable,regions},language:'eng',timeoutMs:5000,...extra}),executable};
}
test('same-image ROI refines identical spelling, retains outside/boundary evidence and preserves original SHA',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),before=await readFile(f.imagePath),result=await f.invoke();
 assert.deepEqual(await readFile(f.imagePath),before);assert.equal(result.coordinateSpace,'image_pixels');
 assert(result.tokens.some(t=>t.text==='Query'&&t.confidence===1&&t.ocrSource==='region'));
 assert(result.tokens.some(t=>t.text==='北京'&&t.confidence===1));
 for(const name of ['OUTSIDE','CROSS'])assert.deepEqual(result.tokens.find(t=>t.text===name).bounds,f.settings.full.find(t=>t.text===name).bounds);
 const artifact=JSON.parse(await readFile(result.artifactPath));assert.deepEqual(artifact.regionalEvidence.fullImageTokens,f.settings.full);assert.equal(artifact.regionalEvidence.regions.length,2);assert(!('regionalEvidence'in result));assert.equal(result.regionalOcr.boundaryTokensRetained,true);
 const calls=(await readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,3);assert(calls.every(args=>args[0]===calls[0][0]));
});
test('no regions preserves default Vision arguments, tokens and artifact shape',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t);const result=await f.invoke({engine:{type:'vision',executable:f.executable}});assert.deepEqual(result.tokens,f.settings.full);assert.equal(result.regionalOcr,undefined);assert.deepEqual(JSON.parse(await readFile(result.artifactPath)),result);const calls=(await readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);assert.equal(calls[0].length,2);
});
test('untrusted shape, overlap, no-pixel regions and extra engine options reject before OCR',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t);
 for(const bad of [[],Array(9).fill(regions[0]),[null],[{...regions[0],x:';touch'}],[{...regions[0],evil:true}],[{...regions[0],width:0}],[{...regions[0],x:1,width:Number.MIN_VALUE}],[regions[0],regions[0]],[{x:.001,y:0,width:.003,height:.1},{x:.004,y:0,width:.003,height:.1}]])await assert.rejects(f.invoke({engine:{type:'vision',executable:f.executable,regions:bad}}),e=>['OCR_CONFIG_INVALID','OCR_REGION_OVERLAP'].includes(e.code));
 assert(!existsSync(f.calls));
 await assert.rejects(f.invoke({engine:{type:'tesseract',executable:f.executable,regions}}),{code:'OCR_CONFIG_INVALID'});
});
test('different spelling inside or across a trusted region cannot create a new anchor',{skip:process.platform!=='darwin'},async t=>{
 for(const full of [[token('NotQuery',1,0,10,30)], [token('Wrong',.5,10,10)]]){
  const f=await fixture(t,{full});await assert.rejects(f.invoke(),{code:'OCR_REGION_CONFLICT'});
  const files=(await readdir(path.join(f.dir,'ocr'))).filter(file=>file.endsWith('.json'));assert.equal(files.length,1);const rejected=JSON.parse(await readFile(path.join(f.dir,'ocr',files[0])));assert.equal(rejected.status,'rejected');assert.deepEqual(rejected.regionalEvidence.fullImageTokens,full);
 }
});
test('ROI confirmation, combined token/output bounds and one total deadline are mandatory',{skip:process.platform!=='darwin'},async t=>{
 let f=await fixture(t,{wrongRegion:true});await assert.rejects(f.invoke(),{code:'OCR_REGION_OUTPUT_INVALID'});
 f=await fixture(t);await assert.rejects(f.invoke({maxTokens:5}),{code:'OCR_TOKEN_LIMIT'});
 f=await fixture(t);await assert.rejects(f.invoke({maxOutputBytes:128}),{code:'OCR_OUTPUT_LIMIT'});
 f=await fixture(t,{delayRegion:500});await assert.rejects(f.invoke({timeoutMs:150}),{code:'OCR_TIMEOUT'});
});

test('regional OCR cannot split one full-image word into a new exact anchor',{skip:process.platform!=='darwin'},async t=>{
 for(const [x,confidence]of [[10,1],[0,1],[10,.5]]){
  const full=[token('NotQuery',confidence,x,10,30)],f=await fixture(t,{full,roi:{'.05':[token('Not',1,10,10,8),token('Query',1,18,10,12)]}});
  await assert.rejects(f.invoke(),{code:'OCR_REGION_CONFLICT'});
  const file=(await readdir(path.join(f.dir,'ocr'))).find(name=>name.endsWith('.json'));const artifact=JSON.parse(await readFile(path.join(f.dir,'ocr',file)));assert.deepEqual(artifact.regionalEvidence.fullImageTokens,full);assert.equal(artifact.status,'rejected');
 }
});

test('a true one-pixel regional token extension is not accepted as confidence refinement',{skip:process.platform!=='darwin'},async t=>{
 const full=[token('Query',.5,4,10,20)],f=await fixture(t,{full,roi:{'.05':[token('Query',1,4,10,20)]}});
 const result=await f.invoke();
 assert.deepEqual(result.tokens,[{...full[0],ocrSource:'full_image'}]);
 const artifact=JSON.parse(await readFile(result.artifactPath));
 assert.deepEqual(artifact.regionalEvidence.fullImageTokens,full);
 assert.equal(artifact.regionalEvidence.regions[0].tokens[0].confidence,1);
 assert.equal(artifact.regionalEvidence.regions[0].tokens[0].bounds.x,4);
});
