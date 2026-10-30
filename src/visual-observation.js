// Local screenshot evidence only. OCR never asserts a control's role or effect.
import path from 'node:path';
import {constants,existsSync} from 'node:fs';
import {lstat,mkdir,open,writeFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const integer=(value,min,max,name)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('OCR_CONFIG_INVALID',name+' exceeds supported limits');return value;};
async function checkedPath(input,{directory=false,missing=false}={}) {
 if(typeof input!=='string'||!path.isAbsolute(input)||input.includes('\0'))fail('OCR_PATH_INVALID','Absolute filesystem path required');
 const absolute=path.resolve(input),parts=absolute.split(path.sep);let cursor=path.parse(absolute).root;
 for(const part of parts.slice(1)){cursor=path.join(cursor,part);let stat;try{stat=await lstat(cursor);}catch(error){if(missing&&error.code==='ENOENT')continue;fail('OCR_PATH_INVALID','Path unavailable');}if(stat.isSymbolicLink())fail('OCR_PATH_SYMLINK','Symbolic links are not accepted');if(cursor!==absolute&&!stat.isDirectory())fail('OCR_PATH_INVALID','Non-directory ancestor');if(cursor===absolute&&!(directory?stat.isDirectory():stat.isFile()))fail('OCR_PATH_INVALID','Unexpected filesystem object');}
 return absolute;
}
function dimensions(data) {
 if(data.length>=33&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.readUInt32BE(8)===13&&data.toString('ascii',12,16)==='IHDR')return {format:'png',width:data.readUInt32BE(16),height:data.readUInt32BE(20)};
 if(data.length>=4&&data[0]===255&&data[1]===216){let offset=2;while(offset<data.length){if(data[offset++]!==255)break;while(data[offset]===255)offset++;const marker=data[offset++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;if(offset+2>data.length)break;const length=data.readUInt16BE(offset);if(length<2||offset+length>data.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return {format:'jpeg',height:data.readUInt16BE(offset+3),width:data.readUInt16BE(offset+5)};offset+=length;}}
 fail('OCR_IMAGE_INVALID','Only bounded PNG/JPEG screenshots are supported');
}
async function snapshot(input,maxBytes) {
 const file=await checkedPath(input),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size>maxBytes)fail('OCR_IMAGE_LIMIT','Screenshot exceeds byte budget');const buffer=Buffer.alloc(Math.min(stat.size+1,maxBytes+1));let size=0;while(size<buffer.length){const {bytesRead}=await handle.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}if(size>maxBytes||size!==stat.size)fail('OCR_IMAGE_CHANGED','Screenshot changed while reading');return buffer.subarray(0,size);}finally{await handle.close();}
}
function execute(executable,args,{remaining,signal,maxBytes}) {
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Object.assign(new Error('OCR cancelled'),{code:'OCR_CANCELLED'}));return;}
  let time;try{time=remaining();}catch(error){reject(error);return;}
  let child,settled=false,reason,stdout=[],stderr=[],size=0,errorBytes=0,killTimer;
  const stop=code=>{reason||=code;child?.kill('SIGTERM');killTimer??=setTimeout(()=>child?.kill('SIGKILL'),500);killTimer.unref();};
  try{child=spawn(executable,args,{shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,OMP_THREAD_LIMIT:'1'}});}catch{reject(Object.assign(new Error('Local OCR engine unavailable'),{code:'OCR_ENGINE_UNAVAILABLE'}));return;}
  const abort=()=>stop('OCR_CANCELLED');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>stop('OCR_TIMEOUT'),time);if(signal?.aborted)abort();
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)stop('OCR_OUTPUT_LIMIT');else stdout.push(chunk);});
  child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes>65536)stop('OCR_OUTPUT_LIMIT');else stderr.push(chunk);});
  child.on('error',()=>finish(Object.assign(new Error('Local OCR engine unavailable'),{code:'OCR_ENGINE_UNAVAILABLE'})));
  child.on('close',code=>{if(reason)return finish(Object.assign(new Error(reason),{code:reason}));if(code!==0)return finish(Object.assign(new Error('Local OCR engine failed'),{code:'OCR_ENGINE_FAILED'}));finish(null,Buffer.concat(stdout).toString('utf8'));});
 });
}
function visionTokens(value,image,region) {
 if(!value||value.width!==image.width||value.height!==image.height||!Array.isArray(value.tokens))fail('OCR_OUTPUT_INVALID','Vision dimensions disagree with screenshot');
 if(region&&(!value.region||Object.keys(value.region).sort().join(',')!=='height,width,x,y'||Object.keys(region).some(key=>value.region[key]!==region[key])))fail('OCR_REGION_OUTPUT_INVALID','Vision did not confirm the requested region');
 return value.tokens.map(item=>{const box=item?.bounds;if(!item||typeof item.text!=='string'||!item.text.trim()||item.text.length>4096||typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||!box||!['x','y','width','height'].every(key=>Number.isSafeInteger(box[key]))||box.x<0||box.y<0||box.width<=0||box.height<=0||box.x+box.width>image.width||box.y+box.height>image.height)fail('OCR_OUTPUT_INVALID','Invalid Vision text or coordinates');return {text:item.text,confidence:item.confidence,bounds:{x:box.x,y:box.y,width:box.width,height:box.height}};});
}
const intersects=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const contains=(a,b)=>b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height;
function ocrRegions(engine,image) {
 if(engine?.regions===undefined)return [];
 if(!Array.isArray(engine.regions)||engine.regions.length<1||engine.regions.length>8)fail('OCR_CONFIG_INVALID','Use one to eight trusted OCR regions');
 const result=engine.regions.map(region=>{if(!region||typeof region!=='object'||Array.isArray(region)||Object.keys(region).sort().join(',')!=='height,width,x,y'||Object.values(region).some(v=>typeof v!=='number'||!Number.isFinite(v))||region.x<0||region.y<0||region.width<=0||region.height<=0||region.x+region.width>1||region.y+region.height>1)fail('OCR_CONFIG_INVALID','Invalid trusted OCR region');const normalized={x:region.x,y:region.y,width:region.width,height:region.height},x=Math.floor(region.x*image.width),y=Math.floor(region.y*image.height),right=Math.ceil((region.x+region.width)*image.width),bottom=Math.ceil((region.y+region.height)*image.height);if(right<=x||bottom<=y)fail('OCR_CONFIG_INVALID','OCR region has no pixels');return {normalized,pixels:{x,y,width:right-x,height:bottom-y}};});
 for(let i=0;i<result.length;i++)for(let j=0;j<i;j++)if(intersects(result[i].pixels,result[j].pixels))fail('OCR_REGION_OVERLAP','Trusted OCR regions overlap in pixels');
 return result;
}
function combineVisionRegions(full,regional,minConfidence) {
 const replacements=new Set(),insertions=new Map(),sameTokens=(a,b)=>a.length===b.length&&a.every((token,i)=>token.text===b[i].text);
 for(let index=0;index<regional.length;index++){
  const pass=regional[index],inside=pass.tokens.filter(token=>contains(pass.pixels,token.bounds)),previous=full.filter(token=>contains(pass.pixels,token.bounds));
  // Preserve absence and all boundary evidence. A crop cannot silently choose
  // a different spelling from the same pixels, even at a higher confidence.
  if(!inside.length)continue;
  if(previous.length&&!sameTokens(previous,inside))fail('OCR_REGION_CONFLICT','Full image and regional OCR disagree');
  const cross=full.filter(token=>intersects(pass.pixels,token.bounds)&&!contains(pass.pixels,token.bounds));
  for(const token of cross){const overlaps=inside.filter(item=>intersects(token.bounds,item.bounds));if(overlaps.length&&!sameTokens([token],overlaps))fail('OCR_REGION_CONFLICT','Boundary text and regional OCR disagree');}
  let position=full.findIndex(token=>intersects(pass.pixels,token.bounds));if(position<0){position=full.findIndex(token=>token.bounds.y>=pass.pixels.y+pass.pixels.height);if(position<0)position=full.length;}
  const items=insertions.get(position)||[];items.push({index,pass,inside});insertions.set(position,items);
  full.forEach((token,i)=>{if(contains(pass.pixels,token.bounds))replacements.add(i)});
 }
 const result=[];
 for(let i=0;i<=full.length;i++){
  for(const item of (insertions.get(i)||[]).sort((a,b)=>a.pass.pixels.y-b.pass.pixels.y||a.pass.pixels.x-b.pass.pixels.x))for(const token of item.inside)if(token.confidence>=minConfidence)result.push({...token,ocrSource:'region',regionIndex:item.index});
  if(i<full.length&&!replacements.has(i)&&full[i].confidence>=minConfidence)result.push({...full[i],ocrSource:'full_image'});
 }
 return result;
}

/** Call only from a trusted capture/import boundary. Artifacts contain raw OCR. */
export async function observeImage({imagePath,outputDir,engine,language='eng',signal,timeoutMs=15000,maxImageBytes=16*1024*1024,maxPixels=16000000,maxTokens=2000,maxOutputBytes=1024*1024,minConfidence=0}={}) {
 integer(timeoutMs,1,120000,'timeoutMs');integer(maxImageBytes,1,32*1024*1024,'maxImageBytes');integer(maxPixels,1,32000000,'maxPixels');integer(maxTokens,1,5000,'maxTokens');integer(maxOutputBytes,128,4*1024*1024,'maxOutputBytes');
 if(typeof minConfidence!=='number'||!Number.isFinite(minConfidence)||minConfidence<0||minConfidence>1||typeof language!=='string'||!/^\w+(?:\+\w+)*$/.test(language)||language.length>128)fail('OCR_CONFIG_INVALID','Invalid OCR language/confidence');
 if(engine!==undefined&&(!engine||typeof engine!=='object'||Array.isArray(engine)||!['tesseract','vision'].includes(engine.type)||Object.keys(engine).some(key=>!(engine.type==='vision'?['type','executable','regions']:['type','executable','tessdataDir']).includes(key))||engine.type==='vision'&&process.platform!=='darwin'))fail('OCR_CONFIG_INVALID','Unsupported OCR engine');
 let executable=engine?.executable||(engine?.type==='vision'?null:existsSync('/opt/homebrew/bin/tesseract')?'/opt/homebrew/bin/tesseract':existsSync('/usr/bin/tesseract')?'/usr/bin/tesseract':null);
 if(!executable)fail('OCR_ENGINE_UNAVAILABLE','Configure a local tesseract executable');if(typeof executable!=='string'||!path.isAbsolute(executable))fail('OCR_CONFIG_INVALID','OCR executable must be an absolute path');try{executable=await realpath(executable);}catch{fail('OCR_ENGINE_UNAVAILABLE','Local OCR executable unavailable');}await checkedPath(executable); // Executable must be a real file, not a shell expression.
 if(engine?.executable!==undefined&&(typeof engine.executable!=='string'||!engine.executable))fail('OCR_CONFIG_INVALID','Invalid executable path');
 if(engine?.tessdataDir!==undefined&&(typeof engine.tessdataDir!=='string'||!engine.tessdataDir))fail('OCR_CONFIG_INVALID','Invalid OCR data directory');
 const started=Date.now(),remaining=()=>{if(signal?.aborted)fail('OCR_CANCELLED','OCR cancelled');const value=timeoutMs-(Date.now()-started);if(value<=0)fail('OCR_TIMEOUT','OCR budget exhausted');return value;};
 remaining();const data=await snapshot(imagePath,maxImageBytes),image=dimensions(data);if(!image.width||!image.height||image.width*image.height>maxPixels||image.width>16384||image.height>16384)fail('OCR_IMAGE_LIMIT','Screenshot exceeds pixel budget');
 const regions=ocrRegions(engine,image);remaining();const root=await checkedPath(outputDir,{directory:true,missing:true});await mkdir(root,{recursive:true,mode:0o700});await checkedPath(root,{directory:true});
 const engineArgs=engine?.tessdataDir?['--tessdata-dir',await checkedPath(engine.tessdataDir,{directory:true})]:[];
 const available=await execute(executable,[...engineArgs,'--list-langs'],{remaining,signal,maxBytes:65536});const languages=new Set(available.split(/\r?\n/).map(line=>line.trim()).filter(line=>/^\w+$/.test(line)));
 if(language.split('+').some(item=>!languages.has(item)))fail('OCR_LANGUAGE_UNAVAILABLE','Requested OCR language is not installed');
 const id=randomUUID(),privateImage=path.join(root,id+'.'+image.format),artifactPath=path.join(root,id+'.json');await writeFile(privateImage,data,{flag:'wx',mode:0o600});
 const raw=await execute(executable,engine?.type==='vision'?[privateImage,language]:[privateImage,'stdout',...engineArgs,'-l',language,'--psm','11','tsv'],{remaining,signal,maxBytes:4*1024*1024});remaining();
 let vision=null;if(engine?.type==='vision'){try{vision=JSON.parse(raw);}catch{fail('OCR_OUTPUT_INVALID','Invalid Vision JSON');}if(!vision||vision.width!==image.width||vision.height!==image.height||!Array.isArray(vision.tokens))fail('OCR_OUTPUT_INVALID','Vision dimensions disagree with screenshot');}
 const rows=vision?[]:raw.split(/\r?\n/);if(!vision&&rows.shift()!=='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext')fail('OCR_OUTPUT_INVALID','Invalid OCR TSV header');
 const tokens=[];let pageVerified=!!vision,filtered=0;
 if(vision)for(const item of vision.tokens){const box=item?.bounds;if(!item||typeof item.text!=='string'||!item.text.trim()||item.text.length>4096||typeof item.confidence!=='number'||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||!box||!['x','y','width','height'].every(key=>Number.isSafeInteger(box[key]))||box.x<0||box.y<0||box.width<=0||box.height<=0||box.x+box.width>image.width||box.y+box.height>image.height)fail('OCR_OUTPUT_INVALID','Invalid Vision text or coordinates');if(item.confidence<minConfidence){filtered++;continue;}if(tokens.length>=maxTokens)fail('OCR_TOKEN_LIMIT','OCR token budget exhausted');tokens.push({text:item.text,confidence:item.confidence,bounds:{x:box.x,y:box.y,width:box.width,height:box.height}});}

 for(const row of rows){if(!row)continue;const columns=row.split('\t');if(columns.length!==12)fail('OCR_OUTPUT_INVALID','Invalid OCR TSV row');const [level,page,block,paragraph,line,word,x,y,width,height,confidence]=columns.slice(0,11).map(Number),text=columns[11];if(![level,page,block,paragraph,line,word,x,y,width,height].every(Number.isSafeInteger)||![1,2,3,4,5].includes(level)||page!==1||[x,y,width,height].some(value=>value<0)||x+width>image.width||y+height>image.height||!Number.isFinite(confidence))fail('OCR_OUTPUT_INVALID','OCR coordinates disagree with screenshot');
  if(level===1){if(pageVerified||x||y||width!==image.width||height!==image.height)fail('OCR_OUTPUT_INVALID','OCR page dimensions disagree with screenshot');pageVerified=true;}
  if(level!==5||!text.trim())continue;if(confidence<0||confidence>100)fail('OCR_OUTPUT_INVALID','Invalid word confidence');if(confidence/100<minConfidence){filtered++;continue;}if(tokens.length>=maxTokens)fail('OCR_TOKEN_LIMIT','OCR token budget exhausted');tokens.push({text,confidence:confidence/100,bounds:{x,y,width,height}});
 }
 if(!pageVerified)fail('OCR_OUTPUT_INVALID','OCR did not verify screenshot dimensions');
 let regionalEvidence;
 if(regions.length){
  const full=visionTokens(vision,image),passes=[];let total=full.length;
  for(const region of regions){
   const rawRegion=await execute(executable,[privateImage,language,'--region',JSON.stringify(region.normalized)],{remaining,signal,maxBytes:4*1024*1024});remaining();let parsed;try{parsed=JSON.parse(rawRegion)}catch{fail('OCR_OUTPUT_INVALID','Invalid regional Vision JSON')}
   const observed=visionTokens(parsed,image,region.normalized);total+=observed.length;if(total>maxTokens)fail('OCR_TOKEN_LIMIT','Combined OCR token budget exhausted');passes.push({...region,tokens:observed});
  }
  regionalEvidence={fullImageTokens:full,regions:passes};let combined;
  try{combined=combineVisionRegions(full,passes,minConfidence)}catch(error){const failure=JSON.stringify({schemaVersion:1,status:'rejected',error:error.code,imageSha256:createHash('sha256').update(data).digest('hex'),width:image.width,height:image.height,regionalEvidence},null,2)+'\n';if(Buffer.byteLength(failure)<=maxOutputBytes)await writeFile(artifactPath,failure,{flag:'wx',mode:0o600});throw error}
  tokens.splice(0,tokens.length,...combined);
 }
 const result={schemaVersion:1,provenance:'local_ocr',untrusted:true,coordinateSpace:'image_pixels',engine:engine?.type||'tesseract',imageSha256:createHash('sha256').update(data).digest('hex'),width:image.width,height:image.height,language,tokens,gaps:['ocr_text_is_not_a_control_role','ocr_does_not_verify_business_outcomes',...(filtered?['low_confidence_tokens_omitted']:[]),...(!tokens.length?['no_text_recognized']:[])],artifactPath,imagePath:privateImage};
 if(regionalEvidence)result.regionalOcr={regions:regions.map(r=>r.normalized),fullImageTokenCount:regionalEvidence.fullImageTokens.length,regionalTokenCount:regionalEvidence.regions.reduce((n,r)=>n+r.tokens.length,0),boundaryTokensRetained:true,conflictsRejected:true};
 const serialized=JSON.stringify(regionalEvidence?{...result,regionalEvidence}:result,null,2)+'\n';if(Buffer.byteLength(serialized)>maxOutputBytes)fail('OCR_OUTPUT_LIMIT','OCR evidence exceeds output budget');remaining();await writeFile(artifactPath,serialized,{flag:'wx',mode:0o600});remaining();return result;
}
