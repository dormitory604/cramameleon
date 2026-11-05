import { AppError } from '../contracts/index.ts';
import type { Document } from '../contracts/index.ts';

export type RemoteResource = { id: string; kind: 'material' | 'package'; title: string; courseName: string; format: string; size: number; url: string; availability: string };
export type RemoteItem = { id: string; packageId: string; name: string; path: string; format: string; size: number; supported: boolean };
export type RemotePage<T> = { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean };
export async function oldSiteRequest<T>(userId: string, path: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<T> {
 const response = await fetcher('/api/old-site' + path, { headers: { 'X-Cram-User': userId }, signal });
 if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new AppError(payload.error?.code ?? 'OLD_SITE_UNAVAILABLE', payload.error?.message ?? '资料服务暂不可用'); }
 return response.json();
}

export function remoteDocumentId(resource: Pick<RemoteResource, 'id' | 'kind'>, itemId?: string): string { return `old-site:${resource.kind}:${resource.id}${itemId ? ':' + itemId : ''}`; }
export function attributeRemoteDocument(doc: Document, resource: RemoteResource, item?: RemoteItem): Document {
 const id = remoteDocumentId(resource, item?.id);
 return { ...doc, id, origin: 'old-site', title: item?.name ?? resource.title, remoteRef: { resourceId: resource.id, kind: resource.kind, itemId: item?.id, url: resource.url }, chunks: doc.chunks.map((chunk, index) => ({ ...chunk, documentId: id, chunkId: `${id}:${index}`, title: item?.name ?? resource.title, url: resource.url })) };
}

export type PreviewKind = 'pdf' | 'image' | 'text' | 'office';
const previewKinds: Record<string, PreviewKind> = { pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', txt: 'text', md: 'text', markdown: 'text', doc: 'office', docx: 'office', ppt: 'office', pptx: 'office', xls: 'office', xlsx: 'office' };
export function previewKind(format: string): PreviewKind | undefined { return previewKinds[format.toLowerCase()]; }

// The old site's public preview endpoints are viewing aids only: they never
// charge quota and are never used as the source for imported text.
export function previewUrl(resource: Pick<RemoteResource, 'id' | 'kind' | 'url'>, item?: Pick<RemoteItem, 'path'>): string | undefined {
 let origin: URL;
 try { origin = new URL(resource.url); } catch { return undefined; }
 if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return undefined;
 const id = encodeURIComponent(resource.id);
 if (resource.kind === 'material') return `${origin.origin}/api/materials/${id}/preview`;
 return item ? `${origin.origin}/api/packages/${id}/preview/${encodeURIComponent(item.path)}` : undefined;
}
export function officeViewerUrl(url: string): string { return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`; }
