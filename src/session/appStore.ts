import type { ChatMessage, LearningState } from '../contracts/index.ts';
export type LocalData = { version: 2; messages: ChatMessage[]; states: Record<string, LearningState> };
const empty = (): LocalData => ({ version: 2, messages: [], states: {} });
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cramameleon', 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('users')) request.result.createObjectStore('users'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他旧版本页面后重试'));
  });
}
export async function loadData(userId: string): Promise<LocalData> {
  if (!userId) throw new Error('缺少用户身份');
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('users', 'readonly');
    const request = transaction.objectStore('users').get(userId);
    request.onsuccess = () => {
      const record = request.result as LocalData | undefined;
      if (!record) { resolve(empty()); return; }
      if (record.version !== 2 || !Array.isArray(record.messages) || !record.states || typeof record.states !== 'object') { reject(new Error('本机记录版本不兼容')); return; }
      resolve({ ...record, messages: record.messages.map(m => m.status === 'running' ? { ...m, status: 'interrupted' } : m) });
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}
// Serialize writes across async opens so a stale save can never resurrect a deleted session.
let writes: Promise<void> = Promise.resolve();
export function saveData(userId: string, data: LocalData): Promise<void> {
  const snapshot = structuredClone(data);
  const next = writes.catch(() => undefined).then(async () => {
    if (!userId) throw new Error('缺少用户身份');
    const db = await database();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('users', 'readwrite');
      transaction.objectStore('users').put(snapshot, userId);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  });
  writes = next;
  return next;
}
