import type { JsonObject } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { MAX_QUIZZES_PER_BATCH, validateQuiz } from '../contracts/index.ts';
import type { Quiz, Source } from '../contracts/index.ts';
import { ContextSources } from './contextSources.ts';

export const sourceRefSchema = { type:'array',maxItems:6,items:{type:'object',properties:{documentId:{type:'string'},chunkId:{type:'string'}},required:['documentId','chunkId'],additionalProperties:false} };
const questionSchema = {type:'object',properties:{
  question:{type:'string',minLength:1,maxLength:3000},options:{type:'array',minItems:2,maxItems:6,items:{type:'object',properties:{id:{type:'string',maxLength:8},text:{type:'string',maxLength:2000},explanation:{type:'string',maxLength:3000}},required:['id','text','explanation'],additionalProperties:false}},
  correctOptionId:{type:'string'},origin:{type:'string',enum:['generated','adapted','past_paper']},sourceRefs:sourceRefSchema,
},required:['question','options','correctOptionId'],additionalProperties:false} as const;

export function quizTool(onQuiz: (quiz: Quiz) => void, context = new ContextSources([]), verifyRemote?: (question: string, options: {text:string}[], sources: Source[], signal?: AbortSignal) => Promise<boolean>) {
  const staged = new Map<number, { id: string; args: string; error?: string }>();
  async function prepare(params: unknown, signal?: AbortSignal): Promise<string | undefined> {
    try {
      signal?.throwIfAborted();
      const args = validateToolArguments({ ...tool, parameters: questionSchema }, { type:'toolCall', id:'quiz', name:tool.name, arguments:params as JsonObject });
      const sources = context.resolve(args.sourceRefs ?? []);
      const quiz = { id:crypto.randomUUID(), question:args.question, options:args.options, correctOptionId:args.correctOptionId, origin:args.origin ?? 'generated', sources };
      if (!validateQuiz(quiz)) throw new Error('题目无效：检查唯一选项 ID、正确答案、全部解释，以及改编/真题的真实来源。');
      if (quiz.origin === 'past_paper' && !context.verifyPastPaper(sources,quiz.question,quiz.options) && !(await verifyRemote?.(quiz.question,quiz.options,sources,signal))) {
        throw new Error('无法在已读真题原文核对题干和全部选项，请重新核对来源。');
      }
      signal?.throwIfAborted();
      onQuiz(quiz);
    } catch (error) {
      signal?.throwIfAborted();
      return error instanceof Error ? error.message.split('\nReceived arguments:')[0] : '题目校验未通过';
    }
  }

  const tool: AgentTool<any> = {
    name:'present_quiz',label:'准备练习题',
    description:'一次展示一批单选题。把一题或多题按展示顺序放入 quizzes；每题的正确答案及全部选项解释必须完整。来源只用本轮实际已读块 ID；真题须匹配原文。',
    parameters:{type:'object',properties:{
      ...questionSchema.properties,
      quizzes:{type:'array',minItems:1,maxItems:MAX_QUIZZES_PER_BATCH,items:{type:'object',description:'每题含 question、options（每项含 id、text、explanation）、correctOptionId，可选 origin、sourceRefs。逐题校验。'}},
    },additionalProperties:false},
    execute:async(id,params,signal)=>{
      const questions = params.quizzes === undefined ? [params] : params.quizzes;
      if (!Array.isArray(questions) || !questions.length || questions.length > MAX_QUIZZES_PER_BATCH) throw new Error('请提交 1–10 道单选题。');
      if (staged.size > questions.length) throw new Error('题目流与最终载荷不一致。');
      const errors: string[] = [];
      for (const [index, question] of questions.entries()) {
        const cached = staged.get(index);
        if (cached && (cached.id !== id || cached.args !== JSON.stringify(question))) throw new Error('题目流与最终载荷不一致。');
        const error = cached ? cached.error : await prepare(question, signal);
        if (error) errors.push(`第 ${index+1} 题：${error}`);
      }
      if (errors.length === questions.length) throw new Error(errors.join('\n'));
      return {content:[{type:'text',text:errors.length
        ? `已展示 ${questions.length-errors.length} 道题。只修复未通过的题一次，勿重复已展示的题。\n${errors.join('\n')}`
        : `已展示 ${questions.length} 道题。请简短提示用户作答，正文不要重复题面或揭示答案。` }], details:{ batch:params.quizzes !== undefined, rejected:errors.length }};
    },
  };
  return {
    ...tool,
    reset: () => staged.clear(),
    stage: async (id: string, index: number, args: Record<string, unknown>, signal?: AbortSignal) => {
      if (index !== staged.size) return;
      staged.set(index, { id, args:JSON.stringify(args), error:await prepare(args, signal) });
    },
  };
}
