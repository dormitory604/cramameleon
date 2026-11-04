import { test, expect, type Page } from '@playwright/test';

const session = { user: { id: 'continuity-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 1024 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
type Request = { sessionId: string; turnId: string; requestId: string; messages: { role: string; content: string; tool_call_id?: string }[]; tools: { function: { name: string } }[] };
type Step = { type: 'text_delta'; delta: string } | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> };
const text = (delta: string): Step => ({ type: 'text_delta', delta });
const call = (name: string, args: Record<string, unknown>): Step => ({ type: 'tool_call', id: crypto.randomUUID(), name, arguments: args });

// Control only the HTTP model boundary. The UI, Pi loop, tools and browser storage are real.
async function modelBoundary(page: Page, steps: Step[]) {
  const requests: Request[] = [];
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/model', async route => {
    const body = route.request().postDataJSON() as Request;
    requests.push(body);
    const step = steps.shift();
    expect(step, 'unexpected extra model request').toBeDefined();
    const events = [{ type: 'start', requestId: body.requestId }, step,
      { type: 'usage', usage: { input: 1, output: 1, total: 2 } },
      { type: 'finish', stopReason: step?.type === 'tool_call' ? 'toolUse' : 'stop' }];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
  });
  await page.goto('/');
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  return requests;
}
async function send(page: Page, value: string) {
  await page.getByLabel('输入消息').fill(value);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}
async function reloadSaved(page: Page) {
  await expect(page.getByRole('status', { name: '本机存储状态' })).toHaveText('已保存到当前浏览器');
  await page.reload();
  await expect(page.getByLabel('输入消息')).toBeEnabled();
}

test('storage status tracks the latest edit before reload and deletion', async ({ page }) => {
  await modelBoundary(page, [text('已开始学习。')]);
  await send(page, '开始学习');
  await reloadSaved(page);

  const status = page.getByRole('status', { name: '本机存储状态' });
  const transitions: string[] = [];
  await page.exposeFunction('recordStorageStatus', (value: string) => transitions.push(value));
  await status.evaluate(element => {
    const record = () => void (window as unknown as { recordStorageStatus(value: string): Promise<void> }).recordStorageStatus(element.textContent ?? '');
    new MutationObserver(record).observe(element, { childList: true, characterData: true, subtree: true });
  });
  await page.getByText('当前对话偏好', { exact: true }).click();
  const preference = page.getByPlaceholder('例如：回答简短，不主动出题');
  await preference.fill('用具体例子简短讲解');
  await expect.poll(() => transitions).toContain('正在保存到当前浏览器');
  await reloadSaved(page);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference).toHaveValue('用具体例子简短讲解');

  await preference.fill('详细解释必要条件');
  await reloadSaved(page);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference).toHaveValue('详细解释必要条件');
  await page.getByRole('button', { name: '删除对话 开始学习', exact: true }).click();
  await reloadSaved(page);
  await expect(page.getByText('还没有对话', { exact: true })).toBeVisible();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference).toHaveValue('');
});

test('chapter-only learning location is visible and restored without claiming mastery', async ({ page }) => {
  const steps = [call('update_learning_state', { chapter: '条件概率', phase: 'learning' }), text('先看已知条件如何改变计算范围。')];
  const requests = await modelBoundary(page, steps);
  await send(page, '先讲条件概率');
  const location = page.getByLabel('学习位置', { exact: true });
  await expect(location).toContainText('条件概率');
  await expect(location).not.toContainText(/掌握|已学会/);
  await reloadSaved(page);
  await expect(location).toContainText('条件概率');
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1)?.role).toBe('tool');
  expect(requests[1].messages.at(-1)?.content).toContain('条件概率');
  expect(steps).toHaveLength(0);
});

test('wide review waits for a choice, then continues from the actual saved location', async ({ page }) => {
  const steps = [
    call('read_skill', { name: 'review' }),
    call('update_learning_state', { course: '概率论', chapter: '', progress: '等待选择复习部分', phase: 'scope' }),
    text('按通用知识，可以选事件与条件概率、随机变量、期望与方差。你想先复习哪一部分？'),
  ];
  const requests = await modelBoundary(page, steps);
  await send(page, '带我复习概率论，目前没有资料。先给几个可选部分。');
  await expect(page.getByText('等待你的选择', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续学习', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('学习位置')).toContainText('等待选择复习部分');
  expect(requests).toHaveLength(3);
  expect(requests[1].messages.at(-1)?.content).toContain('系统复习');
  await reloadSaved(page);
  await expect(page.getByText('等待你的选择', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(3);

  steps.push(call('update_learning_state', { phase: 'scope' }), text('还没有选范围，你想先复习哪一部分？'));
  await send(page, '继续');
  expect(requests[3].messages[0].content).toContain('"phase":"scope"');
  await expect(page.getByText('等待你的选择', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '继续学习', exact: true })).toHaveCount(0);

  steps.push(
    call('read_skill', { name: 'review' }),
    call('update_learning_state', { chapter: '条件概率', progress: '已讲条件概率的分母与正概率条件', phase: 'learning' }),
    text('条件概率在已知条件限定的范围内计算。$P(A\\mid B)=P(A\\cap B)/P(B)$，要求 $P(B)>0$。'),
  );
  await send(page, '我选条件概率，直接讲这一部分，别出题。');
  expect(requests[5].messages.at(-1)?.content).toBe('我选条件概率，直接讲这一部分，别出题。');
  expect(requests[5].tools.some(tool => tool.function.name === 'present_quiz')).toBe(false);
  const reviewSkill = JSON.parse(requests[6].messages.at(-1)!.content);
  expect(reviewSkill.name).toBe('review');
  expect(reviewSkill.text).toContain('$P(A\\cap B) = P(A)P(B)$');
  expect(reviewSkill.text).toContain('$P(B) > 0$');
  await expect(page.getByLabel('学习位置')).toContainText('已讲条件概率的分母与正概率条件');
  await expect(page.locator('.quiz')).toHaveCount(0);
  await reloadSaved(page);

  steps.push(call('update_learning_state', { progress: '已讲独立时条件概率不变', phase: 'learning' }),
    text('独立时仍可用条件概率：$P(A\\mid B)=P(A)$，前提是 $P(B)>0$。'));
  await page.getByRole('button', { name: '继续学习', exact: true }).click();
  await expect(page.getByLabel('学习位置')).toContainText('已讲独立时条件概率不变');
  const continuation = requests[8];
  expect(continuation.messages.at(-1)?.content).toBe('请接着刚才的内容继续。');
  expect(continuation.messages[0].content).toContain('"chapter":"条件概率"');
  expect(continuation.messages[0].content).toContain('已讲条件概率的分母与正概率条件');
  expect(continuation.messages.some(message => message.role === 'assistant' && message.content.includes('P(B)>0'))).toBe(true);
  expect(continuation.tools.some(tool => tool.function.name === 'present_quiz')).toBe(false);
  await expect(page.locator('.msg.assistant').last().locator('.msg-text')).toContainText('独立时仍可用条件概率');
  await expect(page.locator('.msg.assistant').last().locator('.katex')).toHaveCount(2);
  await expect(page.getByLabel('学习位置')).not.toContainText('掌握');
  expect(requests).toHaveLength(10);
  expect(steps).toHaveLength(0);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`already named chapter enters content directly at width ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const steps = [call('read_skill', { name: 'review' }),
      call('update_learning_state', { course: '概率论', chapter: '条件概率', progress: '已讲条件概率定义', phase: 'learning' }),
      text('从条件概率开始：条件事件 $B$ 已发生时，计算 $P(A\\mid B)$；要求 $P(B)>0$。')];
    const requests = await modelBoundary(page, steps);
    await send(page, '带我复习概率论的条件概率，别出题。');
    await expect(page.getByLabel('学习位置')).toContainText('条件概率');
    await expect(page.getByText('等待你的选择', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '继续学习', exact: true })).toBeVisible();
    await expect(page.locator('.msg-text')).toContainText('从条件概率开始');
    await expect(page.locator('.katex')).toHaveCount(3);
    await expect(page.locator('.katex-error')).toHaveCount(0);
    expect(await page.evaluate(async () => (await document.fonts.load('16px KaTeX_Main')).length)).toBeGreaterThan(0);
    const box = await page.getByLabel('学习位置').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(requests).toHaveLength(3);
    expect(requests[0].messages.at(-1)?.content).toBe('带我复习概率论的条件概率，别出题。');
    expect(steps).toHaveLength(0);
  });
}

for (const change of [
  { input: '简单点', output: '条件概率是在已知条件下计算的概率。', facts: ['已知条件', '概率'], chapter: '条件概率', progress: '已简述条件概率' },
  { input: '直接给答案：已知条件下概率是 3/6，是多少？', output: '答案是 $1/2$。', facts: ['答案', '1/2'], chapter: '条件概率', progress: '已给出当前计算答案' },
  { input: '别出题，继续讲', output: '独立时，知道条件不改变事件的概率。', facts: ['独立', '不改变'], chapter: '条件概率', progress: '已讲独立性关系' },
  { input: '跳过这个例子，讲独立性', output: '事件独立表示知道一个事件发生不改变另一个事件的概率。', facts: ['独立', '另一个事件'], chapter: '独立性', progress: '已跳过例子，讲独立性定义' },
  { input: '换章节，讲期望，不要出题', output: '期望是按概率加权的平均值。', facts: ['期望', '加权'], chapter: '期望', progress: '已讲期望定义' },
]) {
  test(`latest request reaches the current turn: ${change.input}`, async ({ page }) => {
    const steps = [call('update_learning_state', { course: '概率论', chapter: '条件概率', progress: '已讲条件概率定义', phase: 'learning' }),
      text('已知条件后，在条件限定的范围内计算。')];
    const requests = await modelBoundary(page, steps);
    await send(page, '带我复习条件概率');
    steps.push(call('update_learning_state', { chapter: change.chapter, progress: change.progress, phase: 'learning' }), text(change.output));
    await send(page, change.input);
    expect(requests[2].messages.at(-1)).toMatchObject({ role: 'user', content: change.input });
    expect(requests[2].messages.some(message => message.role === 'assistant' && message.content.includes('条件限定的范围'))).toBe(true);
    for (const fact of change.facts) await expect(page.locator('.msg.assistant').last().locator('.msg-text')).toContainText(fact);
    await expect(page.locator('.quiz')).toHaveCount(0);
    await expect(page.getByLabel('学习位置')).toContainText(change.chapter);
    await expect(page.getByLabel('学习位置')).toContainText(change.progress);
    await expect(page.getByLabel('学习位置')).not.toContainText(/掌握|已学会/);
    if (/别出题|不要出题/.test(change.input)) expect(requests[2].tools.some(tool => tool.function.name === 'present_quiz')).toBe(false);
    expect(requests).toHaveLength(4);
    expect(steps).toHaveLength(0);
  });
}

test('one-turn preferences expire after reload while session preferences persist and remain editable', async ({ page }) => {
  const steps = [text('会话内可以出题。')];
  const requests = await modelBoundary(page, steps);
  await page.getByText('当前对话偏好', { exact: true }).click();
  const preference = page.getByPlaceholder('例如：回答简短，不主动出题');
  await preference.fill('详细讲解');
  await send(page, '以后可以出题');
  expect(requests[0].tools.some(tool => tool.function.name === 'present_quiz')).toBe(true);

  const temporary = '这次别出题，简单点，直接讲互斥事件的加法公式。';
  steps.push(call('update_learning_state', { chapter: '互斥事件', progress: '已讲互斥加法公式', phase: 'learning', preference: { text: temporary, scope: 'turn' } }),
    text('互斥事件不会同时发生，所以 $P(A\\cup B)=P(A)+P(B)$。'));
  await send(page, temporary);
  expect(requests[1].messages.at(-1)?.content).toBe(temporary);
  expect(requests[1].messages[0].content).toContain('不能反推交集为空');
  expect(requests[1].tools.some(tool => tool.function.name === 'present_quiz')).toBe(false);
  await expect(preference).toHaveValue('详细讲解');
  await expect(page.getByText(/^已记住：/)).toHaveCount(0);
  await reloadSaved(page);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference).toHaveValue('详细讲解');

  steps.push(text('沿用会话偏好详细讲解，可以按需练习。'));
  await send(page, '接着讲');
  expect(requests[3].messages[0].content).toContain('"quizPolicy":"allow"');
  expect(requests[3].messages[0].content).toContain('"preferences":"详细讲解"');
  expect(requests[3].messages[0].content).not.toContain('"instructions":["这次');
  expect(requests[3].tools.some(tool => tool.function.name === 'present_quiz')).toBe(true);

  steps.push(text('以后只讲解，不出题。'));
  await send(page, '以后别出题');
  await expect(page.getByText(/^已记住：/)).toContainText('以后别出题');
  await reloadSaved(page);
  steps.push(text('继续只讲解互斥事件。'));
  await send(page, '继续');
  expect(requests[5].messages[0].content).toContain('"quizPolicy":"avoid"');
  expect(requests[5].tools.some(tool => tool.function.name === 'present_quiz')).toBe(false);
  expect(requests[5].messages[0].content).not.toContain(temporary);
  await page.getByRole('button', { name: '新对话' }).click();
  steps.push(text('这是新的学习会话。'));
  await send(page, '什么是期望？');
  expect(requests[6].sessionId).not.toBe(requests[5].sessionId);
  expect(requests[6].messages[0].content).toContain('"preferences":""');
  expect(requests[6].messages[0].content).not.toContain('以后别出题');
  expect(requests[6].tools.some(tool => tool.function.name === 'present_quiz')).toBe(true);
  expect(requests).toHaveLength(7);
  expect(steps).toHaveLength(0);
});

for (const simple of [
  { id: 'simple-definition', input: '什么是机会成本？用一句话说明。', output: '机会成本是做出选择时放弃的最佳可行替代方案的收益。', facts: ['最佳', '替代方案'] },
  { id: 'simple-python', input: 'Python 的 list 是什么？两句话说明。', output: 'Python 的 list 是有序、可变的序列容器，例如 `[1, "a"]`。它从 0 开始索引，能增删改元素并容纳不同类型的数据。', facts: ['有序', '可变', '0'] },
]) {
  test(`${simple.id}: direct controlled answer without teaching tools`, async ({ page }) => {
    const requests = await modelBoundary(page, [text(simple.output)]);
    await send(page, simple.input);
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1)?.content).toBe(simple.input);
    expect(requests[0].messages[0].content).toContain('按句数交付');
    for (const fact of simple.facts) await expect(page.locator('.msg-text')).toContainText(fact);
    if (simple.id === 'simple-python') await expect(page.locator('.msg-text code')).toContainText('[1, "a"]');
    await expect(page.locator('.quiz')).toHaveCount(0);
    await expect(page.locator('.tool-block')).toContainText('0 次工具调用');
    await expect(page.getByLabel('学习位置')).toHaveCount(0);
  });
}

test('concept-opportunity: necessary example constraint and best alternative reach the browser', async ({ page }) => {
  const requests = await modelBoundary(page, [call('read_skill', { name: 'concept' }),
    call('update_learning_state', { course: '经济学', chapter: '机会成本', progress: '已讲最佳可行替代方案', phase: 'learning' }),
    text('周末只能选讲座或打工，打工能赚 200 元；选讲座的机会成本就是放弃的 200 元。多个可行替代方案只取收益最佳的一个，不相加。')]);
  await send(page, '带我理解机会成本，用一个具体例子，不要出题，简短。');
  expect(requests).toHaveLength(3);
  const skill = JSON.parse(requests[1].messages.at(-1)!.content);
  expect(skill.name).toBe('concept');
  expect(skill.text).toContain('只能选一个替代方案');
  expect(requests[0].tools.some(tool => tool.function.name === 'present_quiz')).toBe(false);
  await expect(page.locator('.msg-text')).toContainText('只能选');
  await expect(page.locator('.msg-text')).toContainText('200 元');
  await expect(page.locator('.msg-text')).toContainText('不相加');
  await expect(page.locator('.quiz')).toHaveCount(0);
  await expect(page.getByLabel('学习位置')).toContainText('已讲最佳可行替代方案');
});

test('concept-bayes: published conditions and controlled base-rate arithmetic render as math', async ({ page }) => {
  const requests = await modelBoundary(page, [call('read_skill', { name: 'concept' }),
    call('update_learning_state', { course: '概率论', chapter: '贝叶斯公式', progress: '已讲基础概率与检测阳性的两条路径', phase: 'learning' }),
    text('设 $D$ 为患病，$+$ 为阳性，要求 $P(+)>0$。患病率 1%、灵敏度 99%、误报率 1% 时，10000 人中 100 人患病，99 人真阳性；9900 名健康者中也有 99 人误报。阳性总数为 198，故患病概率是 $99/198=50\\%$，不是 99%。\n\n$$\nP(D\\mid +)=\\frac{0.99\\times0.01}{0.99\\times0.01+0.01\\times0.99}=0.5\n$$\n\n分母包含真阳性与健康误报两条路径；先验患病率和两类人的阳性率共同决定结果。')]);
  await send(page, '带我理解贝叶斯公式的直觉，用一个简短例子，不出题。');
  expect(requests).toHaveLength(3);
  const skill = JSON.parse(requests[1].messages.at(-1)!.content);
  expect(skill.name).toBe('concept');
  expect(skill.text).toContain('$P(+) > 0$');
  expect(skill.text).toContain('99+99=198');
  expect(skill.text).toContain('0.99\\times0.01+0.01\\times0.99');
  await expect(page.locator('.msg-text')).toContainText('9900');
  await expect(page.locator('.msg-text')).toContainText('198');
  await expect(page.locator('.msg-text')).toContainText('50%');
  await expect(page.locator('.msg-text')).toContainText('先验');
  await expect(page.locator('.katex-display')).toHaveCount(1);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(await page.evaluate(async () => (await document.fonts.load('16px KaTeX_Main')).length)).toBeGreaterThan(0);
  await expect(page.locator('.quiz')).toHaveCount(0);
});
