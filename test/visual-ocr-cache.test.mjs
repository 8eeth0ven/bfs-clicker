import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkVisualOCR} from '../scripts/benchmark-visual-ocr.mjs';

test('same-host multi-region observations reduce real OCR calls without changing actual output',{timeout:180000},async()=>{
 const report=await benchmarkVisualOCR(),[uncached,current]=report.variants;
 assert.deepEqual(uncached.requests,[{first:'alpha',second:'one'},{first:'beta',second:'two'},{first:'gamma',second:'three'}]);assert.deepEqual(current.requests,uncached.requests);
 assert.deepEqual(current.execution.data,uncached.execution.data);
 for(let i=0;i<2;i++){const a=uncached.samples[i].visual,b=current.samples[i].visual;assert.equal(a.captures,a.ocrCalls);assert.equal(b.captures,b.ocrCalls);assert(b.ocrCalls<a.ocrCalls,JSON.stringify({a,b}));}
 assert(current.execution.visual.ocrCalls<uncached.execution.visual.ocrCalls,JSON.stringify(report));assert.equal(current.execution.visual.captures,current.execution.visual.ocrCalls);
});

test('replacing the result canvas during the same observation pass fails closed',{timeout:90000},async()=>{
 const outcome=await benchmarkVisualOCR({replacementProbe:true});assert.equal(outcome.accepted,false,JSON.stringify(outcome));assert.equal(outcome.error,'WORKFLOW_VALIDATION_FAILED');assert.equal(outcome.validation.runs[0].error.code,'VISUAL_RESULT_TARGET_CHANGED',JSON.stringify(outcome));assert.deepEqual(outcome.requests,[{first:'alpha',second:'one'}]);
});
