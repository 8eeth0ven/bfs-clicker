// Internal bridge: consumes only a local, already captured image. No actions.
import {observeImage} from './visual-observation.js';
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Error('INPUT_LIMIT');}
try{const args=JSON.parse(raw);const result=await observeImage({...args,maxTokens:1000,maxOutputBytes:262144,timeoutMs:Math.max(1,Math.min(120000,args.timeoutMs))});const {privateArtifacts,artifactPath,imagePath,...evidence}=result;process.stdout.write(JSON.stringify(evidence));}catch(error){process.stderr.write(String(error.code||'OCR_FAILED'));process.exitCode=1;}
