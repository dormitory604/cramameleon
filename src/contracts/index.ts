export const CONTRACT_VERSION = 'app.v1' as const;
export type Source = { documentId: string; chunkId: string; title: string; text: string; location: string; page?: number; slide?: number; url?: string };
export type Quiz = { id: string; question: string; options: { id: string; text: string; explanation: string }[]; correctOptionId: string; origin: 'generated' | 'adapted' | 'past_paper'; sources: Source[] };
export type RunStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'limited' | 'interrupted' | 'waiting';
export type SkillName = 'concept' | 'review' | 'exam';
export const TOOL_NAMES = ['present_quiz', 'read_skill', 'update_learning_state', 'search_context', 'cite_sources'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export const isToolName = (name: unknown): name is ToolName => typeof name === 'string' && (TOOL_NAMES as readonly string[]).includes(name);
export type LearningState = { preferences: string; progress: string; course?: string; chapter?: string; phase?: 'scope' | 'learning' | 'practice'; skill?: SkillName; skillVersions?: Partial<Record<SkillName, string>>; instructions?: string[]; quizPolicy?: 'allow' | 'avoid' };
export type ChatMessage = { id: string; conversationId: string; createdAt: number; role: 'user' | 'assistant'; text: string; status?: RunStatus; logs?: string[]; modelRequests?: number; toolCalls?: number; quiz?: Quiz; selectedOption?: string; revealed?: boolean; sources?: Source[]; error?: string; errorCode?: string; replyTo?: string;
  // Material ids selected when this turn was submitted (#6); undefined on records saved before turn scopes existed.
  selectedMaterialIds?: string[] };
export type HistoryMessage = { role: 'user' | 'assistant'; text: string };
export type MaterialCandidate = { id: string; title: string; kind: 'material' | 'package'; url?: string };
export type Document = { id: string; title: string; chunks: Source[]; warnings: string[]; kind?: 'material' | 'past_paper'; format?: string; size?: number; importedAt?: number; fingerprint?: string; origin?: 'local' };
export type MaterialScope = { documents: Document[]; selectedIds: string[] };
export type ArchiveEntry = { name: string; size: number; supported: boolean };
export type ImportResult = { documents: Document[]; warnings: string[] };
export type AgentAction = { type: 'send'; text: string } | { type: 'retry'; text: string; userMessageId: string } | { type: 'continue' } | { type: 'next_question' } | { type: 'confirm_materials'; ids: string[] };
export type AgentInput = { sessionId: string; turnId: string; action: AgentAction; history: HistoryMessage[]; documents: Document[]; state: LearningState; signal: AbortSignal };
export type AppSession = { user: { id: string; name: string }; mode: 'internal'; modelReady: boolean; model: string; limits: { maxToolCalls: number; timeoutSeconds: number; maxOutputTokens: number }; budget: { day: string; limit: number; used: number } };
export type ModelUsage = { input: number; output: number; total: number };
type Envelope = { sessionId: string; turnId: string };
export type AgentEvent = Envelope & (
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_status'; category: 'model' | 'tool'; status: 'started' | 'completed'; message: string }
  | { type: 'quiz_ready'; quiz: Quiz }
  | { type: 'sources_ready'; sources: Source[] }
  | { type: 'materials_ready'; materials: MaterialCandidate[] }
  | { type: 'document_ready'; document: Document }
  | { type: 'state_update'; state: LearningState }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; status: Exclude<RunStatus, 'running' | 'interrupted'> }
);
export interface AgentRunner { run(input: AgentInput): AsyncGenerator<AgentEvent> }
export type ModelStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: ToolName; arguments: Record<string, unknown> }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'finish'; stopReason: 'stop' | 'toolUse' | 'length' }
  | { type: 'error'; code: string; message: string };
export class AppError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function validSource(value: unknown): value is Source {
  if (!value || typeof value !== 'object') return false;
  const s = value as Source;
  return ['documentId', 'chunkId', 'title', 'text', 'location'].every(k => typeof s[k as keyof Source] === 'string') && !!s.documentId && !!s.chunkId
    && (s.page === undefined || Number.isInteger(s.page) && s.page > 0) && (s.slide === undefined || Number.isInteger(s.slide) && s.slide > 0)
    && (s.url === undefined || typeof s.url === 'string' && /^https?:\/\//.test(s.url));
}
export function validateQuiz(value: unknown): value is Quiz {
  if (!value || typeof value !== 'object') return false;
  const q = value as Quiz;
  if (typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) return false;
  const ids = new Set<string>();
  for (const o of q.options) {
    if (!o || typeof o.id !== 'string' || !o.id || ids.has(o.id) || typeof o.text !== 'string' || !o.text.trim() || typeof o.explanation !== 'string' || !o.explanation.trim()) return false;
    ids.add(o.id);
  }
  return ids.has(q.correctOptionId) && ['generated', 'adapted', 'past_paper'].includes(q.origin) && Array.isArray(q.sources) && q.sources.every(validSource) && (q.origin === 'generated' || q.sources.length > 0);
}
export function parseModelEvent(value: unknown): ModelStreamEvent {
  if (!value || typeof value !== 'object') throw new AppError('MODEL_PROTOCOL', '模型流事件格式错误');
  const e = value as Record<string, any>;
  if (e.type === 'start' && typeof e.requestId === 'string') return e as ModelStreamEvent;
  if (e.type === 'text_delta' && typeof e.delta === 'string') return e as ModelStreamEvent;
  if (e.type === 'finish' && ['stop', 'toolUse', 'length'].includes(e.stopReason)) return e as ModelStreamEvent;
  if (e.type === 'error' && typeof e.code === 'string' && typeof e.message === 'string') return e as ModelStreamEvent;
  if (e.type === 'usage' && e.usage && ['input', 'output', 'total'].every(k => Number.isSafeInteger(e.usage[k]) && e.usage[k] >= 0) && e.usage.total === e.usage.input + e.usage.output) return e as ModelStreamEvent;
  if (e.type === 'tool_call' && typeof e.id === 'string' && e.id && isToolName(e.name) && e.arguments && typeof e.arguments === 'object' && !Array.isArray(e.arguments)) return e as ModelStreamEvent;
  throw new AppError('MODEL_PROTOCOL', '模型流包含未知或不完整的事件');
}
