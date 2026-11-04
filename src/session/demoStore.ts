import type { ChatMessage } from '../contracts/index.ts';
const USER_KEY = 'demo-developer';
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cramameleon-demo', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('sessions'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function loadMessages(): Promise<ChatMessage[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', 'readonly');
    const request = transaction.objectStore('sessions').get(USER_KEY);
    request.onsuccess = () => {
      const record = request.result;
      const messages = record?.version === 1 && Array.isArray(record.messages) ? record.messages as ChatMessage[] : [];
      resolve(messages.map(message => message.status === 'running' ? { ...message, status: 'interrupted' } : message));
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}
export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', 'readwrite');
    transaction.objectStore('sessions').put({ version: 1, messages }, USER_KEY);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}
// TODO(session): Production identity namespaces, version migration and full material state.
