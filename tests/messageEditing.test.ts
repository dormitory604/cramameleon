import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/contracts/index.ts';
import { prepareMessageEdit } from '../src/session/messageEditing.ts';

const messages: ChatMessage[] = [
  { id: 'first', conversationId: 'study', role: 'user', text: '前面的背景', createdAt: 1 },
  { id: 'first-answer', conversationId: 'study', role: 'assistant', text: '前面的回答', createdAt: 2, replyTo: 'first', status: 'completed' },
  { id: 'edit', conversationId: 'study', role: 'user', text: '原问题', createdAt: 3, selectedMaterialIds: ['d1'] },
  { id: 'answer', conversationId: 'study', role: 'assistant', text: '旧回答', createdAt: 4, replyTo: 'edit', status: 'completed' },
  { id: 'later', conversationId: 'study', role: 'user', text: '后面的追问', createdAt: 5 },
  { id: 'later-answer', conversationId: 'study', role: 'assistant', text: '后面的回答', createdAt: 6, replyTo: 'later', status: 'completed' },
  { id: 'other', conversationId: 'another-user-scope', role: 'user', text: '其他对话', createdAt: 7 },
];

test('an edit preserves the original conversation, remaps reply ids and keeps only earlier context for regeneration', () => {
  const before = structuredClone(messages);
  const plan = prepareMessageEdit(messages, 'study', 'edit', '  修改后的问题\n第二行  ');
  assert.deepEqual(messages, before);
  assert.deepEqual(plan.prefix.map(message => message.id), ['first', 'first-answer']);
  assert.equal(plan.message.id, 'edit');
  assert.equal(plan.message.text, '修改后的问题\n第二行');
  assert.equal(plan.message.createdAt, 3);
  assert.ok(plan.message.editedAt);
  assert.equal(plan.archived.length, 6);
  assert.equal(plan.archived[0].editArchive, true);
  assert.equal(plan.archived[2].text, '原问题');
  assert.deepEqual(plan.archived[2].selectedMaterialIds, ['d1']);
  assert.ok(plan.archived.every(message => message.conversationId === plan.archiveId));
  assert.equal(new Set([...messages, ...plan.archived].map(message => message.id)).size, messages.length + plan.archived.length);
  for (const index of [1, 3, 5]) assert.equal(plan.archived[index].replyTo, plan.archived[index - 1].id);
});

test('edits reject assistant, stale, cross-conversation, blank and unchanged messages before creating a branch', () => {
  for (const id of ['answer', 'missing', 'other']) assert.throws(() => prepareMessageEdit(messages, 'study', id, 'new'), /只能编辑/);
  for (const text of ['', '  \n ', 'x'.repeat(8001)]) assert.throws(() => prepareMessageEdit(messages, 'study', 'edit', text), /1–8000/);
  assert.throws(() => prepareMessageEdit(messages, 'study', 'edit', '原问题'), /先修改/);
});

test('editing a saved version keeps its boundary state and promotes the edited conversation out of the archive label', () => {
  const state = { preferences: '保持简短', progress: '原来的学习位置', quizPolicy: 'avoid' as const };
  const saved = messages.slice(0, 4).map((message, index) => ({ ...message, ...(index === 0 ? { editArchive: true as const } : {}), ...(message.id === 'edit' ? { learningStateBefore: state } : {}) }));
  const plan = prepareMessageEdit(saved, 'study', 'edit', '再次修改');
  assert.deepEqual(plan.message.learningStateBefore, state);
  assert.ok(plan.prefix.every(message => !message.editArchive));
  assert.equal(plan.message.editArchive, undefined);
  assert.equal(plan.archived[0].editArchive, true);
});
