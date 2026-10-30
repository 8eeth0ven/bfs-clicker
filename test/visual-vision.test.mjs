import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {realpath,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {observeImage} from '../src/visual-observation.js';
import {temp,root} from './helpers.mjs';

test('Apple Vision recognizes actual Chinese canvas text with pixel-accurate boxes and bounded language validation',{skip:process.platform!=='darwin',timeout:60000},async t=>{
 const dir=await realpath(temp(t)),executable=path.join(dir,'vision-ocr');execFileSync('/usr/bin/xcrun',['swiftc',path.join(root,'scripts/visual-vision.swift'),'-o',executable],{timeout:30000,stdio:'pipe'});
 const listed=execFileSync(executable,['--list-langs'],{encoding:'utf8'}).split(/\s+/);assert(listed.includes('chi_sim'));assert(listed.includes('eng'));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:900,height:320},deviceScaleFactor:2});await page.setContent('<canvas width="900" height="320"></canvas>');await page.locator('canvas').evaluate(canvas=>{const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,900,320);ctx.fillStyle='black';ctx.font='48px PingFang SC';ctx.fillText('搜索',50,90);ctx.fillText('查询结果',50,200);ctx.font='40px Arial';ctx.fillText('RESULT DELTA',420,200)});assert.equal(await page.locator('body').innerText(),'');
 const imagePath=path.join(dir,'chinese.png');await page.locator('canvas').screenshot({path:imagePath});const result=await observeImage({imagePath,outputDir:path.join(dir,'ocr'),engine:{type:'vision',executable},language:'chi_sim+eng',timeoutMs:30000});const text=result.tokens.map(t=>t.text).join(' ');assert.match(text,/搜索/);assert(result.tokens.some(token=>token.text==='查询结果'),JSON.stringify(result.tokens));assert.match(text,/RESULT/);assert.equal(result.width,1800);assert.equal(result.height,640);assert.equal(result.engine,'vision');assert.equal(result.provenance,'local_ocr');for(const token of result.tokens)assert(token.bounds.width>0&&token.bounds.height>0&&token.bounds.x+token.bounds.width<=result.width&&token.bounds.y+token.bounds.height<=result.height);assert.deepEqual(JSON.parse(await readFile(result.artifactPath,'utf8')),result);
 await assert.rejects(observeImage({imagePath,outputDir:path.join(dir,'bad'),engine:{type:'vision',executable},language:'not_installed',timeoutMs:10000}),{code:'OCR_LANGUAGE_UNAVAILABLE'});
});
