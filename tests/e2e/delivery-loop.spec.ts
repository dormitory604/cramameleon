import { test, expect, type Page } from '@playwright/test';

// #12 final acceptance: the whole local learning loop in one learning session.
// Real UI, Worker parsing, PiAgentAdapter, tools and IndexedDB; only /api/model responses are controlled.
const session = { user: { id: 'delivery-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 1024 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
const lecture = '# 第二章 条件概率\n\n条件概率：当 P(B)>0 时，P(A|B)=P(A∩B)/P(B)。\n\n# 第三章 互斥事件\n\n互斥事件：P(A∪B)=P(A)+P(B)。DELIVERY_CHAPTER_3';
type Body = { requestId: string; messages: { role: string; content: string; tool_call_id?: string }[]; tools: { function: { name: string } }[] };
type Step = { type: 'text_delta'; delta: string } | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };
const call = (id: string, name: string, args: Record<string, unknown>): Step => ({ type: 'tool_call', id, name, arguments: args });
const text = (delta: string): Step => ({ type: 'text_delta', delta });

async function boundary(page: Page) {
  const requests: Body[] = [];
  const turns: ((body: Body) => Step)[][] = [];
  await page.route('**/api/session', r => r.fulfill({ json: session }));
  await page.route('**/api/health', r => r.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/model', async route => {
    const body = route.request().postDataJSON() as Body;
    requests.push(body);
    const next = turns[0]?.shift();
    expect(next, 'unexpected model request').toBeDefined();
    if (turns[0]?.length === 0) turns.shift();
    const step = next!(body);
    const events = [{ type: 'start', requestId: body.requestId }, step, { type: 'usage', usage: { input: 1, output: 1, total: 2 } }, { type: 'finish', stopReason: step.type === 'tool_call' ? 'toolUse' : 'stop' }];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') });
  });
  return { requests, script: (...steps: ((body: Body) => Step)[]) => turns.push(steps) };
}
const lastTool = (body: Body) => JSON.parse(body.messages.at(-1)!.content);
async function send(page: Page, value: string) {
  await page.getByLabel('输入消息').fill(value);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}

const devices = { desktop: { viewport: { width: 1280, height: 800 } }, mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } };
for (const [device, use] of Object.entries(devices)) test.describe(device, () => {
  test.use(use);
  test('local material → chapter → review → quiz → local feedback → source → reload → next question', async ({ page }) => {
    test.setTimeout(60000);
    const { requests, script } = await boundary(page);
    await page.goto('/');
    await expect(page.getByLabel('输入消息')).toBeEnabled();

    // 1. Choose local material: real Worker parsing, no model request.
    await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: '概率讲义.md', mimeType: 'text/markdown', buffer: Buffer.from(lecture) });
    await expect(page.getByLabel('使用资料 概率讲义.md', { exact: true })).toBeChecked();
    expect(requests).toHaveLength(0);

    // 2-3. Name a chapter and review it from the selected material, with a cited explanation.
    let refs: { documentId: string; chunkId: string }[] = [];
    script(
      () => call('skill', 'read_skill', { name: 'review' }),
      () => call('search', 'search_context', { query: '条件概率' }),
      body => {
        const hit = lastTool(body).chunks.find((c: { text: string }) => c.text.includes('P(A∩B)/P(B)'));
        expect(hit, 'search returns the selected material').toBeDefined();
        refs = [{ documentId: hit.documentId, chunkId: hit.chunkId }];
        return call('state', 'update_learning_state', { course: '概率论', chapter: '条件概率', progress: '已讲条件概率定义与 P(B)>0', phase: 'learning' });
      },
      () => call('cite', 'cite_sources', { refs }),
      () => text('依据讲义：$P(A\\mid B)=P(A\\cap B)/P(B)$，要求 $P(B)>0$。'),
    );
    await send(page, '复习第二章条件概率，依据我的讲义讲，先别出题。');
    expect(requests[0].messages.at(-1)?.content).toBe('复习第二章条件概率，依据我的讲义讲，先别出题。');
    expect(requests[0].tools.some(t => t.function.name === 'present_quiz')).toBe(false);
    await expect(page.getByLabel('学习位置')).toContainText('已讲条件概率定义与 P(B)>0');
    await expect(page.locator('.msg.assistant').last().locator('.katex').first()).toBeVisible();
    await expect(page.locator('.quiz')).toHaveCount(0);

    // 4. Ask for a quiz grounded in this turn's own read: answers and explanations stay hidden until the learner acts.
    script(
      () => call('search2', 'search_context', { query: '条件概率' }),
      body => {
        const hit = lastTool(body).chunks.find((c: { text: string }) => c.text.includes('P(A∩B)/P(B)'));
        refs = [{ documentId: hit.documentId, chunkId: hit.chunkId }];
        return call('quiz', 'present_quiz', { question: '依据讲义，条件概率 P(A|B) 的分母是什么？', options: [
        { id: 'A', text: 'P(B)', explanation: 'EXPLAIN_A 讲义给出分母为条件事件的概率 P(B)。' },
        { id: 'B', text: 'P(A)', explanation: 'EXPLAIN_B 分母是已知发生的条件事件，不是 A。' },
      ], correctOptionId: 'A', origin: 'adapted', sourceRefs: refs });
      },
      () => text('请在题板中作答。'),
    );
    await send(page, '出一道题考考我');
    const quiz = page.locator('.quiz');
    await expect(quiz).toContainText('条件概率 P(A|B) 的分母是什么？');
    await expect(page.getByText(/EXPLAIN_A|EXPLAIN_B|回答正确/)).toHaveCount(0);

    // 5. Local feedback: zero model requests.
    const beforeAnswer = requests.length;
    await page.getByRole('button', { name: 'A P(B)', exact: true }).click();
    await expect(page.getByText('回答正确', { exact: true })).toBeVisible();
    await expect(quiz).toContainText('EXPLAIN_A');
    await expect(quiz).toContainText('EXPLAIN_B');
    expect(requests).toHaveLength(beforeAnswer);

    // 6. Check the source carried by the quiz: cached text with its real location, keyboard return.
    const chip = page.locator('.msg.assistant').last().getByRole('button', { name: '▧ 概率讲义.md', exact: true });
    await expect(chip).toBeVisible();
    await chip.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('P(A∩B)/P(B)');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(chip).toBeFocused();
    expect(requests).toHaveLength(beforeAnswer);

    // 7. Reload and continue: records, answer, location and material selection restore; continuing sends them.
    // On phones the storage status lives in the closed drawer (#10 hides it from focus and readers).
    if (device === 'mobile') await page.getByRole('button', { name: '打开侧边栏' }).tap();
    await expect(page.getByRole('status', { name: '本机存储状态' })).toHaveText('已保存到当前浏览器');
    await page.reload();
    await expect(page.getByLabel('输入消息')).toBeEnabled();
    await expect(page.getByLabel('使用资料 概率讲义.md', { exact: true })).toBeChecked();
    await expect(page.getByText('回答正确', { exact: true })).toBeVisible();
    await expect(page.getByLabel('学习位置')).toContainText('已讲条件概率定义与 P(B)>0');
    expect(requests).toHaveLength(beforeAnswer);

    script(
      () => call('quiz2', 'present_quiz', { question: '已知 P(B)=0.5、P(A∩B)=0.2，P(A|B) 是多少？', options: [
        { id: 'A', text: '0.4', explanation: '0.2/0.5=0.4。' },
        { id: 'B', text: '0.1', explanation: '这是相乘，不是条件概率。' },
      ], correctOptionId: 'A', origin: 'generated', sourceRefs: [] }),
      () => text('第二题已放在题板中。'),
    );
    await page.getByRole('button', { name: '下一题', exact: true }).click();
    await expect(page.getByText('已知 P(B)=0.5、P(A∩B)=0.2，P(A|B) 是多少？', { exact: true })).toBeVisible();
    const resumed = requests[beforeAnswer];
    expect(resumed.messages[0].content).toContain('"chapter":"条件概率"');
    expect(resumed.messages[0].content).toContain('已讲条件概率定义与 P(B)>0');
    const history = JSON.stringify(resumed.messages);
    expect(history).toContain('复习第二章条件概率');
    expect(history).toContain('条件概率 P(A|B) 的分母是什么？');
    expect(history).toMatch(/用户作答：A/);
    expect(requests).toHaveLength(beforeAnswer + 2);
  });
});
