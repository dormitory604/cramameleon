import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Document, Source } from '../contracts/index.ts';
import { AppError } from '../contracts/index.ts';
import { ContextSources } from './contextSources.ts';
import { oldSiteRequest, remoteDocumentId } from './oldSiteMaterials.ts';
import type { RemotePage, RemoteResource } from './oldSiteMaterials.ts';

export function remoteEvidence(userId: string, turnId: string, selected: Document[], sources: ContextSources, fetcher: typeof fetch) {
 const documents = new Map(selected.filter(d => d.remoteRef && d.chunks.length === 0).map(d => [d.id, d.remoteRef!]));
 const calls: string[] = [];
 let searches = 0, reads = 0;
 const result = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });
 async function read(id: string, callId: string, signal: AbortSignal | undefined, startChunk?: number, query?: string) {
  const ref = documents.get(id);
  if (!ref) throw new Error('请先搜索破壁计划，并从结果中选择一份资料读取。');
  if (reads >= 3) throw new Error('本轮已达到三次远程读取上限。');
  reads++;
  const path = ref.kind === 'package' ? `/packages/${ref.resourceId}/items/${ref.itemId}/evidence` : `/materials/${ref.resourceId}/evidence`;
  const params = new URLSearchParams({ turnId, callId });
  if (startChunk) params.set('startChunk', String(startChunk));
  if (query) params.set('query', query);
  const value = await oldSiteRequest<{ chunks: Source[] }>(userId, `${path}?${params}`, signal, fetcher);
  signal?.throwIfAborted();
  for (const chunk of value.chunks) sources.rememberRemote(chunk);
  calls.push(callId);
  return result({ remoteEvidence: true });
 }
 const tools: AgentTool<any>[] = [
  { name: 'search_old_site', label: '搜索破壁计划资料', description: '从破壁计划搜索单份课程资料，最多返回 5 个候选。query 写课程名或短关键词（例如高等数学），pastPaper=true 只查历年试题。结果是标题与链接，不是正文。',
   parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 80 }, pastPaper: { type: 'boolean' } }, required: ['query'], additionalProperties: false },
   execute: async (_id, p, signal) => {
    if (!p.query.trim() || searches >= 2) throw new Error('本轮最多搜索两次，请使用简短课程名。');
    searches++;
    const params = new URLSearchParams({ search: p.query.trim(), page_size: '5' });
    if (p.pastPaper) params.set('category', 'past_exam');
    const page = await oldSiteRequest<RemotePage<RemoteResource>>(userId, '/materials?' + params, signal, fetcher);
    signal?.throwIfAborted();
    const candidates = page.items.slice(0, 5).map(resource => {
     const documentId = remoteDocumentId(resource);
     if (resource.availability === 'available') documents.set(documentId, { kind: resource.kind, resourceId: resource.id, url: resource.url });
     return { documentId, title: resource.title, courseName: resource.courseName, url: resource.url, availability: resource.availability };
    });
    return result({ candidates });
   },
  },
  { name: 'read_old_site', label: '读取破壁计划资料', description: '读取本轮搜索返回的一份资料的原文片段。先搜索，再传入原样的 documentId。默认从开头读取，可用 startChunk 续读。每轮远程资料最多读取三次。若只读到封面、页眉页脚或缺失题干，优先换另一份候选；有可用正文且需要后文时才用 startChunk 续读。',
   parameters: { type: 'object', properties: { documentId: { type: 'string' }, startChunk: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['documentId'], additionalProperties: false },
   execute: (callId, p, signal) => read(p.documentId, callId, signal, p.startChunk),
  },
 ];
 return {
  tools, read,
  async verify(question: string, options: { text: string }[], refs: Source[], signal?: AbortSignal) {
   if (!calls.length) return false;
   const response = await fetcher('/api/old-site-verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cram-User': userId }, signal,
    body: JSON.stringify({ turnId, calls, parts: [question, ...options.map(o => o.text)], refs: refs.map(({ documentId, chunkId }) => ({ documentId, chunkId })) }),
   });
   if (!response.ok) throw new AppError('FILE_VERIFY', '暂时无法核对旧站真题');
   return (await response.json()).verified === true;
  },
 };
}
