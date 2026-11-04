import { useEffect, useRef, useState } from 'react';
import type { ArchiveEntry, Document, MaterialScope, Source } from '../contracts/index.ts';
import { importLocalFile, listLocalArchive } from '../tools/localMaterials.ts';

export function Materials({scope,disabled,onChange,onBusy,onSource}:{scope:MaterialScope;disabled:boolean;onChange:(scope:MaterialScope)=>void;onBusy:(busy:boolean)=>void;onSource:(source:Source)=>void}) {
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
    const existing=documents.find(d=>d.fingerprint===doc.fingerprint);
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
 return <details className="materials-panel" open>
  <summary>本地资料（已选 {selected.length}/{scope.documents.length}）</summary>
  <p className="materials-hint" aria-label="本轮资料范围" role="status">{!scope.documents.length
   ?'尚未导入资料，没有可检索的本地文件。请导入并勾选课程文件，或直接在问题中粘贴原文；也可明确选择按通用知识回答，但不能据此确认本校课件或考试范围。'
   :!selected.length?'尚未勾选资料，没有可检索的本地文件。请勾选下方文件、导入其他资料，或直接在问题中粘贴原文；也可明确选择按通用知识回答。'
   :`本轮已选 ${selected.length} 份资料，仅检索已选文件的可用文本；勾选不代表已读取全文。可取消勾选或移除以调整范围。`}</p>
  <p className="materials-hint">支持 TXT、Markdown、文本 PDF、DOCX、PPTX、ZIP；单文件 20MB。仅在本机解析和保存文本，提问时发送必要片段。</p>
  <label className="material-upload">导入本地资料<input aria-label="导入本地资料" type="file" multiple accept=".txt,.md,.markdown,.pdf,.docx,.pptx,.zip" disabled={locked} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length)void importFiles(files);}}/></label>
  {working&&<div role="status">{progress}<button type="button" onClick={cancel}>取消导入</button></div>}
  {notice&&<div className="material-notice" role="status">{notice}</div>}
  {needsRecovery&&<p className="material-warning" aria-label="导入恢复办法">失败文件未加入已选资料。请确认文件完整、拆分过大文件或重新导出后，用“导入本地资料”重新导入；扫描件请先在本机转为可复制文本，再另存为 TXT／Markdown 导入。不完整的图表和公式请对照原文件。</p>}
  {archive&&<section aria-label="ZIP 目录" className="archive-list">
   <strong>{archive.file.name} · 先选文件再解析</strong>
   {archive.entries.map(entry=><label key={entry.name}><input type="checkbox" disabled={locked||!entry.supported} checked={archive.selected.includes(entry.name)} onChange={e=>setArchive({...archive,selected:e.target.checked?[...archive.selected,entry.name]:archive.selected.filter(n=>n!==entry.name)})}/>{entry.name}（{Math.ceil(entry.size/1024)} KB）{!entry.supported&&' · 格式不支持或超过 20MB'}</label>)}
   <button type="button" disabled={locked||!archive.selected.length||archive.selected.length>20} onClick={()=>void importFiles([archive.file],archive.selected)}>解析选中条目</button>
   <button type="button" disabled={working} onClick={()=>setArchive(null)}>关闭目录</button>
  </section>}
  {!!scope.documents.length&&<ul className="material-list">{scope.documents.map(doc=><li key={doc.id}>
   <label><input type="checkbox" aria-label={`使用资料 ${doc.title}`} disabled={locked} checked={scope.selectedIds.includes(doc.id)} onChange={e=>onChange({...scope,selectedIds:e.target.checked?[...scope.selectedIds,doc.id]:scope.selectedIds.filter(id=>id!==doc.id)})}/>{doc.title}</label>
   <small>{doc.chunks.length} 个文本块</small>
   <select aria-label={`资料类型 ${doc.title}`} disabled={locked} value={doc.kind??'material'} onChange={e=>onChange({...scope,documents:scope.documents.map(d=>d.id===doc.id?{...d,kind:e.target.value as Document['kind']}:d)})}><option value="material">普通资料</option><option value="past_paper">历年试题（自行确认）</option></select>
   <button type="button" disabled={!doc.chunks.length} onClick={()=>onSource(doc.chunks[0])}>查看文本：{doc.title}</button>
   <button type="button" disabled={locked} onClick={()=>onChange({documents:scope.documents.filter(d=>d.id!==doc.id),selectedIds:scope.selectedIds.filter(id=>id!==doc.id)})}>移除：{doc.title}</button>
   {!doc.chunks.length&&<p className="material-warning">没有可用文本。请取消勾选并移除此资料，换用可复制文本的文件重新导入。</p>}
   {doc.warnings.map((warning,i)=><p className="material-warning" key={i}>{warning}</p>)}
   {!!doc.warnings.length&&<p className="material-warning">请查看缓存文本并对照原文件；缺失内容可另存为 TXT／Markdown 补充导入，或取消勾选此资料后重选。</p>}
  </li>)}</ul>}
 </details>;
}
