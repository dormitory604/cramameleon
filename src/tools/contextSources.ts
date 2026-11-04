import { validSource } from '../contracts/index.ts';
import type { Document, Source } from '../contracts/index.ts';
export type SourceKey = { documentId: string; chunkId: string };
const key = (s: SourceKey) => JSON.stringify([s.documentId,s.chunkId]);
export class ContextSources {
 private docs: Document[];
 private read = new Map<string, Source>();
 private remaining = 8000;
 constructor(documents: Document[]) { this.docs = documents.slice(0,20); }
 search(query: string, documentIds?: string[]): Source[] {
  if (!query.trim() || query.length>500) throw new Error('请给出简短的检索问题');
  if (documentIds?.some(id=>!this.docs.some(d=>d.id===id))) throw new Error('只能搜索当前已选文档');
  const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? [query.toLowerCase()])];
  const found: {source:Source;score:number}[]=[];
  for (const doc of this.docs) {
   if (documentIds?.length && !documentIds.includes(doc.id)) continue;
   for (const raw of doc.chunks.slice(0,1000)) {
    if (!validSource(raw) || raw.documentId!==doc.id || !raw.text.trim()) continue;
    const hay=(doc.title+' '+raw.text).toLowerCase();
    const score=tokens.reduce((n,t)=>n+Number(hay.includes(t)),0);
    if(score>0) found.push({source:{...raw,title:doc.title},score});
   }
  }
  let remaining=Math.min(6000,this.remaining);
  const results:Source[]=[];
  for (const {source} of found.sort((a,b)=>b.score-a.score).slice(0,6)) {
   if(remaining<=0) break;
   const snippet={...source,text:source.text.slice(0,Math.min(2000,remaining))};
   remaining-=snippet.text.length;this.remaining-=snippet.text.length;this.read.set(key(snippet),snippet);results.push(snippet);
  }
  return results;
 }
 resolve(refs: SourceKey[]): Source[] {
  if (!Array.isArray(refs) || refs.length>6) throw new Error('来源最多六个');
  const seen=new Set<string>();
  return refs.map(ref=>{
   if(!ref || typeof ref.documentId!=='string'||typeof ref.chunkId!=='string') throw new Error('来源标识无效');
   const id=key(ref),source=this.read.get(id);
   if(!source||seen.has(id)) throw new Error('来源未读取、重复或不属于当前资料范围');
   seen.add(id); return {...source};
  });
 }
 verifyPastPaper(sources:Source[], question:string, options:{text:string}[]) {
  const normalized=(s:string)=>s.replace(/\s+/g,'');
  return sources.some(s=>this.docs.some(d=>d.id===s.documentId&&d.kind==='past_paper') && [question,...options.map(o=>o.text)].every(text=>normalized(s.text).includes(normalized(text))));
 }
}
