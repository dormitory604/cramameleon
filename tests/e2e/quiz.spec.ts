import { test, expect, type Page } from '@playwright/test';

const session = { user: { id: 'quiz-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
const quiz = {
 question: '若事件 A、B 互斥，P(A)=0.2，P(B)=0.3，则 P(A∪B) 是多少？',
 options: [
  { id: 'A', text: '0.5', explanation: '互斥使交集概率为零，因此并集概率为两者之和 0.5。' },
  { id: 'B', text: '0.06', explanation: '乘积计算混淆了交集与并集；这里需要相加。' },
 ], correctOptionId: 'A', origin: 'generated', sourceRefs: [],
};
const nextQuiz = {
 question: '下一题：两个正概率互斥事件能否独立？',
 options: [
  { id: 'A', text: '不能独立', explanation: '互斥使交集概率为零，正概率使概率乘积大于零，故不满足独立条件。' },
  { id: 'B', text: '必然独立', explanation: '互斥约束同时发生，独立要求交集概率等于概率乘积；这里二者不相等。' },
 ], correctOptionId: 'A', origin: 'generated', sourceRefs: [],
};
type Request = { requestId: string; messages: { role: string; content: string; tool_call_id?: string }[] };
type Step = { type: 'text_delta'; delta: string } | { type: 'tool_call'; id: string; name: string; arguments: object };
async function setup(page: Page, respond: (body: Request) => Step) {
 const requests: Request[] = [];
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/session') return route.fulfill({ json: session });
  if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
  if (path !== '/api/model') return route.fulfill({ status: 404 });
  const body: Request = route.request().postDataJSON(); requests.push(body);
  const step = respond(body);
  const events = [{ type: 'start', requestId: body.requestId }, step, { type: 'usage', usage: { input: 1, output: 1, total: 2 } }, { type: 'finish', stopReason: step.type === 'tool_call' ? 'toolUse' : 'stop' }];
  return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
 });
 await page.goto('/');
 await expect(page.getByLabel('输入消息')).toBeEnabled();
 return requests;
}
async function send(page: Page, text: string) {
 await page.getByLabel('输入消息').fill(text);
 await page.getByRole('button', { name: '发送消息', exact: true }).click();
 await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}
test('revealing an answer is distinct from answering, and the current quiz survives long followups and reload', async ({ page }) => {
 const requests = await setup(page, body => {
  const last = body.messages.at(-1)!;
  if (last.content === '再解释详细些') return { type: 'text_delta', delta: '补充解释互斥与独立的条件。'.repeat(1200) };
  return practiceResponse(body);
 });
 await send(page, '考考我，互斥事件');
 const count = requests.length;
 await page.getByRole('button', { name: '看答案', exact: true }).click();
 await expect(page.locator('.quiz')).toContainText('正确答案：A');
 await expect(page.locator('.quiz')).not.toContainText('回答错误');
 for (const option of quiz.options) await expect(page.locator('.quiz')).toContainText(option.explanation);
 expect(requests).toHaveLength(count);
 await page.waitForTimeout(350);
 await page.reload();
 await expect(page.locator('.quiz')).toContainText('正确答案：A');
 expect(requests).toHaveLength(count);
 await send(page, '再解释详细些');
 const revealedHistory = JSON.stringify(requests[count].messages.filter(message => message.role !== 'system').slice(0, -1));
 expect(revealedHistory).toContain('已查看答案，未选择选项');
 expect(revealedHistory).not.toContain('尚未作答');
 await page.getByRole('button', { name: '下一题', exact: true }).click();
 await expect(page.locator('.quiz')).toHaveCount(2);
 const nextHistory = JSON.stringify(requests[count + 1].messages.filter(message => message.role !== 'system').slice(0, -1));
 expect(nextHistory).toContain(quiz.question);
 expect(nextHistory).toContain(quiz.options[1].explanation);
 expect(nextHistory).toContain('已查看答案，未选择选项');
});

test('quiz sources open cached worker text without a separate citation and survive quiz-only source records on mobile', async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 const requests = await setup(page, body => {
  const last = body.messages.at(-1)!;
  if (last.role === 'user') return { type: 'tool_call', id: 'search', name: 'search_context', arguments: { query: '互斥' } };
  if (last.tool_call_id === 'search') {
   const chunk = JSON.parse(last.content).chunks[0];
   return { type: 'tool_call', id: 'quiz', name: 'present_quiz', arguments: { ...quiz, origin: 'adapted', sourceRefs: [{ documentId: chunk.documentId, chunkId: chunk.chunkId }] } };
  }
  return { type: 'text_delta', delta: '请选择一个选项。' };
 });
 const text = '互斥事件不能同时发生，交集概率为零，并集概率等于两者概率之和。';
 await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: '互斥讲义.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
 await expect(page.getByLabel('使用资料 互斥讲义.txt', { exact: true })).toBeChecked();
 expect(requests).toHaveLength(0);
 await send(page, '依据讲义出一道互斥题');
 const source = page.getByRole('button', { name: '▧ 互斥讲义.txt', exact: true });
 await expect(source).toHaveCount(1);
 await source.click();
 await expect(page.getByRole('dialog')).toContainText(text);
 const location = await page.locator('.source-location').textContent();
 expect(location).toBeTruthy();
 await page.getByRole('button', { name: '关闭来源', exact: true }).click();
 const count = requests.length;
 await page.waitForTimeout(350);
 // At the IndexedDB boundary, prepare a saved quiz-only source record for
 // restore. Its quiz and sources were generated by the real adapter above.
 await page.evaluate(() => new Promise<void>((resolve, reject) => {
  const request = indexedDB.open('cramameleon', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
   const db = request.result;
   const transaction = db.transaction('users', 'readwrite');
   const store = transaction.objectStore('users');
   const record = store.get('quiz-user');
   record.onsuccess = () => {
    const data = record.result;
    for (const message of data.messages) delete message.sources;
    store.put(data, 'quiz-user');
   };
   transaction.oncomplete = () => { db.close(); resolve(); };
   transaction.onabort = () => { db.close(); reject(transaction.error); };
  };
 }));
 await page.reload();
 await expect(page.locator('.quiz')).toContainText(quiz.question);
 await expect(page.locator('.quiz-feedback')).toHaveCount(0);
 await expect(source).toHaveCount(1);
 await source.click();
 await expect(page.getByRole('dialog')).toContainText(text);
 await expect(page.locator('.source-location')).toHaveText(location!);
 await page.getByRole('button', { name: '关闭来源', exact: true }).click();
 await page.getByRole('button', { name: 'A 0.5', exact: true }).click();
 await expect(page.locator('.quiz')).toContainText('回答正确');
 await page.waitForTimeout(350);
 await page.reload();
 await expect(page.locator('.quiz')).toContainText('回答正确');
 expect(requests).toHaveLength(count);
});

for (const outcome of ['repair', 'fallback'] as const) {
 test(`invalid quiz ${outcome} uses real validation without marking the user wrong`, async ({ page }) => {
  let attempts = 0;
  const requests = await setup(page, body => {
   const last = body.messages.at(-1)!;
   if (last.role === 'user' || attempts < 2) {
    attempts++;
    return { type: 'tool_call', id: 'quiz-' + attempts, name: 'present_quiz', arguments: { ...quiz, correctOptionId: outcome === 'repair' && attempts === 2 ? 'A' : 'Z' } };
   }
   return { type: 'text_delta', delta: outcome === 'repair' ? '请选择一个选项。' : '本轮未能生成有效题目。先解释互斥：交集概率为零，并集概率可以相加。' };
  });
  await send(page, '考考我，互斥事件');
  expect(requests).toHaveLength(3);
  await page.getByText('工具调用', { exact: true }).click();
  await expect(page.locator('.tool-block')).toContainText('题目校验未通过，尝试修复一次');
  await expect(page.locator('.quiz-feedback')).toHaveCount(0);
  await expect(page.getByText(/回答错误/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下一题', exact: true })).toHaveCount(0);
  if (outcome === 'repair') {
   await expect(page.locator('.quiz')).toContainText(quiz.question);
   await expect(page.locator('.quiz')).not.toContainText(quiz.options[0].explanation);
   await page.getByRole('button', { name: 'A 0.5', exact: true }).click();
   await expect(page.locator('.quiz-feedback')).toContainText('回答正确');
   expect(requests).toHaveLength(3);
  } else {
   await expect(page.locator('.quiz')).toHaveCount(0);
   await expect(page.locator('.tool-block')).toContainText('题目校验未通过，改为讲解');
   await expect(page.locator('.msg-text')).toContainText('本轮未能生成有效题目');
  }
 });
}

test('an unanswered followup keeps answers hidden, then a later local answer reaches the next question', async ({ page }) => {
 const requests = await setup(page, practiceResponse);
 await send(page, '考考我，互斥事件');
 await send(page, '只解释题意，不要告诉我答案或出新题');
 await expect(page.locator('.quiz')).toHaveCount(1);
 await expect(page.locator('.quiz-feedback')).toHaveCount(0);
 await expect(page.getByRole('button', { name: '下一题', exact: true })).toHaveCount(0);
 const history = JSON.stringify(requests[2].messages.filter(message => message.role !== 'system').slice(0, -1));
 expect(history).toContain(quiz.question);
 expect(history).toContain('尚未作答');
 expect(history).toContain('correctOptionId');
 for (const option of quiz.options) expect(history).toContain(option.explanation);
 const count = requests.length;
 await page.getByRole('button', { name: 'A 0.5', exact: true }).click();
 await expect(page.locator('.quiz-feedback')).toContainText('回答正确');
 expect(requests).toHaveLength(count);
 await page.getByRole('button', { name: '下一题', exact: true }).click();
 await expect(page.locator('.quiz')).toHaveCount(2);
 const nextHistory = JSON.stringify(requests[count].messages.filter(message => message.role !== 'system').slice(0, -1));
 expect(nextHistory).toContain('用户作答：A（回答正确）');
 expect(nextHistory).not.toContain('尚未作答');
});

function practiceResponse(body: Request): Step {
 const last = body.messages.at(-1)!;
 if (last.content === '只解释题意，不要告诉我答案或出新题') return { type: 'text_delta', delta: '题目中的并集表示 A 或 B 至少有一个发生。请按这个意思独立判断。' };
 if (last.role === 'user' && (last.content === '考考我，互斥事件' || last.content.includes('出下一题'))) {
  return { type: 'tool_call', id: 'quiz', name: 'present_quiz', arguments: last.content.includes('出下一题') ? nextQuiz : quiz };
 }
 return { type: 'text_delta', delta: last.role === 'tool' ? '请选择一个选项，作答后可查看解释。' : '题目问的是并集；互斥事件的交集概率为零，所以相加。' };
}

test('local feedback stays available for followup and only an explicit next action requests a new quiz', async ({ page }) => {
 const requests = await setup(page, practiceResponse);
 await send(page, '考考我，互斥事件');
 const board = page.locator('.quiz');
 await expect(board).toContainText(quiz.question);
 await expect(page.locator('.msg-text')).toHaveText('请选择一个选项，作答后可查看解释。');
 for (const option of quiz.options) await expect(board.getByText(option.explanation, { exact: true })).toHaveCount(0);
 await expect(board.getByText(/正确答案/)).toHaveCount(0);
 const before = requests.length;
 await board.getByRole('button', { name: 'B 0.06', exact: true }).click();
 await expect(board).toContainText('回答错误，正确答案：A');
 for (const option of quiz.options) await expect(board).toContainText(option.explanation);
 await expect(page.getByRole('button', { name: '下一题', exact: true })).toBeVisible();
 expect(requests).toHaveLength(before);
 await send(page, '为什么不能相乘？');
 await expect(page.locator('.quiz')).toHaveCount(1);
 await expect(page.locator('.msg-text').last()).toContainText('互斥事件的交集概率为零');
 expect(requests).toHaveLength(before + 1);
 await expect(page.getByRole('button', { name: '下一题', exact: true })).toBeVisible();
 await page.getByRole('button', { name: '下一题', exact: true }).click();
 await expect(page.locator('.quiz').last()).toContainText('下一题：两个正概率互斥事件能否独立？');
 await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
 const nextRequest = requests[before + 1];
 const history = JSON.stringify(nextRequest.messages.filter(message => message.role !== 'system').slice(0, -1));
 expect(history).toContain(quiz.question);
 expect(history).toContain('用户作答：B');
 expect(history).toContain('为什么不能相乘');
 const count = requests.length;
 await page.locator('.quiz').last().getByRole('button', { name: 'A 不能独立', exact: true }).click();
 await expect(page.locator('.quiz').last()).toContainText('回答正确');
 expect(requests).toHaveLength(count);
});
