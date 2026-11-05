import { test, expect, type Page } from '@playwright/test';

const session = { mode: 'guest', user: { id: 'message-actions', name: '测试' }, modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-05', limit: 100000, used: 0 } };

async function ready(page: Page, reply: (body: any) => object | Promise<object> = body => ({ type: 'text_delta', delta: '回答：' + body.messages.at(-1).content })) {
  const requests: any[] = [];
  await page.addInitScript(() => {
    (window as any).copiedTexts = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedTexts.push(text); } } });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: session });
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
    if (path === '/api/model') {
      const body = route.request().postDataJSON(); requests.push(body);
      const step: any = await reply(body);
      const events = [{ type: 'start', requestId: body.requestId }, step, { type: 'usage', usage: { input: 1, output: 1, total: 2 } }, { type: 'finish', stopReason: step.type === 'tool_call' ? 'toolUse' : 'stop' }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await expect(page.getByLabel('输入消息', { exact: true })).toBeEnabled();
  return requests;
}
async function send(page: Page, text: string) {
  await page.getByLabel('输入消息', { exact: true }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}

test('hover reveals per-message icons; user and assistant copy only their own text, and keyboard focus reveals actions', async ({ page }, testInfo) => {
  const requests = await ready(page, () => ({ type: 'text_delta', delta: '这是 **回答**。\n\n```js\nconsole.log(1)\n```' }));
  await send(page, '这是用户的消息');
  const user = page.locator('.msg.user').first(), assistant = page.locator('.msg.assistant').first();
  await page.mouse.move(0, 0);
  await expect(user.getByRole('group', { name: '消息操作' })).toHaveCSS('opacity', '0');
  await expect(assistant.getByRole('group', { name: '消息操作' })).toHaveCSS('opacity', '0');
  await user.locator('.bubble').hover();
  await expect(user.getByRole('group', { name: '消息操作' })).toHaveCSS('opacity', '1');
  await expect(user.getByRole('button', { name: '编辑消息', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('user-actions-light.png'), animations: 'disabled' });
  await user.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect(user.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await expect(assistant.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(0);
  await assistant.hover();
  await assistant.getByRole('button', { name: '复制消息', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedTexts)).toEqual(['这是用户的消息', '这是 **回答**。\n\n```js\nconsole.log(1)\n```']);
  await page.getByLabel('输入消息', { exact: true }).focus();
  await page.mouse.move(0, 0);
  await user.getByRole('button', { name: '编辑消息', exact: true }).focus();
  await expect(user.getByRole('group', { name: '消息操作' })).toHaveCSS('opacity', '1');
  expect(requests).toHaveLength(1);
});

test('editing resends once with earlier context, keeps the original version and materials, and survives reload', async ({ page }, testInfo) => {
  const requests = await ready(page, body => {
    const last = body.messages.at(-1), question = body.messages.findLast((message: any) => message.role === 'user').content;
    if (last.role === 'user' && ['前面的背景', '不应进入新请求的后续追问'].includes(question)) {
      return { type: 'tool_call', id: 'state', name: 'update_learning_state', arguments: { course: question === '前面的背景' ? '背景课程' : '后续状态课', progress: question } };
    }
    return { type: 'text_delta', delta: '回答：' + question };
  });
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: '编辑资料.txt', mimeType: 'text/plain', buffer: Buffer.from('本机资料原文，仅选中后可用于回答。') });
  await expect(page.locator('.materials-panel summary')).toContainText('已选 1/1');
  await send(page, '前面的背景'); await send(page, '准备修改的原问题'); await send(page, '不应进入新请求的后续追问');
  await page.getByLabel('输入消息', { exact: true }).fill('尚未发送的草稿');
  const user = page.locator('.msg.user').nth(1);
  await user.locator('.user-message').hover(); await user.getByRole('button', { name: '编辑消息', exact: true }).click();
  const editor = page.getByRole('form', { name: '编辑用户消息' });
  await expect(editor.getByLabel('编辑消息内容')).toBeFocused();
  await editor.getByLabel('编辑消息内容').fill('修改后的问题\n第二行');
  await page.screenshot({ path: testInfo.outputPath('message-editor.png'), animations: 'disabled' });
  expect(requests).toHaveLength(5);
  await editor.getByRole('button', { name: '保存并重新发送', exact: true }).click();
  await expect(page.getByText('回答：修改后的问题\n第二行', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(6);
  const body = requests[5];
  expect(body.messages.at(-1).content).toBe('修改后的问题\n第二行');
  expect(body.messages.filter((message: any) => message.role === 'user' && message.content === '修改后的问题\n第二行')).toHaveLength(1);
  expect(body.messages.some((message: any) => message.content === '前面的背景')).toBe(true);
  expect(JSON.stringify(body)).not.toContain('准备修改的原问题');
  expect(JSON.stringify(body)).not.toContain('不应进入新请求的后续追问');
  expect(body.messages[0].content).toContain('编辑资料.txt');
  expect(body.messages[0].content).toContain('背景课程');
  expect(JSON.stringify(body)).not.toContain('后续状态课');
  await expect(page.locator('.msg.user')).toHaveCount(2);
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('尚未发送的草稿');
  await expect(page.getByRole('status', { name: '本机存储状态' })).toHaveText('已保存到当前浏览器');
  await page.reload();
  await expect(page.getByText('回答：修改后的问题\n第二行', { exact: true })).toBeVisible();
  await page.locator('.conversation-main').filter({ hasText: '编辑前版本' }).click();
  await expect(page.locator('.msg.user')).toHaveCount(3);
  await expect(page.getByText('准备修改的原问题', { exact: true })).toBeVisible();
  await expect(page.locator('.msg.user .bubble').filter({ hasText: '不应进入新请求的后续追问' })).toBeVisible();
  await expect(page.locator('.materials-panel summary')).toContainText('已选 1/1');
  await expect(page.getByLabel('学习位置')).toContainText('后续状态课');
  expect(requests).toHaveLength(6);
});

test('empty or unchanged edits cannot send; Escape cancels, restores focus and preserves the draft', async ({ page }) => {
  const requests = await ready(page);
  await send(page, '原始消息');
  await page.getByLabel('输入消息', { exact: true }).fill('输入框草稿');
  const user = page.locator('.msg.user').first();
  await user.locator('.user-message').hover(); await user.getByRole('button', { name: '编辑消息', exact: true }).click();
  const save = page.getByRole('button', { name: '保存并重新发送', exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel('编辑消息内容').fill('   '); await expect(save).toBeDisabled();
  await page.getByLabel('编辑消息内容').fill('多行草稿'); await page.getByLabel('编辑消息内容').press('Enter');
  await expect(page.getByLabel('编辑消息内容')).toHaveValue('多行草稿\n');
  await page.getByLabel('编辑消息内容').press('Escape');
  await expect(page.getByRole('form', { name: '编辑用户消息' })).toHaveCount(0);
  await expect(user.getByRole('button', { name: '编辑消息', exact: true })).toBeFocused();
  await expect(user.locator('.bubble')).toHaveText('原始消息');
  await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('输入框草稿');
  expect(requests).toHaveLength(1);
  await expect(page.locator('.conversation-main').filter({ hasText: '编辑前版本' })).toHaveCount(0);
});

test('clipboard rejection explains recovery and a running reply locks editing', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests = await ready(page, async body => {
    if (body.messages.at(-1).content === '等待中的消息') await held;
    return { type: 'text_delta', delta: '回答：' + body.messages.at(-1).content };
  });
  await send(page, '原消息');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } } }));
  const user = page.locator('.msg.user').first();
  await user.locator('.user-message').hover(); await user.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('浏览器未允许复制');
  try {
    await page.getByLabel('输入消息', { exact: true }).fill('等待中的消息');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await user.locator('.user-message').hover();
    await expect(user.getByRole('button', { name: '编辑消息', exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2);
});

test.describe('touch devices', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('actions remain reachable without hover and editing fits the screen in dark mode', async ({ page }, testInfo) => {
    const requests = await ready(page);
    await send(page, '手机上的消息');
    const user = page.locator('.msg.user').first();
    await expect(user.getByRole('group', { name: '消息操作' })).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: '切换为深色模式', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('message-actions-dark-mobile.png'), animations: 'disabled' });
    await user.getByRole('button', { name: '编辑消息', exact: true }).tap();
    await expect(page.getByLabel('编辑消息内容')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.getByLabel('编辑消息内容').fill('修改后的手机消息');
    await page.getByRole('button', { name: '保存并重新发送', exact: true }).tap();
    await expect(page.getByText('回答：修改后的手机消息', { exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
  });
});
