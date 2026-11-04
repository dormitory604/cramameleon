import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppSession, ArchiveEntry, Document, MaterialScope, Source } from '../contracts/index.ts';
import { importLocalFile, listLocalArchive } from '../tools/localMaterials.ts';
import { RemoteMaterials } from './RemoteMaterials.tsx';

type MaterialComposerProps = {
 session?: AppSession | null;
 scope: MaterialScope;
 disabled: boolean;
 onChange: (scope: MaterialScope) => void;
 onBusy: (busy: boolean) => void;
 onSource: (source: Source) => void;
 onSubmit: () => void;
 actions: ReactNode;
 children: ReactNode;
};

export function MaterialComposer({session, scope, disabled, onChange, onBusy, onSource, onSubmit, actions, children}: MaterialComposerProps) {
 const [remoteOpen, setRemoteOpen] = useState(false);
 const [entryContext,setEntryContext]=useState<AppSession['initialContext']>();
 useEffect(()=>{
  if(session?.mode!=='old-site'||!session.initialContext||!Object.keys(session.initialContext).length)return;
  const key=`cram-entry:${session.user.id}:${JSON.stringify(session.initialContext)}`;
  if(sessionStorage.getItem(key))return;
  sessionStorage.setItem(key,'1');setEntryContext(session.initialContext);setRemoteOpen(true);
 },[session?.user.id]);
 const [menuOpen, setMenuOpen] = useState(false);
 const [dragging, setDragging] = useState(false);
 const dragDepth = useRef(0);
 const menu = useRef<HTMLDivElement>(null);
 const menuTrigger = useRef<HTMLButtonElement>(null);
 const fileInput = useRef<HTMLInputElement>(null);
 useEffect(() => {
  if (!menuOpen) return;
  function dismissOutside(event: PointerEvent) {
   if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
  }
  document.addEventListener('pointerdown', dismissOutside);
  return () => document.removeEventListener('pointerdown', dismissOutside);
 }, [menuOpen]);
 const [progress,setProgress]=useState('');
 const [notice,setNotice]=useState('');
 const [needsRecovery,setNeedsRecovery]=useState(false);
 const [archive,setArchive]=useState<{file:File;entries:ArchiveEntry[];selected:string[]}|null>(null);
 const controller=useRef<AbortController|null>(null);
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
 const working=!!controller.current;
 async function importFiles(files:File[],selected?:string[]) {
  if(controller.current||disabled)return;
  setMenuOpen(false);
  const task=new AbortController();controller.current=task;onBusy(true);setNotice('');setNeedsRecovery(false);setProgress('准备解析…');
  try {
   if(files.length===1&&files[0].name.toLowerCase().endsWith('.zip')&&!selected) {
    const entries=await listLocalArchive(files[0],task.signal);task.signal.throwIfAborted();
    setArchive({file:files[0],entries,selected:[]});setNotice('请从目录勾选需要的文件，再开始解析。');return;
   }
   if(files.length>20)throw new Error('每次最多导入 20 份资料');
   if(files.some(f=>f.name.toLowerCase().endsWith('.zip'))&&files.length>1)throw new Error('ZIP 请单独选择，以便先确认目录');
   const incoming:Document[]=[],warnings:string[]=[];
   for(const file of files) {
    setProgress(`正在解析：${file.name}`);
    try {const result=await importLocalFile(file,task.signal,setProgress,selected);incoming.push(...result.documents);warnings.push(...result.warnings);}
    catch(error) {task.signal.throwIfAborted();warnings.push(`${file.name}：${error instanceof Error?error.message:'解析失败'}`);}
   }
   task.signal.throwIfAborted();
   setNeedsRecovery(warnings.length>0);
   const documents=[...scope.documents],selectedIds=new Set(scope.selectedIds);let added=0;
   for(const doc of incoming) {
    const existing=documents.find(d=>d.origin!=='old-site'&&d.fingerprint===doc.fingerprint);
    if(existing){selectedIds.add(existing.id);warnings.push(`${doc.title}：已有相同内容，复用本机缓存`);continue;}
    if(documents.length>=20){warnings.push(`${doc.title}：每个会话最多 20 份资料，请移除不用的资料后重试`);continue;}
    documents.push(doc);selectedIds.add(doc.id);added++;
   }
   if(incoming.length)onChange({documents,selectedIds:[...selectedIds]});
   setNotice([`已导入 ${added} 份资料。`,...warnings].join('\n'));
   if(added)setArchive(null);
  } catch(error) {if(!task.signal.aborted){setNotice(error instanceof Error?error.message:'解析失败');setNeedsRecovery(true);}}
  finally {if(controller.current===task){controller.current=null;if(mounted.current){setProgress('');onBusy(false);}}}
 }
 function cancel(){controller.current?.abort();setNotice('已取消，未提交的解析结果不会保存。');}
 const locked=disabled||working;
 const selected=scope.documents.filter(doc=>scope.selectedIds.includes(doc.id));
 return <form
  className={dragging && !locked ? 'composer composer-dragging' : 'composer'}
  onSubmit={event => { event.preventDefault(); if(!remoteOpen)onSubmit(); }}
  onDragEnter={event => {
   if (!event.dataTransfer.types.includes('Files')) return;
   event.preventDefault();
   dragDepth.current++;
   if (!locked) setDragging(true);
  }}
  onDragOver={event => {
   if (!event.dataTransfer.types.includes('Files')) return;
   event.preventDefault();
   event.dataTransfer.dropEffect = locked ? 'none' : 'copy';
  }}
  onDragLeave={() => {
   dragDepth.current = Math.max(0, dragDepth.current - 1);
   if (!dragDepth.current) setDragging(false);
  }}
  onDrop={event => {
   dragDepth.current = 0;
   setDragging(false);
   const files = Array.from(event.dataTransfer.files);
   if (!files.length && !event.dataTransfer.types.includes('Files')) return;
   event.preventDefault();
   if (files.length) void importFiles(files);
  }}
 >
  <input ref={fileInput} hidden aria-label="导入本地资料" type="file" multiple accept=".txt,.md,.markdown,.pdf,.docx,.pptx,.zip" disabled={locked}
   onChange={event => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length) void importFiles(files);
   }}/>
  {(working || notice || needsRecovery || archive) && <div className="material-feedback">
  {working&&<div role="status">{progress}<button type="button" onClick={cancel}>取消导入</button></div>}
  {notice&&<div className="material-notice" role="status">{notice}</div>}
  {needsRecovery&&<p className="material-warning" aria-label="导入恢复办法">失败文件未加入已选资料。请确认文件完整、拆分过大文件或重新导出后，用“导入本地资料”重新导入；扫描件请先在本机转为可复制文本，再另存为 TXT／Markdown 导入。不完整的图表和公式请对照原文件。</p>}
  {archive&&<section aria-label="ZIP 目录" className="archive-list">
   <strong>{archive.file.name} · 先选文件再解析</strong>
   {archive.entries.map(entry=><label key={entry.name}><input type="checkbox" disabled={locked||!entry.supported} checked={archive.selected.includes(entry.name)} onChange={e=>setArchive({...archive,selected:e.target.checked?[...archive.selected,entry.name]:archive.selected.filter(n=>n!==entry.name)})}/>{entry.name}（{Math.ceil(entry.size/1024)} KB）{!entry.supported&&' · 格式不支持或超过 20MB'}</label>)}
   <button type="button" disabled={locked||!archive.selected.length||archive.selected.length>20} onClick={()=>void importFiles([archive.file],archive.selected)}>解析选中条目</button>
   <button type="button" disabled={working} onClick={()=>setArchive(null)}>关闭目录</button>
  </section>}
  </div>}
  {!!scope.documents.length && <details className="materials-panel">
   <summary><span>学习资料（已选 {scope.selectedIds.length}/{scope.documents.length}）</span><span className="material-names">{scope.documents.map(doc => doc.title).join('、')}</span></summary>
   <p className="materials-hint" aria-label="本轮资料范围" role="status">{!selected.length?'尚未勾选资料，没有可检索的本地文件。请勾选下方文件、导入其他资料，或直接在问题中粘贴原文；也可明确选择按通用知识回答。':`本轮已选 ${selected.length} 份资料，仅检索已选文件的可用文本；勾选不代表已读取全文。可取消勾选或移除以调整范围。`}</p>
   <ul className="material-list">{scope.documents.map(doc=><li key={doc.id}>
   <label><input type="checkbox" aria-label={`使用资料 ${doc.title}`} disabled={locked} checked={scope.selectedIds.includes(doc.id)} onChange={e=>onChange({...scope,selectedIds:e.target.checked?[...scope.selectedIds,doc.id]:scope.selectedIds.filter(id=>id!==doc.id)})}/>{doc.title}</label>
   <small>{doc.chunks.length} 个文本块</small>
   {doc.remoteRef&&<a href={doc.remoteRef.url} target="_blank" rel="noreferrer">旧站原资料</a>}
   <select aria-label={`资料类型 ${doc.title}`} disabled={locked} value={doc.kind??'material'} onChange={e=>onChange({...scope,documents:scope.documents.map(d=>d.id===doc.id?{...d,kind:e.target.value as Document['kind']}:d)})}><option value="material">普通资料</option><option value="past_paper">历年试题（自行确认）</option></select>
   <button type="button" disabled={!doc.chunks.length} onClick={()=>onSource(doc.chunks[0])}>查看文本：{doc.title}</button>
   <button type="button" disabled={locked} onClick={()=>onChange({documents:scope.documents.filter(d=>d.id!==doc.id),selectedIds:scope.selectedIds.filter(id=>id!==doc.id)})}>移除：{doc.title}</button>
   {!doc.chunks.length&&<p className="material-warning">没有可用文本。请取消勾选并移除此资料，换用可复制文本的文件重新导入。</p>}
   {doc.warnings.map((warning,i)=><p className="material-warning" key={i}>{warning}</p>)}
   {!!doc.warnings.length&&<p className="material-warning">请查看缓存文本并对照原文件；缺失内容可另存为 TXT／Markdown 补充导入，或取消勾选此资料后重选。</p>}
  </li>)}</ul>
  </details>}
  {children}
  <div className="composer-bar">
   <div className="composer-add" ref={menu}
    onBlur={event => {
     if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
    }}
    onKeyDown={event => {
     if (event.key !== 'Escape' || !menuOpen) return;
     event.preventDefault();
     setMenuOpen(false);
     menuTrigger.current?.focus();
    }}
   >
    <button ref={menuTrigger} className="composer-add-button" type="button" aria-label="添加" aria-expanded={menuOpen && !locked} aria-controls="composer-add-options" disabled={locked}
     onClick={event => {
      event.currentTarget.focus();
      setMenuOpen(open => !open);
     }}>
     <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    <div id="composer-add-options" className="composer-add-options" hidden={!menuOpen || locked}>
     {session?.mode==='old-site'&&<button type="button" onClick={()=>{setMenuOpen(false);setRemoteOpen(true);}}>搜索课程资料</button>}
     <button type="button" aria-describedby="composer-file-help" onClick={() => {
      menuTrigger.current?.focus();
      setMenuOpen(false);
      fileInput.current?.click();
     }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5l-8.7 8.7a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
      添加文件
     </button>
     <p id="composer-file-help" className="materials-hint">也可拖到输入框。支持 TXT、Markdown、文本 PDF、DOCX、PPTX、ZIP，单文件 20 MB。文件在本机解析，提问时仅发送必要片段。</p>
    </div>
   </div>
   {actions}
  </div>
  {dragging && !locked && <div className="composer-drop-hint" aria-hidden="true">松开以添加文件</div>}
  {remoteOpen&&session?.mode==='old-site'&&<RemoteMaterials session={session} documents={scope.documents} onBusy={onBusy} onClose={()=>{setRemoteOpen(false);setEntryContext(undefined);}} initial={entryContext} onImport={incoming=>{
   const documents=[...scope.documents],selectedIds=new Set(scope.selectedIds);
   for(const doc of incoming){const index=documents.findIndex(d=>d.id===doc.id);if(index>=0)documents[index]=doc;else documents.push(doc);selectedIds.add(doc.id);}
   onChange({documents,selectedIds:[...selectedIds]});
  }}/>}
 </form>;
}
