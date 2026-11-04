/* Offline DOM-object fixture for the real fixed probe; no browser/device claim. */
const assert = require('node:assert/strict');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { raw += part; });
process.stdin.on('end', () => {
  const {script} = JSON.parse(raw);
  const run = new Function('window', 'document', 'specs', 'pins', 'return (function(){' + script + '}).apply(null,[specs,pins]);');
  const failures = [];
  let checks = 0;
  function check(name, fn) { try { fn(); checks++; } catch (e) { failures.push(name + ': ' + e.message); } }
  function fixture() {
    const nodes = new Map();
    const doc = {URL:'http://127.0.0.1:18999/form', readyState:'complete'};
    const style = {display:'block',visibility:'visible',opacity:'1'};
    function element(id, tag, parent) {
      const attrs = {}, el = {id,tagName:tag.toUpperCase(),parentElement:parent,isConnected:true,ownerDocument:doc,
        isContentEditable:false,disabled:false,readOnly:false,hidden:false,value:'',textContent:'',style:{...style},
        getAttribute:name => Object.hasOwn(attrs,name) ? attrs[name] : null,
        getRootNode:() => doc, getBoundingClientRect:() => ({x:0,y:0,width:200,height:40}),
        closest(sel) {
          for (let item=this; item; item=item.parentElement) {
            if (sel.startsWith('#') && item.id === sel.slice(1)) return item;
            if (sel === '[hidden],[inert],[aria-hidden="true"]' && (item.hidden || item.inert || item.getAttribute('aria-hidden') === 'true')) return item;
          }
          return null;
        },
        contains(other) { for (let item=other;item;item=item.parentElement) if (item===this) return true; return false; }, attrs};
      nodes.set(id,el);
      return el;
    }
    const html=element('root','html',null), body=element('body','body',html), form=element('searchForm','form',body);
    doc.documentElement=html;doc.body=body;
    form.action=doc.URL;form.method='get';
    const query=element('query','input',form), detail=element('detail','textarea',form), button=element('run','button',form), output=element('result','div',form);
    query.type='text';query.form=form;detail.type='textarea';detail.form=form;button.type='submit';button.form=form;button.textContent='Search';output.textContent='Idle';
    query.value='中文 e\u0301 🦊';detail.value='第二项';
    const specs=[{id:'query',kind:'input',selector:'#query',group:'#searchForm'}, {id:'detail',kind:'input',selector:'#detail',group:'#searchForm'},
      {id:'run',kind:'button',selector:'#run',group:'#searchForm'}, {id:'result',kind:'output',selector:'#result',group:'#searchForm'}];
    doc.querySelectorAll=sel => sel.startsWith('#') ? (nodes.has(sel.slice(1)) ? [nodes.get(sel.slice(1))] : []) :
      [...nodes.values()].filter(el => ['input','textarea','button','select','output'].includes(el.tagName.toLowerCase()) || ['status','alert'].includes(el.getAttribute('role')));
    const win={location:{origin:'http://127.0.0.1:18999'},getComputedStyle:el=>el.style};win.top=win;
    return {nodes,doc,win,specs,query,detail,button,output,form,body,element};
  }
  function execute(f, pins=null) { return run(f.win,f.doc,f.specs,pins); }
  check('exact Unicode live .value and independent field',()=>{const f=fixture(),r=execute(f);assert.equal(r.rows.query.value,'中文 e\u0301 🦊');assert.equal(r.rows.detail.value,'第二项');});
  check('flat live refs roundtrip',()=>{const f=fixture(),a=execute(f),b=execute(f,a.refs);assert.equal(b.pinsMatched,true);assert.equal(b.refs[0],f.doc.documentElement);assert.equal(b.refs[1],f.body);});
  check('stable group is actually observed',()=>{const f=fixture(),r=execute(f);assert.equal(r.rows.result.contract.groupId,'searchForm');assert.equal(r.rows.query.contract.formId,'searchForm');});
  check('target replaced same ID rejected by reference identity',()=>{const f=fixture(),a=execute(f);const old=f.query;const replacement={...old};f.nodes.set('query',replacement);assert.throws(()=>execute(f,a.refs),/IDENTITY/);});
  check('body replaced same URL rejected',()=>{const f=fixture(),a=execute(f);f.doc.body={...f.body};assert.throws(()=>execute(f,a.refs),/IDENTITY/);});
  check('form owner replaced rejected',()=>{const f=fixture(),a=execute(f);f.query.form={...f.form};assert.throws(()=>execute(f,a.refs),/FORM_GROUP/);});
  check('parent replaced rejected',()=>{const f=fixture(),a=execute(f);f.query.parentElement={...f.form};assert.throws(()=>execute(f,a.refs),/GROUP|IDENTITY/);});
  check('hidden rejected',()=>{const f=fixture();f.query.hidden=true;assert.throws(()=>execute(f),/HIDDEN/);});
  check('ancestor aria hidden rejected',()=>{const f=fixture();f.form.attrs['aria-hidden']='true';assert.throws(()=>execute(f),/HIDDEN/);});
  check('disabled rejected',()=>{const f=fixture();f.query.disabled=true;assert.throws(()=>execute(f),/DISABLED/);});
  check('readonly rejected',()=>{const f=fixture();f.query.readOnly=true;assert.throws(()=>execute(f),/DISABLED/);});
  check('secure input rejected',()=>{const f=fixture();f.query.type='password';assert.throws(()=>execute(f),/INPUT_TYPE/);});
  check('contenteditable rejected',()=>{const f=fixture();f.query.isContentEditable=true;assert.throws(()=>execute(f),/EDITABLE/);});
  check('detached rejected',()=>{const f=fixture();f.query.isConnected=false;assert.throws(()=>execute(f),/DETACHED/);});
  check('foreign document rejected',()=>{const f=fixture();f.query.ownerDocument={};assert.throws(()=>execute(f),/DETACHED/);});
  check('nested shadow root rejected',()=>{const f=fixture();f.query.getRootNode=()=>({});assert.throws(()=>execute(f),/DETACHED/);});
  check('iframe rejected',()=>{const f=fixture();f.win.top={};assert.throws(()=>execute(f),/DOCUMENT/);});
  check('loading rejected',()=>{const f=fixture();f.doc.readyState='loading';assert.throws(()=>execute(f),/LOADING/);});
  check('duplicate ID rejected',()=>{const f=fixture(),old=f.doc.querySelectorAll;f.doc.querySelectorAll=sel=>sel==='#query'?[f.query,f.query]:old(sel);assert.throws(()=>execute(f),/AMBIGUOUS/);});
  check('invalid selector rejected',()=>{const f=fixture();f.specs[0].selector='input';assert.throws(()=>execute(f),/SELECTOR/);});
  check('unowned form rejected',()=>{const f=fixture();f.query.form={...f.form,id:'other'};assert.throws(()=>execute(f),/FORM_GROUP/);});
  check('DOM output outside form supported with no inferred owner',()=>{const f=fixture();f.output.parentElement=f.body;f.specs[3].group=null;const r=execute(f);assert.equal(r.rows.result.contract.groupId,null);assert.equal(r.rows.result.contract.parentTag,'body');});
  check('unconfigured visible controls inventoried without values/authorization',()=>{const f=fixture(),extra=f.element('extra','input',f.form);extra.type='checkbox';extra.value='must-not-copy';extra.attrs['data-testid']='extra-check';const r=execute(f),seen=r.inventory.find(el=>el.selector==='#extra');assert.equal(seen.configured,false);assert.equal(seen.dispatchAuthorized,false);assert.ok(!Object.hasOwn(seen,'value'));assert.ok(!JSON.stringify(r.inventory).includes('must-not-copy'));});
  check('automatic inventory has bounded scan and result counts',()=>{const f=fixture();for(let i=0;i<1100;i++)f.element('extra_'+i,'input',f.form).type='checkbox';const r=execute(f);assert.equal(r.inventory.length,256);assert.equal(r.inventoryTotal,1024);assert.equal(r.inventoryTruncated,true);});
  check('live property beats stale value attribute',()=>{const f=fixture();f.query.attrs.value='stale';assert.equal(execute(f).rows.query.value,'中文 e\u0301 🦊');});
  check('probe is read only',()=>{const f=fixture(),before=JSON.stringify([...f.nodes.values()].map(el=>[el.id,el.value,el.textContent,el.attrs]));execute(f);assert.equal(JSON.stringify([...f.nodes.values()].map(el=>[el.id,el.value,el.textContent,el.attrs])),before);});
  process.stdout.write(JSON.stringify({checks,failures}));
  if (failures.length) process.exitCode=1;
});
