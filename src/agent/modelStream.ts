import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, JsonObject, Message, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { AppError, CONTRACT_VERSION, parseModelEvent } from '../contracts/index.ts';
import type { AgentInput, ModelStreamEvent, ModelUsage } from '../contracts/index.ts';
export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function wireContext(messages: Message[]) {
  const tools = new Map<string, { type: string; function: { name: string; description: string; parameters: object } }>();
  const system: string[] = [];
  const history: object[] = [];
  const text = (value: string | { type: string; text?: string }[]) => typeof value === 'string' ? value : value.filter(v => v.type === 'text').map(v => v.text ?? '').join('\n');
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(text(m.content), ...Object.values(m.sections ?? {}).filter((s): s is string => s !== null));
      for (const t of m.toolsAdded ?? []) tools.set(t.name, { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } });
      for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    } else if (m.role === 'user') history.push({ role: 'user', content: text(m.content) });
    else if (m.role === 'toolResult') history.push({ role: 'tool', tool_call_id: m.toolCallId, content: text(m.content) });
    else {
      const calls = m.content.filter(b => b.type === 'toolCall').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.arguments) } }));
      history.push({ role: 'assistant', content: text(m.content), ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return { messages: [{ role: 'system', content: system.join('\n\n') }, ...history], tools: [...tools.values()] };
}
export function createModelStream(input: AgentInput, callbacks: { started: () => void; usage: (u: ModelUsage) => void; error: (e: AppError) => void; quizCandidate?: (event: Extract<ModelStreamEvent, { type:'quiz_candidate' }>, signal: AbortSignal) => Promise<void>; policy?: () => { disabled: string[]; instruction: string } }, fetcher: typeof fetch = fetch, userId = '') {
  return (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'pending', timestamp: Date.now(), usage: emptyUsage() };
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let finish: 'stop' | 'toolUse' | 'length' | undefined;
      let started = false;
      const requestId = crypto.randomUUID();
      try {
        input.signal.throwIfAborted(); options?.signal?.throwIfAborted(); callbacks.started();
        const wire = wireContext(context.messages);
        const policy = callbacks.policy?.();
        if (policy) {
          wire.tools = wire.tools.filter(t => !policy.disabled.includes(t.function.name));
          (wire.messages[0] as { content: string }).content += '\n本轮执行约束：' + policy.instruction;
        }
        const response = await fetcher('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cram-User': userId }, credentials: 'same-origin', signal: options?.signal ?? input.signal,
          body: JSON.stringify({ contractVersion: CONTRACT_VERSION, requestId, turnId: input.turnId, sessionId: input.sessionId, ...wire }) });
        if (!response.ok) {
          const value = await response.json().catch(() => null);
          throw new AppError(value?.error?.code ?? 'NETWORK_ERROR', value?.error?.message ?? '模型服务请求失败');
        }
        if (!response.body) throw new AppError('MODEL_PROTOCOL', '模型流为空');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        stream.push({ type: 'start', partial: message });
        const consume = async (line: string) => {
          if (!line.startsWith('data:')) return;
          if (finish) throw new AppError('MODEL_PROTOCOL', '模型终止后仍有数据');
          const event = parseModelEvent(JSON.parse(line.slice(5).trim()));
          if (event.type === 'start') {
            if (started || event.requestId !== requestId) throw new AppError('MODEL_PROTOCOL', '模型请求 ID 不匹配');
            started = true; return;
          }
          if (!started) throw new AppError('MODEL_PROTOCOL', '模型缺少开始事件');
          if (event.type === 'text_delta') {
            let index = message.content.findIndex(b => b.type === 'text');
            if (index < 0) { index = message.content.length; message.content.push({ type: 'text', text: '' }); stream.push({ type: 'text_start', contentIndex: index, partial: message }); }
            const b = message.content[index]; if (b.type === 'text') b.text += event.delta;
            stream.push({ type: 'text_delta', delta: event.delta, contentIndex: index, partial: message });
          } else if (event.type === 'quiz_candidate') {
            if (!policy?.disabled.includes('present_quiz')) await callbacks.quizCandidate?.(event, options?.signal ?? input.signal);
          } else if (event.type === 'tool_call') {
            const toolCall = { type: 'toolCall' as const, id: event.id, name: event.name, arguments: event.arguments as JsonObject };
            message.content.push(toolCall);
            stream.push({ type: 'toolcall_end', contentIndex: message.content.length - 1, toolCall, partial: message });
          } else if (event.type === 'usage') {
            message.usage = { ...emptyUsage(), input: event.usage.input, output: event.usage.output, totalTokens: event.usage.total };
            callbacks.usage(event.usage);
          } else if (event.type === 'error') throw new AppError(event.code, event.message);
          else if (event.type === 'finish') finish = event.stopReason;
        };
        while (true) {
          // A native read failure after a valid start means the reply was cut off mid-transfer, not that the request never connected.
          const { done, value } = await reader.read().catch((error: unknown) => {
            if (started && !(error instanceof AppError)) throw new AppError('MODEL_STREAM_INTERRUPTED', '回答传输中断，已保留收到的内容，请手动重试');
            throw error;
          });
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let split: number;
          while ((split = pending.indexOf('\n')) >= 0) { await consume(pending.slice(0, split).replace(/\r$/, '')); pending = pending.slice(split + 1); }
          if (pending.length > 262144) throw new AppError('MODEL_PROTOCOL', '模型流分片过长');
        }
        pending += decoder.decode(); if (pending.trim()) await consume(pending);
        if (!finish) throw new AppError('MODEL_STREAM_INTERRUPTED', '模型连接提前关闭，请手动重试');
        if (finish === 'length') throw new AppError('MODEL_OUTPUT_LIMIT', '回答达到输出上限，已保留收到的内容。可缩小问题后重试。');
        message.stopReason = finish;
        stream.push({ type: 'done', reason: finish, message });
      } catch (error) {
        const aborted = options?.signal?.aborted || input.signal.aborted;
        const appError = error instanceof AppError ? error : new AppError('NETWORK_ERROR', error instanceof Error ? error.message : '模型连接失败');
        if (!aborted) callbacks.error(appError);
        message.stopReason = aborted ? 'aborted' : 'error'; message.errorMessage = appError.message;
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); stream.end(); }
    })();
    return stream;
  };
}
