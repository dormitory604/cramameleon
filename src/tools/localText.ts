import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { AppError } from '../contracts/index.ts';
import type { Document, Source } from '../contracts/index.ts';
import { extension, extractEntry, zipDirectory } from './localArchive.ts';

export type TextSection = { text: string; location: string; page?: number; slide?: number };
export function decodeText(bytes: Uint8Array): string {
 let encoding='utf-8';
 if(bytes[0]===255&&bytes[1]===254) encoding='utf-16le';
 if(bytes[0]===254&&bytes[1]===255) encoding='utf-16be';
 try {
  const text=new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/\r\n?/g,'\n');
  if(/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error();
  return text;
 } catch { throw new AppError('FILE_ENCODING','文本编码不受支持或文件不是文本，请另存为 UTF-8 后导入'); }
}
export function textSections(text: string, markdown=false): TextSection[] {
 const sections:TextSection[]=[];let heading='';let paragraph=0;
 for(const block of text.split(/\n\s*\n/)) {
  if(!block.trim())continue;
  if(markdown) { const match=block.match(/^#{1,6}\s+(.+)$/m);if(match)heading=match[1].slice(0,150); }
  sections.push({text:block.trim(),location:(heading?`章节「${heading}」 · `:'')+`段落 ${++paragraph}`});
 }
 return sections;
}
type XmlNode = Record<string, any>;
function xml(bytes: Uint8Array): XmlNode[] {
 const text=decodeText(bytes);
 if(/<!DOCTYPE|<!ENTITY/i.test(text)) throw new AppError('FILE_XML','不支持带 DTD 或自定义实体的文档');
 if(XMLValidator.validate(text)!==true) throw new AppError('FILE_XML','Office XML 已损坏');
 return new XMLParser({preserveOrder:true,ignoreAttributes:false,parseTagValue:false,trimValues:false}).parse(text);
}
function elements(nodes:XmlNode[],tag:string):XmlNode[][] {
 const result:XmlNode[][]=[];
 for(const node of nodes) for(const [key,value] of Object.entries(node)) {
  if(key===tag)result.push(value);
  else if(key!==':@'&&Array.isArray(value))result.push(...elements(value,tag));
 }
 return result;
}
function content(nodes:XmlNode[],prefix:string):string {
 let text='';
 for(const node of nodes) for(const [key,value] of Object.entries(node)) {
  if(key===prefix+':t')text+=value.map((n:XmlNode)=>n['#text']??'').join('');
  else if([prefix+':br',prefix+':cr'].includes(key))text+='\n';
  else if(key===prefix+':tab')text+='\t';
  else if(key!==':@' && key!=='w:del' && Array.isArray(value))text+=content(value,prefix);
 }
 return text;
}
export function officeSections(bytes:Uint8Array,format:string):TextSection[] {
 const entries=zipDirectory(bytes,true),byName=new Map(entries.map(e=>[e.name,e]));
 const read=(name:string)=>{const e=byName.get(name);if(!e)throw new AppError('FILE_XML','Office 缺少必要内容：'+name);return xml(extractEntry(bytes,e));};
 if(format==='docx') return elements(read('word/document.xml'),'w:p').map((p,i)=>({text:content(p,'w'),location:`段落 ${i+1}`}));
 const relationships=read('ppt/_rels/presentation.xml.rels');
 const rels=new Map<string,string>();
 for(const n of elements(relationships,'Relationships').flat()) if(n.Relationship){const a=n[':@'];if(a?.['@_TargetMode']!=='External')rels.set(a?.['@_Id'],a?.['@_Target']);}
 const ids=elements(read('ppt/presentation.xml'),'p:sldIdLst').flat().filter(n=>n['p:sldId']);
 if(ids.length>1000)throw new AppError('FILE_LIMIT','幻灯片过多，请拆分文件');
 return ids.map((n,i)=>{
  const target=rels.get(n[':@']?.['@_r:id']);
  if(!target || !/^(?:\/ppt\/)?(?:slides\/slide[^/]+\.xml)$/.test(target))throw new AppError('FILE_XML','幻灯片引用无效');
  const path=target.startsWith('/')?target.slice(1):'ppt/'+target;
  return {text:elements(read(path),'a:p').map(p=>content(p,'a')).join('\n'),slide:i+1,location:`幻灯片 ${i+1}`};
 });
}
export function makeDocument(title:string,sections:TextSection[],warnings:string[],size:number,fingerprint:string):Document {
 const id='local-'+fingerprint;
 const chunks:Source[]=[];let characters=0;
 for(const section of sections) {
  const text=section.text.trim();characters+=text.length;
  if(characters>2_000_000)throw new AppError('FILE_LIMIT','提取文本超过 200 万字，请拆分文件');
  for(let at=0;at<text.length;at+=1800){
   if(chunks.length>=1000)throw new AppError('FILE_LIMIT','文本块超过 1000 个，请拆分文件');
   chunks.push({documentId:id,chunkId:`chunk-${chunks.length+1}`,title,text:text.slice(at,at+1800),location:section.location+(text.length>1800?` · 字符 ${at+1}–${Math.min(at+1800,text.length)}`:''),...(section.page?{page:section.page}:{}),...(section.slide?{slide:section.slide}:{})});
  }
 }
 if(!chunks.length)throw new AppError('FILE_EMPTY','未提取到文本；扫描件、图片文字暂不支持 OCR，请换用文本文件');
 return {id,title,chunks,warnings,kind:'material',format:extension(title),size,fingerprint,origin:'local',importedAt:Date.now()};
}
