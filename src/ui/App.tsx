import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentAction, AppSession, ChatMessage, EntryConfig, Source } from '../contracts/index.ts';
import { MaterialComposer } from './Materials.tsx';
import { SourceViewer } from './SourceViewer.tsx';
import { Markdown, stripQuizRecords } from './Markdown.tsx';
import { ThemeToggle } from './Theme.tsx';
import { MessageTools } from './MessageTools.tsx';
import { MessageEditor } from './MessageEditor.tsx';
import { PiAgentAdapter } from '../agent/PiAgentAdapter.ts';
import { buildLearningHistory } from '../session/learningContext.ts';
import { useLocalRecords } from '../session/useLocalRecords.ts';
import { LEGACY_CONVERSATION_ID } from '../session/appStore.ts';
import { prepareMessageEdit } from '../session/messageEditing.ts';

const LOGO = import.meta.env.BASE_URL + 'logo-192.png';

// UI consumes business events only; the Agent owns model/tool scheduling.
type Health = { status: string; stats?: { active: number; requests: number; completed: number; cancelled: number } };
const statusText: Record<string, string> = { running: '运行中', completed: '已完成', cancelled: '已停止', failed: '失败', limited: '达到上限', interrupted: '已中断', waiting: '等待你的选择' };
// The Agent ends an output-limit run as failed; the UI labels it as reaching the
// limit (README) without rewriting the stored terminal status.
const displayStatus = (message: ChatMessage) => message.status === 'failed' && message.errorCode === 'MODEL_OUTPUT_LIMIT' ? 'limited' : message.status;
const recoveryErrors: Record<string, string> = {
  NETWORK_ERROR: '网络连接失败，请检查网络或 SSH 转发后重试。',
  MODEL_STREAM_INTERRUPTED: '回答传输中断，已保留收到的内容。请重试。',
  BUDGET_EXCEEDED: '今日模型额度不足，请等待北京时间次日额度恢复后重试。正在进行的请求也会占用额度。',
  TOTAL_BUDGET_EXCEEDED: '全站模型额度已用完，暂时无法继续提问。',
  CONCURRENCY_LIMIT: '当前请求过多或上一请求仍在结束，请稍后重试。',
  MODEL_NOT_CONFIGURED: '模型尚未配置，请联系维护者配置模型，然后点击“重新检查模型状态”；就绪后可重试原问题。',
};

// Select complete turns at A's submission boundary; visible records remain intact.
function scopedMessages(messages: ChatMessage[], conversationId: string, selectedIds: string[], retryUserId?: string): ChatMessage[] {
  const selected = new Set(selectedIds);
  const current = messages.filter(message => (message.conversationId ?? LEGACY_CONVERSATION_ID) === conversationId);
  // Older records have no turn scope. Treat their known citations as one scope,
  // including uncited follow-ups that may paraphrase those same materials.
  const legacyScope = [...new Set(current.filter(message => message.selectedMaterialIds === undefined)
    .flatMap(message => [...message.sources ?? [], ...message.quiz?.sources ?? []].map(source => source.documentId)))];
  const compatible = (message: ChatMessage) => {
    const scope = message.selectedMaterialIds ?? legacyScope;
    // A turn stays usable while every material it saw is still selected; adding
    // materials keeps it, deselecting or removing one of its materials drops it.
    return scope.every(id => selected.has(id));
  };
  const result: ChatMessage[] = [];
  let user: ChatMessage | undefined;
  for (const message of current) {
    if (message.id === retryUserId) break;
    if (message.role === 'user') { user = message; continue; }
    if (!user) continue;
    if (compatible(user) && compatible(message)) result.push(user, message);
    user = undefined;
  }
  return result;
}

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
  const authChannel=useRef<BroadcastChannel|null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [importing, setImporting] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef<{ id: string; conversationId: string; controller: AbortController } | null>(null);
  const accessValid = useRef(false);
  const sessionGeneration = useRef(0);
  // Records stay owned by the session user across an expiry (#8) and are
  // replaced only when another user enters or the user exits (#9).
  const { messages, setMessages, states, setStates, materials, setMaterials, conversationId, setConversationId, loaded, storageStatus, storageFailed, readFailed, retryStorage, flush, preserveRecovery } = useLocalRecords(appSession?.user.id, () => {
    // Invalidate before abort: even a late terminal event belongs to the old turn.
    detachActiveTurn();
  });
  const [leaving, setLeaving] = useState(false);
  const [editing, setEditing] = useState<{ id: string; trigger: HTMLElement | null } | null>(null);
  const [exitRisk, setExitRisk] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const chat = useRef<HTMLElement>(null);
  // Follow new output only while the learner is at the bottom; reading history pauses it (#10).
  const following = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const conversations = useMemo(() => {
    const map = new Map<string, { id: string; title: string; updatedAt: number; running: boolean; count: number; editArchive?: true }>();
    for (const id of Object.keys(states)) {
      map.set(id, { id, title: '', updatedAt: 0, running: false, count: 0 });
    }
    for (const [id, scope] of Object.entries(materials)) {
      if(scope.documents.length) map.set(id, { id, title: scope.documents[0].title, updatedAt: scope.documents[0].importedAt ?? 0, running: false, count: 0 });
    }
    for (const message of messages) {
      const id = message.conversationId ?? LEGACY_CONVERSATION_ID;
      const entry = map.get(id) ?? { id, title: '', updatedAt: 0, running: false, count: 0 };
      if (!entry.title && message.role === 'user') entry.title = message.text.slice(0, 40);
      entry.updatedAt = Math.max(entry.updatedAt, message.createdAt ?? 0);
      entry.running ||= message.status === 'running';
      if (message.editArchive) entry.editArchive = true;
      entry.count += 1;
      map.set(id, entry);
    }
    return [...map.values()].map(item => ({ ...item, title: (item.title || '新对话') + (item.editArchive ? ' · 编辑前版本' : '') })).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [messages, materials, states]);
  const visibleConversations = authenticated ? conversations.filter(item => !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const current = authenticated ? messages.filter(message => (message.conversationId ?? LEGACY_CONVERSATION_ID) === conversationId) : [];
  const currentQuiz = [...current].reverse().find(message => message.quiz);
  // The quiz stays current for followups until the learner moves on: it is the
  // latest turn, or later turns have not moved the learning state to another phase.
  const lastMessage = current.at(-1);
  const nextQuestionAvailable = !!currentQuiz?.revealed && ['completed', 'waiting'].includes(currentQuiz.status ?? '')
    && ['completed', 'waiting'].includes(lastMessage?.status ?? '')
    && (lastMessage === currentQuiz || !['learning', 'scope'].includes(states[conversationId]?.phase ?? ''));
  const canRun = authenticated && loaded && appSession?.modelReady && !busy && !importing && !leaving && !editing;
  const currentTitle = (authenticated && conversations.find(item => item.id === conversationId)?.title) || '新对话';
  const sourceDocument = source ? materials[conversationId]?.documents.find(d=>d.id===source.documentId) : undefined;
  useEffect(() => { setEditing(null); }, [appSession?.user.id, conversationId, authenticated]);

  async function refreshHealth() {
    try { const response = await fetch('/api/health'); if (!response.ok) throw new Error(); setHealth(await response.json()); }
    catch { setHealth(null); }
  }
  function detachActiveTurn() {
    const running = active.current;
    active.current = null;
    running?.controller.abort();
    setBusy(false);
    return running;
  }
  function revokeAccess() {
    sessionGeneration.current++;
    accessValid.current = false;
    setAuthenticated(false);
    setNotice(appSession?.mode==='old-site'?'应用会话已失效，请从破壁计划重新进入。本机学习记录会保留。':'应用会话已失效，请通过内部访问口令重新进入。本机学习记录会保留。');
    const running = detachActiveTurn();
    if (running) {
      updateMessage(running.id, message => ({ ...message, status: 'failed', errorCode: 'AUTH_REQUIRED', error: '应用会话已失效，请重新进入后重试。' }));
    }
    setSource(null);
  }
  async function refreshSession(initial = false, recheck = false) {
    if (!initial && !accessValid.current) return;
    const generation = ++sessionGeneration.current;
    const userId = appSession?.user.id;
    try {
      const response = await fetch('/api/session');
      const data = response.ok ? await response.json() as AppSession : null;
      if (generation !== sessionGeneration.current) return;
      if(response.status===401&&initial&&!userId){setAuthenticated(false);return;}
      if(response.status===403&&initial&&!userId){setAuthenticated(false);setNotice('当前账号尚未获得内测资格，请联系项目维护者。');return;}
      if (response.status === 401 || response.status===403 || data && userId && data.user.id !== userId) { revokeAccess(); return; }
      if (!data) throw new Error();
      setAppSession(data);
      if(data.mode==='internal')setEntryConfig({mode:'internal'});
      if (recheck) setNotice(data.modelReady ? '模型已就绪，可点击重试继续原问题。' : '模型仍未配置，请联系维护者配置后再次检查。');
      if (initial) { accessValid.current = true; setAuthenticated(true); }
    } catch {
      if (generation !== sessionGeneration.current) return;
      setNotice('无法连接后端，请稍后重试。');
    }
  }
  async function recheckReadiness() {
    if (checkingReadiness || busy) return;
    setCheckingReadiness(true);
    setNotice('');
    try { await refreshSession(false, true); }
    finally { setCheckingReadiness(false); }
  }
  useEffect(() => {
    void refreshHealth();
    const entryError=new URLSearchParams(location.search).get('entryError');
    if(entryError){setNotice(entryError==='ENTRY_NOT_ALLOWED'?'当前账号尚未获得内测资格，请联系项目维护者。':entryError==='OLD_SITE_UNAVAILABLE'?'暂时无法连接破壁计划，请稍后重新进入。':'本次进入授权未完成，请从破壁计划重新进入。');history.replaceState(null,'',location.pathname);}
    void refreshSession(true);
    return () => { sessionGeneration.current++; active.current?.controller.abort(); };
  }, []);
  useEffect(()=>{
    if(authenticated!==false||entryConfig?.mode==='internal')return;
    const controller=new AbortController();
    void fetch('/api/auth/config',{signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error();const entry:EntryConfig=await r.json();if(!['internal','old-site'].includes(entry.mode))throw new Error();setEntryConfig(entry);}).catch(()=>{if(!controller.signal.aborted)setNotice('暂时无法确认进入方式，请刷新页面重试。');});
    return()=>controller.abort();
  },[authenticated]);
  useEffect(()=>{
    if(appSession?.mode!=='old-site'||!authenticated)return;
    const userId=appSession.user.id;const channel=new BroadcastChannel('cramameleon-auth');authChannel.current=channel;
    channel.onmessage=event=>{if(event.data?.type==='signed-out'||event.data?.type==='identity'&&event.data.userId!==userId){preserveRecovery();revokeAccess();setAppSession(null);setInput('');setImporting(false);setNotice('账号已在其他页面切换或退出，请刷新后继续。');}};
    channel.postMessage({type:'identity',userId});return()=>{channel.close();authChannel.current=null;};
  },[appSession?.user.id,authenticated]);
  useEffect(() => {
    // A user change or exit resets transient UI; a same-user expiry keeps it (#8).
    detachActiveTurn();
    setImporting(false); setInput(''); setSource(null); setQuery(''); setExitRisk(false);
  }, [appSession?.user.id]);
  useEffect(() => { following.current = true; }, [conversationId]);
  useEffect(() => { const el = chat.current; if (el && following.current) el.scrollTop = el.scrollHeight; }, [messages, conversationId]);
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input, conversationId, authenticated]);

  async function authorize() {
    if (authBusy) return;
    const generation = ++sessionGeneration.current;
    setAuthBusy(true); setNotice('');
    try {
      const response = await fetch('/api/internal/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '授权失败');
      if (generation !== sessionGeneration.current) return;
      try { await flush(); }
      catch {
        if (generation !== sessionGeneration.current) return;
        if (appSession && appSession.user.id !== data.user.id) {
          setNotice('授权已成功，但原用户的记录未保存，暂时无法切换用户。请用原用户口令重新进入并保留此页面，待本机存储恢复后再切换。');
          return;
        }
      }
      if (generation !== sessionGeneration.current) return;
      accessValid.current = true;
      setAppSession(data); setAccessToken('');
      setAuthenticated(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : '模拟授权失败'); }
    finally { setAuthBusy(false); }
  }
  async function logout(exitAnyway = false) {
    if (leaving || busy || importing) return;
    setLeaving(true); setNotice('');
    try {
      if (exitAnyway) preserveRecovery();
      else {
        try { await flush(); }
        catch { setExitRisk(true); return; }
      }
      const response = await fetch('/api/logout', { method: 'POST',headers:{'X-Cram-User':appSession?.user.id??''} });
      if (!response.ok && response.status !== 401) throw new Error('退出失败');
      sessionGeneration.current++; accessValid.current = false;
      setAuthenticated(false); setAppSession(null); setSource(null); setExitRisk(false);
      authChannel.current?.postMessage({type:'signed-out'});
    } catch { setNotice('退出失败，请稍后重试。'); }
    finally { setLeaving(false); }
  }
  function updateMessage(id: string, change: (message: ChatMessage) => ChatMessage) {
    setMessages(previous => previous.map(message => message.id === id ? change(message) : message));
  }
  async function run(text: string, retryMessage?: ChatMessage, action?: AgentAction, editMessage?: ChatMessage) {
    if (!text.trim() || !accessValid.current || !authenticated || importing || leaving || active.current || !loaded || !appSession?.modelReady || editing && !editMessage) return;
    let edit: ReturnType<typeof prepareMessageEdit> | undefined;
    if (editMessage) {
      try { edit = prepareMessageEdit(messages, conversationId, editMessage.id, text); }
      catch (error) { setNotice(error instanceof Error ? error.message : '消息无法编辑'); return; }
    }
    sessionGeneration.current++;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const now = Date.now();
    const userMessageId = edit?.message.id ?? retryMessage?.replyTo ?? crypto.randomUUID();
    const documents = (materials[conversationId]?.documents ?? []).filter(d => materials[conversationId]?.selectedIds.includes(d.id));
    const selectedMaterialIds = documents.map(d => d.id);
    // #6 selects material-compatible complete turns; #7 then projects quiz records within budget.
    const history = buildLearningHistory(scopedMessages(edit?.prefix ?? messages, conversationId, selectedMaterialIds, retryMessage ? userMessageId : undefined), conversationId);
    const initialState = edit ? edit.message.learningStateBefore ?? { preferences: '', progress: '' } : states[conversationId] ?? { preferences: '', progress: '' };
    let modelNotConfigured = false;
    following.current = true;
    active.current = { id, conversationId, controller }; setBusy(true); if (!edit) setInput(''); setNotice(''); setEditing(null);
    if (edit) {
      const { archiveId } = edit;
      setStates(previous => ({ ...previous, [archiveId]: previous[conversationId] ?? { preferences: '', progress: '' }, [conversationId]: initialState }));
      setMaterials(previous => ({ ...previous, [archiveId]: previous[conversationId] ?? { documents: [], selectedIds: [] } }));
      setSource(null);
    }
    setMessages(previous => [...(edit
      ? [...previous.filter(m => (m.conversationId ?? LEGACY_CONVERSATION_ID) !== conversationId), ...edit.archived, ...edit.prefix]
      : previous.filter(m => m.id !== retryMessage?.id).map(m => m.id === userMessageId ? { ...m, selectedMaterialIds } : m)),
      ...(!retryMessage ? [{ ...(edit?.message ?? { id: userMessageId, role: 'user' as const, conversationId, createdAt: now }), text: text.trim(), selectedMaterialIds, learningStateBefore: initialState }] : []),
      { id, replyTo: userMessageId, role: 'assistant', text: '', status: 'running', logs: [], modelRequests: 0, toolCalls: 0, conversationId, createdAt: now + 1, selectedMaterialIds }]);
    try {
      for await (const event of new PiAgentAdapter(appSession).run({ sessionId: conversationId, turnId: id, action: retryMessage ? { type: 'retry', text, userMessageId } : action ?? { type: 'send', text }, history, documents, state: initialState, signal: controller.signal })) {
        if (active.current?.id !== id || event.turnId !== id || event.sessionId !== conversationId) continue;
        if (controller.signal.aborted && event.type !== 'done') continue;
        if (event.type === 'state_update') { setStates(previous => ({ ...previous, [conversationId]: event.state })); continue; }
        if (event.type === 'error' && ['AUTH_REQUIRED','SESSION_CHANGED','ENTRY_NOT_ALLOWED'].includes(event.code)) { revokeAccess(); continue; }
        if (event.type === 'error' && event.code === 'MODEL_NOT_CONFIGURED') {
          modelNotConfigured = true;
          setAppSession(previous => previous ? { ...previous, modelReady: false } : previous);
        }
        updateMessage(id, message => {
          switch (event.type) {
            case 'text_delta': return { ...message, text: message.text + event.delta };
            case 'tool_status': return { ...message, logs: [...message.logs ?? [], event.message], modelRequests: (message.modelRequests ?? 0) + Number(event.category === 'model' && event.status === 'started'), toolCalls: (message.toolCalls ?? 0) + Number(event.category === 'tool' && event.status === 'started') };
            case 'quiz_ready': return { ...message, quiz: event.quiz };
            case 'sources_ready': return { ...message, sources: event.sources };
            case 'error': return { ...message, error: recoveryErrors[event.code] ?? event.message, errorCode: event.code };
            case 'done': return { ...message, status: event.status };
            default: return message;
          }
        });
      }
    } catch (error) {
      if (active.current?.id === id) updateMessage(id, message => ({ ...message, status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : '运行失败' }));
    } finally {
      if (active.current?.id === id) {
        active.current = null; setBusy(false);
        void refreshHealth();
        if (!modelNotConfigured) void refreshSession();
      }
    }
  }
  function nextQuestion() {
    if (nextQuestionAvailable) void run('请出下一题。', undefined, { type: 'next_question' });
  }
  function stop() {
    const running = detachActiveTurn();
    if (!running) return;
    updateMessage(running.id, message => ({ ...message, status: 'cancelled' }));
  }
  function retry(message: ChatMessage) {
    const index = current.findIndex(item => item.id === message.id);
    const prompt = message.replyTo ? current.find(item => item.id === message.replyTo) : current[index - 1];
    if (prompt?.role === 'user') void run(prompt.text, { ...message, replyTo: prompt.id });
  }
  function cancelEdit() {
    const trigger = editing?.trigger;
    setEditing(null);
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); });
  }
  function newConversation() {
    if (busy || importing || leaving || !loaded) return;
    setConversationId(crypto.randomUUID()); setInput(''); setNotice(''); setSource(null); setSidebarOpen(false);
    setTimeout(() => textarea.current?.focus(), 0);
  }
  function openConversation(id: string) {
    if (busy || importing || leaving || !loaded) return;
    setConversationId(id); setNotice(''); setSource(null); setSidebarOpen(false);
  }
  function deleteConversation(id: string) {
    if (leaving || !loaded) return;
    if (active.current?.conversationId === id) detachActiveTurn();
    if (id === conversationId) setImporting(false);
    setMessages(previous => previous.filter(message => (message.conversationId ?? LEGACY_CONVERSATION_ID) !== id));
    setStates(previous => { const next = { ...previous }; delete next[id]; return next; });
    setMaterials(previous => { const next = { ...previous }; delete next[id]; return next; });
    setSource(null);
    if (id === conversationId) setConversationId(crypto.randomUUID());
  }

  if(authenticated===false&&entryConfig?.mode!=='internal')return <div className="auth-screen"><section className="auth-card"><img src={LOGO} alt="" className="brand-mark"/><h1>Cramameleon</h1><p>使用破壁计划账号进入学习空间</p>{notice&&<div role="alert" className="notice">{notice}</div>}{entryConfig?.mode==='old-site'?<a className="primary-button entry-link" href={entryConfig.oldSiteEntryUrl}>从破壁计划进入</a>:<p role="status">正在确认进入方式…</p>}<small>学习记录保存在当前浏览器，按账号隔离。</small></section></div>;
  return <div className={`app ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <aside className="sidebar" aria-label="会话列表">
      <div className="sidebar-header">
        <div className="brand"><img className="brand-mark" src={LOGO} alt=""/><span>Cramameleon</span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏">×</button>
      </div>
      <button className="new-chat" onClick={newConversation} disabled={!authenticated || busy || importing || leaving || !loaded}><span>＋</span>新对话</button>
      <input className="search" placeholder="搜索对话" value={authenticated && loaded ? query : ''} disabled={!authenticated} onChange={event => setQuery(event.target.value)} aria-label="搜索对话"/>
      <div className="sidebar-label">对话</div>
      <nav className="conversation-list">
        {authenticated && !visibleConversations.length && <div className="list-empty">{query ? '没有匹配的对话' : '还没有对话'}</div>}
        {visibleConversations.map(item => <div key={item.id} className={`conversation-item ${item.id === conversationId ? 'active' : ''}`}>
          <button className="conversation-main" disabled={leaving || !loaded || ((busy || importing) && item.id !== conversationId)} onClick={() => openConversation(item.id)}>
            <span className="conversation-title">{item.running && <span className="running-dot"/>}{item.title}</span>
            <span className="conversation-meta">{relativeTime(item.updatedAt)} · {item.count} 条</span>
          </button>
          <button className="conversation-delete" disabled={leaving || !loaded} onClick={() => deleteConversation(item.id)} aria-label={`删除对话 ${item.title}`} title="删除">×</button>
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <span className={`status-dot ${health?.status === 'ok' ? 'online' : 'offline'}`}/>
        <span>{health?.status === 'ok' ? '服务在线' : '后端待检查'}</span>
        {authenticated && <small role="status" aria-label="本机存储状态">{storageFailed ? '本机记录需要处理' : storageStatus}</small>}
        {authenticated && appSession?.mode !== 'guest' && <button className="icon-button" disabled={busy || importing || leaving} onClick={() => void logout()}>退出</button>}
      </div>
    </aside>
    <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)}/>

    <main className="main">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏">☰</button>
        <div className="topbar-title"><strong>{currentTitle}</strong></div>
        <ThemeToggle/>
      </header>

      {authenticated && (states[conversationId]?.course || states[conversationId]?.chapter || states[conversationId]?.progress) && <div className="learning-progress" aria-label="学习位置"><strong>{[states[conversationId]?.course, states[conversationId]?.chapter].filter(Boolean).join(' · ')}</strong><span>{states[conversationId]?.progress}</span></div>}
      <section ref={chat} className="chat" aria-label="聊天记录" aria-live="polite" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
        <div className="chat-inner">
          {!current.length && <div className="empty">
            <div className="empty-icon">✳</div>
            <h2>今天想学点什么？</h2>
            <p>提问、理解概念、系统复习或者做题，都可以直接说。</p>
          </div>}
          {current.map((message, index) => {
            const sources = [...new Map([...(message.sources ?? []), ...(message.quiz?.sources ?? [])].map(item => [JSON.stringify([item.documentId, item.chunkId]), item])).values()];
            return message.role === 'user'
            ? <article key={message.id} className="msg user"><div className={`user-message${editing?.id === message.id ? ' editing' : ''}`}>
              {editing?.id === message.id
                ? <MessageEditor text={message.text} disabled={busy || importing || leaving || !loaded || !appSession?.modelReady} onCancel={cancelEdit} onSend={text => void run(text, undefined, undefined, message)}/>
                : <div className="bubble">{message.text}</div>}
              <MessageTools text={message.text} createdAt={message.createdAt} editDisabled={!canRun} onEdit={() => setEditing({ id: message.id, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null })} onCopyError={() => setNotice('浏览器未允许复制，请手动选择文字。')}/>
            </div></article>
            : <article key={message.id} className="msg assistant">
              <div className="msg-head"><img className="brand-mark small" src={LOGO} alt=""/>{message.status && message.status !== 'completed' && <span className={`run-status ${displayStatus(message)}`}>{statusText[displayStatus(message)!]}</span>}</div>
              {!!message.logs?.length && <details className="tool-block">
                <summary><span className="tool-icon">⚙</span><span>工具调用</span><span className="tool-count">{message.modelRequests ?? 0} 次模型请求 · {message.toolCalls ?? 0} 次工具调用</span></summary>
                <ol>{message.logs.map((log, logIndex) => <li key={logIndex}>{log}</li>)}</ol>
              </details>}
              {message.text ? <Markdown className="msg-text" text={message.role === 'assistant' ? stripQuizRecords(message.text) : message.text} streaming={message.status === 'running'}/> : message.status === 'running' && <div className="thinking"><span/><span/><span/></div>}
              {message.error && <div role="alert" className="error-card">{message.error}</div>}
              {message.quiz && <div className="quiz">
                <div className="quiz-top"><span>练习题</span><span>{message.quiz.origin === 'generated' ? '自编' : message.quiz.origin === 'adapted' ? '改编' : '真题'} · 单选题</span></div>
                <h3><Markdown inline text={message.quiz.question}/></h3>
                <div className="quiz-options">{message.quiz.options.map(option => <button key={option.id} disabled={!!message.revealed || leaving} className={`quiz-option ${message.revealed ? option.id === message.quiz!.correctOptionId ? 'correct' : option.id === message.selectedOption ? 'incorrect' : '' : ''}`} onClick={() => updateMessage(message.id, item => ({ ...item, selectedOption: option.id, revealed: true }))}><span className="option-key">{option.id}</span><Markdown inline text={option.text}/>{message.revealed && option.id === message.quiz!.correctOptionId && <b>✓</b>}</button>)}</div>
                {message.revealed
                  ? <div className="quiz-feedback"><strong className={!message.selectedOption ? undefined : message.selectedOption === message.quiz.correctOptionId ? 'ok' : 'bad'}>{!message.selectedOption ? `正确答案：${message.quiz.correctOptionId}` : message.selectedOption === message.quiz.correctOptionId ? '回答正确' : `回答错误，正确答案：${message.quiz.correctOptionId}`}</strong>{message.quiz.options.map(option => <p key={option.id}><b>{option.id}.</b> <Markdown inline text={option.explanation}/></p>)}</div>
                  : <small className="quiz-hint">选择一个选项后显示答案与解析。<button disabled={leaving} onClick={() => updateMessage(message.id, item => ({ ...item, revealed: true }))}>看答案</button></small>}
              </div>}
              {!!sources.length && <div className="sources">{sources.map(item => <button key={JSON.stringify([item.documentId, item.chunkId])} onClick={() => setSource(item)}>▧ {item.title}</button>)}</div>}
              {message.status !== 'running' && <div className="msg-actions">
                <MessageTools text={stripQuizRecords(message.text)} createdAt={message.createdAt} onCopyError={() => setNotice('浏览器未允许复制，请手动选择文字。')}/>
                {index === current.length - 1 && nextQuestionAvailable && <button disabled={!canRun} onClick={nextQuestion}>下一题</button>}
                {index === current.length - 1 && !message.quiz && message.status === 'completed' && states[conversationId]?.phase === 'learning' && <button disabled={!canRun} onClick={() => void run('请继续讲。', undefined, { type: 'continue' })}>继续学习</button>}
                {index === current.length - 1 && ['cancelled', 'failed', 'interrupted', 'limited'].includes(message.status ?? '') && <button disabled={!canRun} onClick={() => retry(message)}>重试</button>}
              </div>}
            </article>;
          })}
        </div>
      </section>

      <footer className="composer-wrap">
        {notice && <div role="alert" className="notice">{notice}</div>}
        {authenticated === null && (notice
          ? <button className="primary-button" type="button" onClick={() => { setNotice(''); void refreshSession(true); }}>重新连接</button>
          : <div role="status" className="composer-hint">正在连接学习空间…</div>)}
        {authenticated === false && <form className="composer access-form" onSubmit={event => { event.preventDefault(); if (accessToken && !authBusy) void authorize(); }}>
          <input className="search" type="password" autoComplete="current-password" aria-label="内部访问口令" placeholder="输入内部访问口令" value={accessToken} onChange={event => setAccessToken(event.target.value)}/>
          <button className="primary-button" type="submit" disabled={authBusy || !accessToken}>{authBusy ? '授权中…' : '进入学习空间'}</button>
        </form>}
        {authenticated && <>
        {storageFailed && <div role="alert" className="notice">{storageStatus}<button onClick={retryStorage}>{readFailed ? '重试读取' : '重试保存'}</button></div>}
        {!appSession?.modelReady && <div role="alert" className="notice">模型尚未配置，请联系维护者配置模型，然后点击“重新检查模型状态”；就绪后可重试原问题。此检查不会调用模型。<button type="button" disabled={checkingReadiness || busy} onClick={() => void recheckReadiness()}>{checkingReadiness ? '正在检查模型状态…' : '重新检查模型状态'}</button></div>}
        {exitRisk && storageFailed && <div role="alert" className="notice">保存失败。仍然退出可能丢失未保存的修改；退出前会尽量保留当前用户的本机恢复副本。可重试保存，或自行选择仍然退出。<button disabled={busy || importing || leaving} onClick={() => void logout(true)}>仍然退出（可能丢失修改）</button><button disabled={leaving} onClick={() => setExitRisk(false)}>继续编辑</button></div>}
        <MaterialComposer
          session={loaded?appSession:null}
          key={`${appSession?.user.id}:${conversationId}`}
          scope={materials[conversationId] ?? { documents: [], selectedIds: [] }}
          disabled={busy || importing || leaving || !loaded}
          onBusy={setImporting}
          onSource={setSource}
          onChange={scope => setMaterials(previous => ({ ...previous, [conversationId]: scope }))}
          onSubmit={() => void run(input)}
          actions={<>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            {busy ? <button className="stop-button" type="button" onClick={stop} aria-label="停止">■</button> : <button className="send-button" type="submit" disabled={!input.trim() || !canRun} aria-label="发送消息">↑</button>}
          </>}
        >
          <label className="sr-only" htmlFor="message-input">输入消息</label>
          <textarea ref={textarea} id="message-input" maxLength={8000} rows={1} placeholder="问点什么，或者说“考考我”…" value={loaded ? input : ''} disabled={!canRun} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void run(input); } }}/>
        </MaterialComposer>
        </>}
      </footer>
    </main>

    {authenticated && source && loaded && <SourceViewer source={source} document={sourceDocument} onClose={()=>setSource(null)}/>}
  </div>;
}
// TODO(ui): Full accessibility pass.
