// Enumerate schemas that constrain the same body instance. Child property/item
// schemas remain opaque; condition predicates must never become field evidence.
const composition = new Set(['allOf','anyOf','oneOf','if','then','else','dependentSchemas']);
const forbidden = new Set(['__proto__','prototype','constructor']);
const references = new Set(['$ref','$dynamicRef','$recursiveRef']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
function fail(code,message) {const error=new Error(message);error.code=code;throw error;}

function jsonClone(value, ancestors=new Set(), depth=0, budget={nodes:0}) {
  if(depth>512 || ++budget.nodes>100000)fail('FORM_SCHEMA_BRANCH_LIMIT','Form schema exceeds traversal budget');
  if(value===null || typeof value==='boolean' || typeof value==='string')return value;
  if(typeof value==='number' && Number.isFinite(value))return value;
  if(!Array.isArray(value) && !plain(value))fail('FORM_SCHEMA_INVALID','Form schema must contain plain JSON values');
  if(ancestors.has(value))fail('FORM_SCHEMA_INVALID','Form schema is cyclic');
  ancestors.add(value);
  const array=Array.isArray(value),result=array?[]:Object.create(null),keys=Reflect.ownKeys(value);
  for(const key of keys) {
    if(array && key==='length')continue;
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string' || forbidden.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value'))fail('FORM_SCHEMA_INVALID','Form schema contains unsafe JSON members');
    if(array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key)>=value.length))fail('FORM_SCHEMA_INVALID','Form schema array has non-JSON members');
    if(references.has(key))fail('FORM_SCHEMA_REFERENCE_UNRESOLVED','Form schema references must be resolved before branch inference');
    result[key]=jsonClone(descriptor.value,ancestors,depth+1,budget);
  }
  if(array && Object.keys(result).length!==value.length)fail('FORM_SCHEMA_INVALID','Form schema arrays must not be sparse');
  ancestors.delete(value);
  return result;
}
const and=(left,right)=>left===false || right===false?false:left===true?right:right===true?left:{allOf:[left,right]};
const not=value=>typeof value==='boolean'?!value:{not:value};

export function formSchemaBranches(schema,{maxBranches=128}={}) {
  if(!Number.isSafeInteger(maxBranches) || maxBranches<1 || maxBranches>100000)fail('FORM_SCHEMA_BRANCH_LIMIT','Invalid form branch budget');
  const source=jsonClone(schema),output=[];
  const visit=(node,when,depth)=>{
    if(depth>128 || output.length>=maxBranches)fail('FORM_SCHEMA_BRANCH_LIMIT','Form schema branch budget exceeded');
    if(typeof node!=='boolean' && !plain(node))fail('FORM_SCHEMA_INVALID','Expected a schema object or boolean');
    const projected=typeof node==='boolean'?node:Object.fromEntries(Object.entries(node).filter(([key])=>!composition.has(key)));
    output.push({when:structuredClone(when),node:structuredClone(projected)});
    if(typeof node==='boolean')return;
    for(const key of ['allOf','anyOf','oneOf']) {
      if(!Object.hasOwn(node,key))continue;
      if(!Array.isArray(node[key]))fail('FORM_SCHEMA_INVALID','Schema composition must be an array');
      for(const branch of node[key])visit(branch,key==='allOf'?when:and(when,branch),depth+1);
    }
    if(Object.hasOwn(node,'if')) {
      if(typeof node.if!=='boolean' && !plain(node.if))fail('FORM_SCHEMA_INVALID','Expected a schema condition');
      if(Object.hasOwn(node,'then'))visit(node.then,and(when,node.if),depth+1);
      if(Object.hasOwn(node,'else'))visit(node.else,and(when,not(node.if)),depth+1);
    }
    if(Object.hasOwn(node,'dependentSchemas')) {
      if(!plain(node.dependentSchemas))fail('FORM_SCHEMA_INVALID','dependentSchemas must be an object');
      for(const [name,branch]of Object.entries(node.dependentSchemas))visit(branch,and(when,{required:[name]}),depth+1);
    }
  };
  visit(source,true,0);
  return output;
}
