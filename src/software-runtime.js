import { constants,openSync,fstatSync,closeSync,existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { PROJECT_ROOT } from './config.js';
import { atomicJson, readAtomic, secureDirectory, acquireLock } from './store.js';
import { redact, redactText } from './redact.js';
import {normalizeWorkflowPermissions, assertWorkflowPermission} from './workflow-permissions.js';
import {publicWriteOutcome, persistedWriteOutcome, mergeWriteOutcomes} from './write-outcome.js';
import {readArtifactTextSnapshot} from './artifact-text.js';
import {runPython} from './software-python.js';
import {createNativeDeviceSnapshot} from './native-workflow-budget.js';
import {CAPABILITY_FIDELITY_VERSION,capabilityFidelity,unknownCapabilityFidelity,sourceRouteDiscovery} from './capability-fidelity.js';
import {bindNativeBranchResults,nativeBranchParameters} from './native-branch-binding.js';
export {runPython} from './software-python.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
function publicCapabilityBase(cap){const {adapter,modality,fidelity,textEvidence,routeDiscovery,quality,catalogContract,catalogMetadata,...base}=cap;return base;}
function explicitlyImpossible(schema){if(schema===false)return true;if(!schema||typeof schema!=='object'||Array.isArray(schema))return false;return schema.not&&typeof schema.not==='object'&&!Object.keys(schema.not).length||schema.allOf?.some(explicitlyImpossible)||schema.anyOf?.every(explicitlyImpossible)||schema.oneOf?.every(explicitlyImpossible)||(schema.required||[]).some(name=>Object.hasOwn(schema.properties||{},name)&&explicitlyImpossible(schema.properties[name]));}
function resolveResultAssertions(spec,provided,outputTargetId,assertParam){const requested=provided??[{outputTargetId,param:assertParam}];if(!Array.isArray(requested)||!requested.length||requested.length>32||Buffer.byteLength(JSON.stringify(requested))>32768||provided&&(outputTargetId||assertParam))throw new Error('WORKFLOW_ASSERTION_REQUIRED');const resolved=requested.map(rule=>{const target=spec.outcomeCandidates?.find(item=>item.id===rule.outputTargetId);if(!target||!Object.hasOwn(spec.inputSchema?.properties||{},rule.param||''))throw new Error('WORKFLOW_ASSERTION_REQUIRED');return {rule,target};});const bound=new Set(spec.branchPlan?nativeBranchParameters(spec):spec.steps.map(step=>step.param||step.input).filter(Boolean));if([...bound].some(param=>!resolved.some(item=>item.rule.param===param)))throw new Error('WORKFLOW_ASSERTION_REQUIRED：每个绑定参数都需要结果断言');return resolved;}
function callerSchema(schema,defaults){const output=clone(schema);for(const place of ['path','query']){const part=output.properties?.[place],original=schema.properties?.[place],values=defaults?.[place];if(part&&original&&values&&Array.isArray(part.required))part.required=part.required.filter(name=>!Object.hasOwn(values,name)||!ajv.validate(original.properties[name],values[name]));}if(Array.isArray(output.required))output.required=output.required.filter(name=>!Object.hasOwn(defaults,name)||!ajv.validate(schema.properties[name],defaults[name]));return output;}
function contractShape(value){if(Array.isArray(value))return value.map(contractShape);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['description','title','$id','$schema','$comment','default','examples','readOnly','writeOnly','deprecated'].includes(key)).map(([k,v])=>[k,contractShape(v)]));return value;}
const validId=value=>{if(!ID.test(value||'')||['__proto__','constructor','prototype'].includes(value))throw new Error('无效的 sourceId');return value;};
const within=(root,file)=>{const p=path.relative(root,file);return p===''||p!=='..'&&!p.startsWith('..'+path.sep)&&!path.isAbsolute(p);};
const json=file=>readAtomic(file);
const ajv=new Ajv2020({strict:false,allErrors:false,allowUnionTypes:true,validateFormats:false});
export function checkedArtifact(input,roots){
 const file=realpathSync(path.resolve(input));if(!roots.some(root=>within(realpathSync(root),file)))throw new Error('输入不在配置的 artifactRoots 中');return file;
}
export function createSoftwareRuntime(options={}){
 const root=path.resolve(options.outputRoot||path.join(PROJECT_ROOT,'output-software'));
 mkdirSync(root,{recursive:true,mode:0o700});secureDirectory(path.join(root,'private'));
 const permissions=options.workflowPermissions===undefined?{}:options.workflowPermissions;if(!permissions||typeof permissions!=='object'||Array.isArray(permissions)||Object.keys(permissions).length>1000)throw new Error('WORKFLOW_PERMISSIONS_INVALID');
 const workflowPermissions=Object.fromEntries(Object.entries(permissions).map(([sourceId,value])=>[validId(sourceId),normalizeWorkflowPermissions(value)]));
 const config={...options,workflowPermissions,outputRoot:root,artifactRoots:[...new Set([...(options.artifactRoots||[PROJECT_ROOT]),root].map(p=>path.resolve(p)))],python:options.python||path.join(PROJECT_ROOT,'.venv/bin/python')};
 const sourcesDir=path.join(root,'sources');mkdirSync(sourcesDir,{recursive:true,mode:0o700});
 // A second MCP connection may share this output root with different bindings.
 // Workers and generated entries must keep the exact configuration they own.
 const runtimeFile=path.join(root,'private/runtime-'+digest(config)+'.json');if(!existsSync(runtimeFile))atomicJson(runtimeFile,config);
 const sourceDir=id=>path.join(sourcesDir,validId(id));
 const current=id=>json(path.join(sourceDir(id),'current.json'));
 const readGeneration=id=>{const ref=current(id),dir=path.join(sourceDir(id),'generations',ref.revision);return projectGeneration({ref,dir,manifest:json(path.join(dir,'manifest.json')),recipes:json(path.join(dir,'private/recipes.json'))});};
 const artifactJson=(directory,name)=>{const base=realpathSync(directory);for(const suffix of ['', '.previous']){const file=path.join(base,name+suffix);let info;try{info=lstatSync(file)}catch(error){if(error.code==='ENOENT')continue;throw error}if(info.isSymbolicLink()||!info.isFile()||info.size>8*1024*1024||!within(base,realpathSync(file)))throw new Error('WORKFLOW_PATH_REJECTED');}return json(path.join(base,name));};
 const readDevice=(file)=>{const info=lstatSync(file);if(info.isSymbolicLink()||!info.isFile()||info.size>1048576)throw new Error('DEVICE_CONFIG_PATH_REJECTED');const actual=realpathSync(file);if(!config.artifactRoots.some(base=>within(realpathSync(base),actual))&&!Object.values(config.devices||{}).some(bound=>{try{return realpathSync(bound)===actual}catch{return false}}))throw new Error('DEVICE_CONFIG_PATH_REJECTED');return JSON.parse(readFileSync(actual,'utf8'));};
 const effectiveDevice=(original,sourceId)=>{const dc=clone(original);delete dc.workflowPermissions;const permission=config.workflowPermissions[sourceId];if(permission&&(permission.allowWrite.length||permission.allowWriteLearning.length))dc.workflowPermissions=clone({allowWrite:permission.allowWrite,allowWriteLearning:permission.allowWriteLearning});return dc;};
 const executionDeviceDigest=device=>{const {workflowPermissions,...contract}=device;return digest(canonical(contract));};
 const boundDevice=(file,original,dc)=>{if(digest(dc)===digest(original))return path.resolve(file);const target=path.join(root,'private','device-'+digest(dc)+'.json');if(!existsSync(target))atomicJson(target,dc);return target;};
 const deviceFor=(file,sourceId)=>{const original=readDevice(file);return boundDevice(file,original,effectiveDevice(original,sourceId));};
 const fidelityForBinding=(binding,sourceKind,deviceCache=new Map())=>{
  let device=null,deviceConfigDigest=null;
  if(['mobile','mobile-workflow'].includes(binding?.adapter)){
   const file=binding.deviceConfigPath||config.devices?.[binding.deviceName];
   if(file){const cacheKey=JSON.stringify([file,binding.sourceId||binding.recipe?.sourceId]);let saved=deviceCache.get(cacheKey);if(!saved){const value=effectiveDevice(readDevice(file),binding.sourceId||binding.recipe?.sourceId);saved={device:value,digest:executionDeviceDigest(value)};deviceCache.set(cacheKey,saved);}device=saved.device;deviceConfigDigest=saved.digest;}
  }
  const metadata=capabilityFidelity({adapter:binding?.adapter,recipe:binding?.recipe,device,sourceKind});
  const executionContract=binding?.adapter==='http'?{adapter:binding.adapter,sourceId:binding.sourceId,endpointId:binding.endpointId,method:binding.method,sourceRevision:binding.sourceRevision}:{adapter:binding?.adapter,sourceId:binding?.sourceId||null,runDir:binding?.runDir||null,mobileDir:binding?.mobileDir||null,workflowDir:binding?.workflowDir||null,deviceName:binding?.deviceName||null,deviceConfigPath:binding?.deviceConfigPath||null,recipe:binding?.recipe??null};
  return {metadata,contract:{version:CAPABILITY_FIDELITY_VERSION,digest:digest(canonical(metadata)),recipeContractDigest:digest(canonical(executionContract)),deviceConfigDigest}};
 };
 const bindCatalogContract=(binding,sourceKind,redactor,deviceCache)=>{
  const fidelity=fidelityForBinding(binding,sourceKind,deviceCache),metadata=redactor.catalogValue(fidelity.metadata);
  binding.catalogMetadata=metadata;binding.catalogContract={...fidelity.contract,publicDigest:digest(canonical(metadata))};return metadata;
 };
 function projectGeneration(g){
  const deviceCache=new Map(),capabilities=g.manifest.capabilities.map(cap=>{
   const binding=g.recipes[cap.id],recorded=binding?.catalogContract,kind=['http','unresolved-http'].includes(binding?.adapter)?'http':['mobile','mobile-workflow'].includes(binding?.adapter)?'mobile':['browser','browser-workflow'].includes(binding?.adapter)?'browser':cap.kind;
   if(!recorded)return {...publicCapabilityBase(cap),kind,...unknownCapabilityFidelity('legacy_metadata_unbound_refresh_required')};
   const currentContract=fidelityForBinding(binding,g.ref.kind,deviceCache),{publicDigest,...rawContract}=recorded;
   if(digest(canonical(rawContract))!==digest(canonical(currentContract.contract))||!binding.catalogMetadata||digest(canonical(binding.catalogMetadata))!==publicDigest)throw Object.assign(new Error('CAPABILITY_CHANGED：执行通路合同已改变，请先刷新来源'),{code:'CAPABILITY_FIDELITY_CHANGED'});
   // Public artifacts/checkpoints cannot inject compiler-owned quality labels.
   return {...publicCapabilityBase(cap),kind,...clone(binding.catalogMetadata)};
  });
  return {...g,manifest:{...g.manifest,source:{...g.manifest.source,routeDiscovery:sourceRouteDiscovery(capabilities)},capabilities}};
 }
 const runNativePython=async(dc,args,options={})=>{const snapshot=createNativeDeviceSnapshot(dc,path.join(root,'private'));try{return await runPython(config,[...args,'--config',snapshot.path],{...options,timeoutMs:snapshot.budget.timeoutMs,cleanupGraceMs:snapshot.budget.cleanupGraceMs});}finally{snapshot.dispose();}};
 const inventoryRecords=(input,sourceId,kind)=>{const resolved=checkedArtifact(input,config.artifactRoots),directory=statSync(resolved).isDirectory(),file=directory?path.join(resolved,'source.json'):resolved;if(directory&&!within(resolved,realpathSync(file)))throw new Error('INVENTORY_PATH_REJECTED');const read=file=>{if(statSync(file).size>32*1024*1024)throw new Error('INVENTORY_LIMIT');return JSON.parse(readFileSync(file,'utf8'));};let raw=read(file),descriptor=null;if(raw?.format==='endpoint-inventory'){descriptor=raw;if(raw.source_id!==sourceId||raw.kind!==kind)throw new Error('SOURCE_IDENTITY_MISMATCH');if(typeof raw.inventory!=='string'||path.isAbsolute(raw.inventory))throw new Error('INVENTORY_PATH_REJECTED');const base=realpathSync(path.dirname(file)),inventory=realpathSync(path.resolve(base,raw.inventory));if(!within(base,inventory))throw new Error('INVENTORY_PATH_REJECTED');if(statSync(inventory).size>32*1024*1024)throw new Error('INVENTORY_LIMIT');if(raw.inventory_sha256&&createHash('sha256').update(readFileSync(inventory)).digest('hex')!==raw.inventory_sha256)throw new Error('INVENTORY_CHANGED');raw=read(inventory);}if(raw?.source_id&&raw.source_id!==sourceId)throw new Error('SOURCE_IDENTITY_MISMATCH');const records=Array.isArray(raw)?raw:raw?.endpoints;if(!Array.isArray(records))throw new Error('INVENTORY_INVALID');return {records,descriptor};};
 async function gateway(configFile){const {createGatewayServices}=await import('../gateway/dist/services.js');return createGatewayServices(configFile);}
 const bindingFor=(sourceId,manifestPath,kind,origins,generatedBinding={})=>{
  const trusted={...generatedBinding,...(config.bindings?.[sourceId]||{})};
  const out={...trusted,...((generatedBinding.schema_overrides||config.bindings?.[sourceId]?.schema_overrides)?{schema_overrides:{...(generatedBinding.schema_overrides||{}),...(config.bindings?.[sourceId]?.schema_overrides||{})}}:{}),id:sourceId,manifest:manifestPath,kind,allowed_origins:trusted.allowed_origins||origins};
  if(!out.credentials)out.public=true;else{delete out.public;if(!trusted.credential_origins?.length)throw new Error('CREDENTIAL_SCOPE_REQUIRED：凭据需独立声明credential_origins');out.credential_origins=trusted.credential_origins;}
  return out;
 };
 async function compile({sourceId,inventoryPath,kind='web',runDir,mobileDir,deviceName,deviceConfigPath,workflowEntries,httpSupplements=[],expectedRevision,schemaOverrides,sourceGaps=[],sourceWarnings=[],specificationInput=null,validateSpecificationInputs}){
  validId(sourceId);const dir=sourceDir(sourceId);mkdirSync(dir,{recursive:true,mode:0o700});
  const release=acquireLock(path.join(dir,'.compile.lock'),{task:'capability_compile'});let stage=null;
  try{
   let old=null;try{old=current(sourceId)}catch{}
   if(expectedRevision!==undefined&&old?.revision!==expectedRevision)throw new Error('SOURCE_CHANGED：来源已更新，请重新读取');
   workflowEntries=workflowEntries??((runDir&&runDir===old?.runDir)||(mobileDir&&mobileDir===old?.mobileDir)?old?.workflowEntries||[]:[]);if(!Array.isArray(workflowEntries)||workflowEntries.length>100)throw new Error('WORKFLOW_LIMIT');
   validateHttpSupplements(httpSupplements);
   const supplements=httpSupplements.map(item=>({...item,...inventoryRecords(item.inventoryPath,sourceId,kind)}));
   const supplementGaps=[],mergedOverrides={...(schemaOverrides||{})};for(const item of supplements)for(const [key,value] of Object.entries(item.schemaOverrides||{})){if(mergedOverrides[key]&&JSON.stringify(canonical(mergedOverrides[key]))!==JSON.stringify(canonical(value))){mergedOverrides[key]={allOf:[mergedOverrides[key],value,{not:{}}]};supplementGaps.push({reason:'conflicting_formal_contracts',operation:key});}else mergedOverrides[key]=value;}
   let browser=null,adapted=null,scope=[],generatedBinding=Object.keys(mergedOverrides).length?{schema_overrides:mergedOverrides}:{};
   if(runDir){
    const {webRunInventory}=await import('../gateway/dist/web-adapter.js');adapted=await webRunInventory({runDir,sourceId});
    const {compileBrowserRun}=await import('./browser-capabilities.js');browser=await compileBrowserRun({runDir,sourceId});
    const saved=json(path.join(runDir,'private/config.json'));scope=saved.requestOrigins||[new URL(saved.startUrl).origin];
    if(!config.bindings?.[sourceId]?.credentials && ((saved.storageState&&!saved.authInject)||(saved.authInject?.headers&&!saved.authInject.urlPattern&&!saved.storageState))){generatedBinding={...generatedBinding,credential_origins:saved.credentialOrigins||[new URL(saved.startUrl).origin],credentialDocument:saved.storageState?{mode:'storageState',storageState:saved.storageState}:{mode:'headers',headers:saved.authInject.headers}};}
   }
   stage=path.join(dir,'staging-'+randomUUID());mkdirSync(stage,{mode:0o700});secureDirectory(path.join(stage,'private'));
   const targetInventory=path.join(stage,'private/inventory.json');let manifestPath,origins=[];
   if(adapted){atomicJson(targetInventory,adapted.manifest);manifestPath=targetInventory;origins=adapted.source.origins;}
   else{
    manifestPath=checkedArtifact(inventoryPath,config.artifactRoots);
    if(statSync(manifestPath).isDirectory()){
     const descriptor=json(path.join(manifestPath,'source.json'));if(descriptor.source_id!==sourceId||descriptor.kind!==kind)throw new Error('移动清单身份与 sourceId/kind 不一致');
    }
   }
   if(supplements.length){const base=adapted?{records:adapted.manifest.endpoints,descriptor:null}:inventoryRecords(inventoryPath,sourceId,kind),records=[...base.records,...supplements.flatMap(item=>item.records)];if(records.length>100000)throw new Error('INVENTORY_LIMIT');atomicJson(targetInventory,{schema_version:'1.1',source_id:sourceId,kind,endpoints:records});manifestPath=targetInventory;if(base.descriptor){const descriptorFile=path.join(stage,'private/source.json');atomicJson(descriptorFile,{...base.descriptor,inventory:'inventory.json',inventory_sha256:createHash('sha256').update(readFileSync(targetInventory)).digest('hex')});manifestPath=descriptorFile;}origins=[];}
   scope=config.bindings?.[sourceId]?.allowed_origins||scope;
   if(generatedBinding.credentialDocument){const document=generatedBinding.credentialDocument;delete generatedBinding.credentialDocument;const file=path.join(stage,'private/credentials.json');atomicJson(file,document);generatedBinding.credentials=file;}
   const gatewayFile=path.join(stage,'private/gateway.json');
   atomicJson(gatewayFile,{manifest_roots:config.artifactRoots.concat([stage]),state_dir:path.join(root,'private/health'),...(config.methods?{methods:config.methods}:{}),sources:[bindingFor(sourceId,manifestPath,kind,scope,generatedBinding)]});
   const services=await gateway(gatewayFile),snapshot=services.registry.get(sourceId);
   scope=snapshot.binding.allowed_origins||[];
   if(!origins.length)origins=snapshot.origins;
   let mobile=null;if(mobileDir){mobileDir=checkedArtifact(mobileDir,config.artifactRoots);mobile={manifest:artifactJson(mobileDir,'manifest.json'),recipes:artifactJson(mobileDir,'recipes.json')};if(mobile.manifest.source.id!==sourceId||mobile.manifest.source.kind!==kind)throw new Error('MOBILE_SOURCE_IDENTITY_MISMATCH');}
   const appIdentity=snapshot.app?digest(canonical(snapshot.app)):null;
   const workflows=workflowEntries.map(entry=>{
    const directory=checkedArtifact(entry.directory,config.artifactRoots),manifest=artifactJson(directory,'manifest.json'),recipes=artifactJson(directory,'recipes.json');
    if(manifest.source.id!==sourceId||manifest.source.kind!==kind||!['browser-workflow','mobile-workflow'].includes(entry.adapter))throw new Error('WORKFLOW_IDENTITY_MISMATCH');
    if(!Array.isArray(manifest.capabilities)||manifest.capabilities.some(cap=>cap.kind!==(entry.adapter==='browser-workflow'?'browser':'mobile')||!recipes[cap.id]||recipes[cap.id].sourceId!==sourceId||recipes[cap.id].capabilityId!==cap.id||recipes[cap.id].revision!==cap.revision||!['read','write'].includes(cap.effect)||cap.effect!==(recipes[cap.id].spec||recipes[cap.id].definition)?.effect))throw new Error('WORKFLOW_RECIPE_IDENTITY_MISMATCH');
    if(entry.adapter==='mobile-workflow'){
     const deviceFile=entry.deviceConfigPath||config.devices?.[entry.deviceName];if(!deviceFile)throw new Error('WORKFLOW_DEVICE_REQUIRED');const dc=readDevice(deviceFile),appId=snapshot.app?.package_name||snapshot.app?.bundle_id;
     if(!appIdentity||entry.appIdentity!==appIdentity||!appId||dc.backend?.appId!==appId||dc.source?.id!==sourceId||dc.source?.kind!==kind)throw new Error('WORKFLOW_APP_IDENTITY_MISMATCH');
    }else if(kind!=='web'||!runDir||entry.runDir&&realpathSync(entry.runDir)!==realpathSync(runDir))throw new Error('WORKFLOW_SOURCE_RUN_MISMATCH');
    return {...entry,manifest,recipes};
   });
   const mobileProofs=[mobile,...workflows.filter(item=>item.adapter==='mobile-workflow')].filter(Boolean).map(item=>item.manifest.source),appHash=snapshot.app?.apk_sha256||snapshot.app?.artifact_sha256;
   const proofMatches=source=>kind==='apk'&&source.appArtifactVerified===true&&source.artifactVerification?.status==='verified'&&/^[a-f0-9]{64}$/.test(appHash||'')&&source.artifactVerification.expectedSha256===appHash&&source.artifactVerification.actualSha256===appHash;
   if(mobileProofs.some(source=>source.artifactVerification?.status==='verified'&&!proofMatches(source)))throw new Error('APP_ARTIFACT_IDENTITY_MISMATCH');
   const appArtifactVerified=mobileProofs.length>0&&mobileProofs.every(proofMatches),artifactVerification=(appArtifactVerified?mobileProofs[0]:mobileProofs.find(source=>!proofMatches(source)))?.artifactVerification||null;
   const preparedCapabilities=[],deviceFidelityCache=new Map();
   for(const item of [browser,mobile,...workflows].filter(Boolean))for(const cap of item.manifest.capabilities){
    const adapter=item.adapter||(item===mobile?'mobile':'browser');if(cap.kind!==(adapter.startsWith('mobile')?'mobile':'browser'))throw new Error('CAPABILITY_ADAPTER_KIND_MISMATCH');
    const id='cap_'+digest([sourceId,cap.kind,cap.id]),binding={adapter,sourceId,runDir:item.runDir||runDir||null,mobileDir:mobileDir||null,workflowDir:item.directory||null,deviceName:item.deviceName||deviceName||null,deviceConfigPath:item.deviceConfigPath||deviceConfigPath||null,recipe:item.recipes[cap.id]};
    const metadata=bindCatalogContract(binding,kind,services.credentials.redactor,deviceFidelityCache);preparedCapabilities.push({item,cap,id,binding,metadata});
   }
   const revision=digest({compilerVersion:'software-to-mcp-22',sourceId,http:snapshot.revision,browser:browser?.manifest.source.revision||null,mobile:mobile?.manifest.source.revision||null,deviceName:deviceName||null,deviceConfigPath:deviceConfigPath||null,workflows:workflows.map(item=>[item.id,item.manifest.source.revision,item.adapter]),workflowPermissions:config.workflowPermissions[sourceId]||null,nativeVisual:config.nativeVisual?.[sourceId]||null,supplements:httpSupplements,scope,binding:config.bindings?.[sourceId]||null,sourceGaps,sourceWarnings,specificationInput,fidelityContracts:{version:CAPABILITY_FIDELITY_VERSION,items:preparedCapabilities.map(item=>[item.id,item.binding.catalogContract])}});
   const capabilities=[],recipes={},gaps=[...sourceGaps,...supplementGaps,...supplements.flatMap(item=>item.gaps||[]),...(adapted?.gaps||[]),...(browser?.manifest.source.gaps||[]),...mobileProofs.flatMap(source=>source.gaps||[]).filter(gap=>!appArtifactVerified||(typeof gap==='string'?gap:gap.reason)!=='app_artifact_not_verified'),...(mobileProofs.length?[...(!appArtifactVerified?[{reason:'app_artifact_not_verified'}]:[]),{reason:'mobile_network_scope_not_enforced'}]:[])];
   for(const endpoint of snapshot.endpoints){
    for(const method of endpoint.methods){
     const op=endpoint.operations[method],id='cap_'+digest([sourceId,'http',endpoint.id,method]),unsupportedContract=explicitlyImpossible(op.params_schema);
     const capabilityRevision=digest([revision,op.contract_revision,id]);
     capabilities.push({id,name:method+' '+endpoint.path,description:op.description||'按已发现的接口契约调用',kind:'http',target:{origin:endpoint.origin,path:endpoint.path,method,endpointId:endpoint.id},inputSchema:callerSchema(op.params_schema,services.registry.get(sourceId).binding.defaults?.[endpoint.id]||{}),readiness:op.allowed&&scope.includes(endpoint.origin)&&!unsupportedContract?'ready':'candidate',effect:['GET','HEAD','OPTIONS'].includes(method)?'read':'write',revision:capabilityRevision,...capabilityFidelity({adapter:'http'}),evidence:{provenance:op.provenance,locations:op.locations,extractionSources:op.extraction_sources,...(op.query_serialization?{querySerialization:op.query_serialization}:{}),...(op.form_serialization?{formSerialization:op.form_serialization}:{})},gaps:[...(op.blocked_reason?[{reason:op.blocked_reason}]:[]),...(unsupportedContract?[{reason:'contract_has_no_supported_inputs'}]:[]),...(!scope.includes(endpoint.origin)?[{reason:'origin_not_approved'}]:[])]});
     recipes[id]={adapter:'http',sourceId,endpointId:endpoint.id,method,sourceRevision:snapshot.revision,capabilityRevision};bindCatalogContract(recipes[id],kind,services.credentials.redactor);
    }
    if(endpoint.unresolved_candidates.length){const id='cap_'+digest([sourceId,'http-unresolved',endpoint.id]);capabilities.push({id,name:'METHOD? '+endpoint.path,description:'已发现但HTTP方法未解析的接口线索',kind:'http',...unknownCapabilityFidelity('http_method_unresolved'),inputSchema:endpoint.unresolved_candidates[0].params_schema||{type:'object',properties:{},additionalProperties:false},readiness:'candidate',effect:'unknown',revision:digest([revision,snapshot.revision,id]),evidence:{provenance:[...new Set(endpoint.unresolved_candidates.flatMap(c=>c.provenance))]},gaps:[{reason:'method_unresolved'}]});recipes[id]={adapter:'unresolved-http'};bindCatalogContract(recipes[id],kind,services.credentials.redactor);gaps.push({reason:'method_unresolved',endpointId:endpoint.id,count:endpoint.unresolved_candidates.length});}
   }
   for(const {item,cap,id,binding,metadata} of preparedCapabilities){
    let permissionGap=false;if(item.adapter?.endsWith('-workflow')&&cap.effect==='write'){const definition=item.recipes[cap.id].spec||item.recipes[cap.id].definition;try{assertWorkflowPermission(config.workflowPermissions[sourceId],definition.id)}catch(error){if(error.code!=='WORKFLOW_WRITE_NOT_APPROVED')throw error;permissionGap=true;}}
    capabilities.push({...publicCapabilityBase(cap),...metadata,id,revision:digest([revision,cap.revision,id]),...(permissionGap?{readiness:'candidate',gaps:[...(cap.gaps||[]),{reason:'workflow_write_not_approved'}]}:{})});recipes[id]=binding;
   }
   const rawManifest={schemaVersion:1,source:{id:sourceId,kind,revision,origins,allowedOrigins:scope,createdAt:new Date().toISOString(),routeDiscovery:sourceRouteDiscovery(capabilities),...(snapshot.app?{app:snapshot.app}:{}),...(mobileProofs.length?{appArtifactVerified,artifactVerification}:{}),gaps,warnings:[...sourceWarnings,...supplements.flatMap(item=>item.warnings||[]),...(adapted?.warnings||[])]},capabilities,coverage:{httpEndpoints:snapshot.endpoints.length,browserCapabilities:(browser?.manifest.capabilities.length||0)+workflows.filter(item=>item.adapter==='browser-workflow').reduce((n,item)=>n+item.manifest.capabilities.length,0),mobileCapabilities:(mobile?.manifest.capabilities.length||0)+workflows.filter(item=>item.adapter==='mobile-workflow').reduce((n,item)=>n+item.manifest.capabilities.length,0),gaps}};
   const publicCatalog=services.credentials.redactor.catalogValue({...rawManifest,capabilities:rawManifest.capabilities.map(({inputSchema,...cap})=>({...cap,params_schema:inputSchema}))});
   for(const cap of publicCatalog.capabilities){const binding=recipes[cap.id];if(binding?.catalogContract&&digest(canonical({modality:cap.modality,fidelity:cap.fidelity}))!==binding.catalogContract.publicDigest)throw new Error('CAPABILITY_METADATA_PROJECTION_CHANGED');}
   const manifest={...publicCatalog,capabilities:publicCatalog.capabilities.map(({params_schema,...cap},index)=>{const complete=digest(contractShape(params_schema))===digest(contractShape(rawManifest.capabilities[index].inputSchema));return {...cap,inputSchema:params_schema,...(!complete?{readiness:'candidate',gaps:[...(cap.gaps||[]),{reason:'schema_projection_incomplete'}]}:{})};})};
   validateSpecificationInputs?.();
   const final=path.join(dir,'generations',revision);mkdirSync(path.dirname(final),{recursive:true,mode:0o700});
   if(!existsSync(final)){
    // Rewrite paths for the immutable generation before the directory rename.
    const finalInventory=supplements.length?path.join(final,'private',path.basename(manifestPath)):adapted?path.join(final,'private/inventory.json'):manifestPath;
    const finalConfig={manifest_roots:config.artifactRoots.concat([final]),state_dir:path.join(root,'private/health'),...(config.methods?{methods:config.methods}:{}),sources:[bindingFor(sourceId,finalInventory,kind,scope,{...generatedBinding,...(generatedBinding.credentials?{credentials:path.join(final,'private/credentials.json')}:{})})]};
    atomicJson(gatewayFile,finalConfig);atomicJson(path.join(stage,'manifest.json'),manifest);atomicJson(path.join(stage,'private/recipes.json'),recipes);
    const {renameSync}=await import('node:fs');validateSpecificationInputs?.();renameSync(stage,final);
   }
   const previous=old?.revision||null;const oldCaps=previous?json(path.join(dir,'generations',previous,'manifest.json')).capabilities:[];const byId=new Map(oldCaps.map(c=>[c.id,c]));const changes={added:capabilities.filter(c=>!byId.has(c.id)).map(c=>c.id),changed:capabilities.filter(c=>byId.has(c.id)&&byId.get(c.id).revision!==c.revision).map(c=>c.id),removed:oldCaps.filter(c=>!capabilities.some(n=>n.id===c.id)).map(c=>c.id)};validateSpecificationInputs?.();atomicJson(path.join(dir,'current.json'),{sourceId,revision,previous:previous===revision?(old?.previous||null):previous,generation:final,runDir:runDir||null,inventoryPath:inventoryPath||null,kind,mobileDir:mobileDir||null,deviceName:deviceName||null,deviceConfigPath:deviceConfigPath||null,appIdentity,browserSourceRevision:browser?.manifest.source.revision||null,workflowEntries,httpSupplements,schemaOverrides:schemaOverrides||null,sourceGaps,sourceWarnings,specificationInput});
   return {source:manifest.source,counts:{total:capabilities.length,ready:manifest.capabilities.filter(c=>c.readiness==='ready').length},changes:Object.fromEntries(Object.entries(changes).map(([key,items])=>[key,items.slice(0,100)])),changeTotals:Object.fromEntries(Object.entries(changes).map(([key,items])=>[key,items.length])),changesTruncated:Object.values(changes).some(items=>items.length>100)};
  }finally{if(stage&&existsSync(stage))rmSync(stage,{recursive:true,force:true});release()}
 }
 const listSources=()=>readdirSync(sourcesDir,{withFileTypes:true}).filter(d=>d.isDirectory()&&ID.test(d.name)).flatMap(d=>{try{const g=readGeneration(d.name);return [{...g.manifest.source,capabilityCount:g.manifest.capabilities.length}]}catch(error){if(error.code==='CAPABILITY_FIDELITY_CHANGED'){const ref=current(d.name);return [{id:d.name,kind:ref.kind,revision:ref.revision,capabilityCount:null,routeDiscovery:{...sourceRouteDiscovery([]),contractStatus:'refresh_required'},gaps:[{reason:'capability_contract_changed_refresh_required'}]}];}return []}});
 function listCapabilities({sourceId,kind,search='',offset=0,limit=30}){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('分页参数无效');
  const g=readGeneration(sourceId);let rows=g.manifest.capabilities;if(kind)rows=rows.filter(c=>c.kind===kind);if(search)rows=rows.filter(c=>(c.name+' '+c.description).toLowerCase().includes(search.toLowerCase()));
  let items=rows.slice(offset,offset+limit);while(Buffer.byteLength(JSON.stringify(items))>98304&&items.length>1)items.pop();if(Buffer.byteLength(JSON.stringify(items))>98304)throw new Error('CAPABILITY_SCHEMA_LIMIT：单项契约超出响应上限');
  return {source:g.manifest.source,items,total:rows.length,offset,nextOffset:offset+items.length<rows.length?offset+items.length:null};
 }
 async function execute({sourceId,capabilityId,expectedRevision,params={},outputDir},signal){
  let writeWorkflow=false;
  try{
  signal?.throwIfAborted();
  const g=readGeneration(sourceId),cap=g.manifest.capabilities.find(c=>c.id===capabilityId);if(!cap)throw new Error('CAPABILITY_NOT_FOUND');
  writeWorkflow=cap.effect==='write'&&g.recipes[capabilityId]?.adapter?.endsWith('-workflow');
  if(expectedRevision!==cap.revision)throw new Error('CAPABILITY_CHANGED：必须使用最新能力 revision');if(cap.readiness!=='ready')throw new Error('CAPABILITY_NOT_READY');
  const binding=g.recipes[capabilityId];if(!binding?.catalogContract||binding.catalogContract.version!==CAPABILITY_FIDELITY_VERSION)throw Object.assign(new Error('CAPABILITY_CHANGED：缺少当前执行合同，请先刷新来源'),{code:'CAPABILITY_FIDELITY_CHANGED'});if(binding.adapter?.endsWith('-workflow')){const definition=binding.recipe.spec||binding.recipe.definition;if(cap.effect!==definition?.effect)throw new Error('WORKFLOW_RECIPE_IDENTITY_MISMATCH');if(definition.effect==='write')assertWorkflowPermission(config.workflowPermissions[sourceId],definition.id);}
  if(binding.adapter!=='http'){const validate=ajv.compile(cap.inputSchema);if(!validate(params))throw new Error('INPUT_INVALID：'+ajv.errorsText(validate.errors));}let result;
  if(binding.adapter==='http'){
   const services=await gateway(path.join(g.dir,'private/gateway.json'));
   try{result=await services.callEndpoint({source:sourceId,endpoint_id:binding.endpointId,expected_revision:binding.sourceRevision,params:{...params,method:binding.method}},signal);}catch(error){if(['PARAMS_INVALID','ENDPOINT_SCHEMA_INVALID'].includes(error.code))throw new Error('INPUT_INVALID：'+error.message);throw error;}
  }else if(binding.adapter==='browser-workflow'){
   const {executeBrowserWorkflow}=await import('./browser-workflows.js');signal?.throwIfAborted();result=await executeBrowserWorkflow({runDir:binding.runDir,recipe:binding.recipe,params,expectedRevision:binding.recipe.revision,outputDir,signal,permissions:config.workflowPermissions[sourceId]});
  }else if(binding.adapter==='browser'){
   const {executeBrowserRecipe}=await import('./browser-capabilities.js');result=await executeBrowserRecipe({runDir:binding.runDir,recipe:binding.recipe,params,expectedRevision:binding.recipe.revision,outputDir});
  }else{
   const deviceFile=binding.deviceConfigPath||config.devices?.[binding.deviceName];if(!deviceFile)throw new Error('NEEDS_DEVICE_CONFIG');const dc=effectiveDevice(readDevice(deviceFile),sourceId);if(executionDeviceDigest(dc)!==binding.catalogContract.deviceConfigDigest)throw Object.assign(new Error('CAPABILITY_CHANGED：设备执行合同已改变，请先刷新来源'),{code:'CAPABILITY_FIDELITY_CHANGED'});
   const recipeFile=path.join(outputDir,'recipe.json');mkdirSync(outputDir,{recursive:true,mode:0o700});atomicJson(recipeFile,binding.recipe);
   const visualType=binding.adapter==='mobile-workflow'?binding.recipe.recipeType:null;
   if(visualType==='ios_visual_workflow'&&g.ref.kind!=='ios'||visualType==='visual_workflow'&&g.ref.kind!=='apk')throw new Error('VISUAL_APP_IDENTITY_MISMATCH');
   const module=visualType==='ios_visual_workflow'?'apk_inventory.mobile_visual_ios':visualType==='visual_workflow'?'apk_inventory.mobile_visual_android':'apk_inventory.mobile_ui';
   await runNativePython(dc,['-m',module,'--operation','execute','--output',outputDir,'--recipe',recipeFile,'--revision',binding.recipe.revision],{signal,stdin:{inputs:params}});
   result=json(path.join(outputDir,'result.json'));
   if(['apk_inventory.mobile_visual_android','apk_inventory.mobile_visual_ios'].includes(module)){
    const services=await gateway(path.join(g.dir,'private/gateway.json')),redactor=services.credentials.redactor,original=result.outputs?.text;
    if(result.ok===true&&typeof original!=='string')throw new Error('VISUAL_OUTPUT_INVALID');
    if(typeof original==='string'){
     const compact=original.replace(/\s+/g,''),hidden=redactor.text(compact)!==compact||redactor.containsObscuredSecret(original),safe=hidden?'[REDACTED]':redactText(redactor.text(original)).replace(/((?:password|passwd|secret|token|api[-_]?key|密码|口令|密钥|令牌)\s*[:：=]?\s*)\S+/gi,'$1[REDACTED]'),bytes=Buffer.from(safe);
     result={...result,outputs:{text:bytes.subarray(0,4096).toString('utf8').replace(/\uFFFD$/,'')},provenance:'device_screenshot_and_local_ocr',untrusted:true,gaps:[...(result.gaps||[]),...(safe!==original?['ocr_sensitive_content_redacted']:[]),...(bytes.length>4096?['ocr_output_truncated']:[])]};
    }
    result=redactor.value(result);
   }
  }
  const clean=redact({sourceId,capabilityId,revision:cap.revision,result});
  mkdirSync(outputDir,{recursive:true,mode:0o700});atomicJson(path.join(outputDir,'validation.json'),{...clean,checkedAt:new Date().toISOString(),status:result?.ok===false?'failed':'executed'});
  return clean;
  }catch(error){const outcome=mergeWriteOutcomes(persistedWriteOutcome(outputDir),error.writeOutcome,writeWorkflow?{status:'not_started',automaticRetry:false}:undefined);if(outcome)error.writeOutcome=outcome;throw error;}
 }
 async function discover({kind,input,sourceId,webOptions={},deviceName,resume=false,runId,resumeOperationDir},outputDir,signal){
  if(kind==='web'){
   const allowed=new Set(['limitMode','maxStates','maxDepth','maxDurationMs','maxRequests','maxActions','maxStatesPerHost','requestDelayMs','shotFormat','order','resourcePolicy','navigationOrigins','requestOrigins','credentialOrigins','seedRoutes','excludeSelectors','actionAllowlist','requestAllowlist']);for(const key of Object.keys(webOptions))if(!allowed.has(key))throw new Error('不支持的webOptions字段: '+key);
   for(const key of ['navigationOrigins','requestOrigins','credentialOrigins']){const ceiling=config.webConfig?.[key];if(ceiling&&webOptions[key]?.some(origin=>!ceiling.includes(new URL(origin).origin)))throw new Error('SCOPE_EXPANSION：'+key+'越出启动配置');}
   for(const key of ['actionAllowlist','requestAllowlist']){const ceiling=config.webConfig?.[key];if(ceiling&&webOptions[key]?.some(rule=>!ceiling.some(approved=>JSON.stringify(canonical(rule))===JSON.stringify(canonical(approved)))))throw new Error('POLICY_EXPANSION：'+key+'越出启动配置');}
   if(config.webConfig?.authInject&&!config.webConfig?.credentialOrigins?.length)throw new Error('NEEDS_CREDENTIAL_SCOPE：认证头须在启动配置声明credentialOrigins');
   const {runAsset}=await import('./runner.js');const id=sourceId||'web_'+randomUUID(),runDir=runId?path.join(root,'runs',validId(runId)):path.join(root,'runs',id);
   let inputConfig={...(config.webConfig||{}),...webOptions,startUrl:input,runId:id,outputDir:runDir};
   if(resume){inputConfig={...json(path.join(runDir,'private/config.json')),...webOptions};delete inputConfig._runtime;delete inputConfig._policy;}
   const result=await runAsset(inputConfig,{resume,log:line=>process.stderr.write(redactText(line)+'\n')});
   return {runId:result.runId,status:result.status,compile:await compile({sourceId:id,runDir,kind:'web'})};
  }
  if(!['apk','ios'].includes(kind))throw new Error('kind必须web/apk/ios');const artifact=checkedArtifact(input,config.artifactRoots);
  let priorDir;if(resumeOperationDir){priorDir=realpathSync(resumeOperationDir);const operationsRoot=realpathSync(path.join(root,'operations'));if(!resume||!within(operationsRoot,priorDir)||path.dirname(priorDir)!==operationsRoot||!existsSync(path.join(priorDir,'task.json')))throw new Error('RESUME_PATH_REJECTED');}
  let inventory=artifact;
  if(!(statSync(artifact).isDirectory()&&existsSync(path.join(artifact,'source.json')))){
   inventory=priorDir&&existsSync(path.join(priorDir,'inventory/source.json'))?path.join(priorDir,'inventory'):path.join(outputDir,'inventory');if(!priorDir||!existsSync(path.join(inventory,'source.json')))await runPython(config,['-m',kind==='apk'?'apk_inventory.extract':'apk_inventory.ios',artifact,'--out',inventory],{signal});
  }
  const descriptor=json(path.join(inventory,'source.json'));if(sourceId&&sourceId!==descriptor.source_id)throw new Error('SOURCE_IDENTITY_MISMATCH：移动来源标识取安装包source.json');let mobileDir,deviceConfigPath;
  if(deviceName){
   const device=config.devices?.[deviceName];if(!device)throw new Error('未知deviceName，先在启动配置绑定');const dc=readDevice(device),app=descriptor.app?.package_name||descriptor.app?.bundle_id;
   const backendKind=dc.backend?.type==='adb'||dc.backend?.type==='webdriver'&&dc.backend.platform==='android'?'apk':dc.backend?.type==='webdriver'&&(!dc.backend.platform||dc.backend.platform==='ios')?'ios':null;
   if(backendKind!==kind||dc.source?.kind&&dc.source.kind!==kind||dc.source?.id&&dc.source.id!==descriptor.source_id||dc.backend?.appId&&dc.backend.appId!==app)throw new Error('移动UI设备配置与安装包身份不一致');
   if(!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/.test(app||''))throw new Error('APP_IDENTITY_REQUIRED');
   dc.source={...dc.source,id:descriptor.source_id,kind};dc.backend.appId=app;delete dc.workflowPermissions;const permission=config.workflowPermissions[descriptor.source_id];if(permission&&(permission.allowWrite.length||permission.allowWriteLearning.length))dc.workflowPermissions=clone({allowWrite:permission.allowWrite,allowWriteLearning:permission.allowWriteLearning});
   const hash=descriptor.app?.apk_sha256||descriptor.app?.artifact_sha256;
   if(dc.expectedArtifact&&(kind!=='apk'||dc.expectedArtifact.kind!=='apk'||dc.expectedArtifact.sha256!==hash))throw new Error('ARTIFACT_BINDING_MISMATCH');
   if(kind==='apk'&&dc.backend.type==='adb'&&/\.apk$/i.test(artifact)&&/^[a-f0-9]{64}$/.test(hash||''))dc.expectedArtifact={kind:'apk',sha256:hash};
   deviceConfigPath=path.join(root,'private','device-'+digest(dc)+'.json');if(!existsSync(deviceConfigPath))atomicJson(deviceConfigPath,dc);
   mobileDir=path.join(priorDir||outputDir,'mobile-ui');await runNativePython(dc,['-m','apk_inventory.mobile_ui','--operation','explore','--output',mobileDir,...(resume&&priorDir?['--resume']:[])],{signal});
  }
  return compile({sourceId:descriptor.source_id,inventoryPath:inventory,kind,mobileDir,deviceName,deviceConfigPath});
 }
 function specificationInputContract(value){
  const bad=()=>{throw Object.assign(new Error('OPENAPI_INPUT_PROVENANCE_INVALID'),{code:'OPENAPI_INPUT_PROVENANCE_INVALID'});};
  const file=value=>typeof value==='string'&&value.length>0&&value.length<=8192&&path.isAbsolute(value);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='documentPath,documentUrl,referenceDocuments,schemaVersion'||value.schemaVersion!==1||!file(value.documentPath)||(value.documentUrl!==null&&(typeof value.documentUrl!=='string'||value.documentUrl.length>8192))||!Array.isArray(value.referenceDocuments)||value.referenceDocuments.length>32)bad();
  for(const ref of value.referenceDocuments)if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).sort().join(',')!=='documentPath,documentUrl'||!file(ref.documentPath)||typeof ref.documentUrl!=='string'||ref.documentUrl.length>8192)bad();
  return value;
 }
 function validateHttpSupplements(value){
  const plain=item=>item&&typeof item==='object'&&!Array.isArray(item)&&[Object.prototype,null].includes(Object.getPrototypeOf(item));
  if(!Array.isArray(value)||value.length>32||value.some(item=>!plain(item)))throw Object.assign(new Error('SUPPLEMENT_LIMIT'),{code:'SUPPLEMENT_LIMIT'});
 }
 function specificationReadContext(bundleCount){
  const fail=code=>{throw Object.assign(new Error(code+'：规范输入不可用、改变或超过预算'),{code});};
  if(!Number.isSafeInteger(bundleCount)||bundleCount<0||bundleCount>33)fail('SPECIFICATION_BUNDLE_LIMIT');
  const aliases=new Map(),files=new Map(),cache=new Map(),cacheLimit=16*1024*1024;let cacheBytes=0,uniqueInputBytes=0;
  const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
  const resolve=input=>{try{return checkedArtifact(input,config.artifactRoots);}catch(error){if(error.code)fail('DOCUMENT_UNAVAILABLE');throw error;}};
  const stamp=file=>{
   let fd;try{fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));const value=fstatSync(fd,{bigint:true});if(!value.isFile())fail('DOCUMENT_LIMIT');return value;}
   catch(error){if(/^DOCUMENT_/.test(error.code||''))throw error;fail('DOCUMENT_UNAVAILABLE');}finally{if(fd!==undefined)closeSync(fd);}
  };
  const validate=()=>{
   for(const [alias,file]of aliases)if(resolve(alias)!==file)fail('DOCUMENT_CHANGED');
   for(const [file,first]of files)if(!same(stamp(file),first.stamp))fail('DOCUMENT_CHANGED');
  };
  const read=(input,maxBytes)=>{
   const alias=path.resolve(input),file=resolve(alias),knownAlias=aliases.get(alias),first=files.get(file);
   if(knownAlias!==undefined&&knownAlias!==file)fail('DOCUMENT_CHANGED');
   if(!knownAlias){if(aliases.size>=1089)fail('SPECIFICATION_INPUT_LIMIT');aliases.set(alias,file);}
   let fd;
   try{
    let found=cache.get(file),before;
    if(found){
     fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));before=fstatSync(fd,{bigint:true});
     cache.delete(file);cache.set(file,found);
    }else{
     // Bytes and metadata must originate from the same descriptor. An outer
     // descriptor A cannot attest bytes read by an independently opened B.
     found=readArtifactTextSnapshot(file,maxBytes);before=found.stamp;
     found={...found,hash:createHash('sha256').update(found.document,'utf8').digest('hex')};
     if(first&&(found.hash!==first.hash||found.bytes!==first.bytes))fail('DOCUMENT_CHANGED');
    }
    if(!before.isFile()||before.size>BigInt(maxBytes))fail('DOCUMENT_LIMIT');
    if(first&&!same(first.stamp,before))fail('DOCUMENT_CHANGED');
    const after=fd===undefined?before:fstatSync(fd,{bigint:true});
    if(!same(before,after)||!same(after,stamp(file))||resolve(alias)!==file)fail('DOCUMENT_CHANGED');
    if(found.bytes>maxBytes)fail('DOCUMENT_LIMIT');
    if(!first){
     if(files.size>=1089||uniqueInputBytes+found.bytes>bundleCount*16*1024*1024)fail('SPECIFICATION_INPUT_LIMIT');
     uniqueInputBytes+=found.bytes;files.set(file,{stamp:before,hash:found.hash,bytes:found.bytes});
    }
    if(!cache.has(file)){
     // UTF-16 is a conservative bound on retained decoded string storage.
     const retained=found.document.length*2;
     while(cache.size&&cacheBytes+retained>cacheLimit){const oldest=cache.keys().next().value;cacheBytes-=cache.get(oldest).retained;cache.delete(oldest);}
     if(retained<=cacheLimit){cache.set(file,{...found,retained});cacheBytes+=retained;}
    }
    return {document:found.document,bytes:found.bytes};
   }catch(error){if(/^DOCUMENT_|^SPECIFICATION_/.test(error.code||''))throw error;fail('DOCUMENT_UNAVAILABLE');}
   finally{if(fd!==undefined)closeSync(fd);}
  };
  return {read,validate};
 }
 async function readSpecificationInput({sourceId,documentPath,documentUrl,referenceDocuments=[]},allowedOrigins,context){
  if(!Array.isArray(referenceDocuments)||referenceDocuments.length>32)throw new Error('REFERENCE_DOCUMENT_LIMIT');
  const file=value=>typeof value==='string'&&value.length>0&&value.length<=8192;
  if(!file(documentPath))throw new Error('INVALID_SPECIFICATION_DOCUMENT');
  for(const entry of referenceDocuments)if(!entry||typeof entry!=='object'||Array.isArray(entry)||!file(entry.documentPath)||typeof entry.documentUrl!=='string'||entry.documentUrl.length>8192)throw new Error('INVALID_REFERENCE_DOCUMENT');
  let documentBytes=0;
  const readDocument=input=>{const found=context.read(input,Math.min(8*1024*1024,16*1024*1024-documentBytes));documentBytes+=found.bytes;return found;};
  const {document}=readDocument(documentPath),boundReferences=[],references=referenceDocuments.map(entry=>{
   boundReferences.push({documentPath:path.resolve(entry.documentPath),documentUrl:entry.documentUrl});
   return {documentUrl:entry.documentUrl,document:readDocument(entry.documentPath).document};
  });
  const {importOpenApi}=await import('./openapi-discovery.js');
  const imported=importOpenApi({document,documentUrl,referenceDocuments:references,sourceId,allowedOrigins});
  const input=specificationInputContract({schemaVersion:1,documentPath:path.resolve(documentPath),documentUrl:documentUrl??null,referenceDocuments:boundReferences});
  return {imported,input};
 }
 function storeSpecification(imported){
  // Repeated refreshes of the same contract reuse an immutable derived file.
  // Original paths remain private provenance and are revalidated on refresh.
  const hash=digest(canonical(imported.manifest)),file=path.join(root,'private','spec-'+hash+'.json');
  if(existsSync(file)){
   const info=lstatSync(file);if(info.isSymbolicLink()||!info.isFile()||info.size>32*1024*1024||digest(canonical(json(file)))!==hash)throw Object.assign(new Error('OPENAPI_SNAPSHOT_CHANGED'),{code:'OPENAPI_SNAPSHOT_CHANGED'});
  }else atomicJson(file,imported.manifest);
  return file;
 }
 async function importSpecification({sourceId,documentPath,documentUrl,referenceDocuments=[],expectedRevision,merge=false}){
  validId(sourceId);const original=merge?readGeneration(sourceId):null;
  if(merge&&(!expectedRevision||original.ref.revision!==expectedRevision))throw new Error('SOURCE_CHANGED：合并需要当前来源revision');
  const previous=original?.ref.httpSupplements===undefined?[]:original.ref.httpSupplements;validateHttpSupplements(previous);
  const id=digest(documentUrl||path.resolve(documentPath));if(merge&&previous.filter(item=>item.id!==id).length>=32)throw Object.assign(new Error('SUPPLEMENT_LIMIT'),{code:'SUPPLEMENT_LIMIT'});
  const allowed=config.bindings?.[sourceId]?.allowed_origins||original?.manifest.source.allowedOrigins?.map(value=>new URL(value).origin)||[],context=specificationReadContext(1);
  const {imported,input}=await readSpecificationInput({sourceId,documentPath,documentUrl,referenceDocuments},allowed,context);context.validate();const documentFile=storeSpecification(imported);
  if(merge){const item={id,inventoryPath:documentFile,schemaOverrides:imported.schemaOverrides,gaps:imported.gaps,warnings:imported.warnings,specificationInput:input};return compileCurrent({sourceId,expectedRevision,httpSupplements:[...previous.filter(previous=>previous.id!==id),item],validateSpecificationInputs:context.validate});}
  return compile({sourceId,kind:'web',inventoryPath:documentFile,expectedRevision,schemaOverrides:imported.schemaOverrides,sourceGaps:imported.gaps,sourceWarnings:imported.warnings,specificationInput:input,validateSpecificationInputs:context.validate});
 }
 async function compileCurrent({sourceId,expectedRevision,...patch}){const ref=current(sourceId);return compile({sourceId,expectedRevision,inventoryPath:ref.inventoryPath,kind:ref.kind,runDir:ref.runDir,mobileDir:ref.mobileDir,deviceName:ref.deviceName,deviceConfigPath:ref.deviceConfigPath,workflowEntries:ref.workflowEntries,httpSupplements:ref.httpSupplements,schemaOverrides:ref.schemaOverrides,sourceGaps:ref.sourceGaps,sourceWarnings:ref.sourceWarnings,specificationInput:ref.specificationInput||null,...patch});}
 async function refresh({sourceId,expectedRevision}){
  const ref=current(sourceId);if(ref.revision!==expectedRevision)throw new Error('SOURCE_CHANGED');
  const legacySnapshot=file=>typeof file==='string'&&path.dirname(path.resolve(file))===path.join(root,'private')&&/^spec-[a-f0-9-]{32,64}\.json$/.test(path.basename(file));
  const reimport=()=>{throw Object.assign(new Error('OPENAPI_REFRESH_REIMPORT_REQUIRED：旧规范未绑定原文档，请重新导入规范及引用映射'),{code:'OPENAPI_REFRESH_REIMPORT_REQUIRED'});};
  const supplements=ref.httpSupplements===undefined?[]:ref.httpSupplements;validateHttpSupplements(supplements);
  if(ref.specificationInput)specificationInputContract(ref.specificationInput);for(const item of supplements)if(item.specificationInput)specificationInputContract(item.specificationInput);
  const context=specificationReadContext((ref.specificationInput?1:0)+supplements.filter(item=>item.specificationInput).length);
  if(!ref.specificationInput&&legacySnapshot(ref.inventoryPath))reimport();
  for(const item of supplements)if(!item.specificationInput&&legacySnapshot(item.inventoryPath))reimport();
  const source=json(path.join(ref.generation,'manifest.json')).source;
  const allowed=config.bindings?.[sourceId]?.allowed_origins||source.allowedOrigins?.map(value=>new URL(value).origin)||[];
  const base=ref.specificationInput?await readSpecificationInput({sourceId,...specificationInputContract(ref.specificationInput)},allowed,context):null;
  // Parse and validate every original bundle before materializing any new data.
  const importedSupplements=[];for(const item of supplements)importedSupplements.push(item.specificationInput?await readSpecificationInput({sourceId,...specificationInputContract(item.specificationInput)},allowed,context):null);
  context.validate();
  const patch=base?{inventoryPath:storeSpecification(base.imported),schemaOverrides:base.imported.schemaOverrides,sourceGaps:base.imported.gaps,sourceWarnings:base.imported.warnings,specificationInput:base.input}:{};
  patch.httpSupplements=supplements.map((item,index)=>{const found=importedSupplements[index];return found?{...item,inventoryPath:storeSpecification(found.imported),schemaOverrides:found.imported.schemaOverrides,gaps:found.imported.gaps,warnings:found.imported.warnings,specificationInput:found.input}:item;});
  return compileCurrent({sourceId,expectedRevision,...patch,validateSpecificationInputs:context.validate});
 }
 async function observeMobile({sourceId,expectedRevision},outputDir,signal){
  validId(sourceId);const g=readGeneration(sourceId);if(g.ref.revision!==expectedRevision)throw new Error('SOURCE_CHANGED');if(!['apk','ios'].includes(g.ref.kind))throw new Error('MOBILE_SOURCE_REQUIRED');
  const settings=config.nativeVisual?.[sourceId];if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(key=>!['engine','language','minConfidence'].includes(key)))throw new Error('NATIVE_VISUAL_NOT_CONFIGURED');
  const {normalizeVisualConfig}=await import('./browser-visual.js');const visual=normalizeVisualConfig({...settings,actions:[]});
  const deviceFile=g.ref.deviceConfigPath||config.devices?.[g.ref.deviceName];if(!deviceFile)throw new Error('NEEDS_DEVICE_CONFIG');const device=deviceFor(deviceFile,sourceId),dc=readDevice(device),app=g.manifest.source.app?.bundle_id||g.manifest.source.app?.package_name;
  if(dc.source?.id!==sourceId||dc.source?.kind!==g.ref.kind||!app||dc.backend?.appId!==app)throw new Error('WORKFLOW_APP_IDENTITY_MISMATCH');
  if(g.ref.kind==='apk'&&dc.backend?.type==='adb'&&((dc.expectedArtifact&&(dc.expectedArtifact.kind!=='apk'||dc.expectedArtifact.sha256!==g.manifest.source.app?.apk_sha256))||(g.manifest.source.appArtifactVerified===true&&!dc.expectedArtifact)))throw new Error('ARTIFACT_BINDING_MISMATCH');
  const {observeNativeImage}=await import('./native-visual-observation.js');const found=await observeNativeImage({deviceConfigPath:device,outputDir:path.join(outputDir,'private','native-visual'),python:config.python,engine:visual.engine,language:visual.language,signal,timeoutMs:60000});
  if(found.source.id!==sourceId||found.source.kind!==g.ref.kind||current(sourceId).revision!==expectedRevision)throw new Error('SOURCE_CHANGED');
  const services=await gateway(path.join(g.dir,'private','gateway.json'));const eligible=found.tokens.filter(item=>item.confidence>=visual.minConfidence),joined=eligible.map(item=>item.text).join(' '),compact=eligible.map(item=>item.text.replace(/\s+/g,'')).join(''),hidden=services.credentials.redactor.text(compact)!==compact||services.credentials.redactor.containsObscuredSecret(joined),safe=hidden?'[REDACTED]':redactText(services.credentials.redactor.text(joined)).replace(/((?:password|passwd|secret|token|api[-_]?key|密码|口令|密钥|令牌)\s*[:：=]?\s*)\S+/gi,'$1[REDACTED]');
  const words=[];let wordsBytes=0;if(safe===joined)for(const item of eligible.slice(0,100)){const word={text:redactText(item.text),confidence:item.confidence,bounds:item.bounds},size=Buffer.byteLength(JSON.stringify(word));if(size>512||wordsBytes+size>4096)break;words.push(word);wordsBytes+=size;}
  const truncated=Buffer.byteLength(safe)>4096||safe===joined&&words.length<eligible.length;
  return {schemaVersion:1,sourceId,sourceRevision:expectedRevision,provenance:found.provenance,untrusted:true,coordinateSpace:found.coordinateSpace,capturedAt:found.capturedAt,width:found.width,height:found.height,imageSha256:found.imageSha256,text:Buffer.from(safe).subarray(0,4096).toString('utf8').replace(/\uFFFD$/,''),words,truncated,gaps:[...found.gaps,...(safe!==joined?['ocr_sensitive_content_redacted']:[]),...(truncated?['ocr_output_truncated']:[]),'screenshot_is_historical_revalidate_before_actions'],artifactVerification:found.artifactVerification,appArtifactVerified:found.appArtifactVerified};
 }
 async function workflowPlan(sourceId,args={}){const g=readGeneration(sourceId);if(!g.ref.runDir)throw new Error('BROWSER_RUN_REQUIRED');const {compileBrowserRun}=await import('./browser-capabilities.js');const proof=await compileBrowserRun({runDir:g.ref.runDir,sourceId});if(g.ref.browserSourceRevision&&proof.manifest.source.revision!==g.ref.browserSourceRevision)throw new Error('SOURCE_CHANGED：请先刷新来源');const {planBrowserWorkflows}=await import('./workflow-planner.js');return {g,plan:await planBrowserWorkflows({runDir:g.ref.runDir,sourceId,...args})};}
 async function nativeWorkflowPlan(sourceId){const g=readGeneration(sourceId),deviceFile=g.ref.deviceConfigPath||config.devices?.[g.ref.deviceName];if(!deviceFile)throw new Error('NEEDS_DEVICE_CONFIG');const device=deviceFor(deviceFile,sourceId),directory=path.join(root,'private','native-plans',randomUUID());await runPython(config,['-m','apk_inventory.mobile_planner','--config',device,'--output',directory,...(g.ref.mobileDir?['--inventory',g.ref.mobileDir]:[])],{timeoutMs:30000});const plan=artifactJson(directory,'plan.private.json');if(plan.source.id!==sourceId||plan.source.kind!==g.ref.kind)throw new Error('WORKFLOW_IDENTITY_MISMATCH');return {g,plan};}
 async function planWorkflows({sourceId,offset=0,limit=20}){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('分页参数无效');const source=current(sourceId);const {g,plan}=source.kind==='web'?await workflowPlan(sourceId,{offset,limit}):await nativeWorkflowPlan(sourceId);const {specs,...catalog}=plan;if(source.kind!=='web'){catalog.items=plan.items.slice(offset,offset+limit);catalog.nextOffset=offset+catalog.items.length<plan.items.length?offset+catalog.items.length:null;}return redact({...catalog,source:{...g.manifest.source,workflowPlanRevision:plan.source?.revision}});}
 async function bindWorkflow(args,outputDir,signal){
  try{const result=await bindWorkflowInternal(args,outputDir,signal),writeOutcome=persistedWriteOutcome(outputDir);return {...result,...(writeOutcome?{writeOutcome}:{})};}
  catch(error){const outcome=mergeWriteOutcomes(persistedWriteOutcome(outputDir),error.writeOutcome);if(outcome)error.writeOutcome=outcome;throw error;}
 }
 async function bindWorkflowInternal({sourceId,expectedRevision,specPath,candidateId,samples,outputTargetId,assertParam,resultAssertions},outputDir,signal){
  signal?.throwIfAborted();
  const g=readGeneration(sourceId);if(g.ref.revision!==expectedRevision)throw new Error('SOURCE_CHANGED');if(!!specPath===!!candidateId)throw new Error('选择specPath或candidateId之一');
  if(g.ref.kind!=='web'){
   if(!Array.isArray(samples)||samples.length<2||samples.length>5||Buffer.byteLength(JSON.stringify(samples))>65536)throw new Error('WORKFLOW_INPUT_LIMIT');let file;
   if(specPath){file=checkedArtifact(specPath,config.artifactRoots);if(!statSync(file).isFile()||statSync(file).size>524288)throw new Error('WORKFLOW_SPEC_LIMIT');}
   else{
    const {plan}=await nativeWorkflowPlan(sourceId);let spec=plan.specs?.[candidateId];if(!spec)throw new Error('WORKFLOW_CANDIDATE_NOT_FOUND');spec=clone(spec);
    const mappings=resolveResultAssertions(spec,resultAssertions,outputTargetId,assertParam);
    if(spec.branchPlan)spec=bindNativeBranchResults(spec,mappings);
    else{
     const targets=[...new Map(mappings.map(item=>[item.target.id,item.target])).values()];
     for(const {rule,target} of mappings){if(rule.representation&&rule.representation!=='value'||rule.valueMap!==undefined||rule.separator!==undefined)throw new Error('WORKFLOW_REPRESENTATION_UNSUPPORTED');spec.steps.push({kind:'assert',selector:target.selector,expect:{containsInput:rule.param,...(rule.changedFromBefore?{changed:true}:{})},timeoutMs:rule.timeoutMs??5000});}
     for(const [index,target]of targets.entries())spec.steps.push({kind:'extract',selector:target.selector,output:targets.length===1?'result':'result_'+(index+1),valueType:'string'});
     delete spec.outcomeCandidates;
    }
    file=path.join(outputDir,'workflow-spec.json');atomicJson(file,spec);
   }
   const definition=JSON.parse(readFileSync(file,'utf8'));if(specPath&&definition?.stagePlan)throw new Error('NATIVE_STAGE_SPEC_PATH_UNSUPPORTED');if(specPath&&definition?.branchPlan)throw new Error('NATIVE_BRANCH_SPEC_PATH_UNSUPPORTED');if(definition?.effect==='write')assertWorkflowPermission(config.workflowPermissions[sourceId],definition.id,{learning:true});
   const deviceFile=g.ref.deviceConfigPath||config.devices?.[g.ref.deviceName];if(!deviceFile)throw new Error('NEEDS_DEVICE_CONFIG');const original=readDevice(deviceFile),dc=effectiveDevice(original,sourceId),device=boundDevice(deviceFile,original,dc),visual=definition?.kind==='native-visual-workflow';
   if(visual){
    const app=g.manifest.source.app,approval=dc.nativeVisualWorkflow;
    const appId=g.ref.kind==='ios'?(app?.bundle_id||app?.package_name):app?.package_name;
    const platformMatches=g.ref.kind==='apk'?dc.backend?.type==='adb'&&dc.expectedArtifact?.kind==='apk'&&/^[a-f0-9]{64}$/.test(app?.apk_sha256||'')&&dc.expectedArtifact.sha256===app.apk_sha256:g.ref.kind==='ios'&&dc.backend?.type==='webdriver'&&dc.backend.platform==='ios'&&dc.expectedArtifact===undefined;
    if(!platformMatches||!appId||dc.backend.appId!==appId||dc.source?.id!==sourceId||dc.source?.kind!==g.ref.kind)throw new Error('VISUAL_APP_IDENTITY_MISMATCH');
    if(approval?.enabled!==true||!Array.isArray(approval.allowedWorkflows)||!approval.allowedWorkflows.includes(definition.id))throw new Error('VISUAL_WORKFLOW_NOT_APPROVED');
    const approvedPath=approval.approvedDefinitions?.[definition.id];let approved;
    try{if(typeof approvedPath!=='string'||!path.isAbsolute(approvedPath))throw new Error();const approvedFile=checkedArtifact(approvedPath,config.artifactRoots);if(!statSync(approvedFile).isFile()||statSync(approvedFile).size>524288)throw new Error();approved=JSON.parse(readFileSync(approvedFile,'utf8'));}catch{throw new Error('VISUAL_DEFINITION_NOT_APPROVED');}
    if(digest(canonical(approved))!==digest(canonical(definition)))throw new Error('VISUAL_DEFINITION_NOT_APPROVED');
   }
   const sampleFile=path.join(outputDir,'workflow-samples.json');atomicJson(sampleFile,samples);const directory=path.join(outputDir,'workflow'),module=visual?(g.ref.kind==='ios'?'apk_inventory.mobile_visual_ios':'apk_inventory.mobile_visual_android'):'apk_inventory.mobile_ui';await runNativePython(dc,['-m',module,'--operation','workflow-learn','--workflow',file,'--samples',sampleFile,'--output',directory],{signal});const learningResult=json(path.join(directory,'result.json'));if(learningResult.ok!==true)throw Object.assign(new Error('WORKFLOW_NOT_VALIDATED：'+String(learningResult.error?.code||learningResult.status||'failed')),{writeOutcome:publicWriteOutcome(learningResult.writeOutcome)});const learned=json(path.join(directory,'manifest.json'));if(!learned.capabilities?.some(cap=>cap.readiness==='ready'))throw new Error('WORKFLOW_NOT_VALIDATED');signal?.throwIfAborted();const id=learned.capabilities[0].id,entry={id,adapter:'mobile-workflow',directory,appIdentity:g.ref.appIdentity,deviceName:g.ref.deviceName,deviceConfigPath:device};return compileCurrent({sourceId,expectedRevision,deviceConfigPath:device,workflowEntries:[...(g.ref.workflowEntries||[]).filter(item=>item.id!==id),entry]});
  }
  if(!g.ref.runDir)throw new Error('BROWSER_RUN_REQUIRED');let file;
  if(specPath){file=checkedArtifact(specPath,config.artifactRoots);if(!statSync(file).isFile()||statSync(file).size>524288)throw new Error('WORKFLOW_SPEC_LIMIT');}
  else{let spec,offset=0;for(let page=0;page<100&&!spec;page++){const {plan}=await workflowPlan(sourceId,{offset,limit:20});spec=plan.specs?.[candidateId];if(spec||plan.nextOffset===null)break;if(plan.nextOffset<=offset)throw new Error('WORKFLOW_SPEC_LIMIT');offset=plan.nextOffset;}if(!spec)throw new Error('WORKFLOW_CANDIDATE_NOT_FOUND');spec=clone(spec);const mappings=resolveResultAssertions(spec,resultAssertions,outputTargetId,assertParam),targets=[...new Map(mappings.map(item=>[item.target.id,item.target])).values()];delete spec.outcomeCandidates;spec.steps=spec.steps.map(({kind,selector,framePath,param,value,choices,timeoutMs,selection,visual,virtual,closedShadow})=>({kind,selector,...(closedShadow?{closedShadow:clone(closedShadow)}:{}),...(visual?{visual:clone(visual)}:{}),...(virtual?{virtual:clone(virtual)}:{}),...(framePath?{framePath}:{}),...(param?{param}:{}),...(value!==undefined?{value}:{}),...(choices?{choices:clone(choices)}:{}),...(timeoutMs!==undefined?{timeoutMs}:{}),...(selection?{selection:clone(selection)}:{})}));spec.effect='read';spec.samples=samples;spec.assertions=mappings.map(({rule,target})=>({selector:target.selector,framePath:target.framePath||[],...(target.closedShadow?{closedShadow:clone(target.closedShadow)}:{}),...(target.visual?{visual:clone(target.visual)}:{}),textIncludesParam:rule.param,...(rule.representation?{paramRepresentation:rule.representation}:{}),...(rule.valueMap?{paramValueMap:rule.valueMap}:{}),...(rule.separator!==undefined?{paramSeparator:rule.separator}:{}),...(rule.timeoutMs!==undefined?{timeoutMs:rule.timeoutMs}:{}),...(rule.changedFromBefore!==undefined?{changedFromBefore:rule.changedFromBefore}:{})}));spec.extract=targets.map((target,index)=>({name:targets.length===1?'result':'result_'+(index+1),selector:target.selector,framePath:target.framePath||[],kind:target.kind,...(target.closedShadow?{closedShadow:clone(target.closedShadow)}:{}),...(target.visual?{visual:clone(target.visual)}:{})}));file=path.join(outputDir,'workflow-spec.json');atomicJson(file,spec);}
  const {compileBrowserWorkflow}=await import('./browser-workflows.js');signal?.throwIfAborted();const directory=path.join(outputDir,'workflow');const learned=await compileBrowserWorkflow({runDir:g.ref.runDir,sourceId,specFile:file,outputDir:directory,signal,permissions:config.workflowPermissions[sourceId]});signal?.throwIfAborted();if(!learned.manifest?.capabilities?.some(cap=>cap.readiness==='ready'))throw new Error('WORKFLOW_NOT_VALIDATED');const id=learned.manifest.capabilities[0].id;const entry={id,adapter:'browser-workflow',directory,runDir:g.ref.runDir};const entries=[...(g.ref.workflowEntries||[]).filter(item=>item.id!==id),entry];return compileCurrent({sourceId,expectedRevision,workflowEntries:entries});
 }
 function generate({sourceId,expectedRevision}){
  const g=readGeneration(sourceId);if(expectedRevision!==g.ref.revision)throw new Error('SOURCE_CHANGED：生成前请核对来源revision');
  const bundle=path.join(root,'generated',sourceId,g.ref.revision);mkdirSync(bundle,{recursive:true,mode:0o700});
  atomicJson(path.join(bundle,'manifest.json'),g.manifest);
  const entry=path.join(bundle,'server.mjs');const module=pathToFileURL(path.join(PROJECT_ROOT,'src/generated-mcp.js')).href;
  writeFileSync(entry,`#!/usr/bin/env node\nimport {startGeneratedMcp} from ${JSON.stringify(module)};\nawait startGeneratedMcp(${JSON.stringify({runtimeFile,sourceId,sourceRevision:g.ref.revision})});\n`,{mode:0o700});
  const client={mcpServers:{[sourceId]:{command:process.execPath,args:[entry]}}};atomicJson(path.join(bundle,'mcp-client.json'),client);
  return {sourceId,revision:g.ref.revision,capabilityCount:g.manifest.capabilities.length,bundleDir:bundle,entry,clientConfig:path.join(bundle,'mcp-client.json')};
 }
 return {root,config,runtimeFile,compile,discover,execute,generate,importSpecification,planWorkflows,bindWorkflow,observeMobile,refresh,listSources,listCapabilities,getSource:sourceId=>clone(readGeneration(sourceId).manifest.source)};
}
