// Formal API declarations are candidates, never observations. This module does no I/O.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { redactText, redactUrl } from './redact.js';
import { formSchemaBranches } from './form-schema-branches.js';

const require = createRequire(import.meta.url);
const METHODS = new Set(['get','head','post','put','patch','delete','options']);
const FORBIDDEN = new Set(['__proto__','prototype','constructor']);
const SCALARS = new Set(['string','integer','number','boolean','null']);
const SIMPLE = new Set(['type','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','format','minItems','maxItems','uniqueItems','minProperties','maxProperties','minContains','maxContains','dependentRequired','readOnly','writeOnly']);
const CHILD = new Set(['items','contains','not','if','then','else','propertyNames','additionalProperties','unevaluatedProperties','unevaluatedItems']);
const LIST = new Set(['allOf','anyOf','oneOf','prefixItems']);
const MAP = new Set(['properties','patternProperties','dependentSchemas']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fail = (code,message) => { throw Object.assign(new Error(message),{code}); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const endpointId = (source,origin,pathname) => 'ep_' + digest(['endpoint-v1',source,origin,pathname]);
const objectSchema = () => ({type:'object',properties:Object.create(null),additionalProperties:false});
const readOnlySchema = value => plain(value) && (value.readOnly === true || Array.isArray(value.allOf) && value.allOf.some(readOnlySchema));
const scrub = value => redactText(String(value ?? '')).slice(0,1000);
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !FORBIDDEN.has(value) && !/[\x00-\x1f]/.test(value);
const credentialConstant = value => Array.isArray(value)?value.some(credentialConstant):plain(value)?Object.entries(value).some(([key,item])=>/password|passwd|secret|token|api[-_]?key|authorization|cookie|session.?id/i.test(key)||credentialConstant(item)):false;

function parseInput(input) {
  let document = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) fail('DOCUMENT_LIMIT','规范文本超过8MiB');
    try { document = JSON.parse(input); }
    catch {
      let yaml; try { yaml = require('yaml'); } catch { try { yaml = createRequire(new URL('../gateway/package.json',import.meta.url))('yaml'); } catch { fail('YAML_UNAVAILABLE','需要安装yaml依赖才能导入YAML规范'); } }
      try { const parsed = yaml.parseDocument(input,{uniqueKeys:true}); if(parsed.errors.length) throw new Error(); document = parsed.toJS({maxAliasCount:32}); }
      catch { fail('DOCUMENT_PARSE_FAILED','规范不是有效或预算内的JSON/YAML'); }
    }
  }
  let count=0; const active=new Set();
  const check=(value,depth=0)=>{
    if(++count>100000||depth>64)fail('DOCUMENT_LIMIT','规范结构超过节点或深度上限');
    if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
    if(!Array.isArray(value)&&!plain(value))fail('DOCUMENT_INVALID','规范必须只包含JSON数据');
    if(active.has(value))fail('DOCUMENT_CYCLE','规范包含循环对象或YAML别名'); active.add(value);
    for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){if(descriptor.get||descriptor.set)fail('DOCUMENT_INVALID','规范不能包含访问器');if(descriptor.enumerable)check(descriptor.value,depth+1);}
    active.delete(value);
  }; check(document);
  if(!plain(document))fail('DOCUMENT_INVALID','规范根节点必须为对象');
  if(Buffer.byteLength(JSON.stringify(document))>8*1024*1024)fail('DOCUMENT_LIMIT','规范超过8MiB');
  return clone(document);
}

/** Import a supplied document only; no URL is fetched, including external $ref. */
export function importOpenApi({document:input,documentUrl,sourceId,allowedOrigins=[],maxOperations=1000}={}) {
  if(typeof sourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sourceId))fail('INVALID_SOURCE','sourceId无效');
  if(!Number.isSafeInteger(maxOperations)||maxOperations<1||maxOperations>10000)fail('INVALID_LIMIT','maxOperations必须为1–10000');
  if(!Array.isArray(allowedOrigins))fail('INVALID_ORIGINS','allowedOrigins必须为精确origin数组');
  const allowed=new Set(allowedOrigins.map(value=>{let url;try{url=new URL(value)}catch{fail('INVALID_ORIGINS','origin无效')}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==value)fail('INVALID_ORIGINS','只接受无凭据的精确HTTP(S) origin');return value;}));
  let base;
  if(documentUrl!=null){try{base=new URL(documentUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new Error()}catch{fail('INVALID_DOCUMENT_URL','documentUrl必须为无凭据HTTP(S)地址');}}
  const doc=parseInput(input),swagger=doc.swagger==='2.0',v31=/^3\.1\.\d+(?:[-+].*)?$/.test(doc.openapi||'');
  if(!swagger&&!v31&&!/^3\.0\.\d+(?:[-+].*)?$/.test(doc.openapi||''))fail('VERSION_UNSUPPORTED','仅支持OpenAPI3.0/3.1或Swagger2.0');
  const manifest=[],schemaOverrides=Object.create(null),origins=new Set(),gaps=[],warnings=[],seen=new Map(); let expanded=0,operations=0;
  const gap=(ctx,reason,extra={})=>{const item={reason,...ctx.location,...extra};gaps.push(item);ctx.problems.add(reason);};
  const warn=(reason)=>{if(!warnings.includes(reason))warnings.push(reason);};
  const rootCtx={location:{},problems:new Set()};
  const pointer=(ref,ctx)=>{
    if(typeof ref!=='string'||!ref.startsWith('#')){gap(ctx,'external_ref_not_loaded',{reference:scrub(ref)});return null;}
    let decoded;try{decoded=decodeURIComponent(ref.slice(1))}catch{gap(ctx,'invalid_local_ref');return null;}
    if(decoded!==''&&!decoded.startsWith('/')){gap(ctx,'unsupported_local_anchor',{reference:scrub(ref)});return null;}
    let node=doc;
    for(const part of decoded===''?[]:decoded.slice(1).split('/').map(value=>value.replace(/~1/g,'/').replace(/~0/g,'~'))){if(FORBIDDEN.has(part)||!node||typeof node!=='object'||!Object.hasOwn(node,part)){gap(ctx,'local_ref_missing',{reference:scrub(ref)});return null;}node=node[part];}
    return node;
  };
  const deref=(value,ctx,stack=[])=>{
    if(!plain(value))return value;
    if(!Object.hasOwn(value,'$ref'))return value;
    if(stack.length>=32||stack.includes(value.$ref)){gap(ctx,'cyclic_or_deep_ref');return null;}
    const target=pointer(value.$ref,ctx);if(target===null)return null;
    const result=deref(target,ctx,[...stack,value.$ref]);
    if(Object.keys(value).some(key=>key!=='$ref'&&!['summary','description'].includes(key)))warn('reference_object_siblings_ignored');
    return result;
  };
  const schema=(raw,ctx,stack=[],depth=0)=>{
    if(++expanded>200000||depth>48){gap(ctx,'schema_expansion_limit');return false;}
    if(typeof raw==='boolean'){if(!v31){gap(ctx,'boolean_schema_requires_openapi31');return false;}return raw;}
    if(!plain(raw)){gap(ctx,'invalid_schema');return false;}
    if(Object.hasOwn(raw,'$ref')){
      if(stack.length>=32||stack.includes(raw.$ref)){gap(ctx,'cyclic_or_deep_ref');return false;}
      const target=pointer(raw.$ref,ctx);if(target===null)return false;
      const resolved=schema(target,ctx,[...stack,raw.$ref],depth+1);
      const siblings=Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='$ref'));
      if(v31&&Object.keys(siblings).length){const refined=schema(siblings,ctx,stack,depth+1);return plain(refined)&&!Object.keys(refined).length?resolved:{allOf:[resolved,refined]};}
      return resolved;
    }
    const out=Object.create(null),readOnly=new Set();
    for(const [name,value]of Object.entries(raw)){
      if(['default','example','examples','description','title','$schema','$defs','definitions','nullable','deprecated','xml','externalDocs','discriminator'].includes(name)||name.startsWith('x-'))continue;
      if(['$id','$anchor','$dynamicAnchor','$dynamicRef','$recursiveRef'].includes(name)){gap(ctx,'unsupported_schema_resource_or_dynamic_ref');continue;}
      if(SIMPLE.has(name)){
        if(['enum','const'].includes(name)&&credentialConstant(value)){gap(ctx,'credential_input_requires_binding');return false;}
        if(name==='pattern'&&(typeof value!=='string'||value.length>512)){gap(ctx,'pattern_limit');continue;}
        if(name==='type'&&(!(typeof value==='string'||v31&&Array.isArray(value))||(Array.isArray(value)?value:[value]).some(type=>!['string','number','integer','boolean','null','object','array'].includes(type)))){gap(ctx,'unsupported_schema_type');continue;}
        out[name]=clone(value);
      }
      else if(CHILD.has(name))out[name]=name==='additionalProperties'&&typeof value==='boolean'?value:schema(value,ctx,stack,depth+1);
      else if(LIST.has(name)){if(!Array.isArray(value)||value.length>64){gap(ctx,'invalid_schema_composition');continue;}out[name]=value.map(item=>schema(item,ctx,stack,depth+1));}
      else if(MAP.has(name)){
        if(!plain(value)||Object.keys(value).length>500){gap(ctx,'schema_properties_limit');continue;}
        out[name]=Object.create(null);
        for(const [key,item]of Object.entries(value)){
          if(!safeName(key)){gap(ctx,'invalid_parameter_name');continue;}
          if(name==='properties'&&plain(item)&&item.readOnly===true){out[name][key]=false;readOnly.add(key);continue;}
          out[name][key]=schema(item,ctx,stack,depth+1);
          if(name==='properties'&&readOnlySchema(out[name][key])){out[name][key]=false;readOnly.add(key);continue;}
          if(/password|passwd|secret|token|api[-_]?key|authorization|cookie/i.test(key)){const type=plain(out[name][key])&&out[name][key].type;out[name][key]=typeof type==='string'?{type}:{};gap(ctx,'credential_input_requires_binding');}
        }
      }else if(name==='required'){
        if(!Array.isArray(value)||value.some(item=>!safeName(item))){gap(ctx,'invalid_required');continue;}out.required=[...new Set(value)];
      }else if(['contentEncoding','contentMediaType','contentSchema'].includes(name)){gap(ctx,'unsupported_content_encoding');}
      else gap(ctx,'unsupported_schema_keyword',{keyword:scrub(name)});
    }
    if(out.required)out.required=out.required.filter(name=>!readOnly.has(name));
    if(!v31&&raw.nullable===true&&out.type)out.type=[...new Set([...(Array.isArray(out.type)?out.type:[out.type]),'null'])];
    if(!v31)for(const key of ['exclusiveMinimum','exclusiveMaximum'])if(typeof out[key]==='boolean'){const bound=key==='exclusiveMinimum'?'minimum':'maximum';if(out[key]&&typeof out[bound]==='number'){out[key]=out[bound];delete out[bound];}else delete out[key];}
    return out;
  };
  const scalarSchema=s=>plain(s)&&(SCALARS.has(s.type)||Array.isArray(s.type)&&s.type.every(type=>SCALARS.has(type))||Array.isArray(s.enum)&&s.enum.every(value=>value===null||['string','number','boolean'].includes(typeof value))||['anyOf','oneOf'].some(key=>Array.isArray(s[key])&&s[key].every(scalarSchema))||Array.isArray(s.allOf)&&s.allOf.some(scalarSchema));
  const pathSchema=s=>plain(s)&&(typeof s.type==='string'?['string','number','integer'].includes(s.type):Array.isArray(s.type)?s.type.every(type=>['string','number','integer'].includes(type)):Array.isArray(s.enum)?s.enum.every(value=>['string','number'].includes(typeof value)):['anyOf','oneOf'].some(key=>Array.isArray(s[key])&&s[key].every(pathSchema))||Array.isArray(s.allOf)&&s.allOf.some(pathSchema));
  const arraySchema=s=>!plain(s)?null:s.type==='array'?s:(s.allOf||[]).map(arraySchema).find(Boolean)||null;
  const declaredKinds=(value,depth=0)=>!plain(value)||depth>24?[]:[...(value.type==null?[]:Array.isArray(value.type)?value.type:[value.type]).map(type=>type==='object'?'object':type==='array'?'array':SCALARS.has(type)?'scalar':'unknown'),...(value.allOf||[]).flatMap(branch=>declaredKinds(branch,depth+1))];
  const queryKind=(value,inherited=null,depth=0)=>{
    if(!plain(value)||depth>24)return null;
    const kinds=new Set(declaredKinds(value));
    if(kinds.size>1||kinds.has('unknown'))return null;
    let kind=[...kinds][0]||inherited;
    if(!kind&&Array.isArray(value.enum)&&value.enum.every(item=>item===null||['string','boolean','number'].includes(typeof item)))kind='scalar';
    if(!kind&&Object.hasOwn(value,'const')&&(value.const===null||['string','boolean','number'].includes(typeof value.const)))kind='scalar';
    for(const key of ['allOf','anyOf','oneOf'])if(Array.isArray(value[key]))for(const branch of value[key]){const next=queryKind(branch,kind,depth+1);if(!next||kind&&kind!==next)return null;kind??=next;}
    return kind;
  };
  const queryBranches=(value)=>[value,...['allOf','anyOf','oneOf'].flatMap(key=>(value[key]||[]).flatMap(queryBranches)),...['then','else'].filter(key=>plain(value[key])).flatMap(key=>queryBranches(value[key])),...Object.values(value.dependentSchemas||{}).flatMap(queryBranches)];
  const queryContract=(value,parameter,ctx)=>{
    const kind=queryKind(value),branches=plain(value)?queryBranches(value):[],array=kind==='array',object=kind==='object';
    const scalarOnly=item=>queryKind(item)==='scalar';
    if(!kind||array&&(!branches.some(branch=>branch.items)||branches.some(branch=>branch.items!==undefined&&branch.items!==false&&!scalarOnly(branch.items)||(branch.prefixItems||[]).some(item=>item!==false&&!scalarOnly(item))||branch.contains&&(branch.minContains??1)>0&&['object','array'].includes(queryKind(branch.contains))))||object&&branches.some(branch=>Object.values(branch.properties||{}).some(item=>item!==false&&!scalarOnly(item))||Object.values(branch.patternProperties||{}).some(item=>item!==false&&!scalarOnly(item))||plain(branch.additionalProperties)&&!scalarOnly(branch.additionalProperties))){gap(ctx,'unsupported_query_shape');return null;}
    let style=parameter.style===undefined?'form':parameter.style,explode=parameter.explode===undefined?(style==='form'):parameter.explode;
    if(swagger){const formats={multi:['form',true],csv:['form',false],ssv:['spaceDelimited',false],tsv:['tabDelimited',false],pipes:['pipeDelimited',false]},name=parameter.collectionFormat===undefined?'csv':parameter.collectionFormat;const format=typeof name==='string'&&Object.hasOwn(formats,name)?formats[name]:null;if(kind==='array'&&!format){gap(ctx,'unsupported_query_serialization');return null;}[style,explode]=kind==='array'?format:['form',true];}
    if(typeof explode!=='boolean'||parameter.allowReserved!==undefined&&typeof parameter.allowReserved!=='boolean'||parameter.allowReserved===true||!(style==='form'||style==='deepObject'&&kind==='object'&&explode||['spaceDelimited','pipeDelimited'].includes(style)&&kind!=='scalar'&&!explode||swagger&&style==='tabDelimited'&&kind==='array'&&!explode)){gap(ctx,'unsupported_query_serialization');return null;}
    if(kind==='scalar')explode=true;
    const rule={style,explode,kind},scalars={type:['string','number','integer','boolean','null']};
    // Shallow object representations have no nested-object/array meaning in
    // OpenAPI. Keep the declared constraints and expose this supported domain.
    let supported=array?{allOf:[value,{type:'array',maxItems:1000,items:scalars}]}:value;
    if(object){
      const propertyNames={not:{enum:[...FORBIDDEN]}};
      if(style==='deepObject')propertyNames.not={anyOf:[{enum:[...FORBIDDEN]},{pattern:'[\\[\\]\\u0000-\\u001f]'}]};
      if(style==='deepObject'&&(/[\[\]]/.test(parameter.name)||branches.some(branch=>Object.keys(branch.properties||{}).some(name=>/[\[\]]/.test(name))))){gap(ctx,'unsupported_deep_object_name');return null;}
      supported={allOf:[value,{type:'object',maxProperties:1000,additionalProperties:scalars,propertyNames}]};
    }
    const delimiter=style==='spaceDelimited'?' ':style==='pipeDelimited'?'|':style==='tabDelimited'?'\t':null;
    if(delimiter){const noDelimiter={not:{pattern:delimiter==='|'?'\\|':delimiter}},atom={anyOf:[{type:'number'},{type:'boolean'},{type:'null'},{allOf:[{type:'string'},noDelimiter]}]};supported={allOf:[supported,kind==='array'?{items:atom}:{additionalProperties:atom,propertyNames:noDelimiter}]};}
    return {rule,schema:supported};
  };
  const formContract=(value,encodings,formParameters,ctx)=>{
    if(queryKind(value)!=='object'){gap(ctx,'unsupported_form_encoding');return null;}
    if(encodings!==undefined&&!plain(encodings)){gap(ctx,'invalid_form_encoding');return null;}
    let sameInstance;try{sameInstance=formSchemaBranches(value);}catch(error){gap(ctx,error.code||'unsupported_form_encoding');return null;}
    const groups=new Map(),scalar={type:['string','number','integer','boolean','null']},fallback={anyOf:[scalar,{type:'array',maxItems:1000,items:{type:['string','number','integer','boolean']}}]};
    for(const branch of sameInstance){if(branch.when===false||!plain(branch.node))continue;const key=JSON.stringify(canonical(branch.when));if(!groups.has(key))groups.set(key,{when:branch.when,nodes:[]});groups.get(key).nodes.push(branch.node);}
    const base=groups.get('true')||{when:true,nodes:[]},conditional=[...groups.values()].filter(group=>group.when!==true),allNames=new Set(sameInstance.flatMap(branch=>Object.keys(branch.node?.properties||{})));
    for(const name of Object.keys(encodings||{}))if(!allNames.has(name))gap(ctx,'form_encoding_property_missing');
    // Additional/unevaluated rules depend on annotation propagation across
    // active branches. Do not promote a conditional rule to an unconditional
    // encoding while that evaluation path is not represented.
    if(conditional.some(group=>group.nodes.some(node=>Object.hasOwn(node,'additionalProperties')||Object.hasOwn(node,'unevaluatedProperties')||Object.keys(node.patternProperties||{}).length)))gap(ctx,'unsupported_conditional_form_evaluation');
    const forField=(name,property,encoding={})=>{
      if(!plain(encoding)||Object.keys(encoding).some(key=>!['style','explode','allowReserved','contentType','headers'].includes(key)&&!key.startsWith('x-'))||encoding.style!==undefined&&typeof encoding.style!=='string'||encoding.allowReserved!==undefined&&typeof encoding.allowReserved!=='boolean'||encoding.contentType!==undefined&&typeof encoding.contentType!=='string'){gap(ctx,'invalid_form_encoding');return null;}
      if(encoding.headers)warn('form_encoding_headers_ignored');
      const stripNullable=item=>{
        if(!plain(item))return item;
        if(item.type==='null'||Object.hasOwn(item,'const')&&item.const===null||Array.isArray(item.enum)&&item.enum.length&&item.enum.every(value=>value===null))return false;
        const result={...item};if(Array.isArray(item.type)){result.type=item.type.filter(type=>type!=='null');if(!result.type.length)return false;}
        for(const key of ['allOf','anyOf','oneOf'])if(Array.isArray(item[key]))result[key]=item[key].map(stripNullable).filter(branch=>key==='allOf'||branch!==false);
        return result;
      };
      const withoutNullable=stripNullable(property);
      const kind=queryKind(withoutNullable),styleBased=swagger||['style','explode','allowReserved'].some(key=>Object.hasOwn(encoding,key));
      if(!v31&&queryBranches(property).some(branch=>['binary','byte','file'].includes(branch.format))){gap(ctx,'unsupported_form_binary_encoding');return null;}
      if(styleBased){
        const source=swagger?(formParameters.get(name)||{}):encoding,wire=queryContract(property,{name,...source},ctx);if(!wire)return null;
        if(encoding.contentType)warn('form_content_type_ignored_for_style');
        const simple=kind==='array'?{type:'array',items:scalar}:kind==='object'?{type:'object',additionalProperties:scalar}:scalar,domain=queryContract(simple,{name,...source},ctx);
        return {rule:{mode:'style',...wire.rule},domain:domain?.schema||simple};
      }
      let media=encoding.contentType;
      if(media===undefined){if(kind==='object')media='application/json';else if(kind==='array'){const items=queryBranches(property).map(branch=>branch.items).filter(item=>plain(item));const itemKind=items.length?queryKind(items.length===1?items[0]:{allOf:items}):null;media=itemKind==='scalar'?'text/plain':['object','array'].includes(itemKind)?'application/json':null;}else if(kind==='scalar')media='text/plain';}
      if(media==='application/json')return {rule:{mode:'content',contentType:media,kind:'json'},domain:true};
      if(media==='text/plain'&&kind==='scalar')return {rule:{mode:'content',contentType:media,kind:'scalar'},domain:scalar};
      if(media==='text/plain'&&kind==='array'){const wire=queryContract(property,{name,style:'form',explode:true},ctx);if(wire)return {rule:{mode:'content',contentType:media,kind:'array'},domain:{type:'array',maxItems:1000,items:scalar}};return null;}
      gap(ctx,'unsupported_form_content_type');return null;
    };
    const infer=(nodes,{conditionalGroup=false,inheritedNodes=[]}={})=>{
      const properties=new Map(),patternSchemas=new Map(),fields=Object.create(null),domains=Object.create(null),patternDomains=Object.create(null),patterns=[];
      for(const node of nodes)for(const [name,item]of Object.entries(node.properties||{})){if(item===false)continue;if(!properties.has(name))properties.set(name,[]);properties.get(name).push(item);}
      for(const node of nodes)for(const [pattern,item]of Object.entries(node.patternProperties||{})){if(item===false)continue;if(!patternSchemas.has(pattern))patternSchemas.set(pattern,[]);patternSchemas.get(pattern).push(item);}
      for(const [pattern,variants]of patternSchemas){const encoded=forField('pattern',variants.length===1?variants[0]:{allOf:variants});if(encoded){patterns.push({pattern,rule:encoded.rule});patternDomains[pattern]=encoded.domain;}}
      for(const [name,original]of properties){
        const inherited=inheritedNodes.flatMap(node=>[...(Object.hasOwn(node.properties||{},name)?[node.properties[name]]:[]),...Object.entries(node.patternProperties||{}).filter(([pattern])=>new RegExp(pattern).test(name)).map(([,item])=>item),...(!Object.hasOwn(node.properties||{},name)&&!Object.keys(node.patternProperties||{}).some(pattern=>new RegExp(pattern).test(name))&&plain(node.additionalProperties)?[node.additionalProperties]:[])]);
        const variants=[...original,...inherited,...[...patternSchemas].filter(([pattern])=>new RegExp(pattern).test(name)).flatMap(([,items])=>items),...nodes.filter(node=>!Object.hasOwn(node.properties||{},name)&&!Object.keys(node.patternProperties||{}).some(pattern=>new RegExp(pattern).test(name))&&plain(node.additionalProperties)).map(node=>node.additionalProperties)];
        const property=variants.length===1?variants[0]:{allOf:variants};
        if(!conditionalGroup&&!queryKind(property)&&conditional.some(group=>group.nodes.some(node=>Object.hasOwn(node.properties||{},name)))&&!Object.hasOwn(encodings||{},name))continue;
        const encoded=forField(name,property,encodings&&Object.hasOwn(encodings,name)?encodings[name]:undefined);if(encoded){fields[name]=encoded.rule;domains[name]=encoded.domain;}
      }
      const evaluatedAll=nodes.some(node=>Object.hasOwn(node,'additionalProperties'));
      const extra=nodes.flatMap(node=>[node.additionalProperties,...(!evaluatedAll?[node.unevaluatedProperties]:[])]).filter(item=>plain(item)),additional=extra.length?forField('additional',extra.length===1?extra[0]:{allOf:extra}):null;
      return {rules:{fields,...(additional?{additional:additional.rule}:{}),...(patterns.length?{patterns}:{})},domains,patternDomains,additionalDomain:additional?.domain??fallback};
    };
    const implies=(child,parent)=>parent===true||JSON.stringify(canonical(child))===JSON.stringify(canonical(parent))||plain(child)&&Array.isArray(child.allOf)&&child.allOf.some(item=>implies(item,parent));
    const fixed=infer(base.nodes),dynamic=conditional.map(group=>({when:group.when,...infer(group.nodes,{conditionalGroup:true,inheritedNodes:[...base.nodes,...conditional.filter(ancestor=>ancestor!==group&&implies(group.when,ancestor.when)).flatMap(ancestor=>ancestor.nodes)]})})),domains=Object.create(null),clauses=[];
    for(const name of allNames){
      domains[name]=true;const definitions=dynamic.filter(item=>Object.hasOwn(item.domains,name));
      const staticDomain=Object.hasOwn(fixed.domains,name)?fixed.domains[name]:Object.entries(fixed.patternDomains).filter(([pattern])=>new RegExp(pattern).test(name)).map(([,domain])=>domain),inactiveDomain=Array.isArray(staticDomain)?staticDomain.length?{allOf:staticDomain}:fixed.additionalDomain:staticDomain;
      if(Object.hasOwn(fixed.domains,name))domains[name]=fixed.domains[name];
      else if(definitions.length)clauses.push({if:{not:{anyOf:definitions.map(item=>item.when)}},then:{properties:{[name]:inactiveDomain}}});
      else domains[name]=inactiveDomain;
    }
    for(const item of dynamic)clauses.push({if:item.when,then:{properties:item.domains}});
    const supported={type:'object',maxProperties:500,properties:domains,...(Object.keys(fixed.patternDomains).length?{patternProperties:fixed.patternDomains}:{}),additionalProperties:fixed.additionalDomain};
    return {rules:{...fixed.rules,...(dynamic.length?{conditions:dynamic.map(item=>({when:item.when,...item.rules}))}:{})},schema:{allOf:[value,supported,...clauses]}};
  };
  const listParameters=(raw,ctx)=>{
    if(raw==null)return [];
    if(!Array.isArray(raw)||raw.length>500){gap(ctx,'parameters_limit_or_invalid');return [];}
    return raw.map(value=>deref(value,ctx)).filter(value=>{if(!plain(value)||!safeName(value.name)||typeof value.in!=='string'){gap(ctx,'invalid_parameter');return false;}return true;});
  };
  const serverUrls=(operation,item,ctx)=>{
    if(swagger){
      const host=doc.host||base?.host,schemes=operation.schemes||doc.schemes||(base?[base.protocol.slice(0,-1)]:[]),basePath=doc.basePath||'';
      if(!host||!Array.isArray(schemes)||!schemes.length){gap(ctx,'missing_server_base');return [];}
      return schemes.map(protocol=>({url:protocol+'://'+host+basePath}));
    }
    const servers=operation.servers??item.servers??doc.servers??[{url:'/'}];
    if(!Array.isArray(servers)||servers.length>32){gap(ctx,'server_limit_or_invalid');return [];}
    return servers;
  };
  const resolveServer=(raw,ctx)=>{
    if(!plain(raw)||typeof raw.url!=='string'){gap(ctx,'invalid_server');return null;}
    let value=raw.url;
    for(const name of new Set(Array.from(value.matchAll(/\{([^{}]+)\}/g),match=>match[1]))){const variable=raw.variables?.[name];if(/password|secret|token|api[-_]?key|authorization|cookie/i.test(name)){gap(ctx,'credential_server_variable_unbound');return null;}if(!plain(variable)||typeof variable.default!=='string'){gap(ctx,'unresolved_server_variable');return null;}value=value.split('{'+name+'}').join(variable.default);warn('server_variable_defaults_selected');}
    let url;try{url=new URL(value,base)}catch{gap(ctx,'missing_or_invalid_server_base');return null;}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/[{}\\]/.test(url.host)||/[{}]|%7[bBdD]/.test(url.pathname)){gap(ctx,'invalid_server');return null;}
    return url;
  };
  if(!plain(doc.paths))fail('PATHS_INVALID','规范paths必须为对象');
  outer:for(const [route,rawItem]of Object.entries(doc.paths)){
    const pathContext={location:{path:scrub(route)},problems:new Set()};
    if(!route.startsWith('/')||/[?#\\]/.test(route)||route.split('/').some(segment=>{try{return ['.','..'].includes(decodeURIComponent(segment))}catch{return true;}})){gap(pathContext,'invalid_path');continue;}
    if(plain(rawItem)&&rawItem.$ref&&Object.keys(rawItem).some(key=>!['$ref','summary','description'].includes(key)))gap(pathContext,'path_item_ref_siblings_ambiguous');
    const item=deref(rawItem,pathContext);if(!plain(item)){gap(pathContext,'invalid_path_item');continue;}
    for(const [method,rawOperation]of Object.entries(item)){
      if(!METHODS.has(method)&&method!=='trace')continue;
      const ctx={location:{path:scrub(route),method:method.toUpperCase()},problems:new Set(pathContext.problems)},operation=deref(rawOperation,ctx);
      if(!plain(operation)){gap(ctx,'invalid_operation');continue;}
      const params=objectSchema();params.properties.path=objectSchema();params.properties.query=objectSchema();
      const declarations={path:[],query:[],headers:[]},querySerialization=Object.create(null),combined=new Map();
      for(const raw of [item.parameters,operation.parameters]){const level=new Set();for(const parameter of listParameters(raw,ctx)){const id=parameter.in+'\0'+parameter.name;if(level.has(id))gap(ctx,'duplicate_parameter_declaration');level.add(id);combined.set(id,parameter);}}
      let bodyContent=null,formSerialization=null;const form=objectSchema(),formParameters=new Map();let hasForm=false;
      for(const parameter of combined.values()){
        const place=parameter.in;
        if(place==='body'&&swagger){if(bodyContent){gap(ctx,'multiple_request_bodies');continue;}bodyContent={schema:parameter.schema||{},required:parameter.required===true};continue;}
        if(place==='formData'&&swagger){hasForm=true;const value=schema(Object.fromEntries(Object.entries(parameter).filter(([key])=>!['name','in','required','description','collectionFormat','default','example'].includes(key))),ctx);form.properties[parameter.name]=value;formParameters.set(parameter.name,parameter);if(parameter.required)(form.required??=[]).push(parameter.name);if(parameter.type==='file')gap(ctx,'unsupported_file_upload');continue;}
        if(['header','cookie'].includes(place)){declarations.headers.push(parameter.name);if(parameter.required&&!/authorization|cookie|api[-_]?key|token/i.test(parameter.name))gap(ctx,'required_header_or_cookie_unbound');else warn('headers_and_cookies_are_managed_locally');continue;}
        if(!['path','query'].includes(place)){gap(ctx,'unsupported_parameter_location');continue;}
        let rawSchema=parameter.schema;
        if(swagger)rawSchema=Object.fromEntries(Object.entries(parameter).filter(([key])=>!['name','in','required','description','collectionFormat','allowEmptyValue','default','example'].includes(key)));
        if(parameter.content){gap(ctx,'unsupported_parameter_content_encoding');rawSchema={};}
        const value=schema(rawSchema||{},ctx),container=params.properties[place];
        container.properties[parameter.name]=value;declarations[place].push(parameter.name);
        if(parameter.required===true)(container.required??=[]).push(parameter.name);
        if(place==='path'&&(parameter.required!==true||!pathSchema(value)))gap(ctx,'invalid_or_unsupported_path_parameter');
        if(place==='query'){
          const encoding=queryContract(value,parameter,ctx);if(encoding){container.properties[parameter.name]=encoding.schema;querySerialization[parameter.name]=encoding.rule;}
        }
        if(place==='path'&&!swagger&&(parameter.style&&parameter.style!=='simple'||parameter.explode===true))gap(ctx,'unsupported_path_serialization');
        if(/password|passwd|secret|token|api[-_]?key|authorization|cookie/i.test(parameter.name)){gap(ctx,'credential_input_requires_binding');container.properties[parameter.name]=plain(value)&&typeof value.type==='string'?{type:value.type}:{};}
      }
      const names=Array.from(route.matchAll(/\{([^{}]+)\}/g),match=>match[1]);
      if(/[{}]/.test(route.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g,'')))gap(ctx,'invalid_path_template');
      for(const name of names)if(!declarations.path.includes(name))gap(ctx,'missing_path_parameter_declaration');
      for(const name of declarations.path)if(!names.includes(name))gap(ctx,'unused_path_parameter_declaration');
      if(!swagger&&operation.requestBody){
        const body=deref(operation.requestBody,ctx),content=body?.content;
        if(!plain(body)||!plain(content)||!Object.keys(content).length)gap(ctx,'invalid_request_body');
        else{const media=['application/json','application/x-www-form-urlencoded','text/plain'].find(type=>Object.hasOwn(content,type));if(!media){gap(ctx,'unsupported_request_media_type');bodyContent={schema:{},required:body.required===true};}else{bodyContent={schema:content[media]?.schema||{},required:body.required===true,encoding:content[media]?.encoding};bodyContent.type=media;if(Object.keys(content).length>1)warn('one_supported_request_media_type_selected');}}
      }
      if(swagger&&(bodyContent||hasForm)){
        const consumes=operation.consumes||doc.consumes||[];
        if(hasForm){if(bodyContent)gap(ctx,'mixed_body_and_form_data');bodyContent={normalised:form,required:(form.required?.length||0)>0,type:consumes.includes('application/x-www-form-urlencoded')?'application/x-www-form-urlencoded':null};}
        else bodyContent.type=['application/json','text/plain'].find(type=>consumes.includes(type))||null;
        if(!bodyContent.type)gap(ctx,'unsupported_request_media_type');
      }
      if(bodyContent){
        params.properties.body=bodyContent.normalised||schema(bodyContent.schema,ctx);if(bodyContent.required)(params.required??=[]).push('body');
        if(['get','head'].includes(method))gap(ctx,'request_body_not_supported_for_method');
        if(bodyContent.type==='text/plain'&&(!plain(params.properties.body)||params.properties.body.type!=='string'))gap(ctx,'unsupported_text_body_shape');
        if(bodyContent.type==='application/x-www-form-urlencoded'){const encoded=formContract(params.properties.body,bodyContent.encoding,formParameters,ctx);if(encoded){params.properties.body=encoded.schema;formSerialization=encoded.rules;}}
      }
      for(const place of ['path','query'])if(params.properties[place].required?.length)(params.required??=[]).push(place);
      if(operation.security?.length||operation.security===undefined&&doc.security?.length)warn('declared_security_requires_trusted_local_credentials');
      if(method==='trace')gap(ctx,'unsupported_http_method');
      const servers=serverUrls(operation,item,ctx);
      for(const rawServer of servers){
        if(operations>=maxOperations){gap(rootCtx,'operation_limit',{limit:maxOperations});warn('remaining_operations_omitted');break outer;}
        const serverCtx={location:ctx.location,problems:new Set(ctx.problems)},server=resolveServer(rawServer,serverCtx);if(!server)continue;
        const fullPath=(server.pathname.replace(/\/$/,'')+route)||'/';let url;
        try{url=new URL(server.origin+fullPath)}catch{gap(serverCtx,'invalid_operation_url');continue;}
        const pathname=url.pathname.replace(/%7B([A-Za-z_][A-Za-z0-9_]*)%7D/gi,'{$1}');
        if(!allowed.has(server.origin))gap(serverCtx,'origin_not_allowed',{origin:server.origin});else origins.add(server.origin);
        const contract=clone(params),record={url:server.origin+pathname,method:method==='trace'?null:method.toUpperCase(),headers:bodyContent?.type?{'content-type':bodyContent.type}:{},query:{},body:null,query_serialization:clone(querySerialization),...(formSerialization?{form_serialization:clone(formSerialization)}:{}),categories:['static_candidate','openapi'],source:'asset',extraction_sources:['asset'],package:(base?redactUrl(base.href):'supplied-document')+'#/paths/'+encodeURIComponent(route)+'/'+method,description:scrub(operation.summary||operation.operationId||method.toUpperCase()+' '+route),parameters:declarations,readiness:serverCtx.problems.size?'candidate':'ready',effect:'unknown',gaps:[...serverCtx.problems],declaredMethod:method.toUpperCase()};
        if(serverCtx.problems.size)contract.allOf=[...(contract.allOf||[]),{not:{}}];
        const id=endpointId(sourceId,server.origin,pathname)+':'+method.toUpperCase();
        if(seen.has(id)){const prior=seen.get(id);if(JSON.stringify(canonical([schemaOverrides[id],prior.query_serialization,prior.form_serialization,prior.headers]))!==JSON.stringify(canonical([contract,record.query_serialization,record.form_serialization,record.headers]))){gap(serverCtx,'conflicting_operation_contract');prior.readiness='candidate';prior.gaps.push('conflicting_operation_contract');schemaOverrides[id].allOf=[...(schemaOverrides[id].allOf||[]),{not:{}}];}continue;}
        schemaOverrides[id]=contract;manifest.push(record);seen.set(id,record);operations++;
      }
    }
  }
  return {manifest,schemaOverrides,origins:[...origins],gaps,warnings};
}
