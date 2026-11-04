import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAgentAdapter } from '../src/agent/PiAgentAdapter.ts';
import type { AgentInput, AppSession } from '../src/contracts/index.ts';
const config: AppSession = { user: { id: 'u', name: 'u' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
const input = (): AgentInput => ({ sessionId: 'chat-a', turnId: 'turn-a', action: { type: 'send', text: '考考我' }, history: [{ role: 'user', text: '我的课程是概率论' },{ role: 'assistant', text: '好的' }], state: { preferences: '简短', progress: '' }, documents: [], signal: new AbortController().signal });
const quiz = { question: '1+1?', options: [{ id:'A',text:'2',explanation:'1+1=2' },{ id:'B',text:'3',explanation:'不等于3' }], correctOptionId:'A' };
test('real Pi loop forwards system/history/tools, executes quiz then submits tool result', async () => {
  const payloads: any[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string); payloads.push(body);
    const events = [{ type:'start',requestId:body.requestId }, ...(payloads.length===1 ? [{ type:'tool_call',id:'call-1',name:'present_quiz',arguments:quiz }] : [{type:'text_delta',delta:'请选择一个选项。'}]), {type:'usage',usage:{input:10,output:2,total:12}}, {type:'finish',stopReason:payloads.length===1?'toolUse':'stop'}];
    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
  }) as typeof fetch;
  const events = await Array.fromAsync(new PiAgentAdapter(config,fetcher).run(input()));
  assert.equal(payloads.length,2);
  assert.equal(payloads[0].sessionId,'chat-a');
  assert.match(payloads[0].messages[0].content,/简短/);
  assert.equal(payloads[0].tools[0].function.name,'present_quiz');
  assert.equal(payloads[0].messages[1].content,'我的课程是概率论');
  assert.equal(payloads[1].messages.at(-1).role,'tool');
  assert.equal(payloads[1].messages.at(-1).tool_call_id,'call-1');
  assert.equal(events.filter(e=>e.type==='quiz_ready').length,1);
  assert.deepEqual(events.at(-1),{sessionId:'chat-a',turnId:'turn-a',type:'done',status:'waiting'});
});
test('HTTP error codes survive Pi mapping, no automatic upstream retry',async()=>{
  let requests=0;
  const fetcher=(async()=>{requests++;return Response.json({error:{code:'BUDGET_EXCEEDED',message:'预算不足'}},{status:429});}) as typeof fetch;
  const events=await Array.fromAsync(new PiAgentAdapter(config,fetcher).run(input()));
  assert.equal(requests,1);assert.ok(events.some(e=>e.type==='error'&&e.code==='BUDGET_EXCEEDED'));
  assert.equal(events.at(-1)?.type,'done');
});
test('abort yields only cancelled terminal and no later content',async()=>{
  const controller=new AbortController();
  const fetcher=(async(_url,init)=>new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))) as typeof fetch;
  const task=Array.fromAsync(new PiAgentAdapter(config,fetcher).run({...input(),signal:controller.signal}));
  setTimeout(()=>controller.abort(),20);const events=await task;
  assert.equal(events.filter(e=>e.type==='done').length,1);assert.equal((events.at(-1) as any).status,'cancelled');assert.equal(events.filter(e=>e.type==='text_delta').length,0);
});
test('native reader error after partial text is a stream interruption, not a network error (#14)',async()=>{
  let requests=0;
  const fetcher=(async(_url,init)=>{
    requests++;const body=JSON.parse(init!.body as string);const enc=new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({async start(controller){
      controller.enqueue(enc.encode('data: '+JSON.stringify({type:'start',requestId:body.requestId})+'\n\ndata: '+JSON.stringify({type:'text_delta',delta:'连接重置前已生成的文字'})+'\n\n'));
      await new Promise(r=>setTimeout(r,10));controller.error(new TypeError('simulated connection reset'));
    }}));
  }) as typeof fetch;
  const events=await Array.fromAsync(new PiAgentAdapter(config,fetcher).run(input()));
  assert.equal(requests,1);
  assert.deepEqual(events.filter(e=>e.type==='text_delta').map(e=>(e as any).delta),['连接重置前已生成的文字']);
  const errors=events.filter(e=>e.type==='error');
  assert.equal(errors.length,1);assert.equal((errors[0] as any).code,'MODEL_STREAM_INTERRUPTED');
  assert.deepEqual(events.at(-1),{sessionId:'chat-a',turnId:'turn-a',type:'done',status:'failed'});
});
test('fetch rejection before any response stays NETWORK_ERROR (#14)',async()=>{
  let requests=0;
  const fetcher=(async()=>{requests++;throw new TypeError('Failed to fetch');}) as typeof fetch;
  const events=await Array.fromAsync(new PiAgentAdapter(config,fetcher).run(input()));
  assert.equal(requests,1);
  assert.deepEqual(events.filter(e=>e.type==='error').map(e=>(e as any).code),['NETWORK_ERROR']);
  assert.equal((events.at(-1) as any).status,'failed');
});
