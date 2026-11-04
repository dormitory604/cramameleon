import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentAction, AppSession, ChatMessage, EntryConfig, LearningState, MaterialScope, Source } from '../contracts/index.ts';
import { MaterialComposer } from './Materials.tsx';
import { PiAgentAdapter } from '../agent/PiAgentAdapter.ts';
import { buildHistory } from '../agent/context.ts';
import { loadData, saveData } from '../session/appStore.ts';

// UI consumes business events only; the Agent owns model/tool scheduling.
type UiMessage = ChatMessage;
type Health = { status: string; stats?: { active: number; requests: number; completed: number; cancelled: number } };
const statusText: Record<string, string> = { running: '运行中', completed: '已完成', cancelled: '已停止', failed: '失败', limited: '达到上限', interrupted: '已中断', waiting: '等待你的选择' };
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
  const [appSession, setAppSession] = useState<AppSession | null>(null);
  const [entryConfig, setEntryConfig] = useState<EntryConfig | null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [states, setStates] = useState<Record<string, LearningState>>({});
  const [materials, setMaterials] = useState<Record<string, MaterialScope>>({});
  const [importing, setImporting] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageStatus, setStorageStatus] = useState('正在读取本机记录');
  const [loaded, setLoaded] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latestMessages = useRef(messages);
  const latestStates = useRef(states);
  const latestMaterials = useRef(materials);
  latestMaterials.current = materials;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identity = useRef('');
  const authChannel = useRef<BroadcastChannel | null>(null);
  latestMessages.current = messages;
  latestStates.current = states;

  const conversations = useMemo(() => {
    const map = new Map<string, { id: string; title: string; updatedAt: number; running: boolean; count: number }>();
    for (const [id, scope] of Object.entries(materials)) {
      if(scope.documents.length) map.set(id, { id, title: scope.documents[0].title, updatedAt: scope.documents[0].importedAt ?? 0, running: false, count: 0 });
    }
    for (const message of messages) {
      const id = message.conversationId ?? LEGACY_ID;
      const entry = map.get(id) ?? { id, title: '', updatedAt: 0, running: false, count: 0 };
      if (!entry.title && message.role === 'user') entry.title = message.text.slice(0, 40);
      entry.updatedAt = Math.max(entry.updatedAt, message.createdAt ?? 0);
      entry.running ||= message.status === 'running';
      entry.count += 1;
      map.set(id, entry);
    }
    return [...map.values()].map(item => ({ ...item, title: item.title || '新对话' })).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [messages, materials]);
  const visibleConversations = conversations.filter(item => !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase()));
  const current = messages.filter(message => (message.conversationId ?? LEGACY_ID) === conversationId);
  const currentTitle = conversations.find(item => item.id === conversationId)?.title ?? '新对话';
  const sourceDocument = source ? materials[conversationId]?.documents.find(d=>d.id===source.documentId) : undefined;
  const cachedSource = sourceDocument?.chunks.find(c=>c.chunkId===source?.chunkId) ?? source;

  function clearUserView() {
    active.current?.controller.abort(); active.current = null;
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    latestMessages.current = []; latestStates.current = {}; latestMaterials.current = {};
    setMessages([]); setStates({}); setMaterials({}); setSource(null);
    setBusy(false); setImporting(false); setLoaded(false); setStorageReady(false);
    setInput(''); setConversationId(crypto.randomUUID());
  }
  function acceptSession(session: AppSession) {
    if (identity.current && identity.current !== session.user.id) clearUserView();
    identity.current = session.user.id;
    setAppSession(session); setAuthenticated(true);
  }
  function invalidateSession() {
    clearUserView(); identity.current = ''; setAppSession(null); setAuthenticated(false);
  }

  async function refreshHealth() {
    try { const response = await fetch('/api/health'); if (!response.ok) throw new Error(); setHealth(await response.json()); }
    catch { setHealth(null); }
  }
  useEffect(() => {
    void refreshHealth();
    const entryError = new URLSearchParams(location.search).get('entryError');
    if (entryError) {
      setNotice(entryError === 'ENTRY_NOT_ALLOWED' ? '当前账号尚未获得内测资格，请联系项目维护者。' : entryError === 'OLD_SITE_UNAVAILABLE' ? '暂时无法连接破壁计划，请稍后重新进入。' : '本次进入授权未完成，请从破壁计划重新进入。');
      history.replaceState(null, '', location.pathname);
    }
    void fetch('/api/session').then(async response => { if (response.ok) acceptSession(await response.json()); else if (response.status === 401) setAuthenticated(false); else throw new Error(); }).catch(() => { setAuthenticated(false); setNotice('无法连接后端，请检查 SSH 转发与服务。'); });
    return () => { active.current?.controller.abort(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);
  useEffect(() => {
    if (authenticated !== false) return;
    const controller = new AbortController();
    void fetch('/api/auth/config', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error();
      const config: EntryConfig = await response.json();
      if (!['internal', 'old-site'].includes(config.mode)) throw new Error();
      if (!controller.signal.aborted) setEntryConfig(config);
    }).catch(() => { if (!controller.signal.aborted) setNotice('暂时无法确认进入方式，请刷新页面重试。'); });
    return () => controller.abort();
  }, [authenticated]);
  useEffect(() => {
    if (appSession?.mode !== 'old-site' || !appSession.user.id) return;
    const channel = new BroadcastChannel('cramameleon-auth');
    authChannel.current = channel;
    channel.onmessage = event => {
      if (event.data?.type === 'signed-out' || event.data?.type === 'identity' && event.data.userId !== identity.current) {
        invalidateSession(); setNotice('账号已在其他页面切换或退出，请刷新后继续。');
      }
    };
    channel.postMessage({ type: 'identity', userId: appSession.user.id });
    return () => { channel.close(); if (authChannel.current === channel) authChannel.current = null; };
  }, [appSession?.user.id]);
  useEffect(() => {
    if (!authenticated || !appSession) return;
    let live = true;
    setLoaded(false);
    setStorageReady(false);
    void loadData(appSession.user.id).then(saved => {
      if (!live || identity.current !== appSession.user.id) return;
      const list = saved.messages;
      setStates(saved.states);
      setMaterials(saved.materials ?? {});
      setStorageReady(true);
      setMessages(list);
      setStorageStatus('已恢复本机记录');
      const latest = [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
      if (latest) setConversationId(latest.conversationId ?? LEGACY_ID);
      else { const id=Object.keys(saved.materials ?? {}).find(id=>saved.materials![id].documents.length);if(id)setConversationId(id); }
    }).catch(() => { if (live) setStorageStatus('本机存储不可用，刷新后记录将丢失'); }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [authenticated, appSession?.user.id]);
  useEffect(() => {
    if (!loaded || !storageReady || !authenticated || !appSession) return;
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveData(appSession.user.id, { version: 2, messages: latestMessages.current, states: latestStates.current, materials: latestMaterials.current }).then(() => setStorageStatus('已保存到当前浏览器')).catch(() => setStorageStatus('保存失败，刷新后可能丢失记录'));
    }, 200);
  }, [messages, states, materials, loaded, storageReady, authenticated, appSession?.user.id]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [messages, conversationId]);
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input, conversationId]);

  async function authorize() {
    setAuthBusy(true); setNotice('');
    try {
      const response = await fetch('/api/internal/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '授权失败');
      acceptSession(data); setAccessToken('');
    } catch (error) { setNotice(error instanceof Error ? error.message : '模拟授权失败'); }
    finally { setAuthBusy(false); }
  }
  function updateMessage(id: string, change: (message: UiMessage) => UiMessage) {
    setMessages(previous => previous.map(message => message.id === id ? change(message) : message));
  }
  async function run(text: string, retryMessage?: UiMessage, action?: AgentAction) {
    if (!text.trim() || importing || active.current || !loaded || !appSession?.modelReady) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const now = Date.now();
    const userMessageId = retryMessage?.replyTo ?? crypto.randomUUID();
    const history = buildHistory(messages, conversationId, retryMessage ? userMessageId : undefined);
    active.current = { id, controller }; setBusy(true); setInput(''); setNotice('');
    setMessages(previous => [...previous.filter(m => m.id !== retryMessage?.id),
      ...(!retryMessage ? [{ id: userMessageId, role: 'user' as const, text: text.trim(), conversationId, createdAt: now }] : []),
      { id, replyTo: userMessageId, role: 'assistant', text: '', status: 'running', logs: [], modelRequests: 0, toolCalls: 0, conversationId, createdAt: now + 1 }]);
    try {
      for await (const event of new PiAgentAdapter(appSession).run({ sessionId: conversationId, turnId: id, action: retryMessage ? { type: 'retry', text, userMessageId } : action ?? { type: 'send', text }, history, documents: (materials[conversationId]?.documents ?? []).filter(d=>materials[conversationId]?.selectedIds.includes(d.id)), state: states[conversationId] ?? { preferences: '', progress: '' }, signal: controller.signal })) {
        if (active.current?.id !== id || event.turnId !== id || event.sessionId !== conversationId) continue;
        if (controller.signal.aborted && event.type !== 'done') continue;
        if (event.type === 'state_update') { setStates(previous => ({ ...previous, [conversationId]: event.state })); continue; }
        if (event.type === 'error' && ['AUTH_REQUIRED', 'ENTRY_NOT_ALLOWED', 'SESSION_CHANGED'].includes(event.code)) {
          invalidateSession(); setNotice(event.code === 'SESSION_CHANGED' ? '账号已在其他页面切换，请刷新后继续。' : '应用会话已失效，请从入口重新进入。'); continue;
        }
        updateMessage(id, message => {
          switch (event.type) {
            case 'text_delta': return { ...message, text: message.text + event.delta };
            case 'tool_status': return { ...message, logs: [...message.logs ?? [], event.message], modelRequests: (message.modelRequests ?? 0) + Number(event.category === 'model' && event.status === 'started'), toolCalls: (message.toolCalls ?? 0) + Number(event.category === 'tool' && event.status === 'started') };
            case 'quiz_ready': return { ...message, quiz: event.quiz };
            case 'sources_ready': return { ...message, sources: event.sources };
            case 'error': return { ...message, error: event.message, errorCode: event.code };
            case 'done': return { ...message, status: event.status };
            default: return message;
          }
        });
      }
    } catch (error) {
      updateMessage(id, message => ({ ...message, status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : '运行失败' }));
    } finally {
      if (active.current?.id === id) { active.current = null; setBusy(false); }
      void refreshHealth();
      void fetch('/api/session').then(async response => { if (response.ok) acceptSession(await response.json()); }).catch(() => undefined);
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
    if (prompt?.role === 'user') void run(prompt.text, { ...message, replyTo: prompt.id });
  }
  function newConversation() {
    if (busy || importing) return;
    setConversationId(crypto.randomUUID()); setInput(''); setNotice(''); setSidebarOpen(false);
    setTimeout(() => textarea.current?.focus(), 0);
  }
  function openConversation(id: string) {
    if (busy || importing) return;
    setConversationId(id); setNotice(''); setSidebarOpen(false);
  }
  function deleteConversation(id: string) {
    if (busy || importing) return;
    setMessages(previous => previous.filter(message => (message.conversationId ?? LEGACY_ID) !== id));
    setStates(previous => { const next = { ...previous }; delete next[id]; return next; });
    setMaterials(previous => { const next = { ...previous }; delete next[id]; return next; });
    setSource(null);
    if (id === conversationId) setConversationId(crypto.randomUUID());
  }

  if (!authenticated) return <div className="auth-screen">
    <div className="auth-card">
      <div className="brand"><span className="brand-mark">C</span><span>Cramameleon</span></div>
      <h1>开始学习</h1>
      <p>{entryConfig?.mode === 'old-site' ? '从破壁计划带着资料，开始这一次学习。' : '你的学习助手。直接提问即可。'}</p>
      {entryConfig?.mode === 'internal' ? <>
      <input className="search" type="password" autoComplete="current-password" aria-label="内部访问口令" placeholder="输入环境文件中的内部访问口令" value={accessToken} onChange={e => setAccessToken(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && accessToken && !authBusy) void authorize(); }}/>
      <button className="primary-button" onClick={() => void authorize()} disabled={authBusy || authenticated === null || !accessToken}>{authenticated === null ? '检查会话中…' : authBusy ? '授权中…' : '进入学习空间'}</button>
      <small>内部开发访问 · 仅通过 SSH 转发使用。旧站授权尚未接入。</small>
      </> : entryConfig?.mode === 'old-site' && entryConfig.oldSiteEntryUrl ? <>
        <a className="primary-button entry-link" href={entryConfig.oldSiteEntryUrl}>从破壁计划进入 <span aria-hidden="true">↗</span></a>
        <small>使用已登录的破壁计划账号，无需另外注册。</small>
      </> : <small role="status">正在检查进入方式…</small>}
      {notice && <div role="alert" className="notice">{notice}</div>}
    </div>
  </div>;

  return <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <aside className="sidebar" aria-label="会话列表">
      <div className="sidebar-header">
        <div className="brand"><span className="brand-mark">C</span><span>Cramameleon</span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏">×</button>
      </div>
      <button className="new-chat" onClick={newConversation} disabled={busy || importing}><span>＋</span>新对话</button>
      <input className="search" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索对话"/>
      <div className="sidebar-label">对话</div>
      <nav className="conversation-list">
        {!visibleConversations.length && <div className="list-empty">{query ? '没有匹配的对话' : '还没有对话'}</div>}
        {visibleConversations.map(item => <div key={item.id} className={`conversation-item ${item.id === conversationId ? 'active' : ''}`}>
          <button className="conversation-main" disabled={(busy || importing) && item.id !== conversationId} onClick={() => openConversation(item.id)}>
            <span className="conversation-title">{item.running && <span className="running-dot"/>}{item.title}</span>
            <span className="conversation-meta">{relativeTime(item.updatedAt)} · {item.count} 条</span>
          </button>
          <button className="conversation-delete" disabled={busy || importing} onClick={() => deleteConversation(item.id)} aria-label={`删除对话 ${item.title}`} title="删除">×</button>
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <span className={`status-dot ${health?.status === 'ok' ? 'online' : 'offline'}`}/>
        <span>{health?.status === 'ok' ? '服务在线' : '后端待检查'}</span>
        <small>{storageStatus}</small>
        <button className="icon-button" disabled={busy || importing} onClick={async () => {
          if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
          try {
            if (appSession && loaded && storageReady) await saveData(appSession.user.id, { version: 2, messages: latestMessages.current, states: latestStates.current, materials: latestMaterials.current });
            const response = await fetch('/api/logout', { method: 'POST', headers: { 'X-Cram-User': appSession?.user.id ?? '' } }); if (!response.ok && response.status !== 401) throw new Error('退出失败');
            authChannel.current?.postMessage({ type: 'signed-out' });
            invalidateSession();
          } catch { setNotice('保存或退出失败，请稍后重试'); }
        }}>退出</button>
      </div>
    </aside>
    <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)}/>

    <main className="main">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏">☰</button>
        <div className="topbar-title"><strong>{currentTitle}</strong></div>
      </header>

      {(states[conversationId]?.course || states[conversationId]?.progress) && <div className="learning-progress" aria-label="学习进度"><strong>{[states[conversationId]?.course, states[conversationId]?.chapter].filter(Boolean).join(' · ')}</strong><span>{states[conversationId]?.progress}</span></div>}
      <section className="chat" aria-label="聊天记录" aria-live="polite">
        <div className="chat-inner">
          {!current.length && <div className="empty">
            <div className="empty-icon">✳</div>
            <h2>今天想学点什么？</h2>
            <p>提问、理解概念、系统复习或者做题，都可以直接说。</p>
          </div>}
          {current.map((message, index) => message.role === 'user'
            ? <article key={message.id} className="msg user"><div className="bubble">{message.text}</div></article>
            : <article key={message.id} className="msg assistant">
              <div className="msg-head"><span className="brand-mark small">C</span>{message.status && message.status !== 'completed' && <span className={`run-status ${message.status}`}>{statusText[message.status]}</span>}</div>
              {!!message.logs?.length && <details className="tool-block">
                <summary><span className="tool-icon">⚙</span><span>工具调用</span><span className="tool-count">{message.modelRequests ?? 0} 次模型请求 · {message.toolCalls ?? 0} 次工具调用</span></summary>
                <ol>{message.logs.map((log, logIndex) => <li key={logIndex}>{log}</li>)}</ol>
              </details>}
              {message.text ? <div className="msg-text">{message.text}{message.status === 'running' && <span className="cursor"/>}</div> : message.status === 'running' && <div className="thinking"><span/><span/><span/></div>}
              {message.error && <div role="alert" className="error-card">{message.error}</div>}
              {message.quiz && <div className="quiz">
                <div className="quiz-top"><span>练习题</span><span>{message.quiz.origin === 'generated' ? '自编' : message.quiz.origin === 'adapted' ? '改编' : '真题'} · 单选题</span></div>
                <h3>{message.quiz.question}</h3>
                <div className="quiz-options">{message.quiz.options.map(option => <button key={option.id} disabled={!!message.revealed} className={`quiz-option ${message.revealed ? option.id === message.quiz!.correctOptionId ? 'correct' : option.id === message.selectedOption ? 'incorrect' : '' : ''}`} onClick={() => updateMessage(message.id, item => ({ ...item, selectedOption: option.id, revealed: true }))}><span className="option-key">{option.id}</span><span>{option.text}</span>{message.revealed && option.id === message.quiz!.correctOptionId && <b>✓</b>}</button>)}</div>
                {message.revealed
                  ? <div className="quiz-feedback"><strong className={message.selectedOption === message.quiz.correctOptionId ? 'ok' : 'bad'}>{!message.selectedOption ? `正确答案：${message.quiz.correctOptionId}` : message.selectedOption === message.quiz.correctOptionId ? '回答正确' : `回答错误，正确答案：${message.quiz.correctOptionId}`}</strong>{message.quiz.options.map(option => <p key={option.id}><b>{option.id}.</b> {option.explanation}</p>)}</div>
                  : <small className="quiz-hint">选择一个选项后显示答案与解析。<button onClick={() => updateMessage(message.id, item => ({ ...item, revealed: true }))}>看答案</button></small>}
              </div>}
              {!!message.sources?.length && <div className="sources">{message.sources.map(item => <button key={item.documentId + ':' + item.chunkId} onClick={() => setSource(item)}>▧ {item.title}</button>)}</div>}
              {message.status !== 'running' && <div className="msg-actions">
                <button onClick={() => void copy(message)} disabled={!message.text}>{copiedId === message.id ? '已复制' : '复制'}</button>
                {index === current.length - 1 && message.quiz && message.revealed && ['completed','waiting'].includes(message.status ?? '') && <button disabled={busy || importing} onClick={() => void run('请出下一题。', undefined, { type: 'next_question' })}>下一题</button>}
                {index === current.length - 1 && !message.quiz && message.status === 'completed' && states[conversationId]?.phase === 'learning' && <button disabled={busy || importing} onClick={() => void run('请继续讲。', undefined, { type: 'continue' })}>继续学习</button>}
                {index === current.length - 1 && ['cancelled', 'failed', 'interrupted', 'limited'].includes(message.status ?? '') && <button disabled={busy || importing} onClick={() => retry(message)}>重试</button>}
              </div>}
            </article>)}
          <div ref={bottom}/>
        </div>
      </section>

      <footer className="composer-wrap">
        {!appSession?.modelReady && <div role="alert" className="notice">模型尚未配置。请在服务器环境文件填写真实 API 密钥并重启服务。</div>}
        {appSession && <div className="composer-hint">北京时间今日 token：{appSession.budget.used.toLocaleString()} / {appSession.budget.limit.toLocaleString()}（含预留）</div>}
        <details><summary>当前对话偏好</summary><input className="search" maxLength={2000} disabled={busy || importing} placeholder="例如：回答简短，不主动出题" value={states[conversationId]?.preferences ?? ''} onChange={e => setStates(previous => ({ ...previous, [conversationId]: { ...previous[conversationId], progress: previous[conversationId]?.progress ?? '', preferences: e.target.value, quizPolicy: undefined } }))}/>{!!states[conversationId]?.instructions?.length && <small>已记住：{states[conversationId].instructions!.join('；')}</small>}</details>
        {notice && <div role="alert" className="notice">{notice}</div>}
        <MaterialComposer
          session={appSession}
          key={`${appSession?.user.id}:${conversationId}`}
          scope={materials[conversationId] ?? { documents: [], selectedIds: [] }}
          disabled={busy || importing || !loaded}
          onBusy={setImporting}
          onSource={setSource}
          onChange={scope => setMaterials(previous => ({ ...previous, [conversationId]: scope }))}
          onSubmit={() => void run(input)}
          actions={<>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            {busy ? <button className="stop-button" type="button" onClick={stop} aria-label="停止">■</button> : <button className="send-button" type="submit" disabled={importing || !input.trim() || !loaded || !appSession?.modelReady} aria-label="发送消息">↑</button>}
          </>}
        >
          <label className="sr-only" htmlFor="message-input">输入消息</label>
          <textarea ref={textarea} id="message-input" maxLength={8000} rows={1} placeholder="问点什么，或者说“考考我”…" value={input} disabled={busy || importing || !loaded || !appSession?.modelReady} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void run(input); } }}/>
        </MaterialComposer>
      </footer>
    </main>

    {source && <div className="modal-backdrop" onClick={() => setSource(null)}><section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title" onClick={event => event.stopPropagation()}><button className="icon-button modal-close" onClick={() => setSource(null)} aria-label="关闭来源">×</button><div className="eyebrow">来源</div><h2 id="source-title">{source.title}</h2><p className="source-location">{source.location}</p><pre>{cachedSource?.text}</pre>{sourceDocument && <label>文本位置<select aria-label="文本位置" value={source.chunkId} onChange={e=>{const chunk=sourceDocument.chunks.find(c=>c.chunkId===e.target.value);if(chunk)setSource(chunk);}}>{sourceDocument.chunks.map(c=><option key={c.chunkId} value={c.chunkId}>{c.location}</option>)}</select></label>}</section></div>}
  </div>;
}
// TODO(ui): Full accessibility pass.
// TODO(auth): Replace internal-only access with old-site one-time authorization code exchange.
