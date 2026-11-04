import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Scenario, Source } from '../contracts/index.ts';
import { PiAgentAdapter } from '../agent/PiAgentAdapter.ts';
import { loadMessages, saveMessages } from '../session/demoStore.ts';

// 学习模式是纯前端概念，发送时映射到现有的后端演示场景。
type Mode = 'qa' | 'concept' | 'system' | 'exam';
const modes: { id: Mode; title: string; short: string; icon: string; description: string; scenario: Scenario; prompts: string[] }[] = [
  { id: 'qa', title: '普通问答', short: '问答', icon: '◌', description: '直接提问，快速得到解答。', scenario: 'chat', prompts: ['这个 Demo 的整体架构是怎样的？', '前端和后端是如何通信的？'] },
  { id: 'concept', title: '概念学习', short: '概念', icon: '◇', description: '围绕一个概念，讲清定义、例子与易错点。', scenario: 'chat', prompts: ['解释一下什么是流式响应。', '工具调用是什么意思？'] },
  { id: 'system', title: '系统学习', short: '系统', icon: '▦', description: '按章节循序渐进，构建完整知识框架。', scenario: 'chat', prompts: ['帮我系统梳理 Agent 的工作流程。', '给我一份分步骤的学习计划。'] },
  { id: 'exam', title: '模拟考试', short: '考试', icon: '✎', description: '出题、作答、即时反馈与解析。', scenario: 'quiz', prompts: ['给我出一道关于这个 Demo 架构的题。', '开始一次模拟考试。'] },
];
const modeOf = (id?: Mode) => modes.find(item => item.id === id) ?? modes[0];

// 在不改动存储层的前提下，把所有会话的消息平铺保存，并用 conversationId 区分。
type UiMessage = ChatMessage & { conversationId?: string; mode?: Mode; createdAt?: number };
type Health = { status: string; stats?: { active: number; requests: number; completed: number; cancelled: number } };
const statusText: Record<string, string> = { running: '运行中', completed: '已完成', cancelled: '已停止', failed: '失败', limited: '达到上限', interrupted: '已中断' };
const LEGACY_ID = 'legacy';

function relativeTime(time?: number) {
  if (!time) return '';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [mode, setMode] = useState<Mode>('qa');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageStatus, setStorageStatus] = useState('正在读取本机记录');
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latestMessages = useRef(messages);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestMessages.current = messages;
  const selected = modeOf(mode);

  const conversations = useMemo(() => {
    const map = new Map<string, { id: string; title: string; mode: Mode; updatedAt: number; running: boolean; count: number }>();
    for (const message of messages) {
      const id = message.conversationId ?? LEGACY_ID;
      const entry = map.get(id) ?? { id, title: '', mode: message.mode ?? 'qa', updatedAt: 0, running: false, count: 0 };
      if (!entry.title && message.role === 'user') entry.title = message.text.slice(0, 40);
      if (message.mode) entry.mode = message.mode;
      entry.updatedAt = Math.max(entry.updatedAt, message.createdAt ?? 0);
      entry.running ||= message.status === 'running';
      entry.count += 1;
      map.set(id, entry);
    }
    return [...map.values()].map(item => ({ ...item, title: item.title || '新对话' })).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [messages]);
  const visibleConversations = conversations.filter(item => !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase()));
  const current = messages.filter(message => (message.conversationId ?? LEGACY_ID) === conversationId);
  const currentTitle = conversations.find(item => item.id === conversationId)?.title ?? '新对话';

  async function refreshHealth() {
    try { const response = await fetch('/api/health'); if (!response.ok) throw new Error(); setHealth(await response.json()); }
    catch { setHealth(null); }
  }
  useEffect(() => {
    void refreshHealth();
    void fetch('/api/session').then(response => { if (response.ok) setAuthenticated(true); else if (response.status === 401) setAuthenticated(false); else throw new Error(); }).catch(() => { setAuthenticated(false); setNotice('无法连接后端，请检查 SSH 转发与服务。'); });
    return () => { active.current?.controller.abort(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    void loadMessages().then(saved => {
      if (!live) return;
      const list = saved as UiMessage[];
      setMessages(list);
      setStorageStatus('已恢复本机记录');
      const latest = [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
      if (latest) { setConversationId(latest.conversationId ?? LEGACY_ID); setMode(latest.mode ?? 'qa'); }
    }).catch(() => { if (live) setStorageStatus('本机存储不可用，刷新后记录将丢失'); }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [authenticated]);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveMessages(latestMessages.current).then(() => setStorageStatus('已保存到当前浏览器')).catch(() => setStorageStatus('保存失败，刷新后可能丢失记录'));
    }, 200);
  }, [messages, loaded, authenticated]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [messages, conversationId]);
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

  async function authorize() {
    setAuthBusy(true); setNotice('');
    try {
      const response = await fetch('/api/demo/session', { method: 'POST' });
      if (!response.ok) throw new Error('模拟授权失败，请检查后端开发模式配置。');
      setAuthenticated(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : '模拟授权失败'); }
    finally { setAuthBusy(false); }
  }
  function updateMessage(id: string, change: (message: UiMessage) => UiMessage) {
    setMessages(previous => previous.map(message => message.id === id ? change(message) : message));
  }
  async function run(text: string, nextMode: Mode = mode) {
    if (!text.trim() || active.current || !loaded) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const scenario = modeOf(nextMode).scenario;
    const now = Date.now();
    active.current = { id, controller }; setBusy(true); setInput(''); setNotice('');
    setMessages(previous => [...previous,
      { id: crypto.randomUUID(), role: 'user', text: text.trim(), scenario, mode: nextMode, conversationId, createdAt: now },
      { id, role: 'assistant', text: '', status: 'running', logs: [], modelRequests: 0, toolCalls: 0, scenario, mode: nextMode, conversationId, createdAt: now + 1 }]);
    try {
      for await (const event of new PiAgentAdapter().run({ sessionId: 'demo-developer', turnId: id, text, scenario, signal: controller.signal })) {
        if (active.current?.id !== id || event.turnId !== id) continue;
        if (controller.signal.aborted && event.type !== 'done') continue;
        updateMessage(id, message => {
          switch (event.type) {
            case 'text_delta': return { ...message, text: message.text + event.delta };
            case 'tool_status': return { ...message, logs: [...message.logs ?? [], event.message], modelRequests: (message.modelRequests ?? 0) + Number(event.category === 'model' && event.status === 'started'), toolCalls: (message.toolCalls ?? 0) + Number(event.category === 'tool' && event.status === 'started') };
            case 'quiz_ready': return { ...message, quiz: event.quiz };
            case 'sources_ready': return { ...message, sources: event.sources };
            case 'error': return { ...message, error: event.message };
            case 'done': return { ...message, status: event.status };
          }
        });
      }
    } catch (error) {
      updateMessage(id, message => ({ ...message, status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : '运行失败' }));
    } finally {
      if (active.current?.id === id) { active.current = null; setBusy(false); }
      void refreshHealth();
    }
  }
  function stop() {
    const running = active.current;
    if (!running) return;
    running.controller.abort();
    updateMessage(running.id, message => ({ ...message, status: 'cancelled' }));
  }
  async function copy(message: UiMessage) {
    try { await navigator.clipboard.writeText(message.text); setCopiedId(message.id); setTimeout(() => setCopiedId(''), 1800); }
    catch { setNotice('浏览器未允许复制，请手动选择文字。'); }
  }
  function retry(message: UiMessage) {
    const index = current.findIndex(item => item.id === message.id);
    const prompt = current[index - 1];
    if (prompt?.role === 'user') void run(prompt.text, message.mode ?? mode);
  }
  function newConversation() {
    if (busy) return;
    setConversationId(crypto.randomUUID()); setInput(''); setNotice(''); setSidebarOpen(false);
    setTimeout(() => textarea.current?.focus(), 0);
  }
  function openConversation(id: string, lastMode: Mode) {
    if (busy) return;
    setConversationId(id); setMode(lastMode); setNotice(''); setSidebarOpen(false);
  }
  function deleteConversation(id: string) {
    if (busy) return;
    setMessages(previous => previous.filter(message => (message.conversationId ?? LEGACY_ID) !== id));
    if (id === conversationId) setConversationId(crypto.randomUUID());
  }

  if (!authenticated) return <div className="auth-screen">
    <div className="auth-card">
      <div className="brand"><span className="brand-mark">C</span><span>Cramameleon</span></div>
      <h1>开始学习</h1>
      <p>普通问答、概念学习、系统学习、模拟考试，四种模式随时切换。</p>
      <button className="primary-button" onClick={() => void authorize()} disabled={authBusy || authenticated === null}>{authenticated === null ? '检查会话中…' : authBusy ? '授权中…' : '进入（模拟授权）'}</button>
      <small>内部 Demo 授权，不连接旧站账号。</small>
      {notice && <div role="alert" className="notice">{notice}</div>}
    </div>
  </div>;

  return <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <aside className="sidebar" aria-label="会话列表">
      <div className="sidebar-header">
        <div className="brand"><span className="brand-mark">C</span><span>Cramameleon</span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏">×</button>
      </div>
      <button className="new-chat" onClick={newConversation} disabled={busy}><span>＋</span>新对话</button>
      <input className="search" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索对话"/>
      <div className="sidebar-label">对话</div>
      <nav className="conversation-list">
        {!visibleConversations.length && <div className="list-empty">{query ? '没有匹配的对话' : '还没有对话'}</div>}
        {visibleConversations.map(item => <div key={item.id} className={`conversation-item ${item.id === conversationId ? 'active' : ''}`}>
          <button className="conversation-main" disabled={busy && item.id !== conversationId} onClick={() => openConversation(item.id, item.mode)}>
            <span className="conversation-title">{item.running && <span className="running-dot"/>}{item.title}</span>
            <span className="conversation-meta"><span className={`mode-tag mode-${item.mode}`}>{modeOf(item.mode).short}</span>{relativeTime(item.updatedAt)} · {item.count} 条</span>
          </button>
          <button className="conversation-delete" disabled={busy} onClick={() => deleteConversation(item.id)} aria-label={`删除对话 ${item.title}`} title="删除">×</button>
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <span className={`status-dot ${health?.status === 'ok' ? 'online' : 'offline'}`}/>
        <span>{health?.status === 'ok' ? '服务在线' : '后端待检查'}</span>
        <small>{storageStatus}</small>
      </div>
    </aside>
    <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)}/>

    <main className="main">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏">☰</button>
        <div className="topbar-title"><strong>{currentTitle}</strong><span>{selected.title}</span></div>
        <div className="mode-switch" role="tablist" aria-label="学习模式">
          {modes.map(item => <button key={item.id} role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} disabled={busy} onClick={() => setMode(item.id)} title={item.description}><span>{item.icon}</span>{item.title}</button>)}
        </div>
      </header>

      <section className="chat" aria-label="聊天记录" aria-live="polite">
        <div className="chat-inner">
          {!current.length && <div className="empty">
            <div className="empty-icon">{selected.icon}</div>
            <h2>{selected.title}</h2>
            <p>{selected.description}</p>
            <div className="suggestions">{selected.prompts.map(prompt => <button key={prompt} disabled={busy || !loaded} onClick={() => void run(prompt)}>{prompt}<span>↗</span></button>)}</div>
            <small>当前为演示环境，回复为固定脚本。</small>
          </div>}
          {current.map((message, index) => message.role === 'user'
            ? <article key={message.id} className="msg user"><div className="bubble">{message.text}</div></article>
            : <article key={message.id} className="msg assistant">
              <div className="msg-head"><span className="brand-mark small">C</span><span className={`mode-tag mode-${message.mode ?? 'qa'}`}>{modeOf(message.mode).title}</span>{message.status && message.status !== 'completed' && <span className={`run-status ${message.status}`}>{statusText[message.status]}</span>}</div>
              {!!message.logs?.length && <details className="tool-block" open={message.status === 'running'}>
                <summary><span className="tool-icon">⚙</span><span>工具调用</span><span className="tool-count">{message.modelRequests ?? 0} 次模型请求 · {message.toolCalls ?? 0} 次工具调用</span></summary>
                <ol>{message.logs.map((log, logIndex) => <li key={logIndex}>{log}</li>)}</ol>
              </details>}
              {message.text ? <div className="msg-text">{message.text}{message.status === 'running' && <span className="cursor"/>}</div> : message.status === 'running' && <div className="thinking"><span/><span/><span/></div>}
              {message.error && <div role="alert" className="error-card">{message.error}</div>}
              {message.quiz && <div className="quiz">
                <div className="quiz-top"><span>模拟考试</span><span>单选题</span></div>
                <h3>{message.quiz.question}</h3>
                <div className="quiz-options">{message.quiz.options.map(option => <button key={option.id} disabled={!!message.revealed} className={`quiz-option ${message.revealed ? option.id === message.quiz!.correctOptionId ? 'correct' : option.id === message.selectedOption ? 'incorrect' : '' : ''}`} onClick={() => updateMessage(message.id, item => ({ ...item, selectedOption: option.id, revealed: true }))}><span className="option-key">{option.id}</span><span>{option.text}</span>{message.revealed && option.id === message.quiz!.correctOptionId && <b>✓</b>}</button>)}</div>
                {message.revealed
                  ? <div className="quiz-feedback"><strong className={message.selectedOption === message.quiz.correctOptionId ? 'ok' : 'bad'}>{message.selectedOption === message.quiz.correctOptionId ? '回答正确' : `回答错误，正确答案：${message.quiz.correctOptionId}`}</strong>{message.quiz.options.map(option => <p key={option.id}><b>{option.id}.</b> {option.explanation}</p>)}</div>
                  : <small className="quiz-hint">选择一个选项后显示答案与解析。</small>}
              </div>}
              {!!message.sources?.length && <div className="sources">{message.sources.map(item => <button key={item.chunkId} onClick={() => setSource(item)}>▧ {item.title}</button>)}</div>}
              {message.status !== 'running' && <div className="msg-actions">
                <button onClick={() => void copy(message)} disabled={!message.text}>{copiedId === message.id ? '已复制' : '复制'}</button>
                {index === current.length - 1 && ['cancelled', 'failed', 'interrupted', 'limited'].includes(message.status ?? '') && <button disabled={busy} onClick={() => retry(message)}>重试</button>}
              </div>}
            </article>)}
          <div ref={bottom}/>
        </div>
      </section>

      <footer className="composer-wrap">
        {notice && <div role="alert" className="notice">{notice}</div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); void run(input); }}>
          <label className="sr-only" htmlFor="message-input">输入消息</label>
          <textarea ref={textarea} id="message-input" rows={1} placeholder={`${selected.title}：${selected.prompts[0]}`} value={input} disabled={busy || !loaded} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void run(input); } }}/>
          <div className="composer-bar">
            <label className="mode-select"><span>{selected.icon}</span>
              <select value={mode} disabled={busy} onChange={event => setMode(event.target.value as Mode)} aria-label="切换学习模式">{modes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
            </label>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            {busy ? <button className="stop-button" type="button" onClick={stop} aria-label="停止">■</button> : <button className="send-button" type="submit" disabled={!input.trim() || !loaded} aria-label="发送消息">↑</button>}
          </div>
        </form>
      </footer>
    </main>

    {source && <div className="modal-backdrop" onClick={() => setSource(null)}><section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title" onClick={event => event.stopPropagation()}><button className="icon-button modal-close" onClick={() => setSource(null)} aria-label="关闭来源">×</button><div className="eyebrow">来源</div><h2 id="source-title">{source.title}</h2><p className="source-location">{source.location}</p><pre>{source.text}</pre></section></div>}
  </div>;
}
// TODO(ui): Course/material selection, real mode-specific prompts and full accessibility pass.
// TODO(auth): Replace simulated entrance with old-site one-time authorization code exchange.
