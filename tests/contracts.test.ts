import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelEvent, validateQuiz } from '../src/contracts/index.ts';
import { buildHistory } from '../src/agent/context.ts';
import type { ChatMessage } from '../src/contracts/index.ts';
const quiz = { id: 'q1', question: 'Question?', origin: 'generated', correctOptionId: 'A', sources: [], options: [{ id: 'A', text: 'A', explanation: 'A explanation' }, { id: 'B', text: 'B', explanation: 'B explanation' }] };
test('quiz validates options and source provenance', () => {
  assert.equal(validateQuiz(quiz), true);
  assert.equal(validateQuiz({ ...quiz, options: [quiz.options[0], quiz.options[0]] }), false);
  assert.equal(validateQuiz({ ...quiz, correctOptionId: 'C' }), false);
  assert.equal(validateQuiz({ ...quiz, options: [{ ...quiz.options[0], explanation: '' }, quiz.options[1]] }), false);
  assert.equal(validateQuiz({ ...quiz, origin: 'past_paper' }), false);
  assert.equal(validateQuiz({ ...quiz, sources: [{}] }), false);
});
test('model protocol rejects old demo, unsafe tools, partial JSON, invalid usage', () => {
  assert.deepEqual(parseModelEvent({ type: 'finish', stopReason: 'toolUse' }), { type: 'finish', stopReason: 'toolUse' });
  assert.throws(() => parseModelEvent({ type: 'tool_call', id: '1', name: 'shell', arguments: {} }));
  assert.throws(() => parseModelEvent({ type: 'tool_call', id: '1', name: 'demo_fixture', arguments: {} }));
  assert.throws(() => parseModelEvent({ type: 'tool_call', id: '1', name: 'present_quiz', arguments: '{' }));
  assert.throws(() => parseModelEvent({ type: 'usage', usage: { input: 10, output: 2, total: 10 } }));
});
test('history is isolated, excludes interrupted pairs, retries do not duplicate prompts', () => {
  const m = (id: string, role: 'user' | 'assistant', conversationId = 'a', status: ChatMessage['status'] = 'completed'): ChatMessage => ({ id, text: id, role, conversationId, status, createdAt: 1 });
  const messages = [m('u1','user'),m('a1','assistant'),m('ub','user','b'),m('ab','assistant','b'),m('u2','user'),m('a2','assistant','a','failed')];
  assert.deepEqual(buildHistory(messages,'a'),[{role:'user',text:'u1'},{role:'assistant',text:'a1'}]);
  assert.deepEqual(buildHistory(messages,'a','u2'),buildHistory(messages,'a'));
  assert.deepEqual(buildHistory(messages,'a',undefined,1),[]);
});
