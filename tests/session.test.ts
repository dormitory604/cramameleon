import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadData, saveData } from '../src/session/appStore.ts';
import { makeDocument } from '../src/tools/localText.ts';
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
test('legacy v2 migrates without losing chats; parsed materials and selection isolate users and delete together',async()=>{
 const legacy={version:2 as const,messages:[],states:{}};
 await saveData('legacy-materials',legacy);assert.deepEqual((await loadData('legacy-materials')).materials,{});
 const doc=makeDocument('notes.txt',[{text:'local text',location:'段落 1'}],[],10,'fingerprint');
 const saved={...legacy,materials:{chat:{documents:[doc],selectedIds:[doc.id]}}};
 await saveData('material-a',saved);
 assert.deepEqual((await loadData('material-a')).materials,saved.materials);
 assert.deepEqual((await loadData('material-b')).materials,{});
 const writing=saveData('material-a',saved),deleting=saveData('material-a',{...legacy,materials:{}});
 await Promise.all([writing,deleting]);assert.deepEqual((await loadData('material-a')).materials,{});
});
