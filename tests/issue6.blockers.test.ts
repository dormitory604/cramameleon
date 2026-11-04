import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextSources } from '../src/tools/contextSources.ts';
import { PiAgentAdapter } from '../src/agent/PiAgentAdapter.ts';
import type { AgentInput, AppSession, Document } from '../src/contracts/index.ts';
const document:Document={id:'long',title:'长讲义',warnings:[],chunks:Array.from({length:6},(_,index)=>({documentId:'long',chunkId:'c'+index,title:'长讲义',location:`段落 ${index+1}`,text:'条件概率：'+String(index).repeat(1795)}))};

test('BLOCKED B: repeated searches retain the evidence already read for a citation', {todo:'B owns ContextSources: later budget-limited reads overwrite longer previously read evidence; #6 partial-evidence acceptance is blocked.'},()=>{
 const context=new ContextSources([document]);
 context.search('条件概率');context.search('条件概率');
 const citation=context.resolve([{documentId:'long',chunkId:'c1'}])[0];
 assert.equal(citation.text.length,1800,'a later shortened read must preserve the full 1800 characters already read');
});

test('BLOCKED B: the actual adapter distinguishes retrieval budget exhaustion from no matching text', {todo:'B owns retrieval result/contract: both currently return identical empty chunks without coverage or budget status.'},async()=>{
 const config:AppSession={user:{id:'blocker',name:'test'},mode:'internal',modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-04',limit:100000,used:0}};
 const input:AgentInput={sessionId:'blocked',turnId:'budget',action:{type:'send',text:'根据资料解释条件概率'},history:[],state:{preferences:'',progress:''},documents:[document],signal:new AbortController().signal};
 async function searchResults(queries:string[]) {
  const results:any[]=[];
  const fetcher=(async(_url,init)=>{
   const body=JSON.parse(init!.body as string);const last=body.messages.at(-1);
   if(last.role==='tool')results.push(JSON.parse(last.content));
   const query=queries.shift();
   const step=query?{type:'tool_call',id:crypto.randomUUID(),name:'search_context',arguments:{query}}:{type:'text_delta',delta:'无法确认其余依据。'};
   return new Response([{type:'start',requestId:body.requestId},step,{type:'finish',stopReason:step.type==='tool_call'?'toolUse':'stop'}].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
  }) as typeof fetch;
  await Array.fromAsync(new PiAgentAdapter(config,fetcher).run({...input,turnId:crypto.randomUUID()}));
  return results;
 }
 const exhausted=await searchResults(['条件概率','条件概率','条件概率']);
 const noMatches=await searchResults(['UNMATCHED_QUERY']);
 assert.equal(exhausted.length,3);assert.equal(noMatches.length,1);
 assert.deepEqual(exhausted[2].chunks,[]);assert.deepEqual(noMatches[0].chunks,[]);
 assert.notDeepEqual(exhausted[2],noMatches[0],'exhausted retrieval and no matches need distinguishable public results');
});
