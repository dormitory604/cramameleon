import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalBytes } from '../src/tools/localParser.ts';
import { attributeRemoteDocument } from '../src/tools/oldSiteMaterials.ts';
import { ContextSources } from '../src/tools/contextSources.ts';
import type { Document } from '../src/contracts/index.ts';

test('old-site content is readable in order without a keyword match and retains source identity', async () => {
  const local = await parseLocalBytes('小测.txt', new TextEncoder().encode('1. 设 A、B 互斥，求并集概率。\n\n2. 求数学期望。'), async () => { throw Error('not PDF'); });
  const doc = attributeRemoteDocument(local, { id: '5232', kind: 'material', title: '概率论与数理统计 2024小测题', courseName: '概率论', format: 'txt', size: 100, url: 'https://materials.example.com/material/5232', availability: 'available', alreadyDownloaded: true });
  const sources = new ContextSources([doc]);
  assert.deepEqual(sources.search('第一题'), []);
  const result = sources.readDocument(doc.id);
  assert.match(result.chunks[0].text, /^1\. 设 A、B 互斥/);
  assert.equal(result.chunks[0].documentId, doc.id);
  assert.equal(result.chunks[0].location, '段落 1');
  assert.equal(result.chunks[0].url, doc.remoteRef!.url);
  assert.deepEqual(sources.resolve([{ documentId: doc.id, chunkId: result.chunks[0].chunkId }]), [result.chunks[0]]);
  assert.throws(() => sources.readDocument(local.id), /当前已选/);
  for (const index of [0, -1, 1.5, 3]) assert.throws(() => sources.readDocument(doc.id, index), /位置无效/);
});

test('sequential reading shares the retrieval budget, reports continuation and preserves earlier evidence', () => {
  const doc: Document = { id: 'cached', title: '缓存资料', warnings: [], chunks: Array.from({ length: 8 }, (_, i) => ({ documentId: 'cached', chunkId: `c${i}`, title: '缓存资料', location: `第 ${i + 1} 页`, page: i + 1, text: '内容' + 'x'.repeat(1798) })) };
  const sources = new ContextSources([doc]);
  const first = sources.readDocument(doc.id);
  assert.equal(first.chunks.length, 3);
  assert.equal(first.nextChunk, 4);
  assert.equal(first.budgetExhausted, false);
  const last = sources.readDocument(doc.id, first.nextChunk!);
  assert.equal(last.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), 2600);
  assert.equal(last.truncated, true);
  assert.equal(last.budgetExhausted, true);
  assert.deepEqual(sources.search('内容'), []);
  const exhausted = sources.readDocument(doc.id, last.nextChunk!);
  assert.equal(exhausted.chunks.length, 0);
  assert.equal(exhausted.budgetExhausted, true);
  assert.equal(sources.resolve([{ documentId: doc.id, chunkId: 'c0' }])[0].text.length, 1800);
  assert.throws(() => new ContextSources([]).readDocument(doc.id), /当前已选/);
});
