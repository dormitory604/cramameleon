import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { zipDirectory, extractEntry, FILE_LIMIT } from '../src/tools/localArchive.ts';
import { parseLocalBytes } from '../src/tools/localParser.ts';
import { makeDocument } from '../src/tools/localText.ts';
import { ContextSources } from '../src/tools/contextSources.ts';
import { txt, docx, pptx } from './materialFixtures.ts';
const noPdf=async()=>{throw new Error('PDF must be exercised in browser Worker');};
test('TXT/Markdown/Office parse actual bytes with stable fingerprint and truthful locations',async()=>{
 const text=await parseLocalBytes('lecture.txt',strToU8(txt),noPdf);
 assert.equal(text.chunks.length,2);assert.equal(text.chunks[1].location,'段落 2');assert.equal(text.origin,'local');
 assert.equal((await parseLocalBytes('copy.txt',strToU8(txt),noPdf)).id,text.id);
 const md=await parseLocalBytes('notes.md',strToU8('# 条件概率\n\n公式说明'),noPdf);assert.match(md.chunks[1].location,/条件概率/);
 const word=await parseLocalBytes('word.docx',docx(),noPdf);assert.equal(word.chunks[0].text,'条件概率 DOCX');assert.equal(word.chunks[1].location,'段落 2');assert.equal(word.chunks[0].page,undefined);
 const deck=await parseLocalBytes('deck.pptx',pptx(),noPdf);assert.match(deck.chunks[0].text,/第一张/);assert.equal(deck.chunks[1].slide,2);
 const ctx=new ContextSources([text]);const found=ctx.search('条件概率');assert.ok(found.length);assert.equal(ctx.resolve(found.map(({documentId,chunkId})=>({documentId,chunkId})))[0].text,found[0].text);
 assert.throws(()=>ctx.search('条件概率',[word.id]),/当前已选/);
});
test('text errors, binary masquerade, unsupported type and oversized input are explicit',async()=>{
 await assert.rejects(parseLocalBytes('empty.txt',new Uint8Array(),noPdf),/未提取/);
 await assert.rejects(parseLocalBytes('bad.txt',new Uint8Array([0xff]),noPdf),/编码/);
 await assert.rejects(parseLocalBytes('bad.txt',strToU8('PK fake'),noPdf),/压缩/);
 await assert.rejects(parseLocalBytes('old.doc',strToU8('abc'),noPdf),/仅支持/);
 await assert.rejects(parseLocalBytes('large.txt',new Uint8Array(FILE_LIMIT+1),noPdf),/20MB/);
 assert.throws(()=>makeDocument('large.txt',[{text:'a'.repeat(2_000_001),location:'段落 1'}],[],1,'hash'),/200 万/);
});
test('ZIP directory precedes extraction; CRC, limits, nesting, paths and malformed bounds are enforced',()=>{
 const bytes=zipSync({'a.txt':strToU8(txt),'unused.txt':strToU8('not selected')});const entries=zipDirectory(bytes);
 assert.equal(entries.length,2);assert.equal(new TextDecoder().decode(extractEntry(bytes,entries[0])),txt);
 const broken=bytes.slice();broken[entries[0].start]^=1;assert.throws(()=>extractEntry(broken,entries[0]));
 assert.throws(()=>zipDirectory(zipSync({'../escape.txt':strToU8('bad')})),/路径/);
 assert.throws(()=>zipDirectory(zipSync({'inner.zip':new Uint8Array()})),/嵌套/);
 assert.throws(()=>zipDirectory(zipSync(Object.fromEntries(Array.from({length:201},(_,i)=>[`${i}.txt`,strToU8('x')])))),/200 条/);
 assert.throws(()=>zipDirectory(bytes.subarray(0,bytes.length-2)),/目录|损坏/);
 const bomb=bytes.slice();const view=new DataView(bomb.buffer);let at=0;for(;at<bomb.length-4;at++)if(view.getUint32(at,true)===0x02014b50)break;view.setUint32(at+24,101*1024*1024,true);assert.throws(()=>zipDirectory(bomb),/100MB/);
 // Forged small advertised sizes cannot cause silently truncated or accepted output.
 const forged=bytes.slice();const f=new DataView(forged.buffer);f.setUint32(at+24,1,true);f.setUint32(22,1,true);const forgedEntry=zipDirectory(forged)[0];assert.throws(()=>extractEntry(forged,forgedEntry),/超限|校验/);
});
test('XML entities and invalid Office payloads are rejected, large chunks retain exact offsets',async()=>{
 const bad=zipSync({'word/document.xml':strToU8('<!DOCTYPE x [<!ENTITY a "evil">]><w:p>&a;</w:p>')});
 await assert.rejects(parseLocalBytes('bad.docx',bad,noPdf),/DTD/);
 await assert.rejects(parseLocalBytes('fake.docx',strToU8('not a zip'),noPdf));
 const doc=makeDocument('long.txt',[{text:'x'.repeat(3601),location:'段落 1'}],[],3601,'h');
 assert.equal(doc.chunks.length,3);assert.match(doc.chunks[2].location,/3601/);assert.equal(doc.chunks.map(c=>c.text).join('').length,3601);
});
