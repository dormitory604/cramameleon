import { AppError } from '../contracts/index.ts';
import { FILE_LIMIT, extension, supported, zipDirectory, extractEntry } from './localArchive.ts';
import { parseLocalBytes } from './localParser.ts';
import type { TextSection } from './localText.ts';
import type { Document } from '../contracts/index.ts';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

async function pdfText(bytes:Uint8Array) {
 const pdfjs=await import('pdfjs-dist');
 const worker=new Worker(pdfWorkerUrl,{type:'module'});
 pdfjs.GlobalWorkerOptions.workerPort=worker;
 const task=pdfjs.getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,useWasm:false,useWorkerFetch:true,
  cMapUrl:new URL('/pdfjs/cmaps/',self.location.origin).href,cMapPacked:true,standardFontDataUrl:new URL('/pdfjs/standard_fonts/',self.location.origin).href});
 try {
  const doc=await task.promise;
  if(doc.numPages>1000)throw new AppError('FILE_LIMIT','PDF 超过 1000 页，请拆分文件');
  const sections:TextSection[]=[],warnings:string[]=[];let empty=0,total=0;
  for(let page=1;page<=doc.numPages;page++) {
   const p=await doc.getPage(page);const content=await p.getTextContent();
   const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('');
   total+=text.length;if(total>2_000_000)throw new AppError('FILE_LIMIT','提取文本超过 200 万字，请拆分文件');
   if(!text.trim())empty++;
   sections.push({text,location:`第 ${page} 页`,page});p.cleanup();
   self.postMessage({type:'progress',message:`正在解析 PDF：${page}/${doc.numPages} 页`});
  }
  if(empty)warnings.push(`${empty} 页未提取到文字，可能为空白页或扫描图像；暂不支持 OCR。`);
  warnings.push('PDF 按文本层提取，多栏、表格和公式的顺序可能不完整，请对照原文。');
  return {sections,warnings};
 } catch(error) {
  if(error instanceof AppError)throw error;
  throw new AppError('FILE_PDF', error instanceof Error&&error.name==='PasswordException'?'PDF 已加密，请在本机解除密码后重试':'PDF 无法解析，请确认文件完整或重新导出');
 } finally {await task.destroy();worker.terminate();pdfjs.GlobalWorkerOptions.workerPort=null;}
}

self.onmessage=async(event:MessageEvent<{mode:'list'|'parse';file:File;entries?:string[]}>)=>{
 try {
  const {file,mode,entries:selected}=event.data;
  if(file.size>FILE_LIMIT)throw new AppError('FILE_LIMIT','单文件最多 20MB');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(extension(file.name)==='zip') {
   const entries=zipDirectory(bytes);
   if(mode==='list') {self.postMessage({type:'result',value:entries.filter(e=>!e.name.endsWith('/')).map(e=>({name:e.name,size:e.size,supported:supported(e.name)&&e.size<=FILE_LIMIT}))});return;}
   if(!selected?.length||selected.length>20||new Set(selected).size!==selected.length)throw new AppError('FILE_SELECTION','请选择 1–20 个条目');
   const documents:Document[]=[],warnings:string[]=[];
   for(const name of selected) {
    const entry=entries.find(e=>e.name===name);if(!entry||!supported(name))throw new AppError('FILE_SELECTION','所选条目不在可用目录中');
    self.postMessage({type:'progress',message:`正在解析：${name}`});
    try {documents.push(await parseLocalBytes(name,extractEntry(bytes,entry),pdfText));}
    catch(error) {warnings.push(`${name}：${error instanceof Error?error.message:'解析失败'}`);}
   }
   self.postMessage({type:'result',value:{documents,warnings}});
  } else {
   const document=await parseLocalBytes(file.name,bytes,pdfText);
   self.postMessage({type:'result',value:{documents:[document],warnings:[]}});
  }
 } catch(error) {self.postMessage({type:'error',code:error instanceof AppError?error.code:'FILE_PARSE',message:error instanceof Error?error.message:'文件解析失败，请检查格式或重新导出'});}
};
