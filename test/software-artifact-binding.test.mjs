import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createSoftwareRuntime} from '../src/software-runtime.js';
import {temp} from './helpers.mjs';

function fixture(t){
 const dir=temp(t),inventory=path.join(dir,'inventory'),mobile=path.join(dir,'mobile');mkdirSync(inventory);mkdirSync(mobile);
 const sha256='a'.repeat(64),sourceId='apk_demo';
 writeFileSync(path.join(inventory,'source.json'),JSON.stringify({format:'endpoint-inventory',schema_version:'1.1',kind:'apk',source_id:sourceId,inventory:'endpoints.json',app:{package_name:'com.example.demo',version_name:'1',apk_sha256:sha256,artifact_type:'apk'}}));
 writeFileSync(path.join(inventory,'endpoints.json'),'[]');writeFileSync(path.join(mobile,'recipes.json'),'{}');
 const proof={schemaVersion:1,source:{id:sourceId,kind:'apk',revision:'1'.repeat(64),appArtifactVerified:true,artifactVerification:{status:'verified',kind:'apk',expectedSha256:sha256,actualSha256:sha256},gaps:['app_artifact_not_verified','network_scope_not_enforced']},capabilities:[]};
 const save=()=>writeFileSync(path.join(mobile,'manifest.json'),JSON.stringify(proof));save();
 const runtime=createSoftwareRuntime({outputRoot:path.join(dir,'out'),artifactRoots:[dir]});
 return {runtime,proof,save,sourceId,compile:()=>runtime.compile({sourceId,kind:'apk',inventoryPath:inventory,mobileDir:mobile,deviceName:'test'})};
}

test('installed App proof only removes the artifact gap when it matches the static package hash',async t=>{
 const f=fixture(t),built=await f.compile();assert.equal(built.source.appArtifactVerified,true);
 assert(!built.source.gaps.some(gap=>(typeof gap==='string'?gap:gap.reason)==='app_artifact_not_verified'));
 assert(built.source.gaps.some(gap=>(typeof gap==='string'?gap:gap.reason).includes('network_scope_not_enforced')));
 f.proof.source.artifactVerification.actualSha256='b'.repeat(64);f.proof.source.revision='2'.repeat(64);f.save();
 await assert.rejects(f.compile(),/APP_ARTIFACT_IDENTITY_MISMATCH/);
 assert.equal(f.runtime.getSource(f.sourceId).revision,built.source.revision,'failed identity proof must not publish a generation');
});

test('unsupported device proof stays unverified, and a different UI source cannot attach to an APK',async t=>{
 const f=fixture(t);f.proof.source.appArtifactVerified=false;f.proof.source.artifactVerification={status:'unsupported',kind:'apk',reason:'installed_bytes_unavailable'};f.save();
 const built=await f.compile();assert.equal(built.source.appArtifactVerified,false);
 assert(built.source.gaps.some(gap=>(typeof gap==='string'?gap:gap.reason)==='app_artifact_not_verified'));
 f.proof.source.id='another_app';f.save();await assert.rejects(f.compile(),/MOBILE_SOURCE_IDENTITY_MISMATCH/);
});
