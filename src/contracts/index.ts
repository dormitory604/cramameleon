export const CONTRACT_VERSION = 'demo.v1' as const;
export type Scenario = 'chat' | 'quiz' | 'slow' | 'error';
export type Source = { documentId: string; chunkId: string; title: string; text: string; location: string };
export type Quiz = { id: string; question: string; options: { id: string; text: string; explanation: string }[]; correctOptionId: string; origin: 'generated'; sources: Source[] };
export type AgentInput = { sessionId: string; turnId: string; text: string; scenario: Scenario; signal: AbortSignal };
type Envelope = { sessionId: string; turnId: string };
export type AgentEvent = Envelope & (
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_status'; category: 'model' | 'tool'; status: 'started' | 'completed'; message: string }
  | { type: 'quiz_ready'; quiz: Quiz }
  | { type: 'sources_ready'; sources: Source[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; status: 'completed' | 'cancelled' | 'failed' | 'limited' }
);
export type ModelStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: 'demo_fixture'; arguments: { scenario: Scenario } }
  | { type: 'finish'; stopReason: 'stop' | 'toolUse' }
  | { type: 'error'; code: string; message: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; status?: 'running' | 'completed' | 'cancelled' | 'failed' | 'limited' | 'interrupted'; logs?: string[]; modelRequests?: number; toolCalls?: number; quiz?: Quiz; selectedOption?: string; revealed?: boolean; sources?: Source[]; error?: string; scenario?: Scenario };

export function isScenario(value: unknown): value is Scenario { return ['chat', 'quiz', 'slow', 'error'].includes(String(value)); }
export function validateQuiz(value: unknown): value is Quiz {
  if (!value || typeof value !== 'object') return false;
  const quiz = value as Quiz;
  if (typeof quiz.id !== 'string' || !quiz.id || typeof quiz.question !== 'string' || !quiz.question.trim() || !Array.isArray(quiz.options) || quiz.options.length < 2 || quiz.options.length > 6) return false;
  const ids = new Set<string>();
  for (const option of quiz.options) {
    if (!option || typeof option.id !== 'string' || !option.id || ids.has(option.id) || typeof option.text !== 'string' || !option.text.trim() || typeof option.explanation !== 'string' || !option.explanation.trim()) return false;
    ids.add(option.id);
  }
  return ids.has(quiz.correctOptionId) && quiz.origin === 'generated' && Array.isArray(quiz.sources);
}
export function parseModelEvent(value: unknown): ModelStreamEvent {
  if (!value || typeof value !== 'object') throw new Error('模型流事件格式错误');
  const event = value as Record<string, unknown>;
  if (event.type === 'start' && typeof event.requestId === 'string') return event as ModelStreamEvent;
  if (event.type === 'text_delta' && typeof event.delta === 'string') return event as ModelStreamEvent;
  if (event.type === 'finish' && ['stop', 'toolUse'].includes(String(event.stopReason))) return event as ModelStreamEvent;
  if (event.type === 'error' && typeof event.code === 'string' && typeof event.message === 'string') return event as ModelStreamEvent;
  if (event.type === 'tool_call' && typeof event.id === 'string' && event.name === 'demo_fixture' && event.arguments && typeof event.arguments === 'object' && isScenario((event.arguments as Record<string, unknown>).scenario)) return event as ModelStreamEvent;
  throw new Error('模型流包含未知或不完整的事件');
}
