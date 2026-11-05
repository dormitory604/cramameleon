import { useEffect, useRef, useState } from 'react';
import { AppError } from '../contracts/index.ts';
import type { AppSession, Document } from '../contracts/index.ts';
import { attributeRemoteDocument, officeViewerUrl, oldSiteRequest, previewKind, previewUrl, remoteDocumentId } from '../tools/oldSiteMaterials.ts';
import type { RemoteItem, RemotePage, RemoteResource } from '../tools/oldSiteMaterials.ts';

type Props = { session: AppSession; documents: Document[]; initial?: AppSession['initialContext']; onClose: () => void; onImport: (docs: Document[]) => void; onBusy: (busy: boolean) => void };
const plural = (kind: 'material' | 'package') => kind === 'material' ? 'materials' : 'packages';
const bytes = (size: number) => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
const authCodes = ['AUTH_REQUIRED', 'MATERIAL_AUTH_EXPIRED', 'SESSION_CHANGED', 'ENTRY_NOT_ALLOWED'];
// One resource the user has decided to read: a single material, or chosen files of one package.
type Choice = { resource: RemoteResource; items: RemoteItem[] };
const choiceKey = (resource: Pick<RemoteResource, 'kind' | 'id'>) => `${resource.kind}:${resource.id}`;
const fileCount = (choices: Choice[]) => choices.reduce((total, choice) => total + (choice.resource.kind === 'package' ? choice.items.length : 1), 0);

function Preview({ url, format, name }: { url?: string; format: string; name: string }) {
 const [loaded, setLoaded] = useState(false); const [failed, setFailed] = useState(false);
 const kind = previewKind(format);
 if (!url || !kind || failed) return <p className="remote-preview remote-preview-empty">{failed ? '预览加载失败' : '该格式暂不支持在线预览'}，可直接确认读取，或打开旧站详情查看。</p>;
 const title = `预览：${name}`;
 return <figure className="remote-preview">
  {!loaded && <p className="remote-preview-loading" role="status">正在加载预览…</p>}
  {kind === 'image'
   ? <img src={url} alt={title} referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setFailed(true)}/>
   : <iframe src={kind === 'office' ? officeViewerUrl(url) : url} title={title} referrerPolicy="no-referrer" sandbox={kind === 'text' ? '' : undefined} onLoad={() => setLoaded(true)}/>}
  <figcaption>预览由破壁计划提供。确认读取后会将资料导入当前对话。</figcaption>
 </figure>;
}

export function RemoteMaterials({ session, documents, initial, onClose, onImport, onBusy }: Props) {
 const [kind, setKind] = useState<'material' | 'package'>(initial?.packageId ? 'package' : 'material');
 const [query, setQuery] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
 const [showSearch, setShowSearch] = useState(!initial);
 const [results, setResults] = useState<RemotePage<RemoteResource> | null>(null);
 const [resource, setResource] = useState<RemoteResource | null>(null);
 const [items, setItems] = useState<RemoteItem[]>([]); const [itemPage, setItemPage] = useState(1); const [moreItems, setMoreItems] = useState(false);
 const [selected, setSelected] = useState<string[]>(initial?.itemId ? [initial.itemId] : []);
 const [showCatalog, setShowCatalog] = useState(!initial?.importId);
 const [error, setError] = useState(''); const [progress, setProgress] = useState('');
 const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [needsAuth, setNeedsAuth] = useState(false);
 const [basket, setBasket] = useState<Choice[]>([]); const [previewItem, setPreviewItem] = useState<RemoteItem | null>(null);
 const active = useRef<AbortController | null>(null); const metadata = useRef<AbortController | null>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=dialog.current;if(!showCatalog || !element)return;const previous=document.activeElement;element.showModal();return()=>{element.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[showCatalog]);
 const userId = session.user.id;
 function report(e: unknown) { setError(e instanceof Error ? e.message : '资料服务暂不可用'); flagAuth(e); }
 function flagAuth(e: unknown) { if (e instanceof AppError && authCodes.includes(e.code)) setNeedsAuth(true); }
 useEffect(() => () => { active.current?.abort(); metadata.current?.abort(); onBusy(false); }, []);
 useEffect(() => {
  if (resource || !showSearch || !showCatalog) return;
  const controller = new AbortController(); setLoading(true);
  void oldSiteRequest<RemotePage<RemoteResource>>(userId, `/${plural(kind)}?search=${encodeURIComponent(search)}&page=${page}`, controller.signal).then(setResults).catch(e => { if (!controller.signal.aborted) report(e); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  return () => controller.abort();
 }, [kind, search, page, resource, userId, showSearch, showCatalog]);
 async function open(kind: 'material' | 'package', id: string, entry?: AppSession['initialContext']) {
  metadata.current?.abort();const controller = new AbortController();metadata.current = controller;setLoading(true);setError('');setItems([]);setItemPage(1);setPreviewItem(null);
  if (entry?.importId) onBusy(true);
  const saved = basket.find(choice => choiceKey(choice.resource) === choiceKey({ kind, id }));
  setSelected(saved ? saved.items.map(item => item.id) : entry?.itemId ? [entry.itemId] : []);
  try {
   const detailRequest = oldSiteRequest<RemoteResource>(userId, `/${plural(kind)}/${id}`, controller.signal);
   const firstCatalog = kind === 'package'
    ? oldSiteRequest<RemotePage<RemoteItem>>(userId, `/packages/${id}/items`, controller.signal)
    : undefined;
   const [detail, firstPage] = await Promise.all([detailRequest, firstCatalog]);
   const automatic = Boolean(entry?.importId && detail.availability === 'available');
   let catalogItems: RemoteItem[] = [];
   if (kind === 'package') {
    let catalog = firstPage!;
    let catalogPage = 1;
    catalogItems = catalog.items;
    while (catalog.hasMore && automatic && (entry?.itemId
     ? !catalogItems.some(item => item.id === entry.itemId)
     : catalogItems.filter(item => item.supported).length <= 20)) {
     catalog = await oldSiteRequest<RemotePage<RemoteItem>>(userId, `/packages/${id}/items?page=${++catalogPage}`, controller.signal);
     catalogItems = [...catalogItems, ...catalog.items];
    }
    controller.signal.throwIfAborted();
    setItems(catalogItems);setMoreItems(catalog.hasMore);setItemPage(catalogPage);
   }
   controller.signal.throwIfAborted();
   setResource(detail);setKind(kind);
   if (!automatic) { if(entry?.importId)setError('当前资料无法导入，可能不存在、格式不支持或超过 20 MB。');return; }
   const chosen = catalogItems.filter(item => item.supported && (!entry?.itemId || item.id === entry.itemId));
   if (kind === 'package') {
    const pending = chosen.filter(item => !documents.some(doc => doc.id === remoteDocumentId(detail, item.id)));
    if (!chosen.length) { setError('这个课程包里没有可自动导入的文件。');return; }
    if (chosen.length > 20 || documents.length + pending.length > 20) {
     setError('当前对话最多保留 20 份资料，请从课程包中选择要复习的文件。');return;
    }
    setSelected(chosen.map(item => item.id));
   }
   await importChoices([{ resource: detail, items: kind === 'package' ? chosen : [] }]);
  } catch(e) { if (!controller.signal.aborted) { report(e);setShowSearch(true); } }
  finally { if (!controller.signal.aborted) { setLoading(false);if(entry?.importId)onBusy(false); } }
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
 async function readChoice(resource: RemoteResource, pending: (RemoteItem | undefined)[], signal: AbortSignal, imported: Document[], warnings: string[]) {
  for (const item of pending) {
   const name = item?.name ?? resource.title;
   setProgress(`服务端正在读取并解析：${name}`);
   try {
    const path = resource.kind === 'package' ? `/packages/${resource.id}/items/${item!.id}/parsed` : `/materials/${resource.id}/parsed`;
    const document = await oldSiteRequest<Document>(userId, path, signal);
    signal.throwIfAborted();
    imported.push(attributeRemoteDocument(document, resource, item));
   } catch(e) {
    signal.throwIfAborted();
    flagAuth(e);
    warnings.push(`${name}：${e instanceof Error ? e.message : '解析失败'}`);
   }
  }
 }
 async function importChoices(choices: Choice[]) {
  if (!choices.length || active.current || busy) return;
  const plan = choices.map(choice => {
   const targets = choice.resource.kind === 'package' ? choice.items : [undefined];
   const cached = targets.map(item => documents.find(doc => doc.id === remoteDocumentId(choice.resource, item?.id))).filter((doc): doc is Document => !!doc);
   return { choice, cached, pending: targets.filter(item => !documents.some(doc => doc.id === remoteDocumentId(choice.resource, item?.id))) };
  });
  const cached = plan.flatMap(step => step.cached);const pendingCount = plan.reduce((total, step) => total + step.pending.length, 0);
  if (documents.length + pendingCount > 20) { setError('当前对话最多保留 20 份资料，请先移除不用的资料或减少待读文件。');return; }
  if (!pendingCount) { onImport(cached);onClose();return; }
  const controller = new AbortController();active.current = controller;setBusy(true);onBusy(true);setError('');setProgress('正在读取资料…');
  const imported: Document[] = [...cached];const warnings: string[] = [];const failed: Choice[] = [];
  try {
   for (const { choice, pending } of plan) {
    if (!pending.length) continue;
    const before = warnings.length;
    await readChoice(choice.resource, pending, controller.signal, imported, warnings);
    if (warnings.length > before) failed.push(choice);
   }
   controller.signal.throwIfAborted();if (imported.length) onImport(imported);
   setBasket(failed);
   if (!failed.length) { onClose();return; }
   setError(`已导入 ${imported.length} 份。可重试读取失败的资料。
${warnings.join('\n')}`);
  } catch(e) { if (!controller.signal.aborted) report(e); }
  finally { if (active.current === controller) { active.current = null;setBusy(false);setProgress('');onBusy(false); } }
 }
 const saved = resource ? basket.find(choice => choiceKey(choice.resource) === choiceKey(resource)) : undefined;
 const pool = [...items, ...(saved?.items ?? [])];
 const chosen = selected.map(id => pool.find(item => item.id === id && item.supported)).filter((item): item is RemoteItem => !!item);
 const current: Choice | null = resource?.availability === 'available' && (resource.kind === 'material' || chosen.length > 0 && chosen.length === selected.length && selected.length <= 20) ? { resource, items: resource.kind === 'package' ? chosen : [] } : null;
 const others = resource ? basket.filter(choice => choiceKey(choice.resource) !== choiceKey(resource)) : basket;
 const queue = current ? [...others, current] : [];
 function browse(keep: boolean) {
  if (keep && current) setBasket([...others, current]);
  setResource(null);setSelected([]);setPreviewItem(null);setError('');setShowSearch(true);
 }
 if (!showCatalog) return <div className="material-feedback">
  {busy || loading
   ? <div role="status">{progress || '正在查找要导入的资料…'} <button type="button" onClick={onClose}>取消导入</button></div>
   : error && <div className="material-notice" role="alert">{error} <button type="button" onClick={() => setShowCatalog(true)}>查看课程资料</button> <button type="button" onClick={onClose}>关闭提示</button></div>}
 </div>;
 return <dialog ref={dialog} className="source-modal remote-materials" aria-labelledby="remote-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} onClick={e=>{if(e.target!==e.currentTarget||busy)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}>
  <button type="button" className="icon-button modal-close" aria-label="关闭课程资料" disabled={busy} onClick={onClose}>×</button>
  <div className="eyebrow">破壁计划</div><h2 id="remote-title">课程资料</h2>
  <p className="materials-hint">资料在服务端解析，提问时使用相关文本片段。</p>
  {error && <p role="alert" className="notice remote-error">{error}</p>}
  {needsAuth && <p><a href="/api/auth/old-site/start">重新通过破壁计划授权</a> · 账号切换后请刷新页面</p>}
  {busy ? <div role="status">{progress}<button type="button" onClick={() => { active.current?.abort();setError('已取消读取。'); }}>取消读取</button></div> : resource ? <>
   <div className="remote-nav"><button type="button" onClick={() => browse(false)}>← 返回搜索</button><button type="button" disabled={!current || loading} onClick={() => browse(true)}>＋ 选择其他资料</button></div>
   <h3>{resource.title}</h3><p>{resource.courseName || '课程资料'} · {resource.kind === 'package' ? '课程包' : `${resource.format.toUpperCase()} · ${bytes(resource.size)}`} · <a href={resource.url} target="_blank" rel="noreferrer">旧站详情</a></p>
   {resource.availability !== 'available' && <p role="status">当前文件无法导入，可能不存在、格式不支持或超过 20 MB。</p>}
   {resource.kind === 'material' && resource.availability !== 'unavailable' && <Preview key={resource.id} url={previewUrl(resource)} format={resource.format} name={resource.title}/>}
   {resource.kind === 'package' && previewItem && <div className="remote-preview-panel"><div className="remote-preview-head"><span>{previewItem.path}</span><button type="button" onClick={() => setPreviewItem(null)}>收起预览</button></div><Preview key={previewItem.id} url={previewUrl(resource, previewItem)} format={previewItem.format} name={previewItem.name}/></div>}
   {resource.kind === 'package' && <div className="remote-catalog" aria-label="课程包目录">{items.map(item => <div className="remote-catalog-row" key={item.id}><label><input type="checkbox" disabled={!item.supported || loading} checked={selected.includes(item.id)} onChange={e => setSelected(old => e.target.checked ? [...old, item.id] : old.filter(id => id !== item.id))}/><span>{item.path}<small>{bytes(item.size)}{!item.supported && ' · 格式不支持或超过 20 MB'}</small></span></label>{previewKind(item.format) && resource.availability === 'available' && <button type="button" className="remote-preview-toggle" aria-pressed={previewItem?.id === item.id} aria-label={`预览：${item.name}`} onClick={() => setPreviewItem(previewItem?.id === item.id ? null : item)}>预览</button>}</div>)}{moreItems && <button type="button" disabled={loading} onClick={() => void more()}>加载更多目录</button>}</div>}
   <div className="remote-confirm">{others.length > 0 && <p>待读清单里还有 {others.length} 项资料，会与当前资料一起读取。</p>}<button type="button" className="primary" disabled={!current || loading || needsAuth} onClick={() => void importChoices(queue)}>{others.length ? `确认读取全部 ${fileCount(queue)} 份文件` : `确认读取${resource.kind === 'package' ? ` ${selected.length} 份文件` : '并导入'}`}</button></div>
  </> : <>
   <div className="remote-search"><select aria-label="资料类别" value={kind} disabled={loading} onChange={e => { setKind(e.target.value as typeof kind);setPage(1);setResults(null); }}><option value="material">单份资料</option><option value="package">课程包</option></select><input autoFocus aria-label="搜索课程资料" placeholder="课程名或资料关键词" maxLength={100} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault();setSearch(query.trim());setPage(1); } }}/><button type="button" onClick={() => { setSearch(query.trim());setPage(1); }}>搜索</button></div>
   {basket.length > 0 && <section className="remote-basket" aria-label="待读清单"><div className="remote-basket-head"><strong>待读清单 · {fileCount(basket)} 份文件</strong></div><ul>{basket.map(choice => <li key={choiceKey(choice.resource)}><button type="button" className="remote-basket-open" disabled={loading} onClick={() => void open(choice.resource.kind, choice.resource.id)}>{choice.resource.title}<small>{choice.resource.kind === 'package' ? `课程包 · ${choice.items.length} 份文件` : `${choice.resource.format.toUpperCase()} · ${bytes(choice.resource.size)}`}</small></button><button type="button" aria-label={`移出：${choice.resource.title}`} onClick={() => setBasket(old => old.filter(other => choiceKey(other.resource) !== choiceKey(choice.resource)))}>移出</button></li>)}</ul><button type="button" className="primary" disabled={loading || needsAuth} onClick={() => void importChoices(basket)}>确认读取 {fileCount(basket)} 份文件</button></section>}
   <div className="remote-results">{results?.items.map(value => <button type="button" key={value.id} onClick={() => void open(value.kind, value.id)} disabled={loading}><strong>{value.title}</strong><small>{value.courseName || '课程资料'} · {value.kind === 'package' ? '查看课程包目录' : `${value.format.toUpperCase()} · ${bytes(value.size)}`}{value.availability !== 'available' && ' · 暂不可读'}{basket.some(choice => choiceKey(choice.resource) === choiceKey(value)) && ' · 已在待读清单'}</small></button>)}{!loading && results?.items.length === 0 && <p>没有找到相关资料，试试其他课程名或关键词。</p>}</div>
   {results && <div className="remote-pagination"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(n => n - 1)}>上一页</button><span>第 {page} 页 · 共 {results.total} 条</span><button type="button" disabled={!results.hasMore || loading} onClick={() => setPage(n => n + 1)}>下一页</button></div>}
  </>}
  {loading && !busy && <p role="status">正在加载资料…</p>}
 </dialog>;
}
