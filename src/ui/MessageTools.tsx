import { useEffect, useRef, useState } from 'react';

type Props = {
  text: string;
  createdAt?: number;
  onEdit?: () => void;
  editDisabled?: boolean;
  onCopyError: () => void;
};

export function MessageTools({ text, createdAt, onEdit, editDisabled, onCopyError }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => {
    setCopied(false);
    return () => { generation.current++; clearTimeout(timer.current); };
  }, [text]);
  async function copy() {
    const version = generation.current;
    try {
      await navigator.clipboard.writeText(text);
      if (version !== generation.current) return;
      clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch { if (version === generation.current) onCopyError(); }
  }
  const date = createdAt === undefined ? null : new Date(createdAt);
  return <div className="message-tools" role="group" aria-label="消息操作">
    {date && Number.isFinite(date.getTime()) && <time dateTime={date.toISOString()} title={date.toLocaleString('zh-CN')}>
      {date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
    </time>}
    <button type="button" className="message-tool" disabled={!text} aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制'} onClick={() => void copy()}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? <path d="m5 12 4 4L19 6"/> : <><rect x="4" y="8" width="12" height="12" rx="3"/><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/></>}
      </svg>
    </button>
    {onEdit && <button type="button" className="message-tool" disabled={editDisabled} aria-label="编辑消息" title="编辑" onClick={onEdit}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m15.5 4.5 4 4M4 20l4.5-1L20 7.5a2.8 2.8 0 0 0-4-4L4.5 15 4 20Z"/>
      </svg>
    </button>}
    <span className="sr-only" role="status">{copied ? '消息已复制到剪贴板' : ''}</span>
  </div>;
}
