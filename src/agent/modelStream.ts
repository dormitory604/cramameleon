import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { CONTRACT_VERSION, parseModelEvent } from '../contracts/index.ts';
import type { AgentInput } from '../contracts/index.ts';

export function createDemoStream(input: AgentInput, requestStarted: () => void) {
  return (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'pending', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    void (async () => {
      let sawFinish = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (options?.signal?.aborted || input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        requestStarted();
        // TODO(model): Real upstream proxy will preserve this transport boundary.
        const response = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: options?.signal, body: JSON.stringify({ contractVersion: CONTRACT_VERSION, requestId: crypto.randomUUID(), turnId: input.turnId, scenario: input.scenario, messages: context.messages }) });
        if (!response.ok) {
          const error = await response.json().catch(() => null);
          throw new Error(error?.error?.message || `HTTP ${response.status}`);
        }
        if (!response.body) throw new Error('模型流为空');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        stream.push({ type: 'start', partial: message });
        const consume = (line: string) => {
          if (!line.startsWith('data:')) return;
          const event = parseModelEvent(JSON.parse(line.slice(5).trim()));
          if (sawFinish) throw new Error('模型终止后仍有数据');
          if (event.type === 'text_delta') {
            let index = message.content.findIndex(block => block.type === 'text');
            if (index < 0) { index = message.content.length; message.content.push({ type: 'text', text: '' }); stream.push({ type: 'text_start', contentIndex: index, partial: message }); }
            const block = message.content[index];
            if (block.type === 'text') block.text += event.delta;
            stream.push({ type: 'text_delta', delta: event.delta, contentIndex: index, partial: message });
          } else if (event.type === 'tool_call') {
            const toolCall = { type: 'toolCall' as const, id: event.id, name: event.name, arguments: event.arguments };
            message.content.push(toolCall);
            stream.push({ type: 'toolcall_end', contentIndex: message.content.length - 1, toolCall, partial: message });
          } else if (event.type === 'error') {
            throw new Error(event.message);
          } else if (event.type === 'finish') {
            sawFinish = true;
            message.stopReason = event.stopReason;
            stream.push({ type: 'done', reason: event.stopReason, message });
          }
        };
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let split: number;
          while ((split = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, split).replace(/\r$/, '')); pending = pending.slice(split + 1); }
          if (pending.length > 65536) throw new Error('模型流分片超限');
        }
        pending += decoder.decode();
        if (pending.trim()) consume(pending);
        if (!sawFinish) throw new Error('模型连接提前关闭，未收到结束事件');
      } catch (error) {
        if (!sawFinish) {
          const aborted = options?.signal?.aborted || input.signal.aborted;
          message.stopReason = aborted ? 'aborted' : 'error';
          message.errorMessage = error instanceof Error ? error.message : '模型请求失败';
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        }
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
        stream.end();
      }
    })();
    return stream;
  };
}
