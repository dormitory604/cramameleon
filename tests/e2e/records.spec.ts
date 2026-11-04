import { test, expect, type Page } from '@playwright/test';
import { controlNativeWrites } from './helpers/nativeWrites.ts';

const session = { user: { id: 'records-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
const preference = (page: Page) => page.getByPlaceholder('例如：回答简短，不主动出题');
async function enter(page: Page) {
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.goto('/');
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await page.getByText('当前对话偏好', { exact: true }).click();
}

test('readable recovery stays visible and editable when checkpoint replay writes persistently fail', async ({ page }) => {
  await controlNativeWrites(page, { abort: true });
  await enter(page);
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('恢复副本中的可读原文') });
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toBeChecked();
  await preference(page).fill('只能读取时也要恢复的偏好');
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  // A real reload persists the user-scoped checkpoint; only native writes fail.
  await page.reload();
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toBeChecked();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('只能读取时也要恢复的偏好');
  await expect(page.getByText(/已恢复.*尚未保存/)).toBeVisible();
  await expect(page.getByText(/读取本机记录失败/)).toHaveCount(0);
  await page.getByRole('button', { name: '查看文本：recovery.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('恢复副本中的可读原文');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  await page.getByRole('button', { name: '移除：recovery.txt', exact: true }).click();
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toHaveCount(0);
  await expect(preference(page)).toBeEnabled();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  await page.evaluate(() => { window.nativeWrites.abort = false; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('只能读取时也要恢复的偏好');
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/尚未保存|保存失败|读取本机记录失败/)).toHaveCount(0);
});

test('persistent write failure offers explicit exit, revokes the session and keeps recovery isolated', async ({ page }) => {
  await controlNativeWrites(page);
  await enter(page);
  let currentSession = session;
  let logoutRequests = 0;
  await page.route('**/api/session', route => route.fulfill({ json: currentSession }));
  await page.route('**/api/internal/session', route => route.fulfill({ json: currentSession }));
  await page.route('**/api/logout', route => { logoutRequests++; return route.fulfill({ json: {} }); });
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'exit-private.txt', mimeType: 'text/plain', buffer: Buffer.from('甲退出时未保存的私有原文') });
  await expect(page.getByLabel('使用资料 exit-private.txt', { exact: true })).toBeChecked();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.nativeWrites.abort = true; });
  await preference(page).fill('甲在持续写入失败时的最新偏好');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '仍然退出（可能丢失修改）', exact: true })).toBeVisible();
  await expect(page.getByText(/仍然退出可能丢失未保存的修改/)).toBeVisible();
  expect(logoutRequests).toBe(0);
  await expect(preference(page)).toHaveValue('甲在持续写入失败时的最新偏好');
  await page.getByRole('button', { name: '仍然退出（可能丢失修改）', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  expect(logoutRequests).toBe(1);
  await expect(page.getByText('甲在持续写入失败时的最新偏好', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('使用资料 exit-private.txt', { exact: true })).toHaveCount(0);
  currentSession = { ...session, user: { id: 'exit-user-b', name: 'B' } };
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await expect(page.getByLabel('使用资料 exit-private.txt', { exact: true })).toHaveCount(0);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  expect(logoutRequests).toBe(2);
  currentSession = session;
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByLabel('使用资料 exit-private.txt', { exact: true })).toBeChecked();
  await expect(page.getByText(/已恢复.*尚未保存/)).toBeVisible();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('甲在持续写入失败时的最新偏好');
  await page.getByRole('button', { name: '查看文本：exit-private.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('甲退出时未保存的私有原文');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.evaluate(() => { window.nativeWrites.abort = false; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('甲在持续写入失败时的最新偏好');
});

test('persisted page transition events interrupt turns and reject late completion while retry runs', async ({ page }) => {
  // Deterministic BFCache lifecycle boundary on a real page, not an actual cache hit.
  // A slow transport deliberately ignores abort so old Agent completion arrives late.
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => fetch(input, input === '/api/model' ? { ...init, signal: undefined } : init);
  });
  await enter(page);
  const requests: any[] = [];
  const releases: (() => void)[] = [];
  await page.route('**/api/model', async route => {
    const body = route.request().postDataJSON();
    const index = requests.length;
    requests.push(body);
    await new Promise<void>(resolve => { releases[index] = resolve; });
    await route.fulfill({ contentType: 'text/event-stream', body: index === 1 ? 'data: invalid-json\n\n' : [
      { type: 'start', requestId: body.requestId },
      { type: 'text_delta', delta: index === 0 ? '离开后不应出现的旧文字' : '生命周期中断后重试成功' },
      ...(index === 0 ? [{ type: 'tool_call', id: 'stale-position', name: 'update_learning_state', arguments: { course: '旧轮不应更新的课程', progress: '迟到位置' } }] : []),
      { type: 'finish', stopReason: index === 0 ? 'toolUse' : 'stop' },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') }).catch(() => undefined);
  });
  const departAndReturn = () => page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  try {
    await page.getByLabel('输入消息').fill('生命周期边界的问题');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    await departAndReturn();
    await expect(page.getByText('已中断', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/model'));
    releases[0]();
    await (await oldResponse).finished();
    await page.waitForTimeout(100);
    await expect(page.getByText('已中断', { exact: true })).toBeVisible();
    await expect(page.getByText('离开后不应出现的旧文字', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('学习位置')).toHaveCount(0);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    await departAndReturn();
    await expect(page.getByText('已中断', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect.poll(() => requests.length).toBe(3);
    const failedResponse = page.waitForResponse(response => response.url().endsWith('/api/model'));
    releases[1]();
    await (await failedResponse).finished();
    await page.waitForTimeout(100);
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await expect(page.locator('.msg.assistant .run-status')).toHaveText('运行中');
    await expect(page.locator('.msg.assistant .error-card')).toHaveCount(0);
    await expect(page.getByLabel('学习位置')).toHaveCount(0);
    releases[2]();
    await expect(page.getByText('生命周期中断后重试成功', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect(page.locator('.msg.user')).toHaveCount(1);
    await expect(page.locator('.msg.assistant')).toHaveCount(1);
    expect(requests[2].messages.filter((message: any) => message.role === 'user' && message.content === '生命周期边界的问题')).toHaveLength(1);
    await page.reload();
    await expect(page.getByText('生命周期中断后重试成功', { exact: true })).toBeVisible();
    await expect(page.getByText('离开后不应出现的旧文字', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('学习位置')).toHaveCount(0);
  } finally { releases.forEach(release => release()); }
});

test('new edits show saving and survive an immediate refresh before autosave', async ({ page }) => {
  await enter(page);
  await preference(page).fill('刷新前的最新偏好');
  await expect(page.getByText('正在保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('刷新前的最新偏好');
});

test('native storage quota protects pending edits on refresh and canceling navigation keeps editing live', async ({ page }) => {
  await controlNativeWrites(page);
  await enter(page);
  await preference(page).fill('已保存的旧偏好');
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  // Fill native localStorage to its actual quota; IndexedDB remains real and pending.
  const quotaFailures = await page.evaluate(() => {
    let low = 0, high = 6 * 1024 * 1024, failures = 0;
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      try { localStorage.setItem('quota-fill', 'x'.repeat(size)); low = size; }
      catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
        failures++; high = size - 1;
      }
    }
    localStorage.setItem('quota-fill', 'x'.repeat(low));
    window.nativeWrites.releaseThrough = 0;
    return failures;
  });
  expect(quotaFailures).toBeGreaterThan(0);
  await preference(page).fill('配额不足时的最新偏好');
  await page.waitForTimeout(250);
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  // Canceled reloads need not emit a navigation completion event.
  await page.reload({ timeout: 2000 }).catch(error => { if (!dialogs.length) throw error; });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  await expect(preference(page)).toHaveValue('配额不足时的最新偏好');
  // A failed recovery copy alone is not a save failure; the pending IndexedDB write decides.
  await expect(page.getByText('正在保存到当前浏览器', { exact: true })).toBeVisible();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toHaveCount(0);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = Infinity; });
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await preference(page).fill('取消离开后仍可编辑保存');
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('取消离开后仍可编辑保存');
  expect(dialogs).toEqual(['beforeunload']);
});

test('older save completion cannot announce success for newer unsaved edits; write failures can be retried', async ({ page }) => {
  // Keep real IndexedDB transactions alive, controlling only the storage boundary.
  await controlNativeWrites(page, { releaseThrough: 0 });
  await enter(page);
  await preference(page).fill('第一版');
  await page.waitForTimeout(250);
  await preference(page).fill('第二版');
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = 1; });
  await page.waitForTimeout(100);
  await expect(page.getByText('正在保存到当前浏览器', { exact: true })).toBeVisible();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.nativeWrites.abort = true; });
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  await page.evaluate(() => { window.nativeWrites.abort = false; window.nativeWrites.releaseThrough = Infinity; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  // The init script intentionally holds transactions again after navigation.
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('第二版');
});

test('deleting a running learning session removes its scope and ignores late model work', async ({ page }) => {
  await enter(page);
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'delete-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('仅属于将被删除的会话') });
  await expect(page.getByLabel('使用资料 delete-notes.txt', { exact: true })).toBeChecked();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/model', async route => {
    await pending;
    const body = route.request().postDataJSON();
    await route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'start', requestId: body.requestId },
      { type: 'tool_call', id: 'late-state', name: 'update_learning_state', arguments: { course: '不应复活', progress: '迟到位置' } },
      { type: 'finish', stopReason: 'toolUse' },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') }).catch(() => undefined);
  });
  await page.getByLabel('输入消息').fill('删除中的学习');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  const remove = page.getByRole('button', { name: '删除对话 delete-notes.txt', exact: true });
  try {
    await expect(remove).toBeEnabled();
    await remove.click();
  } finally { release(); }
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('使用资料 delete-notes.txt', { exact: true })).toHaveCount(0);
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await expect(page.getByText('不应复活', { exact: true })).toHaveCount(0);
});

test('refresh interrupts an unfinished turn and retry keeps the original question', async ({ page }) => {
  await enter(page);
  const requests: any[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/model', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (requests.length === 1) await pending;
    await route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'start', requestId: body.requestId }, { type: 'text_delta', delta: '恢复后的回答' }, { type: 'finish', stopReason: 'stop' },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') }).catch(() => undefined);
  });
  await page.getByLabel('输入消息').fill('尚未完成的问题');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.reload(); release();
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('恢复后的回答', { exact: true })).toBeVisible();
  await expect(page.locator('.msg.user')).toHaveCount(1);
  expect(requests.at(-1).messages.filter((message: any) => message.role === 'user' && message.content === '尚未完成的问题')).toHaveLength(1);
});

test('exit flushes pending edits; users stay isolated when the next read fails and recovers', async ({ page }) => {
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      if ((window as any).failReads) throw new DOMException('测试读取不可用', 'SecurityError');
      return get.apply(this, args);
    };
  });
  await enter(page);
  let currentSession = session;
  await page.route('**/api/session', route => route.fulfill({ json: currentSession }));
  await page.route('**/api/internal/session', route => route.fulfill({ json: currentSession }));
  await page.route('**/api/logout', route => route.fulfill({ json: {} }));
  await preference(page).fill('用户甲的私有偏好');
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'private-a.txt', mimeType: 'text/plain', buffer: Buffer.from('用户甲的缓存原文') });
  await expect(page.getByLabel('使用资料 private-a.txt', { exact: true })).toBeChecked();
  await preference(page).fill('用户甲退出前的最后修改');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  currentSession = { ...session, user: { id: 'records-user-b', name: 'B' } };
  await page.evaluate(() => { (window as any).failReads = true; });
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByText(/读取本机记录失败/)).toBeVisible();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await expect(page.getByText('用户甲退出前的最后修改', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('使用资料 private-a.txt', { exact: true })).toHaveCount(0);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toBeDisabled();
  await page.evaluate(() => { (window as any).failReads = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(preference(page)).toBeEnabled();
  await expect(preference(page)).toHaveValue('');
  await preference(page).fill('用户乙自己的偏好');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  currentSession = session;
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByLabel('使用资料 private-a.txt', { exact: true })).toBeChecked();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('用户甲退出前的最后修改');
  await page.getByRole('button', { name: '查看文本：private-a.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('用户甲的缓存原文');
});

test('deletion cancels an in-flight real Worker and late parsing cannot recreate its session', async ({ page }) => {
  await enter(page);
  await preference(page).fill('等待导入的会话');
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route(/material\.worker[.-]/, async route => {
    started(); await pending; await route.continue().catch(() => undefined);
  });
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('迟到的解析结果') });
  await workerStarted;
  await page.getByRole('button', { name: '删除对话 新对话', exact: true }).click(); release();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('新会话原文') });
  await expect(page.getByLabel('使用资料 new.txt', { exact: true })).toBeChecked();
  await expect(page.getByLabel('使用资料 late.txt', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('使用资料 new.txt', { exact: true })).toBeChecked();
  await expect(page.locator('.conversation-main')).toHaveCount(1);
  await expect(page.getByLabel('使用资料 late.txt', { exact: true })).toHaveCount(0);
});

test('legacy v2 messages without session IDs or materials restore, retry and stay deleted', async ({ page }) => {
  await enter(page);
  // Seed the old storage format; all observations and deletion use the UI.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('cramameleon', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('users', 'readwrite');
      transaction.objectStore('users').put({ version: 2, messages: [
        { id: 'done-u', role: 'user', text: '旧问题', createdAt: 1 },
        { id: 'done-a', role: 'assistant', text: '先前完整回答', status: 'completed', createdAt: 2 },
        { id: 'old-u', role: 'user', text: '继续旧问题', createdAt: 3 },
        { id: 'old-a', role: 'assistant', text: '旧的未完成回答', status: 'running', createdAt: 4 },
      ], states: { legacy: { preferences: '旧版偏好', progress: '第二章', course: '旧课程' } } }, 'records-user');
      transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  });
  await page.reload();
  await expect(page.getByText('旧的未完成回答', { exact: true })).toBeVisible();
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  await expect(page.getByLabel('学习位置')).toContainText('第二章');
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('旧版偏好');
  const requests: any[] = [];
  await page.route('**/api/model', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill({ contentType: 'text/event-stream', body: [
      { type: 'start', requestId: body.requestId }, { type: 'text_delta', delta: '旧版重试成功' }, { type: 'finish', stopReason: 'stop' },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
  });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('旧版重试成功', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].messages.filter((message: any) => message.role !== 'system').map((message: any) => ({ role: message.role, content: message.content }))).toEqual([
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '先前完整回答' },
    { role: 'user', content: '继续旧问题' },
  ]);
  await expect(page.locator('.msg.user')).toHaveCount(2);
  await page.getByRole('button', { name: '删除对话 旧问题', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
});

test('messages, local answers, selected text, preferences and learning position restore in the chosen session', async ({ page }) => {
  await enter(page);
  const requests: any[] = [];
  await page.route('**/api/model', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const last = body.messages.at(-1);
    const step = last.role === 'user'
      ? { type: 'tool_call', id: 'position', name: 'update_learning_state', arguments: { course: '概率论', chapter: '条件概率', progress: '分母 P(B)', phase: 'practice' } }
      : last.tool_call_id === 'position'
        ? { type: 'tool_call', id: 'quiz', name: 'present_quiz', arguments: { question: '条件概率的分母？', options: [{ id: 'A', text: 'P(B)', explanation: '条件事件的概率' }, { id: 'B', text: 'P(A)', explanation: '不是条件事件的概率' }], correctOptionId: 'A' } }
        : { type: 'text_delta', delta: '第一课的讲解' };
    await route.fulfill({ contentType: 'text/event-stream', body: [{ type: 'start', requestId: body.requestId }, step, { type: 'finish', stopReason: step.type === 'tool_call' ? 'toolUse' : 'stop' }].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') });
  });
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles([
    { name: 'course-a.txt', mimeType: 'text/plain', buffer: Buffer.from('课程甲的缓存文本') },
    { name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('未选中的文本') },
  ]);
  await expect(page.getByLabel('使用资料 extra.txt', { exact: true })).toBeChecked();
  await page.getByLabel('使用资料 extra.txt', { exact: true }).uncheck();
  await preference(page).fill('保留这个会话的偏好');
  await page.getByLabel('输入消息').fill('第一课练习');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.getByText('条件概率的分母？', { exact: true })).toBeVisible();
  const beforeAnswer = requests.length;
  await page.locator('.quiz-option').nth(1).click();
  await expect(page.getByText('回答错误，正确答案：A', { exact: true })).toBeVisible();
  expect(requests.length).toBe(beforeAnswer);
  await page.getByRole('button', { name: '新对话', exact: false }).click();
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'course-b.txt', mimeType: 'text/plain', buffer: Buffer.from('课程乙的文本') });
  await expect(page.getByLabel('使用资料 course-b.txt', { exact: true })).toBeChecked();
  await preference(page).fill('第二课偏好');
  await expect(page.getByLabel('学习位置')).toHaveCount(0);
  await expect(page.locator('.msg')).toHaveCount(0);
  await page.getByRole('button', { name: /^course-a.txt .*条$/ }).click();
  await page.reload();
  await expect(page.getByText('第一课的讲解', { exact: true })).toBeVisible();
  await expect(page.getByText('回答错误，正确答案：A', { exact: true })).toBeVisible();
  await expect(page.locator('.quiz-option.incorrect')).toContainText('P(A)');
  await expect(page.getByLabel('学习位置')).toContainText('概率论 · 条件概率');
  await expect(page.getByLabel('学习位置')).toContainText('分母 P(B)');
  await expect(page.getByLabel('使用资料 course-a.txt', { exact: true })).toBeChecked();
  await expect(page.getByLabel('使用资料 extra.txt', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('使用资料 course-b.txt', { exact: true })).toHaveCount(0);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('保留这个会话的偏好');
  await page.getByRole('button', { name: '查看文本：course-a.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('课程甲的缓存文本');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: /^course-b.txt .*条$/ }).click();
  await expect(preference(page)).toHaveValue('第二课偏好');
  await expect(page.locator('.msg')).toHaveCount(0);
  await expect(page.getByLabel('学习位置')).toHaveCount(0);
});

test('unavailable browser storage has a visible recovery action on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as any).storageUnavailable = true;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      if ((window as any).storageUnavailable) throw new DOMException('浏览器存储不可用', 'SecurityError');
      return open(...args);
    };
  });
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('读取本机记录失败');
  await expect(page.getByRole('button', { name: '重试读取', exact: true })).toBeInViewport();
  await expect(page.getByLabel('输入消息')).toBeDisabled();
  await page.evaluate(() => { (window as any).storageUnavailable = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await preference(page).fill('手机上的学习记录');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('读取本机记录失败');
  await page.evaluate(() => { (window as any).storageUnavailable = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('手机上的学习记录');
});

test('a recovery copy that cannot be removed never rolls back a newer committed record', async ({ page }) => {
  await page.addInitScript(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('cramameleon:pending:')) throw new DOMException('测试禁止清理恢复副本', 'SecurityError');
      return remove.call(this, key);
    };
  });
  await enter(page);
  await preference(page).fill('退出时的恢复副本');
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('退出时的恢复副本');
  await preference(page).fill('更新且已提交的偏好');
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('更新且已提交的偏好');
  await page.getByRole('button', { name: '删除对话 新对话', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
});

test('exit awaits the in-flight snapshot and prevents edits until the save finishes', async ({ page }) => {
  await controlNativeWrites(page, { releaseThrough: 0, abortAfter: 1 });
  await enter(page);
  await page.route('**/api/logout', route => route.fulfill({ json: {} }));
  await preference(page).fill('退出正在保存的快照');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(preference(page)).toBeDisabled();
  await page.evaluate(() => { window.nativeWrites.releaseThrough = 1; });
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('退出正在保存的快照');
});

test('deletion wins over an older in-flight save and remains deleted after immediate refresh', async ({ page }) => {
  await controlNativeWrites(page);
  await enter(page);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = 0; });
  await preference(page).fill('删除前尚未提交的快照');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '删除对话 新对话', exact: true }).click();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = Infinity; });
  await page.reload();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('');
});

test('a learning session containing only preferences remains accessible after refresh', async ({ page }) => {
  await enter(page);
  await preference(page).fill('回答简短，不主动出题');
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText('当前对话偏好', { exact: true }).click();
  await expect(preference(page)).toHaveValue('回答简短，不主动出题');
  await expect(page.locator('.conversation-main')).toHaveCount(1);
});
