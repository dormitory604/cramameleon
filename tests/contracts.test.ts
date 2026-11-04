import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelEvent, validateQuiz } from '../src/contracts/index.ts';

const quiz = { id: 'q1', question: 'Demo?', origin: 'generated', correctOptionId: 'A', sources: [], options: [{ id: 'A', text: 'A', explanation: 'A explanation' }, { id: 'B', text: 'B', explanation: 'B explanation' }] };
test('quiz rejects duplicate options, missing answers and missing explanations', () => {
  assert.equal(validateQuiz(quiz), true);
  assert.equal(validateQuiz({ ...quiz, options: [quiz.options[0], quiz.options[0]] }), false);
  assert.equal(validateQuiz({ ...quiz, correctOptionId: 'C' }), false);
  assert.equal(validateQuiz({ ...quiz, options: [{ ...quiz.options[0], explanation: '' }, quiz.options[1]] }), false);
});
test('model transport rejects unknown tools and incomplete calls', () => {
  assert.deepEqual(parseModelEvent({ type: 'finish', stopReason: 'toolUse' }), { type: 'finish', stopReason: 'toolUse' });
  assert.throws(() => parseModelEvent({ type: 'tool_call', id: '1', name: 'shell', arguments: {} }));
  assert.throws(() => parseModelEvent({ type: 'tool_call', id: '1', name: 'demo_fixture', arguments: { scenario: 'unknown' } }));
  assert.throws(() => parseModelEvent({ type: 'text_delta' }));
});
