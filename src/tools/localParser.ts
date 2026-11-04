import { AppError } from '../contracts/index.ts';
import type { Document } from '../contracts/index.ts';
import { FILE_LIMIT, extension, supported } from './localArchive.ts';
import { decodeText, makeDocument, officeSections, textSections } from './localText.ts';
import type { TextSection } from './localText.ts';

export async function parseLocalBytes(name:string,bytes:Uint8Array,readPdf:(bytes:Uint8Array)=>Promise<{sections:TextSection[];warnings:string[]}>):Promise<Document> {
 if(bytes.length>FILE_LIMIT)throw new AppError('FILE_LIMIT','单文件最多 20MB');
 if(!supported(name))throw new AppError('FILE_UNSUPPORTED','仅支持 TXT、Markdown、文本 PDF、DOCX、PPTX 和 ZIP');
 const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const originalSize=bytes.length;
 const format=extension(name);let sections:TextSection[],warnings:string[]=[];
 if(format==='pdf') {
  if(!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))throw new AppError('FILE_FORMAT','PDF 文件头无效');
  ({sections,warnings}=await readPdf(bytes));
 } else if(['docx','pptx'].includes(format)) {
  sections=officeSections(bytes,format);
  warnings=['已提取正文文字；图片、图表、公式对象及复杂布局可能无法还原，请对照原文件。'];
 } else {
  if(bytes[0]===80&&bytes[1]===75)throw new AppError('FILE_FORMAT','检测到压缩数据，不能作为文本或嵌套压缩包导入');
  sections=textSections(decodeText(bytes),format!=='txt');
 }
 return makeDocument(name,sections,warnings,originalSize,fingerprint);
}
