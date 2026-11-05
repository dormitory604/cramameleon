import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteEvidence } from '../src/tools/remoteEvidence.ts';
import { ContextSources } from '../src/tools/contextSources.ts';

test('three candidate files can be tried and verified within the remote read limit', async () => {
 const paths: string[] = [];
 let verification: any;
 const fetcher = (async (url: any, init?: RequestInit) => {
  const path = String(url); paths.push(path);
  if (path === '/api/old-site-verify') {
   verification = JSON.parse(String(init?.body));
   return Response.json({verified:true});
  }
  if (path.startsWith('/api/old-site/materials?')) return Response.json({items:[1,2,3,4].map(id=>({id:String(id),kind:'material',title:'高数',availability:'available'}))});
  return Response.json({chunks:[]});
 }) as typeof fetch;
 const remote = remoteEvidence('user', 'turn', [], new ContextSources([]), fetcher);
 await remote.tools[0].execute('search', {query:'高等数学',pastPaper:true});
 for (const id of [1,2,3]) await remote.read(`old-site:material:${id}`,`read${id}`,undefined);
 await assert.rejects(remote.read('old-site:material:4','read4',undefined),/三次/);
 assert.equal(paths.filter(p=>p.includes('/evidence?')).length,3);
 assert.equal(await remote.verify('题干',[{text:'甲'},{text:'乙'}],[]),true);
 assert.deepEqual(verification.calls,['read1','read2','read3']);
});
