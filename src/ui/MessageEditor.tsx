import { useEffect, useRef, useState } from 'react';

export function MessageEditor({ text, disabled, onCancel, onSend }: {
  text: string; disabled: boolean; onCancel: () => void; onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textarea.current?.focus();
    textarea.current?.setSelectionRange(text.length, text.length);
  }, []);
  return <form className="message-editor" aria-label="编辑用户消息" onSubmit={event => {
    event.preventDefault();
    if (!disabled && draft.trim() && draft.trim() !== text) onSend(draft.trim());
  }} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); }
  }}>
    <textarea ref={textarea} aria-label="编辑消息内容" value={draft} maxLength={8000} rows={Math.min(12, Math.max(3, draft.split('\n').length))} disabled={disabled} onChange={event => setDraft(event.target.value)}/>
    <p>从这里重新回答，原对话会保留为“编辑前版本”。</p>
    <div className="message-editor-actions">
      <button type="button" onClick={onCancel}>取消</button>
      <button type="submit" className="primary-button" disabled={disabled || !draft.trim() || draft.trim() === text}>保存并重新发送</button>
    </div>
  </form>;
}
