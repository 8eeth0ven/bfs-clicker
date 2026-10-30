// Capture is tied to a trusted device configuration; OCR does not grant actions.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {observeImage} from './visual-observation.js';
import {PROJECT_ROOT} from './config.js';
const fail=(code,message)=>Object.assign(new Error(message),{code});
export async function observeNativeImage({deviceConfigPath,outputDir,python,engine,language='eng',signal,timeoutMs=60000}={}){
 if(!path.isAbsolute(deviceConfigPath||'')||!path.isAbsolute(outputDir||'')||!path.isAbsolute(python||'')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw fail('VISUAL_CONFIG_INVALID','需要可信绝对路径与有界超时');
 const start=Date.now(),captureDir=path.join(outputDir,'capture');
 const captured=await new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(fail('CANCELLED','任务已取消'));
  const child=spawn(python,['-m','apk_inventory.mobile_visual','--config',deviceConfigPath,'--output',captureDir],{cwd:PROJECT_ROOT,env:{...process.env,PYTHONPATH:path.join(PROJECT_ROOT,'apk_tools'),PYTHONUNBUFFERED:'1'},stdio:['ignore','pipe','pipe']});let stdout='',reason=null,forced;
  const stop=code=>{reason??=code;child.kill('SIGTERM');forced??=setTimeout(()=>child.kill('SIGKILL'),2000);};
  const abort=()=>stop('CANCELLED');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>stop('VISUAL_CAPTURE_TIMEOUT'),timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>65536)stop('VISUAL_CAPTURE_LIMIT');});child.stderr.resume();
  let spawnError=null;child.on('error',error=>{spawnError=error;});child.on('close',code=>{clearTimeout(timer);clearTimeout(forced);signal?.removeEventListener('abort',abort);if(reason)return reject(fail(reason,'设备截图未完成'));if(spawnError)return reject(fail('VISUAL_CAPTURE_FAILED','无法启动设备截图'));let result;try{result=JSON.parse(stdout);}catch{return reject(fail('VISUAL_CAPTURE_FAILED','设备截图响应无效'));}if(code!==0||result.ok===false)return reject(fail(result.error?.code||'VISUAL_CAPTURE_FAILED','设备截图未完成'));resolve(result);});
 });
 if(signal?.aborted)throw fail('CANCELLED','任务已取消');const remaining=timeoutMs-(Date.now()-start);if(remaining<=0)throw fail('VISUAL_CAPTURE_TIMEOUT','设备截图耗尽预算');
 const ocr=await observeImage({imagePath:captured.imagePath,outputDir:path.join(outputDir,'ocr'),engine,language,signal,timeoutMs:Math.min(120000,remaining)});
 if(ocr.imageSha256!==captured.imageSha256||ocr.width!==captured.width||ocr.height!==captured.height)throw fail('VISUAL_IMAGE_CHANGED','设备截图与 OCR 输入不一致');
 return {schemaVersion:1,source:captured.source,provenance:'device_screenshot_and_local_ocr',untrusted:true,coordinateSpace:'image_pixels',capturedAt:captured.capturedAt,width:ocr.width,height:ocr.height,imageSha256:ocr.imageSha256,tokens:ocr.tokens,gaps:[...captured.gaps,...ocr.gaps],artifactVerification:captured.artifactVerification,appArtifactVerified:captured.appArtifactVerified,privateArtifacts:{capture:captured.imagePath,ocr:ocr.artifactPath}};
}
