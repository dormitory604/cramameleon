import type { AgentInput, LearningState } from '../contracts/index.ts';
import { actionText } from './context.ts';
export function normalizeState(value: LearningState): LearningState {
 return { ...value, preferences: typeof value.preferences === 'string' ? value.preferences.slice(0,2000) : '', progress: typeof value.progress === 'string' ? value.progress.slice(0,500) : '', instructions: Array.isArray(value.instructions) ? value.instructions.filter(v=>typeof v==='string').slice(-8) : [], skillVersions: {...value.skillVersions} };
}
// This is preference enforcement, not intent routing. Skill choice remains a model decision.
export function turnLearning(input: AgentInput) {
 const state = normalizeState(input.state);
 const text = actionText(input.action);
 const oneTurn = /本次|这次|这一轮|这一题|这轮|本轮/.test(text);
 const avoid = /(?:别|不要|不用|不想|停止|不再|不)[^。！？\n]{0,5}(?:出题|考我|练习|做题|考试)|只(?:要|讲|说|解释)[^。！？\n]{0,5}(?:结论|答案|讲解)/.test(text);
 const allow = !avoid && /(?:可以|允许|开始|来|给我|请|再|恢复)[^。！？\n]{0,8}(?:出题|考我|练习|做题|考试)|考考我|下一题|模拟考/.test(text);
 let quizPolicy = state.quizPolicy ?? (/别出题|不出题|不要出题/.test(state.preferences) ? 'avoid' : 'allow');
 if (avoid) quizPolicy = 'avoid'; else if (allow || input.action.type === 'next_question') quizPolicy = 'allow';
 if (!oneTurn && (avoid || allow || input.action.type === 'next_question')) state.quizPolicy = quizPolicy;
 if (!oneTurn && allow) state.instructions = state.instructions?.filter(v => !/别出题|不要出题|不出题/.test(v));
 // Persist unambiguous user requests even if the model needs no state tool.
 if (!oneTurn && /简单点|简短|只说结论|直接告诉.*答案|别出题|不要出题/.test(text) && text.length <= 200) state.instructions = [...new Set([...(state.instructions ?? []),text])].slice(-8);
 return { state, quizPolicy, oneTurn, text };
}
