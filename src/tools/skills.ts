import type { SkillName } from '../contracts/index.ts';
import { teachingContent } from './teachingContent.generated.ts';
export const baseTeachingPrompt = teachingContent.prompts.router + '\n\n' + teachingContent.prompts.style;
export function isSkillName(name: unknown): name is SkillName { return name === 'concept' || name === 'review' || name === 'exam'; }
const sessions = new Map<string, Map<string, typeof teachingContent.skills[SkillName]>>();
export function readSkill(sessionId: string, name: unknown) {
 if (!isSkillName(name)) throw new Error('Skill 不在白名单中，只允许 concept、review、exam');
 let cache = sessions.get(sessionId);
 if (!cache) {
  if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
  cache = new Map(); sessions.set(sessionId, cache);
 }
 const skill = teachingContent.skills[name];
 const key = name+':'+skill.version;
 if (!cache.has(key)) cache.set(key, skill);
 return cache.get(key)!;
}
