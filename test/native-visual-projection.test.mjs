import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {observeNativeImage} from '../src/native-visual-observation.js';
test('public native observation projects text, confidence and bounds without private native spans or raw text',async t=>{
 const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'bfs-native-projection-')));t.after(()=>rm(dir,{recursive:true,force:true}));const png=new PNG({width:100,height:100});png.data.fill(255);const bytes=PNG.sync.write(png),imagePath=path.join(dir,'capture.png');await writeFile(imagePath,bytes);
 const capture={source:{id:'test',kind:'ios'},capturedAt:'2026-01-01T00:00:00Z',width:100,height:100,imageSha256:createHash('sha256').update(bytes).digest('hex'),imagePath,gaps:[],artifactVerification:{status:'verified'},appArtifactVerified:true};
 const python=path.join(dir,'capture.mjs');await writeFile(python,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(capture))});\n`,{mode:0o700});
 const executable=path.join(dir,'ocr.mjs'),header='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',raw=header+'\n1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t\n5\t1\t1\t1\t1\t1\t10\t10\t10\t10\t90\t上\n5\t1\t1\t1\t1\t2\t30\t10\t10\t10\t85\t海\n';
 await writeFile(executable,`#!${process.execPath}\nimport fs from 'node:fs';if(process.argv.includes('--list-langs'))console.log('eng');else{const base=process.argv[3];fs.writeFileSync(base+'.tsv',${JSON.stringify(raw)});fs.writeFileSync(base+'.txt','上海\\n');}\n`,{mode:0o700});
 const result=await observeNativeImage({deviceConfigPath:path.join(dir,'device.json'),outputDir:path.join(dir,'observation'),python,engine:{type:'tesseract',executable,nativeText:true}});
 assert.deepEqual(result.tokens,[{text:'上海',confidence:.85,bounds:{x:10,y:10,width:30,height:10}}]);assert.equal(result.nativeTextEvidence,undefined);assert(!JSON.stringify(result).includes('nativeTextSpan'));assert(!JSON.stringify(result).includes('unicode_codepoints'));
});
