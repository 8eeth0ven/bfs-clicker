import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {importOpenApi} from '../src/openapi-discovery.js';
const require=createRequire(new URL('../gateway/package.json',import.meta.url)),Ajv=require('ajv/dist/2020.js').default;
const origin='https://api.example.invalid';
const document=(schema,encoding,openapi='3.1.1')=>({openapi,servers:[{url:origin}],paths:{'/upload':{post:{requestBody:{required:true,content:{'multipart/form-data':{schema,...(encoding?{encoding}:{})}}}}}}});
const load=doc=>importOpenApi({sourceId:'upload',document:doc,allowedOrigins:[origin]});
const validator=result=>new Ajv({strict:false,validateFormats:false}).compile(Object.values(result.schemaOverrides)[0]);
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
test('OpenAPI3.1 raw binary and3.0 binary format produce constrained inline carrier contracts',()=>{
 for(const [version,file]of [['3.1.1',{}],['3.0.3',{type:'string',format:'binary'}]]){
  const result=load(document(object({title:{type:'string',minLength:1},upload:file,files:{type:'array',items:file}}),{upload:{contentType:'image/png'}},version));assert.equal(result.manifest[0].readiness,'ready');
  assert.equal(result.manifest[0].multipart_serialization.fields.upload.contentType,'image/png');assert.equal(result.manifest[0].multipart_serialization.fields.files.array,true);
  const validate=validator(result),valid={body:{title:'text',upload:{filename:'sample.png',base64:'AA=='},files:[{filename:'empty.bin',base64:''}]}};assert(validate(valid),JSON.stringify(validate.errors));
  for(const bad of [{...valid,body:{...valid.body,upload:{filename:'../x',base64:'AA=='}}},{...valid,body:{...valid.body,upload:{path:'/etc/passwd'}}},{...valid,body:{...valid.body,files:[]}}])assert.equal(validate(bad),false);
 }
});
test('typed legacy binary in3.1, file constraints, transfer encodings and complex fields stay candidate',()=>{
 const cases=[object({upload:{type:'string',format:'binary'}}),object({upload:{contentEncoding:'base64'}}),object({upload:{type:'object'}}),object({upload:{type:['string','null']}}),{allOf:[object({upload:{}})]},object({upload:{type:'array',items:{},uniqueItems:true}})];
 for(const schema of cases){const result=load(document(schema));assert.equal(result.manifest[0].readiness,'candidate');assert.equal(validator(result)({body:{upload:{filename:'x',base64:''}}}),false);assert.equal(result.manifest[0].multipart_serialization,undefined);}
 const constrained=load(document(object({upload:{type:'string',format:'binary',maxLength:10}}),undefined,'3.0.3'));assert.equal(constrained.manifest[0].readiness,'candidate');
});
test('part headers, unsupported MIME and RFC6570 encodings never silently select an upload wire format',()=>{
 for(const encoding of [{upload:{contentType:'image/*'}},{upload:{contentType:'image/png, image/jpeg'}},{upload:{contentType:'image/png; x=y'}},{upload:{contentType:'image/png\r\nX: y'}},{upload:{contentType:'multipart/mixed'}},{upload:{headers:{'X-Test':{schema:{type:'string'}}}}},{upload:{style:'form'}},{upload:{explode:false}},{missing:{contentType:'image/png'}}]){
  const result=load(document(object({upload:{}}),encoding));assert.equal(result.manifest[0].readiness,'candidate');assert.equal(result.manifest[0].multipart_serialization,undefined);
 }
});
test('all supported fields are finite, validated and free from copied raw file examples',()=>{
 for(const schema of [object(Object.fromEntries(Array.from({length:17},(_,i)=>['field'+i,{type:'string'}]))),object({'bad"name':{}}),object({upload:{type:'array',items:{},minItems:9}}),object({title:{type:'string',maxLength:'wrong'}}),{type:'object',minProperties:2,properties:{upload:{},serverOnly:{readOnly:true}}}])assert.equal(load(document(schema)).manifest[0].readiness,'candidate');
 const result=load(document({type:'object',properties:{title:{type:'string'},upload:{example:'do-not-copy-upload',default:'do-not-copy-upload'},serverOnly:{readOnly:true}},required:['upload','serverOnly']}));assert.equal(result.manifest[0].readiness,'ready');assert(!JSON.stringify(result).includes('do-not-copy-upload'));assert(!Object.hasOwn(result.manifest[0].multipart_serialization.fields,'serverOnly'));const body=Object.values(result.schemaOverrides)[0].properties.body;assert.deepEqual(body.required,['upload']);assert.equal(body.additionalProperties,false);assert(result.warnings.includes('multipart_only_declared_fields_supported'));
});
test('existing JSON media selection and GET-body rejection retain their behavior',()=>{
 const source=document(object({upload:{}}));source.paths['/upload'].post.requestBody.content['application/json']={schema:{type:'object',properties:{q:{type:'string'}}}};const chosen=load(source);assert.equal(chosen.manifest[0].headers['content-type'],'application/json');assert.equal(chosen.manifest[0].multipart_serialization,undefined);
 const get=document(object({upload:{}}));get.paths['/upload'].get=get.paths['/upload'].post;delete get.paths['/upload'].post;const result=load(get);assert.equal(result.manifest[0].readiness,'candidate');assert(result.gaps.some(x=>x.reason==='request_body_not_supported_for_method'));assert.equal(result.manifest[0].multipart_serialization,undefined);
});
