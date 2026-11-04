import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Scenario, Source } from '../contracts/index.ts';
import { PiAgentAdapter } from '../agent/PiAgentAdapter.ts';
import { loadMessages, saveMessages } from '../session/demoStore.ts';

const scenarios: { id: Scenario; title: string; description: string; prompt: string; icon: string }[] = [
  { id: 'chat', title: '工具闭环', description: '流式文字 → 工具 → 再次响应', prompt: '演示一次完整的工具调用流程。', icon: '↗' },
  { id: 'quiz', title: '题板反馈', description: '结构化题目与本地作答', prompt: '给我一道关于这个 Demo 架构的示例题。', icon: '▤' },
  { id: 'slow', title: '停止与恢复', description: '中断慢速响应，继续新一轮', prompt: '开始一段慢速响应，让我测试停止。', icon: '◷' },
  { id: 'error', title: '故障演示', description: '可控错误与手动重试', prompt: '触发一次模拟服务错误。', icon: '⌁' },
];
type Health = { status: string; stats?: { active: number; requests: number; completed: number; cancelled: number } };
const statusText: Record<string, string> = { running: '正在运行', completed: '已完成', cancelled: '已停止', failed: '运行失败', limited: '达到上限', interrupted: '刷新后中断' };

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [scenario, setScenario] = useState<Scenario>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageStatus, setStorageStatus] = useState('正在读取本机记录');
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const latestMessages = useRef(messages);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestMessages.current = messages;
  const selected = scenarios.find(item => item.id === scenario)!;

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
    let current = true;
    void loadMessages().then(saved => { if (current) { setMessages(saved); setStorageStatus('已恢复本机记录'); } }).catch(() => { if (current) setStorageStatus('本机存储不可用，刷新后记录将丢失'); }).finally(() => { if (current) setLoaded(true); });
    return () => { current = false; };
  }, [authenticated]);
  useEffect(() => {
    if (!loaded || !authenticated) return;
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveMessages(latestMessages.current).then(() => setStorageStatus('已保存到当前浏览器')).catch(() => setStorageStatus('保存失败，刷新后可能丢失记录'));
    }, 200);
  }, [messages, loaded, authenticated]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [messages]);

  async function authorize() {
    setAuthBusy(true); setNotice('');
    try {
      const response = await fetch('/api/demo/session', { method: 'POST' });
      if (!response.ok) throw new Error('模拟授权失败，请检查后端开发模式配置。');
      setAuthenticated(true);
    } catch (error) { setNotice(error instanceof Error ? error.message : '模拟授权失败'); }
    finally { setAuthBusy(false); }
  }
  function updateMessage(id: string, change: (message: ChatMessage) => ChatMessage) {
    setMessages(previous => previous.map(message => message.id === id ? change(message) : message));
  }
  async function run(text: string, nextScenario: Scenario = scenario) {
    if (!text.trim() || active.current || !loaded) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    active.current = { id, controller }; setBusy(true); setInput(''); setNotice('');
    setMessages(previous => [...previous, { id: crypto.randomUUID(), role: 'user', text: text.trim(), scenario: nextScenario }, { id, role: 'assistant', text: '', status: 'running', logs: [], modelRequests: 0, toolCalls: 0, scenario: nextScenario }]);
    try {
      for await (const event of new PiAgentAdapter().run({ sessionId: 'demo-developer', turnId: id, text, scenario: nextScenario, signal: controller.signal })) {
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
    const current = active.current;
    if (!current) return;
    current.controller.abort();
    updateMessage(current.id, message => ({ ...message, status: 'cancelled' }));
  }
  async function copy(message: ChatMessage) {
    try { await navigator.clipboard.writeText(message.text); setCopiedId(message.id); setTimeout(() => setCopiedId(''), 1800); }
    catch { setNotice('浏览器未允许复制，请手动选择文字。'); }
  }
  function retry(message: ChatMessage) {
    const index = messages.findIndex(item => item.id === message.id);
    const prompt = messages[index - 1];
    if (prompt?.role === 'user') void run(prompt.text, message.scenario);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Cramameleon 首页"><span className="brand-mark">C<span>•</span></span><span>Cramameleon<small>学习空间 · 工程预览</small></span></a>
      <div className="sidebar-label">开发联调场景 <span>04</span></div>
      <nav aria-label="演示场景">{scenarios.map(item => <button key={item.id} className={`scenario ${scenario === item.id ? 'selected' : ''}`} disabled={busy} onClick={() => { setScenario(item.id); setInput(''); }}><span className="scenario-icon">{item.icon}</span><span><strong>{item.title}</strong><small>{item.description}</small></span><span className="scenario-arrow">↗</span></button>)}</nav>
      <div className="sidebar-note"><span className="tiny-dot"/>真实运行的工程链路<p>React → Pi Core → Go<br/>浏览器执行工具，再返回模型流</p><span className="note-tag">业务内容全部模拟</span></div>
      <div className="sidebar-bottom"><span className="avatar">D</span><span>内部开发环境<small>仅本机 SSH 转发访问</small></span></div>
    </aside>
    <main className="workspace">
      <header className="topbar"><div><span className="breadcrumb">工作空间</span><span className="slash">/</span><strong>Demo</strong><span className="demo-label">模拟模式</span></div><div className="health"><span className={`tiny-dot ${health?.status === 'ok' ? 'online' : 'offline'}`}/>{health?.status === 'ok' ? 'Go 服务在线' : '后端连接待检查'}</div></header>
      {!authenticated ? <section className="auth-area"><div className="auth-card"><div className="eyebrow">CRAMAMELEON / DEVELOPMENT</div><h1>先让每个模块<br/>真正连接起来。</h1><p>独立运行的前端、Pi Agent 与 Go 后端。<br/>通过开发态模拟入口，预览完整交互链路。</p><button className="primary enter-button" onClick={() => void authorize()} disabled={authBusy || authenticated === null}>{authenticated === null ? '检查会话中…' : authBusy ? '授权中…' : '模拟旧站入口 →'}</button><div className="auth-footnote">这是内部 Demo 授权，不连接旧站账号。<br/>正式入口授权、真实模型与资料接入均为 TODO。</div>{notice && <div role="alert" className="notice">{notice}</div>}</div><div className="auth-diagram"><span>01 · React 界面</span><i>↓</i><span>02 · Pi 浏览器调度</span><i>↕</i><span>03 · Go 模拟模型流</span><small>无真实账号 · 无外部模型调用 · 无课程数据</small></div></section> : <>
        <section className="workspace-title"><div><div className="eyebrow">ENGINEERING PLAYGROUND</div><h1>{selected.title}<span> / Demo</span></h1><p>{selected.description}。所有示例均用于工程验证。</p></div><button className="secondary" disabled={busy || !messages.length} onClick={() => { setMessages([]); setNotice(''); }}>清空本机记录</button></section>
        <div className="capability-strip"><span><b>Pi Core</b> 浏览器 Agent</span><span><b>Go / Gin</b> 流式接口</span><span><b>IndexedDB</b> 本机恢复</span><span className="version">契约 demo.v1</span></div>
        <section className="conversation" aria-label="聊天记录" aria-live="polite">
          {!messages.length && <div className="empty-state"><div className="empty-symbol">✳</div><h2>从一次真实往返开始</h2><p>发送消息后，观察文字流、工具状态与最终结果。<br/>这里的回复采用固定脚本，内容不随问题变化。</p><button className="suggestion" disabled={busy || !loaded} onClick={() => void run(selected.prompt)}><span>{selected.prompt}</span><b>↗</b></button><div className="empty-caption">不调用真实模型，不产生模型费用</div></div>}
          {messages.map((message, index) => <article key={message.id} className={`message ${message.role}`}>
            <div className={`message-avatar ${message.role}`}>{message.role === 'user' ? '你' : 'C'}</div><div className="message-content"><div className="message-heading"><strong>{message.role === 'user' ? '你' : 'Cramameleon'}</strong>{message.role === 'assistant' && <><span className="message-badge">模拟响应</span><span className={`run-status ${message.status}`}>{statusText[message.status ?? 'completed']}</span></>}</div>
              {message.text ? <div className="message-text">{message.text}</div> : message.status === 'running' && <div className="waiting">正在建立模型流<span>•••</span></div>}
              {!!message.logs?.length && <details className="execution" open={message.status === 'running'}><summary><span>↳ 执行记录</span><span>{message.modelRequests ?? 0} 次模型请求 · {message.toolCalls ?? 0} 次工具调用</span></summary><ol>{message.logs.map((log, logIndex) => <li key={logIndex}>{log}</li>)}</ol></details>}
              {message.error && <div role="alert" className="error-card">{message.error}</div>}
              {message.quiz && <div className="quiz"><div className="quiz-topline"><span>示例题板</span><span>单选 · 虚构工程样例</span></div><h3>{message.quiz.question}</h3><div className="quiz-options">{message.quiz.options.map(option => <button key={option.id} disabled={!!message.revealed} className={`quiz-option ${message.revealed ? option.id === message.quiz!.correctOptionId ? 'correct' : option.id === message.selectedOption ? 'incorrect' : '' : ''}`} onClick={() => updateMessage(message.id, current => ({ ...current, selectedOption: option.id, revealed: true }))}><span>{option.id}</span><span>{option.text}</span>{message.revealed && option.id === message.quiz!.correctOptionId && <b>✓</b>}</button>)}</div>{message.revealed ? <div className="quiz-feedback"><strong>{message.selectedOption === message.quiz.correctOptionId ? '回答正确' : `正确答案：${message.quiz.correctOptionId}`}</strong>{message.quiz.options.map(option => <p key={option.id}><b>{option.id}.</b> {option.explanation}</p>)}<small>本地反馈已完成；继续输入或手动开启下一轮才会请求模型。</small></div> : <small className="quiz-hint">请选择一个选项，作答后显示答案与全部解释。</small>}</div>}
              {!!message.sources?.length && <div className="sources">{message.sources.map(item => <button key={item.chunkId} onClick={() => setSource(item)}>▧ {item.title} <span>↗</span></button>)}</div>}
              {message.role === 'assistant' && message.status !== 'running' && <div className="message-actions"><button onClick={() => void copy(message)} disabled={!message.text}>{copiedId === message.id ? '已复制' : '复制回答'}</button>{index === messages.length - 1 && ['cancelled', 'failed', 'interrupted', 'limited'].includes(message.status ?? '') && <button disabled={busy} onClick={() => retry(message)}>重试本轮</button>}</div>}
            </div></article>)}<div ref={bottom}/>
        </section>
        <footer className="composer-area">{notice && <div role="alert" className="notice">{notice}</div>}<form className="composer" onSubmit={event => { event.preventDefault(); void run(input); }}><label className="sr-only" htmlFor="message-input">输入消息</label><textarea id="message-input" rows={2} placeholder={`试试：${selected.prompt}`} value={input} disabled={busy || !loaded} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void run(input); } }}/><div className="composer-bottom"><span>◈ {selected.title}<i>固定脚本</i></span>{busy ? <button className="stop-button" type="button" onClick={stop}>■ 停止</button> : <button className="send-button" type="submit" disabled={!input.trim() || !loaded} aria-label="发送消息">↑</button>}</div></form><div className="footer-meta"><span>{storageStatus}</span><span>6 次工具调用 / 120 秒上限{health?.stats ? ` · 后端累计 ${health.stats.requests} 次请求` : ''}</span></div></footer>
      </>}
    </main>
    {source && <div className="modal-backdrop" onClick={() => setSource(null)}><section className="source-modal" role="dialog" aria-modal="true" aria-labelledby="source-title" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setSource(null)} aria-label="关闭来源">×</button><div className="eyebrow">模拟来源 · 缓存文本块</div><h2 id="source-title">{source.title}</h2><p className="source-location">{source.location}</p><pre>{source.text}</pre><small>该示例没有原文件，也不对应真实课程资料。</small></section></div>}
  </div>;
}
// TODO(ui): A's production layout, multiple sessions, course/material selection and full accessibility pass.
// TODO(auth): Replace simulated entrance with old-site one-time authorization code exchange.
