import type { ChatMessage, LearningState, MaterialScope } from '../contracts/index.ts';
// Conversation id assigned to records saved before conversations existed.
export const LEGACY_CONVERSATION_ID = 'legacy';
export type LocalData = { version: 2; messages: ChatMessage[]; states: Record<string, LearningState>; materials?: Record<string, MaterialScope>; activeConversationId?: string };
// Transient read metadata; it is never part of the persisted v2 record.
export type LoadedData = LocalData & { recoveryUnsaved?: true };
type StoredData = LocalData & { checkpointId?: string };
type Checkpoint = { id: string; data: LocalData };
const empty = (): LocalData => ({ version: 2, messages: [], states: {}, materials: {} });
const pendingKey = (userId: string) => `cramameleon:pending:${encodeURIComponent(userId)}`;
export function checkpointData(userId: string, data: LoadedData): void {
  if (!userId) throw new Error('缺少用户身份');
  const { recoveryUnsaved: _recoveryUnsaved, ...record } = data;
  localStorage.setItem(pendingKey(userId), JSON.stringify({ id: crypto.randomUUID(), data: record }));
}
function checkpoint(userId: string): string | null {
  try { return globalThis.localStorage?.getItem(pendingKey(userId)) ?? null; }
  catch { return null; } // IndexedDB remains usable when localStorage is disabled.
}
function parseCheckpoint(raw: string): Checkpoint {
  const value = JSON.parse(raw) as Checkpoint;
  if (!value || typeof value.id !== 'string' || !value.id) throw new Error('本机恢复副本格式不兼容');
  return { id: value.id, data: validate(value.data) };
}
function validate(record: StoredData): StoredData {
  if (!record || record.version !== 2 || !Array.isArray(record.messages) || !record.states || typeof record.states !== 'object' || Array.isArray(record.states)
    || (record.materials !== undefined && (!record.materials || typeof record.materials !== 'object' || Array.isArray(record.materials)))) throw new Error('本机记录版本不兼容');
  return { ...record, materials: record.materials ?? {}, messages: record.messages.map(m => ({
    ...m, conversationId: m.conversationId ?? LEGACY_CONVERSATION_ID,
    ...(m.status === 'running' ? { status: 'interrupted' as const } : {}),
  })) };
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cramameleon', 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('users')) request.result.createObjectStore('users'); };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('请关闭其他旧版本页面后重试')); };
  });
}
export async function loadData(userId: string): Promise<LoadedData> {
  if (!userId) throw new Error('缺少用户身份');
  // A restore must include every save accepted before it was requested.
  await writes.catch(() => undefined);
  const db = await database();
  const saved = await new Promise<StoredData>((resolve, reject) => {
    try {
      const transaction = db.transaction('users', 'readonly');
      const request = transaction.objectStore('users').get(userId);
      let record: StoredData;
      request.onsuccess = () => {
        try { record = request.result ? validate(request.result) : empty(); }
        catch (error) { reject(error); }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => { db.close(); resolve(record); };
      transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('本机记录读取已中断')); };
    } catch (error) { db.close(); reject(error); }
  });
  const pending = checkpoint(userId);
  if (!pending) return saved;
  const recovered = parseCheckpoint(pending);
  // Cleanup can be denied even after a successful commit. Remember which
  // recovery copy that commit superseded so it cannot roll newer data back.
  if (saved.checkpointId === recovered.id) return saved;
  try { await saveData(userId, recovered.data); }
  catch { return { ...recovered.data, recoveryUnsaved: true }; }
  return recovered.data;
}
// Serialize writes across async opens so a stale save can never resurrect a deleted session.
let writes: Promise<void> = Promise.resolve();
export function saveData(userId: string, data: LoadedData): Promise<void> {
  const { recoveryUnsaved: _recoveryUnsaved, ...record } = data;
  const snapshot: StoredData = structuredClone(record);
  const pending = checkpoint(userId);
  const next = writes.catch(() => undefined).then(async () => {
    if (pending) snapshot.checkpointId = parseCheckpoint(pending).id;
    if (!userId) throw new Error('缺少用户身份');
    const db = await database();
    return new Promise<void>((resolve, reject) => {
      try {
        const transaction = db.transaction('users', 'readwrite');
        transaction.objectStore('users').put(snapshot, userId);
        transaction.oncomplete = () => {
          db.close();
          if (pending && checkpoint(userId) === pending) {
            try { localStorage.removeItem(pendingKey(userId)); } catch { /* Keep the recovery copy if unavailable. */ }
          }
          resolve();
        };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      } catch (error) { db.close(); reject(error); }
    });
  });
  writes = next;
  return next;
}
