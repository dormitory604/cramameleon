import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname === '/api/session') {
      return route.fulfill({ json: {
        mode: 'guest', user: { id: 'theme-fixture', name: '访客' }, modelReady: false, model: 'deepseek-flash',
        limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 },
        budget: { day: '2026-11-05', limit: 100000, used: 0 },
      } });
    }
    return route.fulfill({ json: { status: 'ok' } });
  });
});

test('defaults to light on a dark OS, toggles both ways and remembers the choice on mobile', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const root = page.locator('html');
  await expect(page.getByRole('button', { name: '切换为深色模式', exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 251, 245)');
  await page.screenshot({ path: testInfo.outputPath('theme-light-desktop.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换为深色模式', exact: true }).click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(27, 26, 24)');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1b1a18');
  await page.screenshot({ path: testInfo.outputPath('theme-dark-mobile.png'), animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('button', { name: '切换为浅色模式', exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: '切换为浅色模式', exact: true }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.getByRole('button', { name: '切换为深色模式', exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#fffbf5');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('theme-light-mobile.png'), animations: 'disabled' });
});

test('restores the saved appearance before the application starts', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('cramameleon.theme', 'dark'));
  // Keep React from starting so its effect cannot mask a first-paint regression.
  await page.route(/\/(src\/main\.tsx|assets\/index-[^/]+\.js)(\?.*)?$/, route => route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1b1a18');
  await expect(page.locator('#root')).toBeEmpty();
});

test('keeps the switch usable when appearance storage is unavailable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'cramameleon.theme') throw new DOMException('Storage blocked', 'SecurityError');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cramameleon.theme') throw new DOMException('Storage blocked', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '切换为深色模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '切换为浅色模式', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
