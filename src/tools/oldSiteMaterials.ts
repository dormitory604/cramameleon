import { AppError } from '../contracts/index.ts';
import type { Document } from '../contracts/index.ts';

export type RemoteResource = { id: string; kind: 'material' | 'package'; title: string; courseName: string; format: string; size: number; url: string; availability: string; alreadyDownloaded: boolean };
export type RemoteItem = { id: string; packageId: string; name: string; path: string; format: string; size: number; supported: boolean };
export type RemotePage<T> = { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean };
export type Quota = { total: number; used: number; remaining: number; cycleStart: string; cycleEnd: string };
export type ReadAccess = { readId: string; charged: number; reused: boolean; replayed: boolean; expires: string; quota: Quota };

export async function oldSiteRequest<T>(userId: string, path: string, signal: AbortSignal, body?: unknown): Promise<T> {
 const response = await fetch('/api/old-site' + path, { method: body ? 'POST' : 'GET', headers: { 'X-Cram-User': userId, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal });
 if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new AppError(payload.error?.code ?? 'OLD_SITE_UNAVAILABLE', payload.error?.message ?? '资料服务暂不可用'); }
 return response.json();
}

export async function oldSiteFile(userId: string, path: string, name: string, signal: AbortSignal): Promise<File> {
 const response = await fetch('/api/old-site' + path, { headers: { 'X-Cram-User': userId }, signal });
 if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new AppError(payload.error?.code ?? 'OLD_SITE_UNAVAILABLE', payload.error?.message ?? '文件读取失败'); }
 const blob = await response.blob(); signal.throwIfAborted();
 if (blob.size > 20 * 1024 * 1024) throw new AppError('FILE_LIMIT', '单份资料最多 20 MB');
 return new File([blob], name, { type: blob.type });
}

export function remoteDocumentId(resource: Pick<RemoteResource, 'id' | 'kind'>, itemId?: string): string { return `old-site:${resource.kind}:${resource.id}${itemId ? ':' + itemId : ''}`; }
export function attributeRemoteDocument(doc: Document, resource: RemoteResource, item?: RemoteItem): Document {
 const id = remoteDocumentId(resource, item?.id);
 return { ...doc, id, origin: 'old-site', title: item?.name ?? resource.title, remoteRef: { resourceId: resource.id, kind: resource.kind, itemId: item?.id, url: resource.url }, chunks: doc.chunks.map((chunk, index) => ({ ...chunk, documentId: id, chunkId: `${id}:${index}`, title: item?.name ?? resource.title, url: resource.url })) };
}
