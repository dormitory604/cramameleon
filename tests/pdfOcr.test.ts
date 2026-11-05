import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrSparsePages, decodeOcrOutput } from '../scripts/pdf-ocr.ts';

test('OCR attempts blank/footer pages only, preserves native text and page references', async () => {
 const sections = [{page:1,location:'第 1 页',text:'正常正文'.repeat(40)}, {page:2,location:'第 2 页',text:'试题第 2 页 共 8 页'}, {page:3,location:'第 3 页',text:''}];
 const pages: number[] = [];
 const warnings = await ocrSparsePages(new Uint8Array(),sections,async page=>{pages.push(page);return '识别出来的试题文字'.repeat(10);});
 assert.deepEqual(pages,[2,3]);
 assert.equal(sections[0].text,'正常正文'.repeat(40));
 assert.match(sections[1].text,/试题第 2 页/);
 assert.match(sections[1].location,/OCR/);
 assert.equal(sections[1].page,2);
 assert.ok(warnings.some(w=>w.includes('2 页补充')));
});
test('OCR failure or empty output preserves existing content and reports the failure',async()=>{
 const sections = [{page:1,location:'第 1 页',text:'页脚'}, {page:2,location:'第 2 页',text:''}];
 const warnings=await ocrSparsePages(new Uint8Array(),sections,async page=>{if(page===1)throw new Error('timeout');return '';});
 assert.equal(sections[0].text,'页脚');assert.equal(sections[1].text,'');
 assert.ok(warnings.some(w=>w.includes('失败或超时')));
});
test('OCR has a page cap and a missing binary stops attempts',async()=>{
 const sections=Array.from({length:20},(_,i)=>({page:i+1,location:`第 ${i+1} 页`,text:''}));
 let calls=0;
 const warnings=await ocrSparsePages(new Uint8Array(),sections,async()=>{calls++;return '';});
 assert.equal(calls,16);assert.ok(warnings.some(w=>w.includes('4 页未完成')));
 calls=0;
 const missing=await ocrSparsePages(new Uint8Array(),sections,async()=>{calls++;throw Object.assign(new Error('missing'),{code:'ENOENT'});});
 assert.equal(calls,1);assert.ok(missing.some(w=>w.includes('服务器未安装')));
});

test('completed page checkpoints survive a timeout and a truncated final record', () => {
 const complete = JSON.stringify({pages:[{page:2,text:'integral formula'}],warnings:[]});
 const result = decodeOcrOutput(complete + '\n' + '{"pages":[{"page":3');
 assert.deepEqual(result.pages,[{page:2,text:'integral formula'}]);
});
