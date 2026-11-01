import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,writeFile,readFile,chmod,realpath,rm,readdir,stat} from 'node:fs/promises';
import os from 'node:os';
import {PNG} from 'pngjs';
import {observeImage} from '../src/visual-observation.js';
const header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const row=(text,i,{score=90,x=i*20,y=10,line=1,word=i+1}={})=>[5,1,1,1,line,word,x,y,10,10,score,text].join('\t');
const table=rows=>header+'\n1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t\n'+rows.join('\n')+'\n';
async function setup(t,tsv,text,{body,bufferText=false,bufferTsv=false,literalPath=false}={}){
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),literalPath?"bfs native '$; ":'bfs-native-text-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const imagePath=path.join(dir,'source.png'),png=new PNG({width:100,height:100});png.data.fill(255);await writeFile(imagePath,PNG.sync.write(png));
 const executable=path.join(dir,literalPath?"engine '$; $(touch SHOULD_NOT_EXIST).mjs":'engine.mjs');
 const data=(v,buffer)=>buffer?'Buffer.from('+JSON.stringify(v)+')':JSON.stringify(v);
 const code=body??`fs.writeFileSync(base+'.tsv',${data(tsv,bufferTsv)});fs.writeFileSync(base+'.txt',${data(text,bufferText)});`;
 await writeFile(executable,`#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv.includes('--list-langs')){console.log('eng');process.exit(0)}\nconst base=process.argv[3];if(base==='stdout'){process.stdout.write(${data(tsv,bufferTsv)});process.exit(0)}\n${code}\n`);await chmod(executable,0o700);
 return {dir,invoke:extra=>observeImage({imagePath,outputDir:path.join(dir,'ocr'),engine:{type:'tesseract',executable,nativeText:true},language:'eng',...extra}),executable};
}
test('independent native TXT+TSV preserves all original words and zero-separator runs',async t=>{
 const original='RESULT 上海\n',{invoke,dir}=await setup(t,table([row('RESULT',0),row('上',1,{score:92}),row('海',2,{score:89})]),original),result=await invoke();
 assert.deepEqual(result.tokens.map(x=>x.text),['RESULT','上海']);assert.equal(result.tokens[1].confidence,.89);assert.deepEqual(result.tokens[1].bounds,{x:20,y:10,width:30,height:10});assert.deepEqual(result.tokens[1].nativeTextSpan,{start:7,end:9,firstWord:1,lastWord:2});
 assert.equal(result.nativeTextEvidence.text,original);assert.deepEqual(result.nativeTextEvidence.words.map(x=>x.text),['RESULT','上','海']);assert.deepEqual(JSON.parse(await readFile(result.artifactPath,'utf8')),result);
 const nativeDir=path.join(dir,'ocr',(await readdir(path.join(dir,'ocr'))).find(x=>x.startsWith('native-')));assert.equal((await stat(nativeDir)).mode&0o777,0o700);for(const name of ['result.txt','result.tsv'])assert.equal((await stat(path.join(nativeDir,name))).mode&0o777,0o600);
});
test('native spaces, multiple spaces and newlines remain exact evidence',async t=>{
 for(const separator of [' ','  ','\n','\u3000']){const {invoke}=await setup(t,table([row('上',0),row('海',1,{line:separator==='\n'?2:1,word:separator==='\n'?1:2})]),'上'+separator+'海\n'),result=await invoke();assert.equal(result.nativeTextEvidence.text,'上'+separator+'海\n');assert.deepEqual(result.tokens.map(x=>x.text),['上','海']);}
});
test('NotQuery and Not搜索 remain complete native runs without suffix anchors',async t=>{
 for(const suffix of ['Query','搜索']){const {invoke}=await setup(t,table([row('Not',0),row(suffix,1)]),'Not'+suffix+'\n'),result=await invoke();assert.deepEqual(result.tokens.map(x=>x.text),['Not'+suffix]);}
});
test('independent files refuse prefixes, suffixes, punctuation, order and malformed TSV',async t=>{
 const normal=table([row('Query',0)]),cases=[[normal,'NotQuery\n'],[normal,'QueryNot\n'],[normal,'Query!\n'],[table([row('A',0),row('B',1)]),'B A\n'],[normal,''],[normal+header+'\n','Query\n'],[normal.replace('word_num','word_id'),'Query\n'],[table([row('A',0,{word:2}),row('B',1,{word:1})]),'A B\n'],[table([row('A',0),row('B',1,{word:1})]),'A B\n'],[table([row('A',0),row('B',1,{line:2,word:1})]),'AB\n'],[normal,'Query\u0000\n'],[normal+'2\t1\t1\t0\t0\t0\t0\t0\t100\t10\t-1\tNotQuery\n','Query\n']];
 for(const [tsv,text]of cases){const {invoke}=await setup(t,tsv,text);await assert.rejects(invoke(),{code:'OCR_NATIVE_TEXT_INVALID'});}
 for(const type of ['text','tsv']){const {invoke}=await setup(t,type==='tsv'?[...Buffer.from(normal),255]:normal,type==='text'?[...Buffer.from('Query\n'),255]:'Query\n',{bufferText:type==='text',bufferTsv:type==='tsv'});await assert.rejects(invoke(),{code:'OCR_NATIVE_TEXT_INVALID'});}
});
test('a TXT line that resembles a TSV hierarchy remains literal text',async t=>{
 const native='2\t1\t1\t0\t0\t0\t0\t0\t100\t10\t-1\tNotQuery\nQuery\n',values=native.trim().split(/\s+/),rows=values.map((v,i)=>row(v,i,{x:10,y:10,line:i===values.length-1?2:1,word:i===values.length-1?1:i+1})),{invoke}=await setup(t,table(rows),native),result=await invoke();assert.equal(result.nativeTextEvidence.text,native);assert(result.tokens.some(t=>t.text==='NotQuery'));
});
test('all original words are budgeted before confidence filtering',async t=>{
 const {invoke}=await setup(t,table([row('上',0),row('海',1,{score:30})]),'上海\n'),result=await invoke({minConfidence:.6});assert.equal(result.tokens.length,0);assert.equal(result.nativeTextEvidence.words.length,2);assert.equal(result.nativeTextEvidence.words[1].confidence,.3);await assert.rejects(invoke({maxTokens:1}),{code:'OCR_TOKEN_LIMIT'});await assert.rejects(invoke({maxOutputBytes:128}),{code:'OCR_OUTPUT_LIMIT'});
});
test('native files have inherited hard size limits, fixed literal argv and bounded time',async t=>{
 const {invoke}=await setup(t,table([]),'',{body:"fs.writeFileSync(base+'.txt',Buffer.alloc(3*1024*1024,32));fs.writeFileSync(base+'.tsv','bad');"});await assert.rejects(invoke(),{code:'OCR_ENGINE_FAILED'});await assert.rejects(invoke({timeoutMs:1}),{code:'OCR_TIMEOUT'});
 const literal=await setup(t,table([row('Query',0)]),'Query\n',{literalPath:true});assert.equal((await literal.invoke()).tokens[0].text,'Query');assert(!(await readdir(literal.dir)).includes('SHOULD_NOT_EXIST'));
});
test('missing, extra, symlink and nonregular renderer files fail closed',async t=>{
 for(const body of ["fs.writeFileSync(base+'.txt','Query');", "fs.writeFileSync(base+'.txt','Query');fs.writeFileSync(base+'.tsv','bad');fs.writeFileSync(base+'.extra','unexpected');"]){const {invoke}=await setup(t,'','',{body});await assert.rejects(invoke(),{code:'OCR_NATIVE_TEXT_INVALID'});}
 const {invoke}=await setup(t,'','',{body:"fs.writeFileSync(base+'.txt','Query');fs.symlinkSync(base+'.txt',base+'.tsv');"});await assert.rejects(invoke(),{code:'OCR_PATH_SYMLINK'});
 const dir=await setup(t,'','',{body:"fs.writeFileSync(base+'.txt','Query');fs.mkdirSync(base+'.tsv');"});await assert.rejects(dir.invoke(),{code:'OCR_PATH_INVALID'});
});
test('default and nativeText=false retain the original TSV contract',async t=>{
 const raw=table([row('上',0),row('海',1)]),{invoke,executable}=await setup(t,raw,'上海\n');for(const nativeText of [undefined,false]){const result=await invoke({engine:{type:'tesseract',executable,...(nativeText===undefined?{}:{nativeText})}});assert.deepEqual(result.tokens.map(x=>x.text),['上','海']);assert.equal(result.nativeTextEvidence,undefined);}
 await assert.rejects(invoke({engine:{type:'tesseract',executable,nativeText:'true'}}),{code:'OCR_CONFIG_INVALID'});await assert.rejects(invoke({engine:{type:'vision',executable,nativeText:true}}),{code:'OCR_CONFIG_INVALID'});
});
