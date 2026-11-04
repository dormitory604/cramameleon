import { test, expect } from '@playwright/test';

test('old-site mode shows a single existing-account entry and never posts a password', async ({ page }) => {
  let passwordRequests = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { mode: 'old-site', oldSiteEntryUrl: 'https://materials.example.com/cramameleon' } });
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
    if (path === '/api/internal/session') passwordRequests++;
    return route.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED' } } });
  });
  await page.goto('/?entryError=AUTH_FLOW_EXPIRED');
  await expect(page.getByRole('link', { name: '从破壁计划进入' })).toHaveAttribute('href', 'https://materials.example.com/cramameleon');
  await expect(page.getByLabel('内部访问口令')).toHaveCount(0);
  await expect(page.getByLabel('输入消息')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('请从破壁计划重新进入');
  expect(new URL(page.url()).search).toBe('');
  expect(passwordRequests).toBe(0);
  if (process.env.ENTRY_SCREENSHOTS_DIR) {
    await page.screenshot({ path: `${process.env.ENTRY_SCREENSHOTS_DIR}/entry-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name: '从破壁计划进入' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.screenshot({ path: `${process.env.ENTRY_SCREENSHOTS_DIR}/entry-mobile.png`, fullPage: true });
  }
});

test('entry configuration failure keeps learning and password inputs closed', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 401 }));
  await page.route('**/api/auth/config', route => route.fulfill({ status: 503 }));
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('无法确认进入方式');
  await expect(page.getByLabel('内部访问口令')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '从破壁计划进入' })).toHaveCount(0);
  await expect(page.getByLabel('输入消息')).toHaveCount(0);
});

test('switching accounts in another tab clears the previous user view and binds model requests', async ({ page, context }) => {
  let userId = 'arxiv-user-A';
  const requestedUsers: string[] = [];
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { mode: 'old-site', oldSiteEntryUrl: 'https://materials.example.com/cramameleon' } });
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
    if (path === '/api/session') return route.fulfill({ json: { mode: 'old-site', user: { id: userId, name: userId }, oldSite: { status: 'ready' }, modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-05', limit: 100000, used: 0 } } });
    if (path === '/api/model') {
      requestedUsers.push(route.request().headers()['x-cram-user']);
      const body = route.request().postDataJSON();
      const events = [{ type: 'start', requestId: body.requestId }, { type: 'text_delta', delta: 'A 同学的学习记录' }, { type: 'usage', usage: { input: 1, output: 1, total: 2 } }, { type: 'finish', stopReason: 'stop' }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('A 的课程');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('A 同学的学习记录', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  expect(requestedUsers).toEqual(['arxiv-user-A']);
  userId = 'arxiv-user-B';
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByLabel('输入消息')).toBeVisible();
  await expect(second.getByText('A 同学的学习记录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '从破壁计划进入' })).toBeVisible();
  await expect(page.getByText('A 同学的学习记录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('账号已在其他页面切换或退出');
});
