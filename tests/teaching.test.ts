import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAgentAdapter } from '../src/agent/PiAgentAdapter.ts';
import { readSkill } from '../src/tools/skills.ts';
import { ContextSources } from '../src/tools/contextSources.ts';
import { quizTool } from '../src/tools/quiz.ts';
import { turnLearning } from '../src/agent/learning.ts';
import { teachingContent } from '../src/tools/teachingContent.generated.ts';
import type { AgentInput, AppSession, Document } from '../src/contracts/index.ts';
const config:AppSession={user:{id:'u',name:'u'},mode:'internal',modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-04',limit:100000,used:0}};
const input=(text='带我复习概率论'):AgentInput=>({sessionId:'study',turnId:'t1',action:{type:'send',text},history:[],state:{preferences:'',progress:''},documents:[],signal:new AbortController().signal});
function scripted(steps:any[]) {
 const payloads:any[]=[];
 const fetcher=(async(_url,init)=>{
  const body=JSON.parse(init!.body as string);payloads.push(body);
  const step=steps.shift();assert.ok(step,'unexpected model request');
  const events=[{type:'start',requestId:body.requestId},step,{type:'usage',usage:{input:1,output:1,total:2}},{type:'finish',stopReason:step.type==='tool_call'?'toolUse':'stop'}];
  return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
 }) as typeof fetch;
 return {fetcher,payloads};
}
const call=(name:string,args:any,id=crypto.randomUUID())=>({type:'tool_call',id,name,arguments:args});
const text=(delta='说明完成')=>({type:'text_delta',delta});
test('published skills are whitelisted, versioned and cached, each has a complete example',()=>{
 for(const name of ['concept','review','exam'] as const){
  const first=readSkill('study',name);assert.strictEqual(first,readSkill('study',name));
  assert.match(first.version,/^[a-f0-9]{12}$/);
  for(const term of ['适用','不适用','步骤','停止','资料不足','改口','输出','完整示例'])assert.ok(first.text.includes(term),name+term);
 }
 assert.throws(()=>readSkill('study','../../secret'));
 assert.throws(()=>readSkill('study','toString'));
 assert.ok(teachingContent.prompts.router.includes('简单'));
});
test('review teaches conditional probability for independent events too, with readable conditions',()=>{
 const {text}=readSkill('probability-review','review');
 assert.match(text,/独立与否.*(?:适用|定义)|(?:适用|定义).*独立与否/);
 assert.ok(text.includes('$P(B) > 0$'));
 assert.ok(text.includes('$P(A\\mid B) = P(A)$'));
 assert.ok(text.includes('$P(A\\cap B) = P(A)P(B)$'));
 assert.ok(!text.includes('P(A|B)'));
});

test('concept publishes a worked Bayes base-rate example with both positive paths',()=>{
 const {text}=readSkill('bayes-concept','concept');
 assert.match(text,/P\(D\).*0\.01/);
 assert.match(text,/P\(\+\\mid D\).*0\.99/);
 assert.match(text,/P\(\+\\mid \\neg D\).*0\.01/);
 assert.ok(text.includes('9900'));
 assert.ok(text.includes('99+99'));
 assert.ok(text.includes('\\dfrac{99}{198} = 50\\%'));
 assert.ok(text.includes('$P(+) > 0$'));
 assert.match(text,/先验|基础概率/);
});

test('base guidance distinguishes disjoint events from zero-probability overlap',()=>{
 const {style}=teachingContent.prompts;
 assert.ok(style.includes('$A\\cap B=\\varnothing$'));
 assert.ok(style.includes('$P(A\\cap B)=0$'));
 assert.match(style,/不能反推.*交集为空/);
 assert.ok(style.includes('$P(A\\cup B)=P(A)+P(B)-P(A\\cap B)$'));
});

test('read Skill and course state persist only after successful turn; scope waits',async()=>{
 const s=scripted([call('read_skill',{name:'review'}),call('update_learning_state',{course:'概率论',chapter:'',progress:'选择复习部分',phase:'scope'}),text('先选复习部分')]);
 const events=await Array.fromAsync(new PiAgentAdapter(config,s.fetcher).run(input()));
 const state=events.find(e=>e.type==='state_update');assert.ok(state?.type==='state_update');
 assert.equal(state.state.course,'概率论');assert.equal(state.state.skillVersions?.review,readSkill('study','review').version);
 assert.equal((events.at(-1) as any).status,'waiting');
 assert.ok(s.payloads[1].messages.at(-1).content.includes('系统复习'));
});
test('simple answer performs zero tool calls and no material tools are declared without docs',async()=>{
 const s=scripted([text('机会成本是放弃的最佳替代方案收益。')]);
 const events=await Array.fromAsync(new PiAgentAdapter(config,s.fetcher).run(input('机会成本是什么？')));
 assert.equal(s.payloads.length,1);
 assert.equal(events.filter(e=>e.type==='tool_status'&&e.category==='tool').length,0);
 assert.ok(!s.payloads[0].tools.some((t:any)=>t.function.name==='search_context'));
});
test('latest no-quiz preference removes tool and one-turn preference does not persist',async()=>{
 const temporary=turnLearning(input('这次别出题，简单讲'));
 assert.equal(temporary.quizPolicy,'avoid');assert.equal(temporary.state.quizPolicy,undefined);
 const persistent=turnLearning(input('以后别出题'));
 assert.equal(persistent.state.quizPolicy,'avoid');
 const next=turnLearning({...input('继续'),state:persistent.state});assert.equal(next.quizPolicy,'avoid');
 const allow=turnLearning({...input('现在可以出题'),state:persistent.state});assert.equal(allow.quizPolicy,'allow');
 const s=scripted([text('本轮只讲解')]);await Array.fromAsync(new PiAgentAdapter(config,s.fetcher).run(input('这次别出题')));
 assert.ok(!s.payloads[0].tools.some((t:any)=>t.function.name==='present_quiz'));
});
test('two malformed quiz attempts count toward limit then fall back to explanation',async()=>{
 const s=scripted([call('present_quiz',{question:'bad'}),call('present_quiz',{question:'still bad'}),text('题目未能生成有效题板，先解释原理。')]);
 const events=await Array.fromAsync(new PiAgentAdapter(config,s.fetcher).run(input('考考我')));
 assert.equal(events.filter(e=>e.type==='quiz_ready').length,0);
 assert.equal(events.filter(e=>e.type==='tool_status'&&e.status==='started'&&e.category==='tool').length,2);
 assert.ok(!s.payloads[2].tools.some((t:any)=>t.function.name==='present_quiz'));
 assert.ok(s.payloads[2].messages[0].content.includes('失败两次'));
 assert.equal((events.at(-1) as any).status,'completed');
});
test('six tools including invalid schema attempts exhaust allowance; final answer has no tools',async()=>{
 const s=scripted([...Array.from({length:6},()=>call('read_skill',{name:'invalid'})),text('无法读取该教学方法。')]);
 const events=await Array.fromAsync(new PiAgentAdapter(config,s.fetcher).run(input()));
 assert.equal(s.payloads.length,7);assert.equal(s.payloads[6].tools.length,0);
 assert.equal(events.filter(e=>e.type==='tool_status'&&e.status==='started'&&e.category==='tool').length,6);
});
const doc:Document={id:'d1',title:'概率论讲义',kind:'past_paper',warnings:[],chunks:[{documentId:'d1',chunkId:'c1',title:'概率论讲义',location:'第 2 页',page:2,text:'概率题：互斥事件并集如何计算？选项一：概率相加。选项二：概率相乘。'}]};
test('sources resolve only searched selected blocks and retain authoritative locations',()=>{
 const context=new ContextSources([doc]);
 assert.throws(()=>context.resolve([{documentId:'d1',chunkId:'c1'}]));
 const found=context.search('概率');assert.equal(found[0].page,2);
 assert.equal(context.resolve([{documentId:'d1',chunkId:'c1'}])[0].location,'第 2 页');
 assert.throws(()=>context.resolve([{documentId:'secret',chunkId:'c1'}]));
 assert.throws(()=>context.search('概率',['secret']));
});
test('past-paper claims need exact question and options in a declared past-paper source',async()=>{
 const context=new ContextSources([doc]);context.search('概率');let rendered:any;
 const tool=quizTool(q=>{rendered=q;},context);
 const p={question:'互斥事件并集如何计算？',options:[{id:'A',text:'概率相加',explanation:'互斥事件概率可相加'},{id:'B',text:'概率相乘',explanation:'这不是并集公式'}],correctOptionId:'A',origin:'past_paper',sourceRefs:[{documentId:'d1',chunkId:'c1'}]};
 await tool.execute('1',p);assert.equal(rendered.sources[0].page,2);
 await assert.rejects(()=>tool.execute('2',{...p,question:'伪造原题'}));
 await assert.rejects(()=>tool.execute('3',{...p,sourceRefs:[]}));
});
test('cancelled teaching turn does not persist staged progress',async()=>{
 const controller=new AbortController();
 const s=scripted([call('update_learning_state',{course:'未完成',progress:'讲到一半'}),text()]);
 const run=new PiAgentAdapter(config,s.fetcher).run({...input(),signal:controller.signal});
 const events=[];for await(const e of run){events.push(e);if(e.type==='tool_status'&&e.status==='completed')controller.abort();}
 assert.equal(events.filter(e=>e.type==='state_update').length,0);
 assert.equal((events.at(-1) as any).status,'cancelled');
});
test('exam one-shot produces a valid quiz payload',async()=>{
 const match=teachingContent.skills.exam.text.match(/present_quiz\((\{[^\n]+\})\)/);
 assert.ok(match);let rendered:any;
 await quizTool(q=>{rendered=q;}).execute('example',JSON.parse(match[1]));
 assert.equal(rendered.origin,'generated');assert.equal(rendered.options.length,2);
});
