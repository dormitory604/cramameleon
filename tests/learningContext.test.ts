import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, HistoryMessage, Quiz } from '../src/contracts/index.ts';
import { buildLearningHistory } from '../src/session/learningContext.ts';

const quiz: Quiz = {
  id: 'union', question: '互斥事件概率分别为 0.2 和 0.3，并集概率是多少？',
  options: [
    { id: 'A', text: '0.5', explanation: '互斥时交集为零，并集概率相加。' },
    { id: 'B', text: '0.06', explanation: '乘积不能计算本题并集。' },
  ], correctOptionId: 'A', origin: 'adapted',
  sources: Array.from({ length: 3 }, (_, i) => ({ documentId: 'lecture', chunkId: `chunk-${i}`, title: '概率讲义', location: `段落 ${i + 1}`, text: '来源正文'.repeat(500) })),
};
const message = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, text, conversationId: 'study', createdAt: 1, status: 'completed', ...extra });
const exercise = (): ChatMessage[] => [message('u1', 'user', '依据讲义考考我'), message('a1', 'assistant', '请选择。', { quiz: structuredClone(quiz), selectedOption: 'B', revealed: true })];
function assertBoundsAndPairs(history: HistoryMessage[]) {
  assert.ok(history.reduce((size, m) => size + m.text.length, 0) <= 12000, 'final history exceeds 12000 characters');
  assert.ok(history.length <= 30);
  assert.equal(history.length % 2, 0);
  for (let i = 0; i < history.length; i += 2) {
    assert.equal(history[i].role, 'user');
    assert.equal(history[i + 1].role, 'assistant');
  }
}

test('near-limit followups and more than fifteen pairs reserve exactly one current quiz and actual reveal state', () => {
  const messages = exercise();
  delete messages[1].selectedOption;
  messages.push(message('long-u', 'user', '再解释详细些'), message('long-a', 'assistant', '讲'.repeat(11900)));
  const nearLimit = buildLearningHistory(messages, 'study');
  assertBoundsAndPairs(nearLimit);
  assert.ok(nearLimit.map(m => m.text).join('\n').includes('已查看答案，未选择选项'));
  for (let i = 1; i <= 20; i++) messages.push(message(`u${i + 10}`, 'user', `追问 ${i}`), message(`a${i + 10}`, 'assistant', `解释 ${i}`));
  const history = buildLearningHistory(messages, 'study');
  assertBoundsAndPairs(history);
  assert.equal(history.length, 30);
  assert.equal(history[0].text, '依据讲义考考我');
  assert.equal(history[2].text, '追问 7');
  assert.equal(history.at(-1)!.text, '解释 20');
  assert.equal(history.map(m => m.text).join('\n').split('题目记录：').length - 1, 1);
});

test('retry history excludes the current question, failed quizzes and other sessions while preserving the valid local quiz', () => {
  const messages = [...exercise(),
    message('foreign-u', 'user', '其他会话问题', { conversationId: 'other' }),
    message('foreign-a', 'assistant', '其他会话答案', { conversationId: 'other', quiz: { ...quiz, id: 'foreign-quiz' } }),
    message('failed-u', 'user', '失败问题'),
    message('failed-a', 'assistant', '失败片段', { status: 'failed', quiz: { ...quiz, id: 'failed-quiz' } }),
    message('retry-u', 'user', '本轮问题'),
    message('retry-a', 'assistant', '中断片段', { status: 'interrupted', quiz: { ...quiz, id: 'interrupted-quiz' } }),
  ];
  const history = buildLearningHistory(messages, 'study', 'retry-u');
  assertBoundsAndPairs(history);
  assert.equal(history.length, 2);
  const text = history.map(m => m.text).join('\n');
  assert.ok(text.includes('用户作答：B（回答错误）'));
  for (const excluded of ['其他会话', '失败问题', '失败片段', '本轮问题', '中断片段', 'foreign-quiz', 'failed-quiz', 'interrupted-quiz']) assert.ok(!text.includes(excluded));
  assert.deepEqual(buildLearningHistory(messages, 'study', 'foreign-u'), buildLearningHistory(messages, 'study'));
  assert.deepEqual(buildLearningHistory([message('alone', 'assistant', '孤立题板', { quiz })], 'study'), []);
});

test('a single large quiz stays whole when it fits, and explicitly omits an oversized record without cutting JSON', () => {
  for (const size of [10000, 14000]) {
    const messages = exercise();
    messages[0].text = '请求'.repeat(2000);
    messages[1].text = '提示'.repeat(1000);
    messages[1].quiz!.question += '条件'.repeat(size / 2);
    const history = buildLearningHistory(messages, 'study');
    assertBoundsAndPairs(history);
    const record = JSON.parse(history[1].text.match(/题目记录：([^\n]+)/)![1]);
    assert.ok(history[1].text.includes('用户作答：B（回答错误）'));
    if (size === 10000) {
      assert.equal(record.question, messages[1].quiz!.question);
      assert.deepEqual(record.options, quiz.options);
      assert.equal(record.correctOptionId, 'A');
    } else {
      assert.equal(record.omitted, true);
      assert.equal(record.id, 'union');
      assert.equal(record.correctOptionId, 'A');
      assert.match(record.reason, /本机/);
      assert.ok(!('question' in record), 'must not present a partially cut quiz as complete');
    }
  }
});

test('an over-budget followup retains the originating quiz pair instead of orphan assistant history', () => {
  const history = buildLearningHistory([...exercise(), message('u2', 'user', '解释所有条件'), message('a2', 'assistant', '讲'.repeat(13000))], 'study');
  assertBoundsAndPairs(history);
  assert.equal(history[0].text, '依据讲义考考我');
  assert.ok(history[1].text.includes(quiz.question));
  assert.ok(history[1].text.includes('用户作答：B（回答错误）'));
});

test('source-backed quiz continuation keeps actual local answer within the final history budget without resending cached bodies', () => {
  const messages = [...exercise(), message('u2', 'user', '再解释详细些'), message('a2', 'assistant', '讲'.repeat(11000))];
  const snapshot = structuredClone(messages);
  const history = buildLearningHistory(messages, 'study');
  assertBoundsAndPairs(history);
  const text = history.map(m => m.text).join('\n');
  assert.ok(text.includes(quiz.question));
  for (const option of quiz.options) assert.ok(text.includes(option.explanation));
  assert.ok(text.includes('用户作答：B（回答错误）'));
  assert.ok(text.includes('chunk-2'));
  assert.ok(text.includes('段落 3'));
  assert.ok(!text.includes('来源正文'));
  assert.equal(text.split('题目记录：').length - 1, 1);
  assert.deepEqual(messages, snapshot, 'projection must leave cached quiz and sources unchanged');
});

test('the current batch keeps separate answers when one question exceeds the history budget', () => {
  const messages = [
    message('u1', 'user', '出两道题'),
    message('a1', 'assistant', '', { quizzes: [
      { quiz: { ...quiz, id: 'oversized', question: '条件'.repeat(7000) }, selectedOption: 'B', revealed: true },
      { quiz: { ...quiz, id: 'small' }, revealed: true },
    ] }),
  ];
  const history = buildLearningHistory(messages, 'study');
  assertBoundsAndPairs(history);
  const text = history[1].text;
  assert.match(text, /"omitted":true[^\n]+"id":"oversized"[^\n]*\n用户作答：B（回答错误）/);
  assert.match(text, /"id":"small"[^\n]*\n用户作答：已查看答案，未选择选项/);
  assert.ok(text.includes(quiz.question));
});
