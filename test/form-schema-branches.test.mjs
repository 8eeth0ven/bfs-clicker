import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from '../gateway/node_modules/ajv/dist/2020.js';
import {formSchemaBranches} from '../src/form-schema-branches.js';

const ajv=new Ajv2020({strict:false,validateFormats:false});
const active=(branches,body)=>branches.filter(branch=>ajv.compile(branch.when)(body)).map(branch=>branch.node);
const own=(nodes,name)=>nodes.filter(node=>node && Object.hasOwn(node.properties||{},name));
const code=(name)=>error=>error.code===name;

test('dependent fields activate on presence, including false, and predicates are opaque',()=>{
  const branches=formSchemaBranches({type:'object',properties:{flag:{type:'boolean'}},dependentSchemas:{flag:{properties:{payload:{type:'object'}}}}});
  assert.equal(branches.length,2);
  assert.equal(own(active(branches,{payload:'plain'}),'payload').length,0);
  assert.equal(own(active(branches,{flag:false,payload:{}}),'payload').length,1);
  assert.equal(own(active(branches,{flag:true}),'payload').length,1);
  assert.deepEqual(branches[1].when,{required:['flag']});
});

test('nested if/else inherits every parent predicate without exposing predicate fields',()=>{
  const schema={if:{properties:{mode:{const:'json'}},required:['mode']},then:{if:{required:['flag']},then:{properties:{json:{type:'object'}}},else:{properties:{empty:{type:'string'}}}},else:{properties:{plain:{type:'string'}}}};
  const branches=formSchemaBranches(schema);
  assert.equal(own(active(branches,{mode:'json',flag:false}),'json').length,1);
  assert.equal(own(active(branches,{mode:'json'}),'empty').length,1);
  assert.equal(own(active(branches,{}),'plain').length,1);
  for(const branch of branches)assert(!Object.hasOwn(branch.node.properties||{},'mode'));
  assert.equal(own(active(branches,{mode:'other',flag:true}),'json').length,0);
});

test('anyOf can activate multiple branches and oneOf conditions preserve complete schemas',()=>{
  const schema={anyOf:[{required:['a'],properties:{p:{type:'object'}}},{required:['b'],properties:{q:{type:'string'}}}],oneOf:[{required:['c'],properties:{r:{type:'array'}}},{required:['d'],properties:{s:{type:'string'}}}]};
  const branches=formSchemaBranches(schema);
  assert.equal(own(active(branches,{a:1,b:2,c:3}),'p').length,1);
  assert.equal(own(active(branches,{a:1,b:2,c:3}),'q').length,1);
  assert.equal(own(active(branches,{a:1,b:2,c:3}),'r').length,1);
  assert.equal(own(active(branches,{a:1,b:2,c:3}),'s').length,0);
  assert.deepEqual(branches[1].when,schema.anyOf[0]);
});

test('allOf preserves stable order and property/item schemas are not same-instance branches',()=>{
  const schema={title:'root',properties:{child:{allOf:[{title:'nested'}]}},items:{then:{title:'item'}},allOf:[{title:'first',allOf:[{title:'second'}]},true,false],then:{title:'orphan'}};
  const branches=formSchemaBranches(schema);
  assert.deepEqual(branches.map(branch=>typeof branch.node==='object'?branch.node.title:branch.node),['root','first','second',true,false]);
  assert(branches.every(branch=>branch.when===true));
  assert(!Object.hasOwn(branches[0].node,'then'));
  assert.deepEqual(branches[0].node.properties,schema.properties);
  assert.deepEqual(formSchemaBranches(false),[{when:true,node:false}]);
  assert.deepEqual(formSchemaBranches({if:false,then:true,else:true}).map(branch=>branch.when),[true,false,true]);
});

test('clones inputs and branches so consumers cannot change source or sibling contracts',()=>{
  const schema={if:{required:['a']},then:{allOf:[{properties:{p:{type:'string'}}}]}};
  const before=structuredClone(schema),branches=formSchemaBranches(schema);
  branches[1].when.required.push('b');branches[2].node.properties.p.type='number';
  assert.deepEqual(schema,before);
  assert.deepEqual(branches[2].when,{required:['a']});
});

test('branch count and composition depth limits throw rather than truncate successful output',()=>{
  const schema={allOf:Array.from({length:127},()=>true)};
  assert.equal(formSchemaBranches(schema).length,128);
  assert.throws(()=>formSchemaBranches({allOf:[...schema.allOf,true]}),code('FORM_SCHEMA_BRANCH_LIMIT'));
  assert.throws(()=>formSchemaBranches(schema,{maxBranches:127}),code('FORM_SCHEMA_BRANCH_LIMIT'));
  for(const n of [0,-1,1.5,Infinity,100001])assert.throws(()=>formSchemaBranches(true,{maxBranches:n}),code('FORM_SCHEMA_BRANCH_LIMIT'));
  let deep=true;for(let n=0;n<129;n++)deep={allOf:[deep]};
  assert.throws(()=>formSchemaBranches(deep,{maxBranches:1000}),code('FORM_SCHEMA_BRANCH_LIMIT'));
});

test('unresolved references are rejected wherever they remain in the JSON document',()=>{
  for(const key of ['$ref','$dynamicRef','$recursiveRef'])for(const schema of [{[key]:'#/x'},{properties:{child:{[key]:'#/x'}}},{items:{[key]:'#/x'}}])assert.throws(()=>formSchemaBranches(schema),code('FORM_SCHEMA_REFERENCE_UNRESOLVED'));
});

test('rejects unsafe non-JSON inputs without invoking accessors',()=>{
  let accessed=0;const getter={};Object.defineProperty(getter,'if',{enumerable:true,get(){accessed++;return true;}});
  const cycle={};cycle.self=cycle;
  const invalid=[getter,cycle,new Date(),{x:undefined},{x:NaN},{x:Infinity},{x:1n},{x:()=>true},{x:Symbol('x')},JSON.parse('{"properties":{"__proto__":{}}}'),JSON.parse('{"constructor":{}}'),{[Symbol('x')]:true},Object.create({inherited:true}),{allOf:{}},{if:1},{dependentSchemas:[]},{allOf:[1]},{sparse:Array(2)}];
  for(const value of invalid)assert.throws(()=>formSchemaBranches(value),code('FORM_SCHEMA_INVALID'));
  assert.equal(accessed,0);
});
