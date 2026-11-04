import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData, saveData } from '../src/session/appStore.ts';
test('IndexedDB isolates users, restores interrupted rounds, and serializes deletes after saves', async () => {
  const record = { version: 2 as const, states: { chat: { preferences:'简短',progress:'' } }, messages: [{ id:'1',role:'assistant' as const,text:'partial',conversationId:'chat',createdAt:1,status:'running' as const }] };
  await saveData('user-a',record);
  assert.equal((await loadData('user-a')).messages[0].status,'interrupted');
  assert.deepEqual((await loadData('user-b')).messages,[]);
  const first=saveData('user-a',record);
  const deleted=saveData('user-a',{version:2,messages:[],states:{}});
  await Promise.all([first,deleted]);
  assert.deepEqual((await loadData('user-a')).messages,[]);
});
