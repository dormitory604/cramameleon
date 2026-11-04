import { test, expect, type Page } from '@playwright/test';
import type { LocalData } from '../../src/session/appStore.ts';
import { controlNativeWrites } from './helpers/nativeWrites.ts';

const session = { user: { id: 'records-user', name: 'test' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 100000, used: 0 } };
const material = (page: Page, name: string) => page.getByLabel(`使用资料 ${name}`, { exact: true });
async function openMaterials(page: Page) {
  const panel = page.locator('details.materials-panel');
  await expect(panel).toBeVisible();
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click();
}
async function importMaterial(page: Page, name: string, content = name) {
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await expect(material(page, name)).toBeChecked();
  await openMaterials(page);
}
async function enter(page: Page) {
  await page.route('**/api/session', route => route.fulfill({ json: session }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.goto('/');
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
}

type LegacyRecord = Omit<LocalData, 'messages'> & { messages: Omit<LocalData['messages'][number], 'conversationId'>[] };
async function seedRecord(page: Page, record: LegacyRecord) {
  await page.evaluate(async ({ record, userId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('cramameleon', 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('users', 'readwrite');
      transaction.objectStore('users').put(record, userId);
      transaction.oncomplete = () => { db.close(); resolve(); }; transaction.onabort = () => { db.close(); reject(transaction.error); };
    });
  }, { record, userId: session.user.id });
}

test('readable recovery stays visible and editable when checkpoint replay writes persistently fail', async ({ page }) => {
  await controlNativeWrites(page, { abort: true });
  await enter(page);
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'recovery.txt', mimeType: 'text/plain', buffer: Buffer.from('恢复副本中的可读原文') });
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toBeChecked();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  // A real reload persists the user-scoped checkpoint; only native writes fail.
  await page.reload();
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toBeChecked();
  await expect(page.getByText(/已恢复.*尚未保存/)).toBeVisible();
  await expect(page.getByText(/读取本机记录失败/)).toHaveCount(0);
  await openMaterials(page);
  await page.getByRole('button', { name: '查看文本：recovery.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('恢复副本中的可读原文');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  await page.getByRole('button', { name: '移除：recovery.txt', exact: true }).click();
  await expect(page.getByLabel('使用资料 recovery.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toBeVisible();
  await page.evaluate(() => { window.nativeWrites.abort = false; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
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
  await openMaterials(page);
  await material(page, 'exit-private.txt').uncheck();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '仍然退出（可能丢失修改）', exact: true })).toBeVisible();
  await expect(page.getByText(/仍然退出可能丢失未保存的修改/)).toBeVisible();
  expect(logoutRequests).toBe(0);
  await openMaterials(page);
  await expect(material(page, 'exit-private.txt')).toBeVisible();
  await expect(material(page, 'exit-private.txt')).not.toBeChecked();
  await page.getByRole('button', { name: '仍然退出（可能丢失修改）', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  expect(logoutRequests).toBe(1);
  await expect(page.getByLabel('使用资料 exit-private.txt', { exact: true })).toHaveCount(0);
  currentSession = { ...session, user: { id: 'exit-user-b', name: 'B' } };
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await expect(page.getByLabel('使用资料 exit-private.txt', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  expect(logoutRequests).toBe(2);
  currentSession = session;
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByText(/已恢复.*尚未保存/)).toBeVisible();
  await openMaterials(page);
  await expect(material(page, 'exit-private.txt')).toBeVisible();
  await expect(material(page, 'exit-private.txt')).not.toBeChecked();
  await page.getByRole('button', { name: '查看文本：exit-private.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('甲退出时未保存的私有原文');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.evaluate(() => { window.nativeWrites.abort = false; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await openMaterials(page);
  await expect(material(page, 'exit-private.txt')).toBeVisible();
  await expect(material(page, 'exit-private.txt')).not.toBeChecked();
});

test('persisted page transition events interrupt turns and reject late completion while retry runs', async ({ page }) => {
  // Deterministic BFCache lifecycle boundary on a real page, not an actual cache hit.
  // Deliver replies inside the browser so reader cancellation cannot race a
  // Playwright network-finished event for an already interrupted turn.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const calls = (window as any).lifecycleCalls = [] as {
      request: { requestId: string; messages: { role: string; content: string }[] };
      release: () => void;
      consumed: boolean;
    }[];
    window.fetch = async (input, init) => {
      if (input !== '/api/model') return originalFetch(input, init);
      const request = JSON.parse(init!.body as string);
      const index = calls.length;
      await new Promise<void>(resolve => { calls.push({ request, release: resolve, consumed: false }); });
      const body = index === 1 ? 'data: invalid-json\n\n' : [
        { type: 'start', requestId: request.requestId },
        { type: 'text_delta', delta: index === 0 ? '离开后不应出现的旧文字' : '生命周期中断后重试成功' },
        ...(index === 0 ? [{ type: 'tool_call', id: 'stale-position', name: 'update_learning_state', arguments: { course: '旧轮不应更新的课程', progress: '迟到位置' } }] : []),
        { type: 'finish', stopReason: index === 0 ? 'toolUse' : 'stop' },
      ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
      const response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      const getReader = response.body!.getReader.bind(response.body);
      response.body!.getReader = (() => {
        const reader = getReader();
        const releaseLock = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          releaseLock();
          calls[index].consumed = true;
        };
        return reader;
      }) as typeof getReader;
      return response;
    };
  });
  await enter(page);
  const waitForCall = (index: number) => page.waitForFunction(i => (window as any).lifecycleCalls.length > i, index);
  const releaseReply = async (index: number) => {
    await page.evaluate(i => (window as any).lifecycleCalls[i].release(), index);
    await page.waitForFunction(i => (window as any).lifecycleCalls[i].consumed, index);
  };
  const departAndReturn = () => page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.getByLabel('输入消息').fill('生命周期边界的问题');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await waitForCall(0);
  await departAndReturn();
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  await releaseReply(0);
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByText('离开后不应出现的旧文字', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('学习位置')).toHaveCount(0);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitForCall(1);
  await departAndReturn();
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitForCall(2);
  await releaseReply(1);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await expect(page.locator('.msg.assistant .run-status')).toHaveText('运行中');
  await expect(page.locator('.msg.assistant .error-card')).toHaveCount(0);
  await expect(page.getByLabel('学习位置')).toHaveCount(0);
  await releaseReply(2);
  await expect(page.getByText('生命周期中断后重试成功', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(page.locator('.msg.user')).toHaveCount(1);
  await expect(page.locator('.msg.assistant')).toHaveCount(1);
  const retryMessages = await page.evaluate(() => (window as any).lifecycleCalls[2].request.messages);
  expect(retryMessages.filter((message: { role: string; content: string }) => message.role === 'user' && message.content === '生命周期边界的问题')).toHaveLength(1);
  await page.reload();
  await expect(page.getByText('生命周期中断后重试成功', { exact: true })).toBeVisible();
  await expect(page.getByText('离开后不应出现的旧文字', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('学习位置')).toHaveCount(0);
});

test('new edits show saving and survive an immediate refresh before autosave', async ({ page }) => {
  await enter(page);
  await importMaterial(page, 'immediate-refresh.txt');
  await expect(page.getByText('正在保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await expect(material(page, 'immediate-refresh.txt')).toBeChecked();
});

test('native storage quota protects pending edits on refresh and canceling navigation keeps editing live', async ({ page }) => {
  await controlNativeWrites(page);
  await enter(page);
  await importMaterial(page, 'quota.txt');
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
  await material(page, 'quota.txt').uncheck();
  await page.waitForTimeout(250);
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  // Canceled reloads need not emit a navigation completion event.
  await page.reload({ timeout: 2000 }).catch(error => { if (!dialogs.length) throw error; });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  await expect(material(page, 'quota.txt')).toBeVisible();
  await expect(material(page, 'quota.txt')).not.toBeChecked();
  // A failed recovery copy alone is not a save failure; the pending IndexedDB write decides.
  await expect(page.getByText('正在保存到当前浏览器', { exact: true })).toBeVisible();
  await expect(page.getByText(/保存失败，刷新后可能丢失记录/)).toHaveCount(0);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = Infinity; });
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await material(page, 'quota.txt').check();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await expect(material(page, 'quota.txt')).toBeChecked();
  expect(dialogs).toEqual(['beforeunload']);
});

test('older save completion cannot announce success for newer unsaved edits; write failures can be retried', async ({ page }) => {
  // Keep real IndexedDB transactions alive, controlling only the storage boundary.
  await controlNativeWrites(page, { releaseThrough: 0 });
  await enter(page);
  await importMaterial(page, 'first-version.txt');
  await page.waitForTimeout(250);
  await material(page, 'first-version.txt').uncheck();
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
  await openMaterials(page);
  await expect(material(page, 'first-version.txt')).toBeVisible();
  await expect(material(page, 'first-version.txt')).not.toBeChecked();
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
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'private-a.txt', mimeType: 'text/plain', buffer: Buffer.from('用户甲的缓存原文') });
  await expect(page.getByLabel('使用资料 private-a.txt', { exact: true })).toBeChecked();
  await openMaterials(page);
  await material(page, 'private-a.txt').uncheck();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  currentSession = { ...session, user: { id: 'records-user-b', name: 'B' } };
  await page.evaluate(() => { (window as any).failReads = true; });
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await expect(page.getByText(/读取本机记录失败/)).toBeVisible();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await expect(page.getByLabel('使用资料 private-a.txt', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('输入消息')).toBeDisabled();
  await page.evaluate(() => { (window as any).failReads = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(page.getByLabel('输入消息')).toBeEnabled();
  await expect(material(page, 'private-a.txt')).toHaveCount(0);
  await importMaterial(page, 'private-b.txt');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  currentSession = session;
  await page.getByLabel('内部访问口令').fill('controlled-token');
  await page.getByRole('button', { name: '进入学习空间' }).click();
  await openMaterials(page);
  await expect(material(page, 'private-a.txt')).toBeVisible();
  await expect(material(page, 'private-a.txt')).not.toBeChecked();
  await expect(material(page, 'private-b.txt')).toHaveCount(0);
  await page.getByRole('button', { name: '查看文本：private-a.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('用户甲的缓存原文');
});

test('deletion cancels an in-flight real Worker and late parsing cannot recreate its session', async ({ page }) => {
  await enter(page);
  await importMaterial(page, 'initial.txt');
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const workerStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route(/material\.worker[.-]/, async route => {
    started(); await pending; await route.continue().catch(() => undefined);
  });
  await page.getByLabel('导入本地资料', { exact: true }).setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('迟到的解析结果') });
  await workerStarted;
  await page.getByRole('button', { name: '删除对话 initial.txt', exact: true }).click(); release();
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
  await seedRecord(page, { version: 2, messages: [
    { id: 'done-u', role: 'user', text: '旧问题', createdAt: 1 },
    { id: 'done-a', role: 'assistant', text: '先前完整回答', status: 'completed', createdAt: 2 },
    { id: 'old-u', role: 'user', text: '继续旧问题', createdAt: 3 },
    { id: 'old-a', role: 'assistant', text: '旧的未完成回答', status: 'running', createdAt: 4 },
  ], states: { legacy: { preferences: '旧版偏好', progress: '第二章', course: '旧课程' } } });
  await page.reload();
  await expect(page.getByText('旧的未完成回答', { exact: true })).toBeVisible();
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  await expect(page.getByLabel('学习位置')).toContainText('第二章');
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
  expect(requests[0].messages[0].content).toContain('"preferences":"旧版偏好"');
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

test('messages, local answers, selected text and learning position restore in the chosen session', async ({ page }) => {
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
  await openMaterials(page);
  await page.getByLabel('使用资料 extra.txt', { exact: true }).uncheck();
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
  await openMaterials(page);
  await page.getByRole('button', { name: '查看文本：course-a.txt', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('课程甲的缓存文本');
  await page.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: /^course-b.txt .*条$/ }).click();
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
  await importMaterial(page, 'phone.txt', '手机上的学习记录');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('读取本机记录失败');
  await page.evaluate(() => { (window as any).storageUnavailable = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(material(page, 'phone.txt')).toBeChecked();
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
  await importMaterial(page, 'recovery-copy.txt');
  await page.reload();
  await expect(material(page, 'recovery-copy.txt')).toBeChecked();
  await openMaterials(page);
  await material(page, 'recovery-copy.txt').uncheck();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await openMaterials(page);
  await expect(material(page, 'recovery-copy.txt')).toBeVisible();
  await expect(material(page, 'recovery-copy.txt')).not.toBeChecked();
  await page.getByRole('button', { name: '删除对话 recovery-copy.txt', exact: true }).click();
  await expect(page.getByText('已保存到当前浏览器', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
});

test('exit awaits the in-flight snapshot and prevents edits until the save finishes', async ({ page }) => {
  await controlNativeWrites(page, { releaseThrough: 0, abortAfter: 1 });
  await enter(page);
  await page.route('**/api/logout', route => route.fulfill({ json: {} }));
  await importMaterial(page, 'exit-snapshot.txt');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(material(page, 'exit-snapshot.txt')).toBeDisabled();
  await page.evaluate(() => { window.nativeWrites.releaseThrough = 1; });
  await expect(page.getByRole('button', { name: '进入学习空间' })).toBeVisible();
  await page.reload();
  await expect(material(page, 'exit-snapshot.txt')).toBeChecked();
});

test('deletion wins over an older in-flight save and remains deleted after immediate refresh', async ({ page }) => {
  await controlNativeWrites(page);
  await enter(page);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = 0; });
  await importMaterial(page, 'deleted-snapshot.txt');
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '删除对话 deleted-snapshot.txt', exact: true }).click();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
  await page.evaluate(() => { window.nativeWrites.releaseThrough = Infinity; });
  await page.reload();
  await expect(page.getByLabel('导入本地资料', { exact: true })).toBeEnabled();
  await expect(page.locator('.conversation-main')).toHaveCount(0);
});

test('a legacy learning session containing only preferences remains accessible after refresh', async ({ page }) => {
  await enter(page);
  await seedRecord(page, { version: 2, messages: [], states: { legacy: { preferences: '回答简短，不主动出题', progress: '' } } });
  await page.reload();
  await expect(page.locator('.conversation-main')).toHaveCount(1);
  await expect(page.locator('.msg')).toHaveCount(0);
});
