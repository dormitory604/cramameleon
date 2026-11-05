import { test, expect } from '@playwright/test';

test('a linked material can retry in a reading list with another file and does not import again after reload', async ({ page }) => {
 const quota = { total: 10, used: 0, remaining: 10, cycleStart: '2026-11-01T00:00:00Z', cycleEnd: '2026-11-08T00:00:00Z' };
 const material = (id: string, title: string) => ({ id, kind: 'material', title, courseName: '概率论', format: 'txt', size: 100, url: `https://materials.example.com/material/${id}`, availability: 'available', alreadyDownloaded: false });
 const linked = material('41', '链接中的概率讲义'), extra = material('42', '补充练习');
 const requestIds: Record<string, string[]> = { '41': [], '42': [] };
 let searches = 0, contents = 0, modelRequests = 0;
 await page.route('https://materials.example.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'preview' }));
 await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
  if (path === '/api/session') return route.fulfill({ json: { mode: 'old-site', user: { id: 'linked-material-reader', name: '测试同学' }, oldSite: { status: 'ready' }, initialContext: { materialId: linked.id, importId: 'trusted-review-click' }, modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-05', limit: 100000, used: 0 } } });
  if (path === '/api/old-site/quota') return route.fulfill({ json: quota });
  if (path === '/api/old-site/materials') {
   searches++;
   return route.fulfill({ json: { items: [linked, extra], total: 2, page: 1, pageSize: 20, hasMore: false } });
  }
  const detail = [linked, extra].find(value => path === `/api/old-site/materials/${value.id}`);
  if (detail) return route.fulfill({ json: detail });
  const access = path.match(/^\/api\/old-site\/materials\/(\d+)\/access$/);
  if (access) {
   const id = access[1];
   requestIds[id].push(request.postDataJSON().requestId);
   if (id === linked.id && requestIds[id].length === 1) return route.fulfill({ status: 502, json: { error: { code: 'OLD_SITE_UNAVAILABLE', message: '自动读取中断，请重试' } } });
   return route.fulfill({ json: { readId: `read-${id}`, charged: 1, replayed: requestIds[id].length > 1, reused: false, expires: '2026-11-08T00:00:00Z', quota } });
  }
  if (path.endsWith('/content')) {
   contents++;
   return route.fulfill({ contentType: 'text/plain', body: '条件概率与独立事件。' });
  }
  if (path === '/api/model') modelRequests++;
  return route.fulfill({ status: 404 });
 });
 await page.goto('/');
 const dialog = page.getByRole('dialog', { name: '课程资料' });
 await expect(dialog.getByRole('alert')).toContainText('自动读取中断，请重试');
 expect(requestIds[linked.id]).toHaveLength(1);
 expect(searches).toBe(0);
 expect(contents).toBe(0);
 await dialog.getByRole('button', { name: '＋ 选择其他资料' }).click();
 await expect(dialog.getByRole('region', { name: '待读清单' })).toContainText(linked.title);
 await dialog.getByRole('button', { name: new RegExp(extra.title) }).click();
 await dialog.getByRole('button', { name: '确认读取全部 2 份文件' }).click();
 await expect(dialog).toHaveCount(0);
 expect(requestIds[linked.id]).toHaveLength(2);
 expect(requestIds[linked.id][0]).toBe(requestIds[linked.id][1]);
 expect(requestIds[extra.id]).toHaveLength(1);
 expect(contents).toBe(2);
 expect(modelRequests).toBe(0);
 await expect(page.locator('.materials-panel summary')).toContainText('已选 2/2');
 await expect(page.getByRole('status', { name: '本机存储状态' })).toHaveText('已保存到当前浏览器');
 await page.reload();
 await expect(page.locator('.materials-panel summary')).toContainText('已选 2/2');
 await expect(dialog).toHaveCount(0);
 expect(requestIds[linked.id]).toHaveLength(2);
 expect(contents).toBe(2);
});
