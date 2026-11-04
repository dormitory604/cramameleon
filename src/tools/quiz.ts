import type { AgentTool } from '@earendil-works/pi-agent-core';
import { validateQuiz } from '../contracts/index.ts';
import type { Quiz } from '../contracts/index.ts';
export function quizTool(onQuiz: (quiz: Quiz) => void): AgentTool<any> {
  return { name: 'present_quiz', label: '展示练习题', description: '用户要求练习时提交一道自编单选题。必须提供正确答案和所有选项解释；不要在聊天文字中提前公布答案。当前工具不支持声称真题或引用未读取资料。',
    parameters: { type: 'object', properties: {
      question: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, explanation: { type: 'string' } }, required: ['id', 'text', 'explanation'], additionalProperties: false } }, correctOptionId: { type: 'string' }
    }, required: ['question', 'options', 'correctOptionId'], additionalProperties: false },
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      const quiz = { ...params, id: crypto.randomUUID(), origin: 'generated', sources: [] };
      if (!validateQuiz(quiz)) throw new Error('题目校验失败，请修复唯一选项 ID、正确答案和全部选项解释。');
      onQuiz(quiz);
      return { content: [{ type: 'text', text: '题目已经展示，等待用户作答。不要再次输出答案，不要继续出题。' }], details: quiz };
    } };
}
