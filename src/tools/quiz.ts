import type { AgentTool } from '@earendil-works/pi-agent-core';
import { validateQuiz } from '../contracts/index.ts';
import type { Quiz } from '../contracts/index.ts';
import { ContextSources } from './contextSources.ts';
export const sourceRefSchema = { type:'array',maxItems:6,items:{type:'object',properties:{documentId:{type:'string'},chunkId:{type:'string'}},required:['documentId','chunkId'],additionalProperties:false} };
export function quizTool(onQuiz: (quiz: Quiz) => void, context = new ContextSources([])): AgentTool<any> {
 return { name:'present_quiz',label:'准备练习题',description:'展示一道单选题。答案和每个选项解释必须完整。origin=generated/adapted/past_paper；来源只用本轮 search_context 或 read_context 返回的块 ID，不传入自编页码。真题必须与明确标记真题的资料原文一致。',
 parameters:{type:'object',properties:{
  question:{type:'string',minLength:1,maxLength:3000},options:{type:'array',minItems:2,maxItems:6,items:{type:'object',properties:{id:{type:'string',maxLength:8},text:{type:'string',maxLength:2000},explanation:{type:'string',maxLength:3000}},required:['id','text','explanation'],additionalProperties:false}},
  correctOptionId:{type:'string'},origin:{type:'string',enum:['generated','adapted','past_paper']},sourceRefs:sourceRefSchema
 },required:['question','options','correctOptionId'],additionalProperties:false},
 execute:async(_id,params,signal)=>{
  signal?.throwIfAborted();
  const sources=context.resolve(params.sourceRefs ?? []);
  const quiz={id:crypto.randomUUID(),question:params.question,options:params.options,correctOptionId:params.correctOptionId,origin:params.origin ?? 'generated',sources};
  if(!validateQuiz(quiz)) throw new Error('题目无效：检查唯一选项 ID、正确答案、全部解释，以及改编/真题的真实来源。最多修复一次，再失败请用文字讲解。');
  if(quiz.origin==='past_paper'&&!context.verifyPastPaper(sources,quiz.question,quiz.options)) throw new Error('无法在已读真题原文核对题干和全部选项；请使用 adapted 或 generated，不能假称真题。');
  onQuiz(quiz);
  return {content:[{type:'text',text:'题板已展示，等待用户作答。不要再次输出题目或正确答案；只需简短提示作答。'}],details:quiz};
 }};
}
