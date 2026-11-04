import { test, expect } from '@playwright/test';

test('browse is free; explicit package import retries one receipt, parses selected files and reuses user cache', async ({ page }) => {
 const user='arxiv-material-fixture';const requestIds:string[]=[];let contents=0;
 const resource={id:'12',kind:'package',title:'概率论课程包',courseName:'概率论',format:'zip',size:100,url:'https://materials.example.com/package/12',availability:'available',alreadyDownloaded:false};
 const quota={total:3,used:0,remaining:3,cycleStart:'2026-11-01T00:00:00Z',cycleEnd:'2026-11-08T00:00:00Z'};
 await page.route('**/api/**',async route=>{
  const request=route.request();const path=new URL(request.url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(path==='/api/session')return route.fulfill({json:{mode:'old-site',user:{id:user,name:'测试同学'},oldSite:{status:'ready'},initialContext:{packageId:'12'},modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-05',limit:100000,used:0}}});
  if(path.startsWith('/api/old-site/'))expect(request.headers()['x-cram-user']).toBe(user);
  if(path==='/api/old-site/quota')return route.fulfill({json:quota});
  if(path==='/api/old-site/packages')return route.fulfill({json:{items:[resource],total:1,page:1,pageSize:20,hasMore:false}});
  if(path==='/api/old-site/packages/12')return route.fulfill({json:resource});
  if(path==='/api/old-site/packages/12/items')return route.fulfill({json:{items:[{id:'1',packageId:'12',name:'lecture.txt',path:'第一章/lecture.txt',format:'txt',size:100,supported:true},{id:'2',packageId:'12',name:'exercise.md',path:'第二章/exercise.md',format:'md',size:100,supported:true},{id:'3',packageId:'12',name:'ignored.exe',path:'ignored.exe',format:'exe',size:1,supported:false}],total:3,page:1,pageSize:20,hasMore:false}});
  if(path==='/api/old-site/packages/12/access'){
   const body=request.postDataJSON();requestIds.push(body.requestId);expect(body.itemIds).toEqual(['1','2']);
   if(requestIds.length===1)return route.fulfill({status:502,json:{error:{code:'OLD_SITE_UNAVAILABLE',message:'模拟连接中断，请使用同一请求重试'}}});
   return route.fulfill({json:{readId:'read-fixture',charged:1,replayed:true,reused:false,expires:'2026-11-08T00:00:00Z',quota:{...quota,used:1,remaining:2}}});
  }
  if(path.endsWith('/content')){contents++;expect(new URL(request.url()).searchParams.get('readId')).toBe('read-fixture');return route.fulfill({contentType:'text/plain',body:'条件概率 P(A|B) = P(A∩B)/P(B)。测试课程资料。'});}
  return route.fulfill({status:404});
 });
 await page.goto('/');const dialog=page.getByRole('dialog',{name:'课程资料'});
 await expect(dialog.getByText('概率论课程包',{exact:true})).toBeVisible();expect(requestIds).toHaveLength(0);expect(contents).toBe(0);
 await expect(dialog.getByRole('checkbox',{name:/ignored.exe/})).toBeDisabled();
 await dialog.getByRole('checkbox',{name:/lecture.txt/}).check();await dialog.getByRole('checkbox',{name:/exercise.md/}).check();
 await expect(dialog).toContainText('首次读取此课程包扣 1 次');
 await dialog.getByRole('button',{name:'确认读取 2 份文件'}).click();await expect(dialog.getByRole('alert')).toContainText('模拟连接中断');
 await dialog.getByRole('button',{name:'确认读取 2 份文件'}).click();await expect(dialog).toHaveCount(0);
 expect(requestIds).toHaveLength(2);expect(requestIds[0]).toBe(requestIds[1]);expect(contents).toBe(2);
 await page.locator('.materials-panel summary').click();await expect(page.getByRole('button',{name:'查看文本：lecture.txt',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看文本：exercise.md',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('条件概率');await page.getByRole('button',{name:'关闭来源'}).click();
 await page.waitForTimeout(400);await page.reload();await expect(dialog).toHaveCount(0);await page.locator('.materials-panel summary').click();await expect(page.getByRole('button',{name:'查看文本：lecture.txt',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'添加',exact:true}).click();await page.getByRole('button',{name:'搜索课程资料',exact:true}).click();
 await dialog.getByLabel('资料类别').selectOption('package');
 await dialog.getByRole('button',{name:/概率论课程包/}).click();await dialog.getByRole('checkbox',{name:/lecture.txt/}).check();await dialog.getByRole('button',{name:'确认读取 1 份文件'}).click();await expect(dialog).toHaveCount(0);
 expect(requestIds).toHaveLength(2);expect(contents).toBe(2);
});
