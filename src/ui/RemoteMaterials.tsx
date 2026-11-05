import { useEffect, useRef, useState } from 'react';
import { AppError } from '../contracts/index.ts';
import type { AppSession, Document } from '../contracts/index.ts';
import { importLocalFile } from '../tools/localMaterials.ts';
import { attributeRemoteDocument, oldSiteFile, oldSiteRequest, remoteDocumentId } from '../tools/oldSiteMaterials.ts';
import type { Quota, ReadAccess, RemoteItem, RemotePage, RemoteResource } from '../tools/oldSiteMaterials.ts';

type Props = { session: AppSession; documents: Document[]; initial?: AppSession['initialContext']; onClose: () => void; onImport: (docs: Document[]) => void; onBusy: (busy: boolean) => void };
const plural = (kind: 'material' | 'package') => kind === 'material' ? 'materials' : 'packages';
const bytes = (size: number) => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;

export function RemoteMaterials({ session, documents, initial, onClose, onImport, onBusy }: Props) {
 const [kind, setKind] = useState<'material' | 'package'>(initial?.packageId ? 'package' : 'material');
 const [query, setQuery] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
 const [showSearch, setShowSearch] = useState(!initial);
 const [results, setResults] = useState<RemotePage<RemoteResource> | null>(null);
 const [resource, setResource] = useState<RemoteResource | null>(null);
 const [items, setItems] = useState<RemoteItem[]>([]); const [itemPage, setItemPage] = useState(1); const [moreItems, setMoreItems] = useState(false);
 const [selected, setSelected] = useState<string[]>(initial?.itemId ? [initial.itemId] : []);
 const [quota, setQuota] = useState<Quota | null>(null); const [error, setError] = useState(''); const [progress, setProgress] = useState('');
 const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [needsAuth, setNeedsAuth] = useState(false);
 const active = useRef<AbortController | null>(null); const metadata = useRef<AbortController | null>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const previous=document.activeElement;const element=dialog.current!;element.showModal();return()=>{element.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 const userId = session.user.id;
 function report(e: unknown) { setError(e instanceof Error ? e.message : '资料服务暂不可用'); if (e instanceof AppError && ['AUTH_REQUIRED', 'MATERIAL_AUTH_EXPIRED', 'SESSION_CHANGED'].includes(e.code)) setNeedsAuth(true); }
 useEffect(() => () => { active.current?.abort(); metadata.current?.abort(); onBusy(false); }, []);
 useEffect(() => {
  const controller = new AbortController();
  void oldSiteRequest<Quota>(userId, '/quota', controller.signal).then(setQuota).catch(e => { if (!controller.signal.aborted) report(e); });
  return () => controller.abort();
 }, [userId]);
 useEffect(() => {
  if (resource || !showSearch) return;
  const controller = new AbortController(); setLoading(true);
  void oldSiteRequest<RemotePage<RemoteResource>>(userId, `/${plural(kind)}?search=${encodeURIComponent(search)}&page=${page}`, controller.signal).then(setResults).catch(e => { if (!controller.signal.aborted) report(e); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  return () => controller.abort();
 }, [kind, search, page, resource, userId, showSearch]);
 async function open(kind: 'material' | 'package', id: string, entry?: AppSession['initialContext']) {
  metadata.current?.abort();
  const controller = new AbortController();
  metadata.current = controller;
  setLoading(true);setError('');setItems([]);setItemPage(1);setSelected(entry?.itemId ? [entry.itemId] : []);
  try {
   const detail = await oldSiteRequest<RemoteResource>(userId, `/${plural(kind)}/${id}`, controller.signal);
   const automatic = Boolean(entry?.importId && detail.availability === 'available');
   let catalogItems: RemoteItem[] = [];
   if (kind === 'package') {
    let catalog: RemotePage<RemoteItem>;
    let catalogPage = 0;
    do {
     catalogPage++;
     catalog = await oldSiteRequest<RemotePage<RemoteItem>>(userId, `/packages/${id}/items${catalogPage === 1 ? '' : `?page=${catalogPage}`}`, controller.signal);
     catalogItems = [...catalogItems, ...catalog.items];
    } while (catalog.hasMore && automatic && (entry?.itemId
     ? !catalogItems.some(item => item.id === entry.itemId)
     : catalogItems.filter(item => item.supported).length <= 20));
    controller.signal.throwIfAborted();
    setItems(catalogItems);setMoreItems(catalog.hasMore);setItemPage(catalogPage);
   }
   controller.signal.throwIfAborted();
   setResource(detail);setKind(kind);
   if (!automatic) return;
   const chosen = catalogItems.filter(item => item.supported && (!entry?.itemId || item.id === entry.itemId));
   if (kind === 'package') {
    const pending = chosen.filter(item => !documents.some(doc => doc.id === remoteDocumentId(detail, item.id)));
    if (!chosen.length) { setError('这个课程包里没有可自动导入的文件。');return; }
    if (chosen.length > 20 || documents.length + pending.length > 20) {
     setError('当前对话最多保留 20 份资料，请从课程包中选择要复习的文件。');return;
    }
    setSelected(chosen.map(item => item.id));
   }
   await importSelected(detail, kind === 'package' ? chosen : [undefined]);
  } catch(e) { if (!controller.signal.aborted) { report(e);setShowSearch(true); } }
  finally { if (!controller.signal.aborted) setLoading(false); }
 }
 useEffect(() => {
  if (initial?.materialId) void open('material', initial.materialId, initial);
  else if (initial?.packageId) void open('package', initial.packageId, initial);
 }, []);
 async function more() {
  if (!resource || loading) return;
  const controller = new AbortController();metadata.current = controller;setLoading(true);
  try { const catalog = await oldSiteRequest<RemotePage<RemoteItem>>(userId, `/packages/${resource.id}/items?page=${itemPage + 1}`, controller.signal);controller.signal.throwIfAborted();setItems(old => [...old, ...catalog.items]);setItemPage(n => n + 1);setMoreItems(catalog.hasMore); }
  catch(e) { if (!controller.signal.aborted) report(e); } finally { if (!controller.signal.aborted) setLoading(false); }
 }
 async function importSelected(resource: RemoteResource, chosen: (RemoteItem | undefined)[]) {
  if (active.current || !chosen.length || chosen.length > 20) return;
  const cached = chosen.map(item => documents.find(doc => doc.id === remoteDocumentId(resource, item?.id))).filter((doc): doc is Document => !!doc);
  const pending = chosen.filter(item => !documents.some(doc => doc.id === remoteDocumentId(resource, item?.id)));
  if (documents.length + pending.length > 20) { setError('当前对话最多保留 20 份资料，请先移除不用的资料。');return; }
  if (!pending.length) { onImport(cached);onClose();return; }
  const controller = new AbortController();active.current = controller;setBusy(true);onBusy(true);setError('');setProgress('正在确认读取权限…');
  const key = `cram-read:${userId}:${resource.kind}:${resource.id}:${pending.map(i => i?.id ?? '').sort().join(',')}`;
  let receipt: ReadAccess | undefined;
  try {
   const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();sessionStorage.setItem(key, requestId);
   receipt = await oldSiteRequest<ReadAccess>(userId, `/${plural(resource.kind)}/${resource.id}/access`, controller.signal, { requestId, ...(resource.kind === 'package' ? { itemIds: pending.map(item => item!.id) } : {}) });
   setQuota(receipt.quota);
   const imported: Document[] = [...cached];const warnings: string[] = [];
   for (const item of pending) {
    const name = item?.name ?? `${resource.title}.${resource.format}`;
    setProgress(`正在读取：${name}`);
    try {
     const path = resource.kind === 'package' ? `/packages/${resource.id}/items/${item!.id}/content` : `/materials/${resource.id}/content`;
     const file = await oldSiteFile(userId, `${path}?readId=${encodeURIComponent(receipt.readId)}`, name, controller.signal);
     const parsed = await importLocalFile(file, controller.signal, setProgress);controller.signal.throwIfAborted();
     imported.push(...parsed.documents.map(doc => attributeRemoteDocument(doc, resource, item)));warnings.push(...parsed.warnings);
    } catch(e) { controller.signal.throwIfAborted();warnings.push(`${name}：${e instanceof Error ? e.message : '解析失败'}`); }
   }
   controller.signal.throwIfAborted();if (imported.length) onImport(imported);
   if (!warnings.length && imported.length) { sessionStorage.removeItem(key);onClose(); }
   else setError(`已导入 ${imported.length} 份。此次确认${receipt.charged ? '扣除 1 次下载额度' : '未扣下载额度'}；失败文件可重试。\n${warnings.join('\n')}`);
  } catch(e) {
   if (!controller.signal.aborted) { report(e);if (e instanceof AppError && ['ACCESS_EXPIRED', 'IDEMPOTENCY_CONFLICT'].includes(e.code)) sessionStorage.removeItem(key); }
  } finally { if (active.current === controller) { active.current = null;setBusy(false);setProgress('');onBusy(false); } }
 }
 const canRead = resource?.availability === 'available' && (resource.kind === 'material' || selected.length > 0 && selected.length <= 20 && selected.every(id => items.some(item => item.id === id && item.supported)));
 return <dialog ref={dialog} className="source-modal remote-materials" aria-labelledby="remote-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} onClick={e=>{if(e.target!==e.currentTarget||busy)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}>
  <button type="button" className="icon-button modal-close" aria-label="关闭课程资料" disabled={busy} onClick={onClose}>×</button>
  <div className="eyebrow">破壁计划</div><h2 id="remote-title">课程资料</h2>
  <p className="materials-hint">搜索与查看目录免费。文件在浏览器解析，提问时仅发送相关文本片段。</p>
  {quota && <div className="remote-quota">本周期剩余 <strong>{quota.remaining} / {quota.total}</strong> 次下载 · {new Date(quota.cycleEnd).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 更新</div>}
  {error && <p role="alert" className="notice remote-error">{error}</p>}
  {needsAuth && <p><a href="/api/auth/old-site/start">重新通过破壁计划授权</a> · 账号切换后请刷新页面</p>}
  {busy ? <div role="status">{progress}<button type="button" onClick={() => { active.current?.abort();setError('已取消。已确认的读取可能已按旧站规则扣额；重试会复用此前的请求。'); }}>取消读取</button></div> : resource ? <>
   <button type="button" onClick={() => { setResource(null);setSelected([]);setError('');setShowSearch(true); }}>← 返回搜索</button>
   <h3>{resource.title}</h3><p>{resource.courseName} · {resource.kind === 'package' ? '课程包' : `${resource.format.toUpperCase()} · ${bytes(resource.size)}`} · <a href={resource.url} target="_blank" rel="noreferrer">旧站详情</a></p>
   {resource.availability !== 'available' && <p role="status">当前文件无法导入，可能不存在、格式不支持或超过 20 MB。</p>}
   {resource.kind === 'package' && <div className="remote-catalog" aria-label="课程包目录">{items.map(item => <label key={item.id}><input type="checkbox" disabled={!item.supported || loading} checked={selected.includes(item.id)} onChange={e => setSelected(old => e.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))}/><span>{item.path}<small>{bytes(item.size)}{!item.supported && ' · 格式不支持或超过 20 MB'}</small></span></label>)}{moreItems && <button type="button" disabled={loading} onClick={() => void more()}>加载更多目录</button>}</div>}
   <div className="remote-confirm"><p>{resource.alreadyDownloaded ? '这份资料已有旧站下载记录，本次读取不扣下载额度。' : resource.kind === 'package' ? '首次读取此课程包扣 1 次下载额度；本周期内可继续读取包内支持的文件，不逐份扣额。' : '首次读取这份资料扣 1 次下载额度。确认后 30 分钟内可重试读取。'}</p><p className="materials-hint">沿用旧站的历史下载权益与每日次数限制。确认后取消或文件解析失败，已扣额度不会自动退回。</p><button type="button" className="primary" disabled={!canRead || loading || needsAuth} onClick={() => void importSelected(resource, resource.kind === 'package' ? items.filter(item => selected.includes(item.id) && item.supported) : [undefined])}>确认读取{resource.kind === 'package' ? ` ${selected.length} 份文件` : '并导入'}</button></div>
  </> : <>
   <div className="remote-search"><select aria-label="资料类别" value={kind} disabled={loading} onChange={e => { setKind(e.target.value as typeof kind);setPage(1);setResults(null); }}><option value="material">单份资料</option><option value="package">课程包</option></select><input autoFocus aria-label="搜索课程资料" placeholder="课程名或资料关键词" maxLength={100} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault();setSearch(query.trim());setPage(1); } }}/><button type="button" onClick={() => { setSearch(query.trim());setPage(1); }}>搜索</button></div>
   <div className="remote-results">{results?.items.map(value => <button type="button" key={value.id} onClick={() => void open(value.kind, value.id)} disabled={loading}><strong>{value.title}</strong><small>{value.courseName || '课程资料'} · {value.kind === 'package' ? '查看课程包目录' : `${value.format.toUpperCase()} · ${bytes(value.size)}`}{value.availability !== 'available' && ' · 暂不可读'}</small></button>)}{!loading && results?.items.length === 0 && <p>没有找到相关资料，试试其他课程名或关键词。</p>}</div>
   {results && <div className="remote-pagination"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(n => n - 1)}>上一页</button><span>第 {page} 页 · 共 {results.total} 条</span><button type="button" disabled={!results.hasMore || loading} onClick={() => setPage(n => n + 1)}>下一页</button></div>}
  </>}
  {loading && <p role="status">正在加载资料…</p>}
 </dialog>;
}
