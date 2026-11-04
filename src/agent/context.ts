import type { AgentAction, ChatMessage, HistoryMessage } from '../contracts/index.ts';
export function actionText(action: AgentAction): string {
  switch (action.type) {
    case 'send': case 'retry': return action.text;
    case 'continue': return '请接着刚才的内容继续。';
    case 'next_question': return '请根据刚才的练习和我的作答，出下一题。';
    case 'confirm_materials': return '我确认选择这些资料：' + action.ids.join('、');
  }
}
// Complete pairs only; retries exclude the original prompt and incomplete answer.
export function buildHistory(messages: ChatMessage[], sessionId: string, retryUserId?: string, maxChars = 12000): HistoryMessage[] {
  const current = messages.filter(m => m.conversationId === sessionId);
  const pairs: HistoryMessage[][] = [];
  let user: ChatMessage | undefined;
  for (const m of current) {
    if (m.id === retryUserId) break;
    if (m.role === 'user') { user = m; continue; }
    if (!user || m.status !== 'completed') continue;
    let text = m.text;
    if (m.quiz) text += '\n题目记录：' + JSON.stringify(m.quiz) + '\n用户作答：' + (m.selectedOption ?? '尚未作答');
    pairs.push([{ role: 'user', text: user.text }, { role: 'assistant', text }]);
    user = undefined;
  }
  const result: HistoryMessage[] = [];
  let size = 0;
  for (const pair of pairs.reverse()) {
    const length = pair.reduce((n, m) => n + m.text.length, 0);
    if (size + length > maxChars || result.length >= 30) break;
    result.unshift(...pair); size += length;
  }
  return result;
}
