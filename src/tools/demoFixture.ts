import type { Quiz, Scenario, Source } from '../contracts/index.ts';

export const DEMO_SOURCE: Source = { documentId: 'demo-architecture', chunkId: 'demo-block-01', title: 'Demo 架构说明 · 模拟资料', location: '示例块 01', text: '这是一份用于工程联调的虚构资料。浏览器中的 Pi Core 负责执行假工具；Go 后端只返回预设的模型协议数据，不执行 Agent 循环。' };
export function makeDemoQuiz(): Quiz {
  return { id: crypto.randomUUID(), question: '在这个 Demo 中，谁实际执行了假工具？', correctOptionId: 'A', origin: 'generated', sources: [DEMO_SOURCE], options: [
    { id: 'A', text: '浏览器中的 Pi Core', explanation: '正确。Pi 收到工具调用后，在浏览器内执行已注册的 demo_fixture。' },
    { id: 'B', text: 'Go 模拟模型接口', explanation: 'Go 只返回预设模型流和工具调用数据，并不执行工具。' },
    { id: 'C', text: '旧站服务器', explanation: '这个 Demo 没有连接旧站，也没有读取真实课程资料。' },
    { id: 'D', text: 'DeepSeek 官方模型', explanation: '这个 Demo 没有配置模型密钥，响应来自本地模拟接口。' },
  ] };
}
export async function demoFixture(scenario: Scenario, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 500);
    signal?.addEventListener('abort', abort, { once: true });
  });
  // TODO(materials): Replace fixture tools with scoped search/read/parse/Skill adapters.
  return { sources: [DEMO_SOURCE], quiz: scenario === 'quiz' ? makeDemoQuiz() : undefined };
}
