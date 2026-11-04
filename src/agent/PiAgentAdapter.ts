import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { AgentEvent, AgentInput, Scenario } from '../contracts/index.ts';
import { validateQuiz } from '../contracts/index.ts';
import { demoFixture } from '../tools/demoFixture.ts';
import { createDemoStream } from './modelStream.ts';

const model = { id: 'cram-demo-fixture', name: 'Cramameleon Demo Fixture', api: 'cram-demo', provider: 'demo', baseUrl: '/api/model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 } as Model<any>;
type EventPayload<T> = T extends unknown ? Omit<T, 'sessionId' | 'turnId'> : never;

export class PiAgentAdapter {
  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let settled = false;
    let limited = false;
    let failed: string | undefined;
    let toolCalls = 0;
    const emit = (event: EventPayload<AgentEvent>) => {
      if (input.signal.aborted && event.type !== 'done') return;
      queue.push({ ...event, sessionId: input.sessionId, turnId: input.turnId } as AgentEvent);
      wake?.(); wake = undefined;
    };
    const tool: AgentTool<any> = { name: 'demo_fixture', label: '演示资料工具', description: '返回明确标记的虚构资料与可选题板，用于内部工程联调。', parameters: { type: 'object', properties: { scenario: { type: 'string', enum: ['chat', 'quiz', 'slow', 'error'] } }, required: ['scenario'], additionalProperties: false }, executionMode: 'sequential', execute: async (_id, params, signal) => {
      if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await demoFixture((params as { scenario: Scenario }).scenario, signal);
      return { content: [{ type: 'text' as const, text: '模拟工具执行成功；未读取真实资料。' }], details: result };
    } };
    const agent = new Agent({ initialState: { systemPrompt: 'You are an internal mock-only transport demonstration. Use only the registered demo_fixture tool.', model, tools: [tool] }, toolExecution: 'sequential', streamFn: createDemoStream(input, () => emit({ type: 'tool_status', category: 'model', status: 'started', message: 'Go 模拟模型响应中' })), beforeToolCall: async () => {
      if (input.signal.aborted || limited || ++toolCalls > 6) { limited = !input.signal.aborted; return { block: true, reason: '已停止或达到工具调用上限', terminate: true }; }
      return undefined;
    }, finishTurn: () => limited || input.signal.aborted ? { action: 'end' } : undefined });
    const unsubscribe = agent.subscribe(event => {
      if (input.signal.aborted || limited) return;
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') emit({ type: 'text_delta', delta: event.assistantMessageEvent.delta });
      if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') failed = event.message.errorMessage || '模拟模型响应失败';
      if (event.type === 'tool_execution_start') emit({ type: 'tool_status', category: 'tool', status: 'started', message: 'Pi 正在执行 demo_fixture' });
      if (event.type === 'tool_execution_end') {
        if (event.isError) { failed = '假工具执行失败'; return; }
        emit({ type: 'tool_status', category: 'tool', status: 'completed', message: '假工具已完成，结果将返回模型' });
        const details = event.result.details as Awaited<ReturnType<typeof demoFixture>>;
        if (details?.sources) emit({ type: 'sources_ready', sources: details.sources });
        if (details?.quiz) { if (validateQuiz(details.quiz)) emit({ type: 'quiz_ready', quiz: details.quiz }); else failed = '题板数据未通过校验'; }
      }
    });
    const abort = () => agent.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { limited = true; agent.abort(); }, 120000);
    const completion = (async () => {
      try { if (!input.signal.aborted) await agent.prompt(input.text); }
      catch (error) { if (!input.signal.aborted && !limited) failed = error instanceof Error ? error.message : 'Agent 运行失败'; }
      finally {
        clearTimeout(timeout); input.signal.removeEventListener('abort', abort); unsubscribe();
        if (failed && !input.signal.aborted && !limited) emit({ type: 'error', code: 'DEMO_RUN_FAILED', message: failed });
        emit({ type: 'done', status: input.signal.aborted ? 'cancelled' : limited ? 'limited' : failed ? 'failed' : 'completed' });
        settled = true; wake?.(); wake = undefined;
      }
    })();
    try {
      while (!settled || queue.length) {
        const next = queue.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally { agent.abort(); await completion; }
    // TODO(agent): Load real teaching Skills, selected materials and contextual state.
  }
}
