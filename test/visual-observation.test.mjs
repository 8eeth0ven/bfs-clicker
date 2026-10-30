import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,symlink,realpath,chmod,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {chromium} from 'playwright';
import {observeImage} from '../src/visual-observation.js';
import {temp} from './helpers.mjs';

async function canvasImage(t,dir,scale=1,format='png') {
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:900,height:300},deviceScaleFactor:scale});await page.setContent('<canvas width="900" height="300"></canvas>');
 await page.locator('canvas').evaluate(canvas=>{const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,900,300);context.fillStyle='black';context.font='bold 48px Arial';context.fillText('CANVAS SEARCH',50,90);context.font='36px Arial';context.fillText('RESULT DELTA 42',50,200);});assert.equal(await page.locator('body').innerText(),'');const file=path.join(dir,`canvas-${scale}.${format}`);await page.locator('canvas').screenshot({path:file,type:format});return file;
}
test('real canvas screenshot OCR returns verifiable text and pixel bounds at two resolutions and JPEG',async t=>{
 const dir=await realpath(temp(t));
 for(const [scale,format]of [[1,'png'],[2,'png'],[1,'jpeg']]){const imagePath=await canvasImage(t,dir,scale,format),result=await observeImage({imagePath,outputDir:path.join(dir,'ocr'),language:'eng'});assert.equal(result.width,900*scale);assert.equal(result.height,300*scale);assert.equal(result.provenance,'local_ocr');assert.equal(result.untrusted,true);assert.match(result.tokens.map(token=>token.text).join(' '),/CANVAS SEARCH.*RESULT DELTA 42/);for(const token of result.tokens){assert(token.confidence>=0&&token.confidence<=1);assert(token.bounds.x>=0&&token.bounds.y>=0&&token.bounds.x+token.bounds.width<=result.width&&token.bounds.y+token.bounds.height<=result.height);}assert.deepEqual(JSON.parse(await readFile(result.artifactPath,'utf8')),result);assert.equal(result.coordinateSpace,'image_pixels');}
});
test('language, input, pixel, output and token bounds reject explicitly without pretending OCR succeeded',async t=>{
 const dir=await realpath(temp(t)),imagePath=await canvasImage(t,dir),outputDir=path.join(dir,'ocr'),invoke=extra=>observeImage({imagePath,outputDir,...extra});
 await assert.rejects(invoke({language:'missing_language_987'}),{code:'OCR_LANGUAGE_UNAVAILABLE'});
 await assert.rejects(invoke({language:'eng;touch'}),{code:'OCR_CONFIG_INVALID'});
 await assert.rejects(invoke({maxPixels:10}),{code:'OCR_IMAGE_LIMIT'});
 await assert.rejects(invoke({maxImageBytes:16}),{code:'OCR_IMAGE_LIMIT'});
 await assert.rejects(invoke({maxOutputBytes:128}),{code:'OCR_OUTPUT_LIMIT'});
 await assert.rejects(invoke({maxTokens:1}),{code:'OCR_TOKEN_LIMIT'});
 await assert.rejects(invoke({engine:{type:'remote'}}),{code:'OCR_CONFIG_INVALID'});
 await assert.rejects(invoke({engine:{type:'tesseract',executable:'/missing/ocr'}}),{code:'OCR_ENGINE_UNAVAILABLE'});
 const invalid=path.join(dir,'bad.png');await writeFile(invalid,'not an image');await assert.rejects(invoke({imagePath:invalid}),{code:'OCR_IMAGE_INVALID'});
 const linked=path.join(dir,'link.png');await symlink(imagePath,linked);await assert.rejects(invoke({imagePath:linked}),{code:'OCR_PATH_SYMLINK'});
 const ancestor=path.join(dir,'linked-dir');await symlink(dir,ancestor);await assert.rejects(invoke({imagePath:path.join(ancestor,path.basename(imagePath))}),{code:'OCR_PATH_SYMLINK'});
 await assert.rejects(invoke({outputDir:ancestor}),{code:'OCR_PATH_SYMLINK'});
 await assert.rejects(invoke({imagePath:dir}),{code:'OCR_PATH_INVALID'});
});
test('actual OCR has a shared deadline and cancellation never returns successful artifacts',async t=>{
 const dir=await realpath(temp(t)),imagePath=await canvasImage(t,dir),outputDir=path.join(dir,'ocr'),controller=new AbortController();controller.abort();await assert.rejects(observeImage({imagePath,outputDir,signal:controller.signal}),{code:'OCR_CANCELLED'});
 await assert.rejects(observeImage({imagePath,outputDir,timeoutMs:1}),{code:'OCR_TIMEOUT'});
 const active=new AbortController();const pending=observeImage({imagePath,outputDir,signal:active.signal});setTimeout(()=>active.abort(),5);await assert.rejects(pending,{code:'OCR_CANCELLED'});
});

test('cancellation waits for an active configured engine process to exit',async t=>{
 const dir=await realpath(temp(t)),imagePath=await canvasImage(t,dir),outputDir=path.join(dir,'ocr'),marker=path.join(dir,'engine-pid'),wrapper=path.join(dir,'local-engine.py');
 let executable;
 for(const directory of (process.env.PATH||'').split(path.delimiter).filter(Boolean)){
  try{const candidate=await realpath(path.resolve(directory,'tesseract'));await access(candidate,constants.X_OK);executable=candidate;break;}catch{}
 }
 assert(executable,'This test requires an executable tesseract on PATH');
 await writeFile(wrapper,'#!/usr/bin/python3\nimport os,sys,time\nif "stdout" in sys.argv:\n open('+JSON.stringify(marker)+',"w").write(str(os.getpid()))\n time.sleep(30)\nos.execv('+JSON.stringify(executable)+',['+JSON.stringify(executable)+']+sys.argv[1:])\n');await chmod(wrapper,0o700);
 const controller=new AbortController(),pending=observeImage({imagePath,outputDir,engine:{type:'tesseract',executable:wrapper},signal:controller.signal});pending.catch(()=>{});let pid;
 for(let n=0;n<300&&!pid;n++){try{pid=Number(await readFile(marker,'utf8'));}catch{}if(!pid)await new Promise(resolve=>setTimeout(resolve,10));}
 assert(pid,'Configured engine did not start');controller.abort();await assert.rejects(pending,{code:'OCR_CANCELLED'});assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
