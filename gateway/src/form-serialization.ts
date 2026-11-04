import {GatewayError, type FormRule, type FormSerialization} from './types.js';
import {queryRules,serializeQuery} from './query-serialization.js';
import {Ajv2020} from 'ajv/dist/2020.js';

const plain=(value:any):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fieldRule(value:any):FormRule {
  if(!plain(value))throw new GatewayError('FORM_CONTRACT_INVALID','表单字段编码声明必须是对象');
  if(value.mode==='style'){
    if(Object.keys(value).some(key=>!['mode','style','explode','kind'].includes(key)))throw new GatewayError('FORM_CONTRACT_INVALID','表单编码含未知字段');
    const {mode,...rule}=value;return {mode,...queryRules({field:rule}).field};
  }
  if(value.mode!=='content'||Object.keys(value).some(key=>!['mode','contentType','kind'].includes(key))||!['scalar','array','json'].includes(value.kind)||!['application/json','text/plain'].includes(value.contentType)||value.contentType==='application/json'&&value.kind!=='json'||value.contentType==='text/plain'&&value.kind==='json')throw new GatewayError('FORM_CONTRACT_INVALID','不支持的表单字段媒体编码');
  return {mode:'content',contentType:value.contentType,kind:value.kind};
}
export function formRules(value:any):FormSerialization {
  if(!plain(value)||Object.keys(value).some(key=>!['fields','additional','patterns','conditions'].includes(key))||!plain(value.fields)||Object.keys(value.fields).length>500)throw new GatewayError('FORM_CONTRACT_INVALID','表单编码声明无效');
  const fields:Record<string,FormRule>=Object.create(null);
  for(const name of Object.keys(value.fields).sort()){const rule=value.fields[name];if(!name||name.length>256||/[\x00-\x1f]/.test(name)||['__proto__','prototype','constructor'].includes(name))throw new GatewayError('FORM_CONTRACT_INVALID','表单字段名无效');fields[name]=fieldRule(rule);}
  let patterns:FormSerialization['patterns'];if(value.patterns!==undefined){if(!Array.isArray(value.patterns)||value.patterns.length>500)throw new GatewayError('FORM_CONTRACT_INVALID','表单模式编码超限');patterns=value.patterns.map((item:any)=>{if(!plain(item)||Object.keys(item).some(key=>!['pattern','rule'].includes(key))||typeof item.pattern!=='string'||item.pattern.length>512)throw new GatewayError('FORM_CONTRACT_INVALID','表单模式编码无效');try{new RegExp(item.pattern);}catch{throw new GatewayError('FORM_CONTRACT_INVALID','表单模式正则无效');}return {pattern:item.pattern,rule:fieldRule(item.rule)};}).sort((a:any,b:any)=>a.pattern.localeCompare(b.pattern));if(new Set(patterns!.map(item=>item.pattern)).size!==patterns!.length)throw new GatewayError('FORM_CONTRACT_INVALID','表单模式编码重复');}
  let conditions:FormSerialization['conditions'];
  if(value.conditions!==undefined){
    if(!Array.isArray(value.conditions)||value.conditions.length>128)throw new GatewayError('FORM_CONTRACT_INVALID','条件表单编码超限');
    conditions=value.conditions.map((item:any)=>{
      if(!plain(item)||Object.keys(item).some(key=>!['when','fields','patterns','additional'].includes(key))||!(typeof item.when==='boolean'||plain(item.when)))throw new GatewayError('FORM_CONTRACT_INVALID','条件表单编码无效');
      const walk=(node:any,depth=0):void=>{if(depth>64)throw new GatewayError('FORM_CONTRACT_INVALID','表单条件过深');if(node===null||['string','boolean'].includes(typeof node)||typeof node==='number'&&Number.isFinite(node))return;if(!plain(node)&&!Array.isArray(node))throw new GatewayError('FORM_CONTRACT_INVALID','表单条件不是JSON');for(const [key,child]of Object.entries(node)){if(['__proto__','prototype','constructor','$ref','$dynamicRef','$recursiveRef','$async'].includes(key))throw new GatewayError('FORM_CONTRACT_INVALID','表单条件含未展开引用或不允许字段');walk(child,depth+1);}};
      walk(item.when);const when=structuredClone(item.when);try{conditionValidator(when);}catch{throw new GatewayError('FORM_CONTRACT_INVALID','表单条件无法编译');}
      const {when:_,...rules}=item;return {when,...formRules(rules)};
    });
  }
  return {fields,...(Object.hasOwn(value,'additional')?{additional:fieldRule(value.additional)}:{}),...(patterns?.length?{patterns}:{}),...(conditions?.length?{conditions}:{})};
}
const ajv=new Ajv2020({allErrors:false,strict:false,allowUnionTypes:true,validateFormats:false});
const validators=new WeakMap<object,any>();
function conditionValidator(schema:boolean|Record<string,any>):any {
  if(typeof schema==='boolean')return ()=>schema;
  let validate=validators.get(schema);if(!validate){validate=ajv.compile(schema);ajv.removeSchema(schema);validators.set(schema,validate);}return validate;
}
export function serializeForm(value:any,contract:FormSerialization):string {
  if(!plain(value)||Object.keys(value).length>500)throw new GatewayError('PARAMS_INVALID','表单请求体必须是预算内对象');
  const prepared:Record<string,any>=Object.create(null),rules:Record<string,any>=Object.create(null);
  const active=(contract.conditions||[]).filter(item=>conditionValidator(item.when)(value));
  for(const [name,item]of Object.entries(value)){
    const fieldRules=[contract,...active].flatMap(part=>Object.hasOwn(part.fields,name)?[part.fields[name]]:[]);
    if(fieldRules.some(rule=>JSON.stringify(rule)!==JSON.stringify(fieldRules[0])))throw new GatewayError('FORM_CONDITIONAL_ENCODING_CONFLICT','生效的表单字段编码冲突');
    const matched=fieldRules.length?[]:[contract,...active].flatMap(part=>(part.patterns||[]).filter(item=>new RegExp(item.pattern).test(name)).map(item=>item.rule));
    if(matched.some(rule=>JSON.stringify(rule)!==JSON.stringify(matched[0])))throw new GatewayError('FORM_PATTERN_ENCODING_CONFLICT','匹配的表单模式编码冲突');
    const additional=[contract,...active].flatMap(part=>part.additional?[part.additional]:[]);
    if(!fieldRules.length&&!matched.length&&additional.some(rule=>JSON.stringify(rule)!==JSON.stringify(additional[0])))throw new GatewayError('FORM_CONDITIONAL_ENCODING_CONFLICT','生效的表单额外字段编码冲突');
    const rule=fieldRules[0]||matched[0]||additional[0];
    if(rule?.mode==='style'){const {mode,...wire}=rule;prepared[name]=item;rules[name]=wire;}
    else if(rule?.contentType==='application/json'){
      let json:string|undefined;try{json=JSON.stringify(item);}catch{throw new GatewayError('PARAMS_INVALID','表单JSON字段无法序列化');}if(json===undefined)throw new GatewayError('PARAMS_INVALID','表单JSON字段无有效值');
      prepared[name]=json;rules[name]={style:'form',explode:true,kind:'scalar'};
    }else{
      prepared[name]=item;if(rule)rules[name]={style:'form',explode:true,kind:rule.kind};
    }
  }
  return serializeQuery(prepared,rules,{maxBytes:1024*1024});
}
