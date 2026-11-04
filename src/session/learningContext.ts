import type { ChatMessage, HistoryMessage } from '../contracts/index.ts';
import { validateQuiz } from '../contracts/index.ts';
import { buildHistory, HISTORY_MAX_CHARS, HISTORY_MAX_MESSAGES } from '../agent/context.ts';

function quizRecord(message: ChatMessage, omitQuiz = false): string {
  const answer = message.selectedOption
    ? `${omitQuiz && message.selectedOption.length > 256 ? '已作答（选项标识过长，保留在本机）' : message.selectedOption}（${message.selectedOption === message.quiz!.correctOptionId ? '回答正确' : '回答错误'}）`
    : message.revealed ? '已查看答案，未选择选项' : '尚未作答';
  const quiz = omitQuiz ? {
    omitted: true, reason: '当前练习超出历史上限，完整题目及解释保留在本机；请勿推测省略内容，可请用户缩短题目。',
    id: message.quiz!.id.length <= 256 ? message.quiz!.id : undefined,
    correctOptionId: message.quiz!.correctOptionId.length <= 256 ? message.quiz!.correctOptionId : undefined,
  } : { ...message.quiz!, sources: message.quiz!.sources.map(({ text: _text, ...source }) => source) };
  return '题目记录：' + JSON.stringify(quiz) + '\n用户作答：' + answer;
}

// Use the shared pairing boundary with small index markers to locate complete
// pairs independently of their text size. It retains the latest 15 pairs.
function pairIndexes(messages: ChatMessage[], sessionId: string): number[][] {
  const history = buildHistory(messages.map((message, index) => ({ ...message, quiz: undefined, text: String(index) })), sessionId, undefined, Infinity);
  return Array.from({ length: history.length / 2 }, (_, index) => [Number(history[index * 2].text), Number(history[index * 2 + 1].text)]);
}

// Project local interactions only at send time. Reserve the current quiz's
// originating pair before pruning ordinary history; never append outside budget.
export function buildLearningHistory(messages: ChatMessage[], sessionId: string, retryUserId?: string): HistoryMessage[] {
  const current = messages.filter(message => message.conversationId === sessionId);
  const beforeRetry = current.findIndex(message => message.id === retryUserId);
  const eligible = beforeRetry < 0 ? current : current.slice(0, beforeRetry);
  const projected = eligible.map(message => ({ ...message, quiz: undefined,
    text: validateQuiz(message.quiz) ? message.text + '\n' + quizRecord(message) : message.text }));
  let pinned: number[] | undefined;
  for (let index = eligible.length - 1; index >= 0; index--) {
    if (eligible[index].role !== 'assistant' || !validateQuiz(eligible[index].quiz)) continue;
    const pair = pairIndexes(eligible.slice(0, index + 1), sessionId).at(-1);
    if (pair?.[1] === index) { pinned = pair; break; }
  }
  if (!pinned) return buildHistory(projected, sessionId);

  const [user, assistant] = pinned;
  const record = quizRecord(eligible[assistant]);
  if (projected[user].text.length + projected[assistant].text.length > HISTORY_MAX_CHARS) projected[assistant].text = record;
  if (projected[user].text.length + record.length > HISTORY_MAX_CHARS) {
    projected[user].text = '（原始练习请求过长，全文保留在本机；配对回答包含当前练习记录。）';
  }
  if (projected[user].text.length + record.length > HISTORY_MAX_CHARS) projected[assistant].text = quizRecord(eligible[assistant], true);
  const remaining = pairIndexes(eligible, sessionId).filter(pair => pair[1] !== assistant);
  const ordinary = buildHistory(remaining.flatMap(pair => pair.map(index => projected[index])), sessionId, undefined,
    HISTORY_MAX_CHARS - projected[user].text.length - projected[assistant].text.length).slice(-(HISTORY_MAX_MESSAGES - 2)); // leave room for the pinned pair
  const retained = ordinary.length ? remaining.slice(-ordinary.length / 2) : [];
  return [...retained, pinned].sort((a, b) => a[0] - b[0]).flatMap(pair => pair.map(index => ({ role: projected[index].role, text: projected[index].text })));
}
