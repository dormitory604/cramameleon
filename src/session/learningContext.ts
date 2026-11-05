import type { ChatMessage, HistoryMessage, QuizBoard } from '../contracts/index.ts';
import { quizBoards, validateQuiz } from '../contracts/index.ts';
import { buildHistory, HISTORY_MAX_CHARS, HISTORY_MAX_MESSAGES } from '../agent/context.ts';

// The record is a machine annotation on the assistant turn, not prose the model
// wrote; label it so the model does not imitate it in its next reply.
export const QUIZ_RECORD_NOTE = '〔系统附注：上面的题目已通过 present_quiz 题板展示，下列记录由本机生成，仅供参考，不是你写过的回答；回复中不要复述或模仿此格式，出题仍须调用 present_quiz〕';

function quizRecord({ quiz, selectedOption, revealed }: QuizBoard, omitQuiz = false): string {
  const answer = selectedOption
    ? `${omitQuiz && selectedOption.length > 256 ? '已作答（选项标识过长，保留在本机）' : selectedOption}（${selectedOption === quiz.correctOptionId ? '回答正确' : '回答错误'}）`
    : revealed ? '已查看答案，未选择选项' : '尚未作答';
  const payload = omitQuiz ? {
    omitted: true, reason: '当前练习超出历史上限，完整题目及解释保留在本机；请勿推测省略内容，可请用户缩短题目。',
    id: quiz.id.length <= 256 ? quiz.id : undefined,
    correctOptionId: quiz.correctOptionId.length <= 256 ? quiz.correctOptionId : undefined,
  } : { ...quiz, sources: quiz.sources.map(({ text: _text, ...source }) => source) };
  return QUIZ_RECORD_NOTE + '\n题目记录：' + JSON.stringify(payload) + '\n用户作答：' + answer;
}

// Use the shared pairing boundary with small index markers to locate complete
// pairs independently of their text size. It retains the latest 15 pairs.
function pairIndexes(messages: ChatMessage[], sessionId: string): number[][] {
  const history = buildHistory(messages.map((message, index) => ({ ...message, text: String(index) })), sessionId, undefined, Infinity);
  return Array.from({ length: history.length / 2 }, (_, index) => [Number(history[index * 2].text), Number(history[index * 2 + 1].text)]);
}

// Project local interactions only at send time. Reserve the current quiz's
// originating pair before pruning ordinary history; never append outside budget.
export function buildLearningHistory(messages: ChatMessage[], sessionId: string, retryUserId?: string): HistoryMessage[] {
  const current = messages.filter(message => message.conversationId === sessionId);
  const beforeRetry = current.findIndex(message => message.id === retryUserId);
  const eligible = beforeRetry < 0 ? current : current.slice(0, beforeRetry);
  const boards = eligible.map(message => quizBoards(message).filter(board => validateQuiz(board.quiz)));
  const records = boards.map(items => items.map(board => quizRecord(board)).join('\n'));
  const projected = eligible.map((message, index) => ({ ...message,
    text: records[index] ? message.text + '\n' + records[index] : message.text }));
  let pinned: number[] | undefined;
  for (let index = eligible.length - 1; index >= 0; index--) {
    if (eligible[index].role !== 'assistant' || !boards[index].length) continue;
    const pair = pairIndexes(eligible.slice(0, index + 1), sessionId).at(-1);
    if (pair?.[1] === index) { pinned = pair; break; }
  }
  if (!pinned) return buildHistory(projected, sessionId);

  const [user, assistant] = pinned;
  const record = records[assistant];
  if (projected[user].text.length + projected[assistant].text.length > HISTORY_MAX_CHARS) projected[assistant].text = record;
  if (projected[user].text.length + record.length > HISTORY_MAX_CHARS) {
    projected[user].text = '（原始练习请求过长，全文保留在本机；配对回答包含当前练习记录。）';
  }
  if (projected[user].text.length + record.length > HISTORY_MAX_CHARS) {
    const items = boards[assistant];
    const compact = items.map(board => quizRecord(board, true));
    let remaining = HISTORY_MAX_CHARS - projected[user].text.length - compact.join('\n').length;
    projected[assistant].text = items.map((board, index) => {
      const full = quizRecord(board);
      const extra = full.length - compact[index].length;
      if (extra > remaining) return compact[index];
      remaining -= extra;
      return full;
    }).join('\n');
  }
  const remaining = pairIndexes(eligible, sessionId).filter(pair => pair[1] !== assistant);
  const ordinary = buildHistory(remaining.flatMap(pair => pair.map(index => projected[index])), sessionId, undefined,
    HISTORY_MAX_CHARS - projected[user].text.length - projected[assistant].text.length).slice(-(HISTORY_MAX_MESSAGES - 2)); // leave room for the pinned pair
  const retained = ordinary.length ? remaining.slice(-ordinary.length / 2) : [];
  return [...retained, pinned].sort((a, b) => a[0] - b[0]).flatMap(pair => pair.map(index => ({ role: projected[index].role, text: projected[index].text })));
}
