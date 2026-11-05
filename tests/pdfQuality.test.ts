import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfTextWarnings } from '../src/tools/pdfQuality.ts';

test('page footers do not hide missing PDF body text', () => {
 const warnings = pdfTextWarnings([
  { text: '正文'.repeat(100), page: 1, location: '第 1 页' },
  { text: '试题第   2   页   共   8   页', page: 2, location: '第 2 页' },
  { text: '  ', page: 3, location: '第 3 页' },
 ]);
 assert.ok(warnings.some(w => w.includes('第 2 页提取文字很少')));
 assert.ok(warnings.some(w => w.includes('1 页未提取到文字')));
 assert.ok(!warnings.some(w => w.includes('第 1 页提取文字很少')));
});

test('normal text has only the general layout warning; short genuine text is not discarded', () => {
 assert.equal(pdfTextWarnings([{text:'正文'.repeat(100),page:1,location:'第 1 页'}]).length,1);
 const sections = [{text:'简短的真实题目',page:1,location:'第 1 页'}];
 assert.match(pdfTextWarnings(sections)[1], /可能/);
 assert.equal(sections[0].text, '简短的真实题目');
});
