import { test, expect, type Page } from '@playwright/test';

const session = { user: { id: 'recovery-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };

// Control only the HTTP fetch/stream boundary. The UI, Agent, tools and IndexedDB are real.
async function controlledModel(page: Page, abortable = false) {
  await page.addInitScript(abortable => {
    const original = window.fetch.bind(window);
    const calls: { body: any; stream: ReadableStreamDefaultController<Uint8Array> }[] = [];
    (window as any).modelCalls = calls;
    window.fetch = async (url, options) => {
      if (url !== '/api/model') return original(url, options);
      const body = JSON.parse(options!.body as string);
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        calls.push({ body, stream });
        if (abortable) options?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
        stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'start', requestId: body.requestId }) + '\n\n'));
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, abortable);
}
async function emit(page: Page, index: number, events: object[], close = false) {
  await page.waitForFunction(i => (window as any).modelCalls?.length > i, index);
  await page.evaluate(({ index, events, close }) => {
    const stream = (window as any).modelCalls[index].stream;
    for (const event of events) stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    if (close) stream.close();
  }, { index, events, close });
}
async function send(page: Page, text: string) {
  await page.getByLabel('输入消息').fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}
async function ready(page: Page, config = session, abortable = false) {
  await page.route('**/api/health', r => r.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/session', r => r.fulfill({ json: config }));
  await controlledModel(page, abortable);
  await page.goto('/');
  await expect(page.getByLabel('输入消息')).toBeEnabled();
}

async function enterWithToken(page: Page, token: string) {
  await page.getByLabel('内部访问口令').fill(token);
  await page.getByRole('button', { name: '进入学习空间' }).click();
}

async function storageFaults(page: Page, initiallyUnavailable = false) {
  await page.addInitScript(initiallyUnavailable => {
    (window as any).storageFault = initiallyUnavailable ? 'unavailable' : '';
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      if ((window as any).storageFault === 'unavailable') throw new DOMException('Storage unavailable', 'SecurityError');
      return Reflect.apply(open, this, args);
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if ((window as any).storageFault === 'write' && args[1] === 'readwrite') throw new DOMException('Storage full', 'QuotaExceededError');
      return Reflect.apply(transaction, this, args);
    };
  }, initiallyUnavailable);
}

for (const fault of ['write', 'unavailable'] as const) {
  test(`same-user expiry recovery preserves unsaved results with storage ${fault}`, async ({ page }) => {
    // #9 keeps records unloaded (with 重试读取) when storage is unavailable at startup,
    // so both faults begin after a successful read and break storage mid-session.
    await storageFaults(page);
    await ready(page);
    await page.route('**/api/internal/session', r => r.fulfill({ json: r.request().postDataJSON().accessToken === 'other-user-token' ? { ...session, user: { id: 'other-user', name: 'other' } } : session }));
    await send(page, '已保存的问题');
    await emit(page, 0, [{ type: 'text_delta', delta: '已保存的回答' }, { type: 'finish', stopReason: 'stop' }], true);
    await expect(page.getByText('已保存到当前浏览器')).toBeVisible();
    await page.evaluate(fault => { (window as any).storageFault = fault; }, fault);
    const index = 1;
    await send(page, '未保存的原问题');
    await emit(page, index, [{ type: 'text_delta', delta: '尚未保存的部分结果' }]);
    await expect(page.getByText('尚未保存的部分结果', { exact: true })).toBeVisible();
    await emit(page, index, [{ type: 'error', code: 'AUTH_REQUIRED', message: 'expired' }], true);
    await enterWithToken(page, 'other-user-token');
    await expect(page.getByRole('alert')).toContainText('原用户的记录未保存');
    await expect(page.getByLabel('输入消息')).toHaveCount(0);
    await enterWithToken(page, 'same-user-token');
    await expect(page.getByLabel('输入消息')).toBeEnabled();
    await expect(page.getByText('尚未保存的部分结果', { exact: true })).toBeVisible();
    await expect(page.getByText('失败', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /未保存|保存失败/ })).toContainText('刷新');
    expect(await page.evaluate(() => (window as any).modelCalls.length)).toBe(index + 1);
    await page.evaluate(() => { (window as any).storageFault = ''; });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await emit(page, index + 1, [{ type: 'text_delta', delta: '保存恢复后的回答' }, { type: 'finish', stopReason: 'stop' }], true);
    await expect(page.getByText('保存恢复后的回答', { exact: true })).toBeVisible();
  });
}

for (const status of ['failed', 'cancelled', 'running', 'limited'] as const) {
  test(`retry of ${status} follows the original question and submits only completed history once`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async status => {
      // Fixture setup at the persisted-record boundary; assertions use only UI and model requests.
      const rows = [
        { id: 'u-good', role: 'user', text: '有效历史问题' },
        { id: 'a-good', role: 'assistant', text: '有效历史回答', status: 'completed', replyTo: 'u-good' },
        { id: 'u-bad', role: 'user', text: '失败历史问题' },
        { id: 'a-bad', role: 'assistant', text: '不可提交的失败回答', status: 'failed', replyTo: 'u-bad' },
        { id: 'original', role: 'user', text: '原始问题' },
        { id: 'unrelated', role: 'user', text: '相邻但无关的问题' },
        { id: 'retry', role: 'assistant', text: '未完成回答', status, replyTo: 'original' },
      ].map((m, i) => ({ ...m, conversationId: 'restored', createdAt: i + 1 }));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('cramameleon', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('users', 'readwrite');
        transaction.objectStore('users').put({ version: 2, messages: rows, states: {} }, 'recovery-user');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      });
    }, status);
    await page.reload();
    await expect(page.getByText(status === 'running' ? '已中断' : status === 'cancelled' ? '已停止' : status === 'limited' ? '达到上限' : '失败', { exact: true }).last()).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await emit(page, 0, [{ type: 'text_delta', delta: '重试成功' }, { type: 'finish', stopReason: 'stop' }], true);
    await expect(page.getByText('重试成功', { exact: true })).toBeVisible();
    const messages = await page.evaluate(() => (window as any).modelCalls[0].body.messages);
    expect(messages.filter((m: any) => m.role !== 'system')).toEqual([
      { role: 'user', content: '有效历史问题' }, { role: 'assistant', content: '有效历史回答' }, { role: 'user', content: '原始问题' },
    ]);
    await expect(page.locator('.msg.user')).toHaveCount(4);
  });
}

test('output limit preserves partial text and offers retry with a limited terminal status', async ({ page }) => {
  await ready(page);
  await send(page, '输出太长的问题');
  await emit(page, 0, [{ type: 'text_delta', delta: '输出上限前的内容' }, { type: 'finish', stopReason: 'length' }], true);
  await expect(page.getByText('达到上限', { exact: true })).toBeVisible();
  await expect(page.getByText('输出上限前的内容', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('缩小问题');
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
});

for (const [code, message] of [
  ['NETWORK_ERROR', '网络连接失败，请检查网络或 SSH 转发后重试。'],
  ['MODEL_STREAM_INTERRUPTED', '回答传输中断，已保留收到的内容。请重试。'],
  ['BUDGET_EXCEEDED', '今日模型额度不足，请等待北京时间次日额度恢复后重试。正在进行的请求也会占用额度。'],
  ['TOTAL_BUDGET_EXCEEDED', '全站模型额度已用完，暂时无法继续提问。'],
  ['CONCURRENCY_LIMIT', '当前请求过多或上一请求仍在结束，请稍后重试。'],
  ['MODEL_NOT_CONFIGURED', '模型尚未配置，请联系维护者配置模型，然后点击“重新检查模型状态”；就绪后可重试原问题。'],
]) {
  test(`${code} explains the cause and available recovery action`, async ({ page }) => {
    await ready(page);
    await send(page, '触发错误');
    for (let i = 0; i < (['NETWORK_ERROR', 'MODEL_STREAM_INTERRUPTED'].includes(code) ? 3 : 1); i++) {
      await emit(page, i, [{ type: 'error', code, message: 'opaque upstream detail' }], true);
    }
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    if (code === 'MODEL_NOT_CONFIGURED') {
      await expect(page.getByLabel('输入消息')).toBeDisabled();
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeDisabled();
    } else {
      await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    }
  });
}

test('model readiness recovery rechecks session without model calls and retries the original question once', async ({ page }) => {
  await ready(page);
  await send(page, '模型恢复后仍要回答的原问题');
  await emit(page, 0, [{ type: 'error', code: 'MODEL_NOT_CONFIGURED', message: 'not configured' }], true);
  await expect(page.getByLabel('输入消息')).toBeDisabled();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: '联系维护者' }).first()).toContainText('重新检查模型状态');

  await page.route('**/api/session', r => r.fulfill({ json: { ...session, modelReady: false } }));
  await page.getByRole('button', { name: '重新检查模型状态', exact: true }).click();
  await expect(page.getByText('模型仍未配置，请联系维护者配置后再次检查。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).modelCalls.length)).toBe(1);

  // Rechecking uses the same expiry handling as the post-turn session refresh.
  await page.route('**/api/session', r => r.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED' } } }));
  await page.getByRole('button', { name: '重新检查模型状态', exact: true }).click();
  await expect(page.getByLabel('内部访问口令')).toBeVisible();
  await page.route('**/api/internal/session', r => r.fulfill({ json: { ...session, modelReady: false } }));
  await enterWithToken(page, 'same-user-token');
  await page.route('**/api/session', r => r.fulfill({ json: session }));
  await page.getByRole('button', { name: '重新检查模型状态', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).modelCalls.length)).toBe(1);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await emit(page, 1, [{ type: 'text_delta', delta: '模型恢复后的回答' }, { type: 'finish', stopReason: 'stop' }], true);
  await expect(page.getByText('模型恢复后的回答', { exact: true })).toBeVisible();
  const requests = await page.evaluate(() => (window as any).modelCalls.map((call: any) => call.body.messages.filter((message: any) => message.role !== 'system')));
  expect(requests).toEqual([
    [{ role: 'user', content: '模型恢复后仍要回答的原问题' }],
    [{ role: 'user', content: '模型恢复后仍要回答的原问题' }],
  ]);
  await expect(page.locator('.msg.user')).toHaveCount(1);
});

test('a post-run session check returning 401 returns to entry and preserves the completed answer', async ({ page }) => {
  await ready(page);
  await page.route('**/api/session', r => r.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED' } } }));
  await page.route('**/api/internal/session', r => r.fulfill({ json: session }));
  await send(page, '完成后失效的问题');
  await emit(page, 0, [{ type: 'text_delta', delta: '已完成的回答' }, { type: 'finish', stopReason: 'stop' }], true);
  await expect(page.getByLabel('内部访问口令')).toBeVisible();
  await enterWithToken(page, 'test-token');
  await expect(page.getByText('已完成的回答', { exact: true })).toBeVisible();
  await expect(page.getByText('已中断', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
});

test('a delayed old session response cannot restore revoked access or overwrite the re-entered user', async ({ page }) => {
  await ready(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let refreshStarted!: () => void;
  const refreshing = new Promise<void>(resolve => { refreshStarted = resolve; });
  await page.route('**/api/session', async r => {
    refreshStarted();
    await held;
    await r.fulfill({ json: session });
  });
  await send(page, '旧用户的记录');
  await emit(page, 0, [{ type: 'text_delta', delta: '旧用户的回答' }, { type: 'finish', stopReason: 'stop' }], true);
  await refreshing;
  await send(page, '导致失效的问题');
  await emit(page, 1, [{ type: 'error', code: 'AUTH_REQUIRED', message: 'expired' }], true);
  await expect(page.getByLabel('内部访问口令')).toBeVisible();
  await page.route('**/api/internal/session', r => r.fulfill({ json: { ...session, user: { id: 'other-user', name: 'other' } } }));
  await enterWithToken(page, 'other-token');
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  const response = page.waitForResponse('**/api/session');
  release();
  await response;
  await expect(page.getByText('旧用户的回答', { exact: true })).toHaveCount(0);
  await expect(page.locator('.msg')).toHaveCount(0);
  await page.route('**/api/logout', r => r.fulfill({ status: 204 }));
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.route('**/api/internal/session', r => r.fulfill({ json: session }));
  await enterWithToken(page, 'original-token');
  await expect(page.getByText('旧用户的回答', { exact: true })).toBeVisible();
  await expect(page.getByText('失败', { exact: true })).toBeVisible();
});

for (const ending of ['stop', 'timeout'] as const) {
  test(`${ending} preserves an already published quiz, sources and partial text across reload`, async ({ page }) => {
    await ready(page, { ...session, limits: { ...session.limits, timeoutSeconds: ending === 'timeout' ? 1 : 120 } }, ending === 'timeout');
    await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('条件概率的分母是条件事件的概率 P(B)。') });
    await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toBeChecked();
    await send(page, '根据资料出题');
    await emit(page, 0, [{ type: 'tool_call', id: 'search', name: 'search_context', arguments: { query: '条件概率' } }, { type: 'finish', stopReason: 'toolUse' }], true);
    await page.waitForFunction(() => (window as any).modelCalls.length > 1);
    const ref = await page.evaluate(() => {
      const chunk = JSON.parse((window as any).modelCalls[1].body.messages.at(-1).content).chunks[0];
      return { documentId: chunk.documentId, chunkId: chunk.chunkId };
    });
    await emit(page, 1, [{ type: 'tool_call', id: 'quiz', name: 'present_quiz', arguments: { question: '条件概率的分母？', options: [{ id: 'A', text: 'P(B)', explanation: '条件事件的概率' }, { id: 'B', text: 'P(A)', explanation: '不是条件事件的概率' }], correctOptionId: 'A', origin: 'adapted', sourceRefs: [ref] } }, { type: 'finish', stopReason: 'toolUse' }], true);
    await emit(page, 2, [{ type: 'text_delta', delta: '结束前的讲解' }]);
    await expect(page.getByText('结束前的讲解', { exact: true })).toBeVisible();
    if (ending === 'stop') await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByText(ending === 'stop' ? '已停止' : '达到上限', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    await expect(page.getByText('条件概率的分母？', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '▧ recovery.txt', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('条件概率的分母是条件事件的概率');
    await page.getByRole('button', { name: '关闭来源' }).click();
    await page.waitForTimeout(350);
    await page.reload();
    await expect(page.getByText(ending === 'stop' ? '已停止' : '达到上限', { exact: true })).toBeVisible();
    await expect(page.getByText('结束前的讲解', { exact: true })).toBeVisible();
    await expect(page.getByText('条件概率的分母？', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '▧ recovery.txt', exact: true })).toBeVisible();
  });
}

test('a transport failure and an unfinished stream produce distinct recoverable errors', async ({ page }) => {
  await page.route('**/api/health', r => r.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/session', r => r.fulfill({ json: session }));
  await page.route('**/api/model', r => r.abort('internetdisconnected'));
  await page.goto('/');
  await send(page, '网络失败的问题');
  await expect(page.getByText('网络连接失败，请检查网络或 SSH 转发后重试。', { exact: true })).toBeVisible();
  await page.route('**/api/model', r => {
    const body = r.request().postDataJSON();
    return r.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'start', requestId: body.requestId }, { type: 'text_delta', delta: '连接中断前的文字' },
    ].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') });
  });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('回答传输中断，已保留收到的内容。请重试。', { exact: true })).toBeVisible();
  await expect(page.getByText('连接中断前的文字', { exact: true })).toBeVisible();
  await expect(page.locator('.msg.user')).toHaveCount(1);
});

test('native stream error after visible output shows interruption guidance (#14)', async ({ page }) => {
  await ready(page);
  await send(page, '传输中断前的问题');
  await emit(page, 0, [{ type: 'text_delta', delta: '连接重置前已显示的部分结果' }]);
  await expect(page.getByText('连接重置前已显示的部分结果', { exact: true })).toBeVisible();
  for (let i = 0; i < 3; i++) {
    if (i > 0) await emit(page, i, [{ type: 'text_delta', delta: '连接重置前已显示的部分结果' }]);
    await page.evaluate(i => (window as any).modelCalls[i].stream.error(new TypeError('simulated connection reset')), i);
  }
  await expect(page.getByText('失败', { exact: true })).toBeVisible();
  await expect(page.getByText('连接重置前已显示的部分结果', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  await expect(page.getByText('回答传输中断，已保留收到的内容。请重试。', { exact: true })).toBeVisible();
});

test('HTTP AUTH_REQUIRED returns to entry without allowing another model request', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/health', r => r.fulfill({ json: { status: 'ok' } }));
  await page.route('**/api/session', r => r.fulfill({ json: session }));
  await page.route('**/api/model', r => { calls++; return r.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED', message: '应用会话已失效' } } }); });
  await page.goto('/');
  await send(page, '过期请求');
  await expect(page.getByLabel('内部访问口令')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('重新进入');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveCount(0);
  expect(calls).toBe(1);
});

test.describe('mobile recovery', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('stop, expiry and same-user re-entry preserve material selection, preference and messages', async ({ page }) => {
    await ready(page);
    await page.route('**/api/internal/session', r => r.fulfill({ json: session }));
    await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'mobile.txt', mimeType: 'text/plain', buffer: Buffer.from('手机恢复的学习资料') });
    await expect(page.getByLabel('使用资料 mobile.txt', { exact: true })).toBeChecked();
    await send(page, '回答简短');
    await emit(page, 0, [{ type: 'text_delta', delta: '好的' }, { type: 'finish', stopReason: 'stop' }], true);
    await expect(page.getByLabel('输入消息')).toBeEnabled();
    await send(page, '手机问题');
    await emit(page, 1, [{ type: 'text_delta', delta: '手机上保留的内容' }]);
    await expect(page.getByText('手机上保留的内容', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByLabel('输入消息')).toBeEnabled();
    await send(page, '应用会话过期');
    await emit(page, 2, [{ type: 'error', code: 'AUTH_REQUIRED', message: 'expired' }], true);
    await expect(page.getByLabel('内部访问口令')).toBeVisible();
    await enterWithToken(page, 'test-token');
    await expect(page.getByText('手机上保留的内容', { exact: true })).toBeVisible();
    await expect(page.getByText('已停止', { exact: true })).toBeVisible();
    await expect(page.getByLabel('使用资料 mobile.txt', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await emit(page, 3, [{ type: 'text_delta', delta: '手机恢复成功' }, { type: 'finish', stopReason: 'stop' }], true);
    const retry = await page.evaluate(() => (window as any).modelCalls[3].body);
    expect(retry.messages[0].content).toContain('"instructions":["回答简短"]');
    await expect(page.getByText('手机恢复成功', { exact: true })).toBeVisible();
    await page.waitForTimeout(350);
    await page.reload();
    await expect(page.getByText('手机恢复成功', { exact: true })).toBeVisible();
    await expect(page.getByLabel('使用资料 mobile.txt', { exact: true })).toBeChecked();
  });
});

test('session expiry blocks learning and same-user re-entry retains the failed turn and its partial text', async ({ page }) => {
  await ready(page);
  await page.route('**/api/internal/session', r => r.fulfill({ json: session }));
  await send(page, '需要保留的问题');
  await emit(page, 0, [{ type: 'text_delta', delta: '会话失效前的内容' }]);
  await expect(page.getByText('会话失效前的内容', { exact: true })).toBeVisible();
  await emit(page, 0, [{ type: 'error', code: 'AUTH_REQUIRED', message: 'expired' }], true);
  await expect(page.getByLabel('内部访问口令')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('应用会话已失效');
  await expect(page.getByLabel('输入消息')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).modelCalls.length)).toBe(1);
  await enterWithToken(page, 'test-token');
  await expect(page.getByText('会话失效前的内容', { exact: true })).toBeVisible();
  await expect(page.getByText('失败', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await emit(page, 1, [{ type: 'text_delta', delta: '重新进入后的回答' }, { type: 'finish', stopReason: 'stop' }], true);
  const request = await page.evaluate(() => (window as any).modelCalls[1].body);
  expect(request.messages.filter((m: any) => m.role !== 'system')).toEqual([{ role: 'user', content: '需要保留的问题' }]);
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.getByText('重新进入后的回答', { exact: true })).toBeVisible();
  await page.waitForTimeout(350);
  await page.reload();
  await expect(page.getByText('重新进入后的回答', { exact: true })).toBeVisible();
  await expect(page.locator('.msg.user')).toHaveCount(1);
});

test('stop preserves partial output and releases the UI before the old stream settles; late output cannot change either turn', async ({ page }) => {
  await ready(page);
  await send(page, '停止前的问题');
  await emit(page, 0, [{ type: 'text_delta', delta: '已收到的部分' }]);
  await expect(page.getByText('已收到的部分', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  await send(page, '后续问题');
  await emit(page, 0, [{ type: 'text_delta', delta: '迟到的旧回答' }, { type: 'finish', stopReason: 'stop' }], true);
  await emit(page, 1, [{ type: 'text_delta', delta: '新的回答' }, { type: 'finish', stopReason: 'stop' }], true);
  await expect(page.getByText('新的回答', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.getByText('已收到的部分', { exact: true })).toBeVisible();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByText(/迟到的旧回答/)).toHaveCount(0);
  const history = await page.evaluate(() => (window as any).modelCalls[1].body.messages);
  expect(history.filter((m: any) => m.role !== 'system')).toEqual([{ role: 'user', content: '后续问题' }]);
  await expect(page.getByText('已保存到当前浏览器')).toBeVisible();
  await page.reload();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByText('已收到的部分', { exact: true })).toBeVisible();
});


test('automatic retry replaces partial text without duplicating the question', async ({ page }) => {
 await ready(page);
 await send(page, '自动恢复这个回答');
 await emit(page, 0, [{ type: 'text_delta', delta: '被截断的旧内容' }]);
 await expect(page.getByText('被截断的旧内容', { exact: true })).toBeVisible();
 await page.evaluate(() => (window as any).modelCalls[0].stream.error(new TypeError('reset')));
 await emit(page, 1, [{ type: 'text_delta', delta: '自动恢复后的完整内容' }, { type: 'finish', stopReason: 'stop' }], true);
 await expect(page.getByText('自动恢复后的完整内容', { exact: true })).toBeVisible();
 await expect(page.getByText('被截断的旧内容', { exact: true })).toHaveCount(0);
 await expect(page.locator('.msg.user')).toHaveCount(1);
 await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
 expect(await page.evaluate(() => (window as any).modelCalls.length)).toBe(2);
});
