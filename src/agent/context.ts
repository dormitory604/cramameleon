import type { AgentAction, ChatMessage, HistoryMessage } from '../contracts/index.ts';
export function actionText(action: AgentAction): string {
  switch (action.type) {
    case 'send': case 'retry': return action.text;
    case 'continue': return '请接着刚才的内容继续。';
    case 'next_question': return '请根据刚才的练习和我的作答，出下一题。';
  }
}
export const HISTORY_MAX_CHARS = 12000;
export const HISTORY_MAX_MESSAGES = 30;
// Pairing and budget rules are shared with the quiz-aware history projection.
export function buildHistory(messages: ChatMessage[], sessionId: string, retryUserId?: string, maxChars = HISTORY_MAX_CHARS): HistoryMessage[] {
  const current = messages.filter(m => m.conversationId === sessionId);
  const pairs: HistoryMessage[][] = [];
  let user: ChatMessage | undefined;
  for (const m of current) {
    if (m.id === retryUserId) break;
    if (m.role === 'user') { user = m; continue; }
    if (!user || !['completed', 'waiting'].includes(m.status ?? '')) continue;
    // Quiz records are projected by buildLearningHistory before pairing.
    pairs.push([{ role: 'user', text: user.text }, { role: 'assistant', text: m.text }]);
    user = undefined;
  }
  const result: HistoryMessage[] = [];
  let size = 0;
  for (const pair of pairs.reverse()) {
    const length = pair.reduce((n, m) => n + m.text.length, 0);
    if (size + length > maxChars || result.length >= HISTORY_MAX_MESSAGES) break;
    result.unshift(...pair); size += length;
  }
  return result;
}
