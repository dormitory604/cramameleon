import { test, expect } from '@playwright/test';

test('a linked material can retry in a reading list with another file and does not import again after reload', async ({ page }) => {
 const material = (id: string, title: string) => ({ id, kind: 'material', title, courseName: '概率论', format: 'txt', size: 100, url: `https://materials.example.com/material/${id}`, availability: 'available', alreadyDownloaded: false });
 const linked = material('41', '链接中的概率讲义'), extra = material('42', '补充练习');
 const reads: Record<string, number> = { '41': 0, '42': 0 };
 let searches = 0, contents = 0, modelRequests = 0;
 await page.route('https://materials.example.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'preview' }));
 await page.route('**/api/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/api/health') return route.fulfill({ json: { status: 'ok' } });
  if (path === '/api/session') return route.fulfill({ json: { mode: 'old-site', user: { id: 'linked-material-reader', name: '测试同学' }, oldSite: { status: 'ready' }, initialContext: { materialId: linked.id, importId: 'trusted-review-click' }, modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-05', limit: 100000, used: 0 } } });
  if (path === '/api/old-site/materials') {
   searches++;
   return route.fulfill({ json: { items: [linked, extra], total: 2, page: 1, pageSize: 20, hasMore: false } });
  }
  const detail = [linked, extra].find(value => path === `/api/old-site/materials/${value.id}`);
  if (detail) return route.fulfill({ json: detail });
  expect(path).not.toMatch(/\/api\/old-site.*\/(quota|access|content)$/);
  const read = path.match(/\/materials\/(\d+)\/parsed$/);
  if (read) {
   const id = read[1];
   if (++reads[id] === 1 && id === linked.id) return route.fulfill({ status: 502, json: { error: { code: 'OLD_SITE_UNAVAILABLE', message: '自动读取中断，请重试' } } });
   contents++;
   return route.fulfill({ json: { id, title: 'fixture', warnings: [], chunks: [{ documentId: id, chunkId: 'c', text: '条件概率与独立事件。', title: 'fixture', location: '段落 1' }] } });
  }
  if (path === '/api/model') modelRequests++;
  return route.fulfill({ status: 404 });
 });
 await page.goto('/');
 const dialog = page.getByRole('dialog', { name: '课程资料' });
 await expect(page.getByRole('alert')).toContainText('自动读取中断，请重试');
 await expect(dialog).toHaveCount(0);
 await page.getByRole('button', { name: '查看课程资料' }).click();
 expect(reads[linked.id]).toBe(1);
 expect(searches).toBe(0);
 expect(contents).toBe(0);
 await dialog.getByRole('button', { name: '＋ 选择其他资料' }).click();
 await expect(dialog.getByRole('region', { name: '待读清单' })).toContainText(linked.title);
 await dialog.getByRole('button', { name: new RegExp(extra.title) }).click();
 await dialog.getByRole('button', { name: '确认读取全部 2 份文件' }).click();
 await expect(dialog).toHaveCount(0);
 expect(reads[linked.id]).toBe(2);
 expect(reads[extra.id]).toBe(1);
 expect(contents).toBe(2);
 expect(modelRequests).toBe(0);
 await expect(page.locator('.materials-panel summary')).toContainText('已选 2/2');
 await expect(page.getByRole('status', { name: '本机存储状态' })).toHaveText('已保存到当前浏览器');
 await page.reload();
 await expect(page.locator('.materials-panel summary')).toContainText('已选 2/2');
 await expect(dialog).toHaveCount(0);
 expect(reads[linked.id]).toBe(2);
 expect(contents).toBe(2);
});

test('without uploads the Agent searches for calculus papers and uses server-only evidence', async ({ page }) => {
 const user = 'calculus-fixture';
 const documentId = 'old-site:material:91', chunkId = documentId + ':0';
 const url = 'https://materials.example.com/material/91';
 let reads = 0, searches = 0, verified = 0, modelRequests = 0;
 await page.route('**/api/**', async route => {
  const request = route.request(), target = new URL(request.url());
  if (target.pathname === '/api/health') return route.fulfill({ json: { status: 'ok' } });
  if (target.pathname === '/api/session') return route.fulfill({ json: {
   mode: 'old-site', user: { id: user, name: '测试同学' }, oldSite: { status: 'ready' },
   modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 },
   budget: { day: '2026-11-05', limit: 100000, used: 0 },
  } });
  if (target.pathname === '/api/old-site/materials') {
   searches++;
   expect(target.searchParams.get('search')).toBe('高等数学');
   expect(target.searchParams.get('category')).toBe('past_exam');
   expect(target.searchParams.get('page_size')).toBe('5');
   return route.fulfill({ json: { items: [{ id:'91', kind:'material', title:'高等数学期末试题', courseName:'高等数学', url, availability:'available' }] } });
  }
  if (target.pathname === '/api/old-site/materials/91/evidence') {
   reads++;
   expect(target.searchParams.get('callId')).toBe('read-1');
   return route.fulfill({ json: { chunks: [{ documentId, chunkId, title:'高等数学期末试题', location:'第 1 页', page:1, url, text:'' }] } });
  }
  if (target.pathname === '/api/old-site-verify') {
   verified++;
   expect(request.postDataJSON().refs).toEqual([{ documentId, chunkId }]);
   expect(request.postDataJSON().calls).toEqual(['read-1']);
   return route.fulfill({ json: { verified:true } });
  }
  if (target.pathname === '/api/model') {
   const body = request.postDataJSON();
   expect(body.tools.some((tool: any) => tool.function.name === 'search_old_site')).toBe(true);
   const call = (id: string, name: string, args: object) => ({ type:'tool_call', id, name, arguments:args });
   let step: object;
   switch (++modelRequests) {
    case 1: step = call('search-1','search_old_site',{ query:'高等数学', pastPaper:true }); break;
    case 2: step = call('read-1','read_old_site',{ documentId }); break;
    case 3:
     expect(JSON.parse(body.messages.at(-1).content)).toEqual({ remoteEvidence:true });
     step = call('quiz-1','present_quiz',{ question:'常数函数的导数是多少？', options:[
      { id:'A', text:'0', explanation:'常数的变化率为零。' }, { id:'B', text:'1', explanation:'常数函数没有变化。' },
     ], correctOptionId:'A', origin:'past_paper', sourceRefs:[{ documentId, chunkId }] });
     break;
    default: step = { type:'text_delta', delta:'先做这一道真题。' };
   }
   const events = [{ type:'start', requestId:body.requestId },step,{ type:'usage', usage:{ input:1, output:1, total:2 } },{ type:'finish', stopReason:modelRequests<4?'toolUse':'stop' }];
   return route.fulfill({ contentType:'text/event-stream', body:events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('') });
  }
  return route.fulfill({ status:404 });
 });
 await page.goto('/');
 await page.getByLabel('输入消息').fill('帮我找一下高数的资料，然后出一些高数真题给我');
 await page.getByRole('button', { name:'发送消息', exact:true }).click();
 await expect(page.getByText('常数函数的导数是多少？', { exact:true })).toBeVisible();
 await expect(page.getByText('先做这一道真题。', { exact:true })).toBeVisible();
 expect([searches,reads,verified]).toEqual([1,1,1]);
 await page.getByRole('button', { name:'▧ 高等数学期末试题', exact:true }).click();
 await expect(page.getByRole('dialog')).toContainText('第 1 页');
 await expect(page.getByRole('dialog').getByRole('link')).toHaveAttribute('href',url);
 await expect(page.getByRole('dialog').locator('pre')).toHaveCount(0);
});
