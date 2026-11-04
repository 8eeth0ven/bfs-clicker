/* Execute production fixed scripts on independent DOM objects, never a device. */
const assert=require('node:assert/strict');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{
 const {readScript,writeScript}=JSON.parse(input);
 const make=source=>new Function('window','document','args','return(function(){'+source+'}).apply(null,args);');
 const read=make(readScript),write=make(writeScript),failures=[];let checks=0;
 function check(name,fn){try{fn();checks++;}catch(e){failures.push(name+': '+e.message);}}
 function fixture(){
  const doc={URL:'http://127.0.0.1:18001/form',readyState:'complete'},win={location:{origin:'http://127.0.0.1:18001'}};win.top=win;
  const element=()=>({isConnected:true,ownerDocument:doc});
  const html=element(),body=element(),form=element(),el={...element(),tagName:'INPUT',type:'text',disabled:false,readOnly:false,isContentEditable:false,value:'',
   getRootNode:()=>doc,getAttribute:()=>null,parentElement:form,form,
   focus(options){assert.deepEqual(options,{preventScroll:true});doc.activeElement=this;f.focusWrites++;if(f.onFocus)f.onFocus();}};
  doc.documentElement=html;doc.body=body;doc.activeElement=body;doc.querySelectorAll=selector=>selector==='#query'?[el]:[];
  const f={doc,win,el,html,body,form,focusWrites:0};f.args=['#query',el,html,body,form,form,doc.URL,win.location.origin];return f;
 }
 const run=(fn,f)=>fn(f.win,f.doc,f.args);
 check('read never focuses or changes the value',()=>{const f=fixture();f.el.value=' 中文🙂e\u0301 ';const r=run(read,f);assert.equal(r.focused,false);assert.equal(r.value,f.el.value);assert.equal(f.focusWrites,0);assert.equal(f.doc.activeElement,f.body);});
 check('write focuses the actual target without assigning its value',()=>{const f=fixture();f.el.value=' 原 e\u0301🙂 ';const r=run(write,f);assert.equal(r.focused,true);assert.equal(r.value,' 原 e\u0301🙂 ');assert.equal(f.focusWrites,1);});
 check('read reports an externally moved focus',()=>{const f=fixture();run(write,f);f.doc.activeElement=f.body;assert.equal(run(read,f).focused,false);assert.equal(f.focusWrites,1);});
 for(const [name,mutate] of [
  ['foreign document',f=>f.el.ownerDocument={}],['replaced html',f=>f.doc.documentElement={}],['replaced body',f=>f.doc.body={}],
  ['same id different target',f=>f.doc.querySelectorAll=()=>[{...f.el}]],['changed owner',f=>f.el.form={}],
  ['changed parent',f=>f.el.parentElement={}],['changed URL',f=>f.doc.URL+='?moved'],['changed origin',f=>f.win.location.origin='https://foreign.example'],
  ['detached target',f=>f.el.isConnected=false],['shadow root',f=>f.el.getRootNode=()=>({})],['secure target',f=>f.el.type='password'],
  ['readonly target',f=>f.el.readOnly=true],['invalid selector',f=>f.args[0]='input'],['iframe',f=>f.win.top={}],
 ])check(name+' refuses before focus write',()=>{const f=fixture();mutate(f);assert.throws(()=>run(write,f),/WEBVIEW_FOCUS:/);assert.equal(f.focusWrites,0);});
 check('focus handler replacing body prevents subsequent readonly verification',()=>{const f=fixture();f.onFocus=()=>f.doc.body={};run(write,f);assert.throws(()=>run(read,f),/DOCUMENT/);assert.equal(f.focusWrites,1);});
 process.stdout.write(JSON.stringify({checks,failures,scope:'offline_DOM_objects_only'}));if(failures.length)process.exitCode=1;
});
