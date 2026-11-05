import { useEffect, useRef, useState } from 'react';
import type { Document, Source } from '../contracts/index.ts';

export function SourceViewer({source,document,onClose}:{source:Source;document?:Document;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const [chunkId,setChunkId]=useState(source.chunkId);
 const original=document?.chunks.find(chunk=>chunk.chunkId===source.chunkId);
 const cached=document?.chunks.find(chunk=>chunk.chunkId===chunkId);
 const shortened=!!original&&original.text!==source.text;
 useEffect(()=>{
  const previous=window.document.activeElement;
  const element=dialog.current!;
  element.showModal();
  return ()=>{element.close();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
 },[]);
 return <dialog ref={dialog} className="source-modal" aria-labelledby="source-title" onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{
  if(event.key!=='Tab')return;
  const controls=event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), a[href]');
  const first=controls[0],last=controls[controls.length-1];
  if(event.shiftKey&&window.document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&window.document.activeElement===last){event.preventDefault();first?.focus();}
 }} onClick={event=>{
  if(event.target!==event.currentTarget)return;
  const rect=event.currentTarget.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose();
 }}>
  <button className="icon-button modal-close" onClick={onClose} aria-label="关闭来源" autoFocus>×</button>
  <div className="eyebrow">来源</div>
  <h2 id="source-title">{document?.title??source.title}</h2>
  {(document?.remoteRef?.url??source.url)&&<p><a href={document?.remoteRef?.url??source.url} target="_blank" rel="noreferrer">查看旧站原资料</a></p>}
  <p className="source-location">{cached?.location??source.location}</p>
  {shortened&&<section aria-label="本轮读取片段"><strong>本轮读取片段 · {source.location}</strong><p>引用记录的片段少于缓存原文；其余文字不代表本轮已读依据。</p><pre>{source.text}</pre></section>}
  {source.text ? <><p>{cached?'缓存原文（仅本机保存的提取文本，不代表模型已读取全文）':'资料缓存已移除或不可用，当前仅显示引用时保存的片段。请重新导入原文件以核对其余内容。'}</p>
  {cached&&<label>文本位置<select aria-label="文本位置" value={chunkId} onChange={event=>setChunkId(event.target.value)}>{document!.chunks.map(chunk=><option key={chunk.chunkId} value={chunk.chunkId}>{chunk.location}</option>)}</select></label>}
  <pre aria-label={cached?'缓存原文':'保存的来源片段'}>{cached?.text??source.text}</pre></> : <p>该来源由服务端读取，可通过原资料链接核对。</p>}
  {!!document?.warnings.length&&<div aria-label="解析限制">{document.warnings.map((warning,i)=><p key={i}>{warning}</p>)}<p>请对照原文件；缺失内容可另存为可复制文本重新导入，再勾选后提问。</p></div>}
 </dialog>;
}
