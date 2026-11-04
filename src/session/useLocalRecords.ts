import { useEffect, useReducer, useRef } from 'react';
import type { ChatMessage, LearningState, MaterialScope } from '../contracts/index.ts';
import { checkpointData, LEGACY_CONVERSATION_ID, loadData, saveData, type LocalData, type LoadedData } from './appStore.ts';

type StoragePhase = 'reading' | 'readFailed' | 'restored' | 'recoveredUnsaved' | 'saving' | 'saved' | 'writeFailed';
const storagePhases: Record<StoragePhase, { message: string; failed?: true }> = {
  reading: { message: '正在读取本机记录' },
  readFailed: { message: '读取本机记录失败，尚未载入记录。请重试读取；读取成功前不会覆盖已有记录。', failed: true },
  restored: { message: '已恢复本机记录' },
  recoveredUnsaved: { message: '已恢复本机副本，但尚未保存到记录库。可移除资料、删除对话后重试保存。', failed: true },
  saving: { message: '正在保存到当前浏览器' },
  saved: { message: '已保存到当前浏览器' },
  writeFailed: { message: '保存失败，刷新后可能丢失记录。请重试保存。', failed: true },
};
type Scope = {
  userId: string; data: LocalData; live: boolean; exiting: boolean;
  revision: number; savedRevision: number; phase: StoragePhase;
  timer?: ReturnType<typeof setTimeout>;
  pending?: { revision: number; promise: Promise<void> };
};
const fresh = (): LocalData => ({ version: 2, messages: [], states: {}, materials: {}, activeConversationId: crypto.randomUUID() });
// Resume where the learner last was: saved choice, newest message, a session with
// materials, a session with learning state, then a new session.
function pickActiveConversation(saved: LoadedData): string {
  const last = [...saved.messages].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  return saved.activeConversationId ?? (last ? last.conversationId ?? LEGACY_CONVERSATION_ID : undefined)
    ?? Object.keys(saved.materials ?? {}).find(id => saved.materials![id].documents.length)
    ?? Object.keys(saved.states)[0] ?? crypto.randomUUID();
}
const isLoaded = (target: Scope) => target.phase !== 'reading' && target.phase !== 'readFailed';

// A scope owns its snapshots and callbacks until it is replaced by another user.
export function useLocalRecords(userId?: string, onInterrupt?: () => void) {
  const interruption = useRef(onInterrupt);
  interruption.current = onInterrupt;
  const owner = useRef<Scope | null>(null);
  const blank = useRef(fresh());
  const [, render] = useReducer(value => value + 1, 0);
  const scope = owner.current?.userId === userId ? owner.current : null;
  const data = scope?.data ?? blank.current;
  function publish(target: Scope) { if (target.live && owner.current === target) render(); }

  function flush(target: Scope): Promise<void> {
    if (target.timer) { clearTimeout(target.timer); target.timer = undefined; }
    if (!isLoaded(target) || target.revision === target.savedRevision) return Promise.resolve();
    const revision = target.revision;
    if (target.pending?.revision === revision) return target.pending.promise;
    target.phase = 'saving'; publish(target);
    const promise = (async () => {
      try {
        await saveData(target.userId, target.data);
        target.savedRevision = Math.max(target.savedRevision, revision);
        if (revision === target.revision) target.phase = 'saved';
      } catch (error) {
        if (revision === target.revision) target.phase = 'writeFailed';
        throw error;
      } finally { publish(target); }
    })();
    target.pending = { revision, promise };
    const clear = () => { if (target.pending?.promise === promise) target.pending = undefined; };
    void promise.then(clear, clear);
    return promise;
  }
  async function restore(target: Scope) {
    target.phase = 'reading'; publish(target);
    try {
      const { recoveryUnsaved, ...saved } = await loadData(target.userId);
      if (!target.live || owner.current !== target) return;
      target.data = { ...saved, activeConversationId: pickActiveConversation(saved) };
      target.revision = recoveryUnsaved ? 1 : 0;
      target.savedRevision = 0;
      target.phase = recoveryUnsaved ? 'recoveredUnsaved' : 'restored';
    } catch {
      if (!target.live || owner.current !== target) return;
      target.phase = 'readFailed';
    } finally { publish(target); }
  }
  function preserveRecovery(target: Scope): boolean {
    if (!isLoaded(target) || target.revision === target.savedRevision) return true;
    try { checkpointData(target.userId, target.data); return true; }
    catch { return false; }
  }
  useEffect(() => {
    if (!userId) { owner.current = null; render(); return; }
    const target: Scope = { userId, data: fresh(), live: true, exiting: false, revision: 0, savedRevision: 0, phase: 'reading' };
    owner.current = target; render();
    void restore(target);
    function checkpointAndFlush(): boolean {
      if (!isLoaded(target) || target.revision === target.savedRevision) return true;
      // IndexedDB may not finish once a document unloads. Keep a synchronous,
      // user-scoped recovery snapshot until that same snapshot has committed.
      // A failed checkpoint (quota, disabled storage) is not a save failure: the
      // IndexedDB write below decides the visible status. It only means leaving
      // now is unsafe, which beforeunload reports while changes are unsaved.
      const recoverable = preserveRecovery(target);
      void flush(target).catch(() => undefined);
      return recoverable;
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      // A canceled navigation has no pageshow event. Keep the live scope editable
      // and the running turn intact until pagehide confirms the document left.
      if (!checkpointAndFlush()) { event.preventDefault(); event.returnValue = ''; }
    }
    function exit() {
      target.exiting = true;
      interruption.current?.();
      if (target.data.messages.some(message => message.status === 'running')) {
        target.data = { ...target.data, messages: target.data.messages.map(message => message.status === 'running' ? { ...message, status: 'interrupted' } : message) };
        target.revision += 1;
      }
      checkpointAndFlush();
    }
    function resume() { target.exiting = false; publish(target); }
    function visibility() { if (document.visibilityState === 'hidden') checkpointAndFlush(); }
    window.addEventListener('pageshow', resume);
    window.addEventListener('pagehide', exit);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      exit(); target.live = false;
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('pagehide', exit);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [userId]);

  function change(update: (previous: LocalData) => LocalData) {
    if (!scope?.live || scope.exiting || !isLoaded(scope) || owner.current !== scope) return;
    scope.data = update(scope.data);
    scope.revision += 1; scope.phase = 'saving'; publish(scope);
    if (!scope.timer) scope.timer = setTimeout(() => { scope.timer = undefined; void flush(scope).catch(() => undefined); }, 200);
  }
  function setMessages(update: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[])) { change(previous => ({ ...previous, messages: typeof update === 'function' ? update(previous.messages) : update })); }
  function setStates(update: Record<string, LearningState> | ((previous: Record<string, LearningState>) => Record<string, LearningState>)) { change(previous => ({ ...previous, states: typeof update === 'function' ? update(previous.states) : update })); }
  function setMaterials(update: Record<string, MaterialScope> | ((previous: Record<string, MaterialScope>) => Record<string, MaterialScope>)) { change(previous => ({ ...previous, materials: typeof update === 'function' ? update(previous.materials ?? {}) : update })); }
  function setConversationId(id: string) { change(previous => ({ ...previous, activeConversationId: id })); }
  return {
    messages: data.messages, states: data.states, materials: data.materials ?? {}, conversationId: data.activeConversationId!,
    setMessages, setStates, setMaterials, setConversationId,
    loaded: !!scope && isLoaded(scope), storageStatus: storagePhases[scope?.phase ?? 'reading'].message,
    storageFailed: !!scope && !!storagePhases[scope.phase].failed, readFailed: scope?.phase === 'readFailed',
    retryStorage: () => { if (scope) void (scope.phase === 'readFailed' ? restore(scope) : flush(scope)).catch(() => undefined); },
    flush: () => scope ? flush(scope) : Promise.resolve(),
    preserveRecovery: () => scope ? preserveRecovery(scope) : true,
  };
}
