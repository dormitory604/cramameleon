import { test, expect, type Locator, type Page } from '@playwright/test';

// #10: real pages, real PiAgentAdapter/tools/Worker/IndexedDB; only the /api/model stream is controlled.
const session = { user: { id: 'device-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
const devices = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
};
const done = [{ type: 'usage', usage: { input: 1, output: 1, total: 2 } }, { type: 'finish', stopReason: 'stop' }];
const toolDone = [{ type: 'usage', usage: { input: 1, output: 1, total: 2 } }, { type: 'finish', stopReason: 'toolUse' }];
const lecture = '互斥事件不能同时发生，交集概率为零，并集概率等于两者概率之和。';
const quiz = {
  question: '若事件 A、B 互斥，P(A)=0.2，P(B)=0.3，则 P(A∪B) 是多少？',
  options: [
    { id: 'A', text: '0.5', explanation: '互斥使交集概率为零，因此并集概率为两者之和 0.5。' },
    { id: 'B', text: '0.06', explanation: '乘积计算混淆了交集与并集；这里需要相加。' },
  ], correctOptionId: 'A', origin: 'adapted',
};

async function ready(page: Page) {
  await page.route('**/api/health', r => r.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/session', r => r.fulfill({ json: session }));
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const calls: { body: any; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
    (window as any).modelCalls = calls;
    window.fetch = async (url, options) => {
      if (url !== '/api/model') return original(url, options);
      const body = JSON.parse(options!.body as string);
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        calls.push({ body, stream });
        options?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
        stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'start', requestId: body.requestId }) + '\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
  await page.goto('/');
  await expect(page.getByLabel('输入消息')).toBeEnabled();
}
async function emit(page: Page, index: number, events: object[], close = false) {
  await page.waitForFunction(i => (window as any).modelCalls?.length > i, index);
  await page.evaluate(({ index, events, close }) => {
    const stream = (window as any).modelCalls[index].stream;
    for (const event of events) stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    if (close) stream.close();
  }, { index, events, close });
}
const answer = (page: Page, index: number, text: string) => emit(page, index, [{ type: 'text_delta', delta: text }, ...done], true);
async function lastMessage(page: Page, index: number) {
  await page.waitForFunction(i => (window as any).modelCalls?.length > i, index);
  return page.evaluate(i => (window as any).modelCalls[i].body.messages.at(-1), index);
}
// One cited quiz turn: search the selected material, present a quiz carrying the hit as its source, then a short reply.
async function citedQuiz(page: Page, first: number) {
  await emit(page, first, [{ type: 'tool_call', id: 'search', name: 'search_context', arguments: { query: '互斥' } }, ...toolDone], true);
  const hit = JSON.parse((await lastMessage(page, first + 1)).content).chunks[0];
  await emit(page, first + 1, [{ type: 'tool_call', id: 'quiz', name: 'present_quiz', arguments: { ...quiz, sourceRefs: [{ documentId: hit.documentId, chunkId: hit.chunkId }] } }, ...toolDone], true);
  await answer(page, first + 2, '请选择一个选项。');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}
async function importLecture(page: Page, name = '互斥讲义.txt', text = lecture) {
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expect(page.getByLabel(`使用资料 ${name}`, { exact: true })).toBeChecked();
}
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ['html', 'body', '.app', '.main', '.chat', '.composer-wrap', '.quiz', '.source-modal']
    .flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)].map(el => ({ selector, extra: el.scrollWidth - el.clientWidth })))
    .filter(item => item.extra > 1));
  expect(overflow).toEqual([]);
}
function chat(page: Page) { return page.getByRole('region', { name: '聊天记录' }); }
const distanceFromBottom = (chat: Locator) => chat.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
async function readHistory(chat: Locator) {
  await chat.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
}
async function expectInViewport(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

for (const [device, use] of Object.entries(devices)) test.describe(`${device} layout`, () => {
  test.use(use);

  test('long formulas, code and tables scroll inside their own boxes without page-level horizontal scroll', async ({ page }) => {
    await ready(page);
    await page.getByLabel('输入消息').fill('给我长公式、代码和表格');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const header = Array.from({ length: 14 }, (_, i) => `列${i}说明文字`);
    const text = [
      `\\[${Array.from({ length: 50 }, (_, i) => `a_{${i}}x^{${i}}`).join('+')}\\]`,
      `行内公式 $${Array.from({ length: 40 }, (_, i) => `b_{${i}}`).join('+')}$ 与长链接 https://example.com/${'path'.repeat(60)} 结束。`,
      '```python\nprint("' + '概率'.repeat(120) + '")\n```',
      `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n| ${header.map(() => '0.123456789').join(' | ')} |`,
    ].join('\n\n');
    await answer(page, 0, text);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await page.getByLabel('输入消息').fill('再出一道题');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await emit(page, 1, [{ type: 'tool_call', id: 'quiz', name: 'present_quiz', arguments: { ...quiz, origin: 'generated', question: `求 \`${'very_long_identifier_'.repeat(12)}\` 的值，其中 $${Array.from({ length: 30 }, (_, i) => `c_{${i}}`).join('+')}$`, options: quiz.options.map(o => ({ ...o, text: `${o.text} 或 ${'很长的选项说明'.repeat(12)}` })) } }, ...toolDone], true);
    await answer(page, 2, '请选择。');
    await expect(page.locator('.quiz')).toBeVisible();
    await page.screenshot({ path: `/private/tmp/cramameleon-spec-4/issue-10-shots/${device}-long-content.png` });
    await expectNoHorizontalOverflow(page);
    for (const selector of ['.msg-text .katex-display', '.msg-text pre', '.msg-text .md-table']) {
      const box = page.locator(selector).first();
      await expect(box).toBeVisible();
      const scrolled = await box.evaluate(el => { el.scrollLeft = 200; return { extra: el.scrollWidth - el.clientWidth, left: el.scrollLeft }; });
      expect(scrolled.extra, selector).toBeGreaterThan(0);
      expect(scrolled.left, selector).toBeGreaterThan(0);
    }
    await page.locator('.quiz-option').first().click();
    await expect(page.locator('.quiz-feedback')).toContainText('回答正确');
    await expectNoHorizontalOverflow(page);
  });

  test('streaming follows the newest text until the learner scrolls back to read history', async ({ page }) => {
    await ready(page);
    for (let i = 0; i < 2; i++) {
      await page.getByLabel('输入消息').fill(`历史问题 ${i}`);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await answer(page, i, `历史回答 ${i}\n\n` + '较早的讲解段落。\n\n'.repeat(30));
      await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    }
    const history = chat(page);
    await page.getByLabel('输入消息').fill('新的问题');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => distanceFromBottom(history)).toBeLessThan(16);
    await emit(page, 2, [{ type: 'text_delta', delta: '流式段落。\n\n'.repeat(20) }]);
    await expect.poll(() => distanceFromBottom(history)).toBeLessThan(16);
    await readHistory(history);
    await emit(page, 2, [{ type: 'text_delta', delta: '更多流式段落。\n\n'.repeat(20) }]);
    await expect(page.getByText('更多流式段落。').last()).toBeAttached();
    await page.waitForTimeout(150);
    expect(await history.evaluate(el => el.scrollTop)).toBeLessThan(4);
    await expect(page.getByText('历史回答 0', { exact: true })).toBeInViewport();
    await history.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await emit(page, 2, [{ type: 'text_delta', delta: '最后的流式段落。\n\n'.repeat(20) }, ...done], true);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect.poll(() => distanceFromBottom(history)).toBeLessThan(16);
    await readHistory(history);
    await page.getByLabel('输入消息').fill('读完历史后再问');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => distanceFromBottom(history)).toBeLessThan(16);
    await answer(page, 3, '新回答');
    await expect(page.getByText('新回答', { exact: true })).toBeInViewport();
  });
});

test.describe('desktop keyboard', () => {
  test.use(devices.desktop);

  async function tabTo(page: Page, target: Locator, max = 60) {
    for (let i = 0; i < max; i++) {
      if (await target.evaluate(el => el === document.activeElement)) return;
      await page.keyboard.press('Tab');
    }
    throw new Error('target not reachable by Tab');
  }
  async function expectFocusRing(locator: Locator) {
    await expect(locator).toBeFocused();
    const ring = await locator.evaluate(el => { const style = getComputedStyle(el); return { outline: style.outlineStyle, width: parseFloat(style.outlineWidth), opacity: style.opacity }; });
    expect(ring.outline).not.toBe('none');
    expect(ring.width).toBeGreaterThan(0);
    expect(ring.opacity).toBe('1');
  }

  test('main controls and the source dialog work from the keyboard with visible focus and focus restore', async ({ page }) => {
    await ready(page);
    await importLecture(page);
    await page.locator('body').click({ position: { x: 600, y: 300 } });
    const input = page.getByLabel('输入消息');
    await tabTo(page, input);
    await page.keyboard.type('依据讲义出一道互斥题');
    await page.keyboard.press('Enter');
    await citedQuiz(page, 0);

    const option = page.getByRole('button', { name: 'A 0.5', exact: true });
    await tabTo(page, option);
    await expectFocusRing(option);
    await page.keyboard.press('Enter');
    await expect(page.locator('.quiz-feedback')).toContainText('回答正确');

    const chip = page.getByRole('button', { name: '▧ 互斥讲义.txt', exact: true });
    await tabTo(page, chip);
    await expectFocusRing(chip);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '互斥讲义.txt' });
    await expect(dialog).toContainText(lecture);
    const close = dialog.getByRole('button', { name: '关闭来源', exact: true });
    await expectFocusRing(close);
    await page.screenshot({ path: '/private/tmp/cramameleon-spec-4/issue-10-shots/desktop-source-dialog-focus.png' });
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(chip).toBeFocused();

    const view = page.getByRole('button', { name: '查看文本：互斥讲义.txt', exact: true });
    await tabTo(page, view);
    await expectFocusRing(view);
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(view).toBeFocused();

    await tabTo(page, input);
    await page.keyboard.type('来源看完了，继续');
    await page.keyboard.press('Enter');
    await answer(page, 3, '好的，继续讲。');
    await expect(page.getByText('好的，继续讲。', { exact: true })).toBeVisible();

    const remove = page.getByRole('button', { name: /^删除对话 / });
    await tabTo(page, remove);
    await expectFocusRing(remove);
  });
});

test.describe('mobile touch', () => {
  test.use(devices.mobile);

  test('import, send, answer, check sources and switch or delete sessions by touch', async ({ page }) => {
    await ready(page);
    const sidebarNew = page.getByRole('button', { name: '新对话' });
    await expect(sidebarNew, 'closed drawer must not be reachable off screen').toBeHidden();
    await importLecture(page);
    await importLecture(page, '补充讲义.txt', '独立事件的交集概率等于概率乘积。');
    const input = page.getByLabel('输入消息');
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await expectInViewport(page, input);
    await page.screenshot({ path: '/private/tmp/cramameleon-spec-4/issue-10-shots/mobile-materials-composer.png' });
    expect((await chat(page).boundingBox())!.height, 'chat keeps room to read after materials are listed').toBeGreaterThan(260);
    await input.tap();
    await input.fill('依据讲义出一道互斥题');
    await expectInViewport(page, send);
    await send.tap();
    await citedQuiz(page, 0);
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'B 0.06', exact: true }).tap();
    await expect(page.locator('.quiz-feedback')).toContainText('回答错误，正确答案：A');

    const chip = page.getByRole('button', { name: '▧ 互斥讲义.txt', exact: true });
    await chip.tap();
    const dialog = page.getByRole('dialog', { name: '互斥讲义.txt' });
    await expect(dialog).toContainText(lecture);
    const close = dialog.getByRole('button', { name: '关闭来源', exact: true });
    await expectInViewport(page, close);
    await expectNoHorizontalOverflow(page);
    await close.tap();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: '打开侧边栏' }).tap();
    await expect(sidebarNew).toBeVisible();
    await sidebarNew.tap();
    await expect(sidebarNew).toBeHidden();
    await input.fill('第二个会话的问题');
    await send.tap();
    await answer(page, 3, '第二个会话的回答');
    await expect(page.getByText('第二个会话的回答', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '打开侧边栏' }).tap();
    await page.getByRole('button', { name: /^互斥讲义\.txt/ }).tap();
    await expect(page.locator('.quiz-feedback')).toContainText('回答错误');
    await expect(page.getByText('第二个会话的回答', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '打开侧边栏' }).tap();
    const remove = page.getByRole('button', { name: '删除对话 第二个会话的问题', exact: true });
    await page.screenshot({ path: '/private/tmp/cramameleon-spec-4/issue-10-shots/mobile-session-delete.png' });
    expect(await remove.evaluate(el => getComputedStyle(el).opacity), 'delete is discoverable without hover').toBe('1');
    const box = (await remove.boundingBox())!;
    expect(Math.min(box.width, box.height), 'delete is a usable touch target').toBeGreaterThanOrEqual(32);
    await remove.tap();
    await expect(page.getByRole('button', { name: /第二个会话的问题/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^互斥讲义\.txt/ })).toBeVisible();
    await page.locator('.sidebar-scrim').tap({ position: { x: 360, y: 300 } });
    await expect(sidebarNew).toBeHidden();
    await expect(page.locator('.quiz-feedback')).toContainText('回答错误');
  });
});
