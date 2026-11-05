import { test, expect } from '@playwright/test';
const parsed = (text: string, pages = 1) => ({
 id: 'fixture', title: 'fixture', warnings: [],
 chunks: Array.from({ length: pages }, (_, i) => ({ documentId: 'fixture', chunkId: `fixture-${i}`, title: 'fixture', text, location: `第 ${i + 1} 页`, page: i + 1 })),
});

for (const automatic of [false, true]) {
test(`package import ${automatic ? 'starts automatically from the review button' : 'waits for manual selection when browsing'} and imports parsed text`, async ({ page }) => {
 const user='arxiv-material-fixture';let contents=0;
 const modelRequests:any[]=[];
 const resource={id:'12',kind:'package',title:'概率论课程包',courseName:'概率论',format:'zip',size:100,url:'https://materials.example.com/package/12',availability:'available',alreadyDownloaded:false};
 await page.route('**/api/**',async route=>{
  const request=route.request();const path=new URL(request.url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(path==='/api/session')return route.fulfill({json:{mode:'old-site',user:{id:user,name:'测试同学'},oldSite:{status:'ready'},initialContext:{packageId:'12',...(automatic ? {importId:'review-click'} : {})},modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-05',limit:100000,used:0}}});
  if(path==='/api/model'){
   const body=request.postDataJSON();modelRequests.push(body);
   const last=body.messages.at(-1);
   const step=last.role==='user'?{type:'tool_call',id:'read-selected',name:'search_context',arguments:{query:'条件概率'}}:
    {type:'text_delta',delta:'已从旧站资料读到：'+JSON.parse(last.content).chunks[0].text};
   const events=[{type:'start',requestId:body.requestId},step,{type:'usage',usage:{input:1,output:1,total:2}},{type:'finish',stopReason:step.type==='tool_call'?'toolUse':'stop'}];
   return route.fulfill({contentType:'text/event-stream',body:events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')});
  }
  if(path.startsWith('/api/old-site/'))expect(request.headers()['x-cram-user']).toBe(user);
  expect(path).not.toMatch(/\/api\/old-site.*\/(quota|access|content)$/);
  if(path==='/api/old-site/packages')return route.fulfill({json:{items:[resource],total:1,page:1,pageSize:20,hasMore:false}});
  if(path==='/api/old-site/packages/12')return route.fulfill({json:resource});
  if(path==='/api/old-site/packages/12/items')return route.fulfill({json:{items:[{id:'1',packageId:'12',name:'lecture.txt',path:'第一章/lecture.txt',format:'txt',size:100,supported:true},{id:'2',packageId:'12',name:'exercise.md',path:'第二章/exercise.md',format:'md',size:100,supported:true},{id:'3',packageId:'12',name:'ignored.exe',path:'ignored.exe',format:'exe',size:1,supported:false}],total:3,page:1,pageSize:20,hasMore:false}});
  if(path.endsWith('/parsed')){contents++;return route.fulfill({json:parsed('条件概率 P(A|B) = P(A∩B)/P(B)。测试课程资料。')});}
  return route.fulfill({status:404});
 });
 await page.goto('/');const dialog=page.getByRole('dialog',{name:'课程资料'});
 if (automatic) {
  await expect(page.getByText('已导入并选中 2 份课程资料。')).toBeVisible();
  await expect(dialog).toHaveCount(0);
 } else {
  await expect(dialog.getByText('概率论课程包',{exact:true})).toBeVisible();
  expect(contents).toBe(0);
  await expect(dialog.getByRole('checkbox',{name:/ignored.exe/})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:/lecture.txt/}).check();await dialog.getByRole('checkbox',{name:/exercise.md/}).check();
  await dialog.getByRole('button',{name:'确认读取 2 份文件'}).click();
  await expect(dialog).toHaveCount(0);
 }
 expect(contents).toBe(2);
 await page.locator('.materials-panel summary').click();await expect(page.getByRole('button',{name:'查看文本：lecture.txt',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'查看文本：exercise.md',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('条件概率');await page.getByRole('button',{name:'关闭来源'}).click();
 await page.waitForTimeout(400);await page.reload();await expect(dialog).toHaveCount(0);await page.locator('.materials-panel summary').click();await expect(page.getByRole('button',{name:'查看文本：lecture.txt',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'添加',exact:true}).click();await page.getByRole('button',{name:'搜索课程资料',exact:true}).click();
 await dialog.getByLabel('资料类别').selectOption('package');
 await dialog.getByRole('button',{name:/概率论课程包/}).click();await dialog.getByRole('checkbox',{name:/lecture.txt/}).check();await dialog.getByRole('button',{name:'确认读取 1 份文件'}).click();await expect(dialog).toHaveCount(0);
 expect(contents).toBe(2);
 await page.getByLabel('输入消息').fill('按已选的旧站资料讲解条件概率');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByText(/已从旧站资料读到：条件概率/)).toBeVisible();
 expect(modelRequests).toHaveLength(2);
 expect(modelRequests[0].messages[0].content).toContain('old-site:package:12:1');
 expect(modelRequests[0].tools.some((tool:any)=>tool.function.name==='search_context')).toBe(true);
 expect(modelRequests[1].messages.at(-1).content).toContain('P(A|B)');
 expect(modelRequests[0].messages[0].content).not.toContain('旧站授权尚未接入');
});
}

test('an imported old-site PDF can be read from its first question, cited and reused after reload despite earlier missing-material history', async ({ page }) => {
 const user='old-site-pdf-reader',question='1. For disjoint events add their probabilities.';
 const resource={id:'5232',kind:'material',title:'概率论与数理统计 2024小测题',courseName:'概率论',format:'pdf',size:1000,url:'https://materials.example.com/material/5232',availability:'available',alreadyDownloaded:false};
 const requests:any[]=[];let contents=0,source:any;
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/session')return route.fulfill({json:{mode:'old-site',user:{id:user,name:'测试同学'},oldSite:{status:'ready'},modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-05',limit:100000,used:0}}});
  if(path==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(path.startsWith('/api/old-site/'))expect(request.headers()['x-cram-user']).toBe(user);
  expect(path).not.toMatch(/\/api\/old-site.*\/(quota|access|content)$/);
  if(path==='/api/old-site/materials')return route.fulfill({json:{items:[resource],total:1,page:1,pageSize:20,hasMore:false}});
  if(path==='/api/old-site/materials/5232')return route.fulfill({json:resource});
  if(path.endsWith('/parsed')){contents++;return route.fulfill({json:parsed(question,2)});}
  if(path==='/api/model'){
   const body=request.postDataJSON();requests.push(body);
   const last=body.messages.at(-1);let step:any;
   if(!body.tools.some((tool:any)=>tool.function.name==='read_context'))step={type:'text_delta',delta:'当前没有已选资料。'};
   else if(last.role==='user')step={type:'tool_call',id:'read-first',name:'read_context',arguments:{documentId:'old-site:material:5232'}};
   else if(last.tool_call_id==='read-first'){
    const result=JSON.parse(last.content);source=result.chunks[0];
    expect(source.text).toContain(question);expect(source.page).toBe(1);
    step={type:'tool_call',id:'cite-first',name:'cite_sources',arguments:{refs:[{documentId:source.documentId,chunkId:source.chunkId}]}};
   }else step={type:'text_delta',delta:'已读原文：'+source.text};
   const events=[{type:'start',requestId:body.requestId},step,{type:'usage',usage:{input:1,output:1,total:2}},{type:'finish',stopReason:step.type==='tool_call'?'toolUse':'stop'}];
   return route.fulfill({contentType:'text/event-stream',body:events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')});
  }
  return route.fulfill({status:404});
 });
 const send=async(text:string)=>{await page.getByLabel('输入消息').fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0);};
 await page.goto('/');await send('帮我查一下概率论的课程资料');
 await expect(page.getByText('当前没有已选资料。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'添加',exact:true}).click();await page.getByRole('button',{name:'搜索课程资料',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'课程资料'});
 await dialog.getByRole('button',{name:new RegExp(resource.title)}).click();
 expect(contents).toBe(0);
 await dialog.getByRole('button',{name:'确认读取并导入',exact:true}).click();
 await expect(dialog).toHaveCount(0);await expect(page.locator('.materials-panel summary')).toContainText('已选 1/1');
 await send('给我讲解里面的第一题的知识吧');
 await expect(page.getByText('已读原文：'+question,{exact:true})).toBeVisible();
 expect(requests).toHaveLength(4);
 expect(requests[1].messages[0].content).toContain('"chunkCount":2');
 expect(requests[1].messages[0].content).toContain('"origin":"old-site"');
 expect(requests[1].messages[0].content).not.toContain('旧站授权尚未接入');
 await page.getByRole('button',{name:'▧ '+resource.title,exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText(question);await expect(page.getByRole('dialog')).toContainText('第 1 页');
 await page.getByRole('button',{name:'关闭来源',exact:true}).click();
 await expect(page.getByRole('status',{name:'本机存储状态'})).toHaveText('已保存到当前浏览器');
 await page.reload();await send('再按这份资料讲第一题');
 await expect(page.locator('.msg.assistant').last()).toContainText(question);
 expect(contents).toBe(1);
 await page.locator('.materials-panel summary').click();
 await page.getByLabel('使用资料 '+resource.title,{exact:true}).uncheck();
 await send('再读一遍第一题');
 expect(requests.at(-1).tools.some((tool:any)=>tool.function.name==='read_context')).toBe(false);
 expect(JSON.stringify(requests.at(-1))).not.toContain(question);
 expect(contents).toBe(1);
});

test('material detail previews the old-site file for free and a reading list imports several materials at once', async ({ page }) => {
 const user='arxiv-material-fixture';const accessed:string[]=[];
 const material=(id:string,title:string,format:string,alreadyDownloaded=false)=>({id,kind:'material',title,courseName:'',format,size:2048,url:`https://materials.example.com/material/${id}`,availability:'available',alreadyDownloaded});
 const linear=material('21','线性代数讲义','md');const exam=material('22','线代期末真题','txt',true);const notes=material('23','线代笔记','zip');const scan=material('24','线代扫描版','pdf');
 await page.route('https://materials.example.com/**',route=>route.fulfill({contentType:'text/plain',body:'preview'}));
 await page.route('**/api/**',async route=>{
  const request=route.request();const path=new URL(request.url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(path==='/api/session')return route.fulfill({json:{mode:'old-site',user:{id:user,name:'测试同学'},oldSite:{status:'ready'},initialContext:{},modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-05',limit:100000,used:0}}});
  expect(path).not.toMatch(/\/api\/old-site.*\/(quota|access|content)$/);
  if(path==='/api/old-site/materials')return route.fulfill({json:{items:[linear,exam,notes,scan],total:4,page:1,pageSize:20,hasMore:false}});
  const detail=[linear,exam,notes,scan].find(m=>path===`/api/old-site/materials/${m.id}`);if(detail)return route.fulfill({json:detail});
  const read=path.match(/\/materials\/(\d+)\/parsed$/);
  if(read){accessed.push(read[1]);return route.fulfill({json:parsed('矩阵的秩与线性方程组。')});}
  return route.fulfill({status:404});
 });
 await page.goto('/');
 await page.getByRole('button',{name:'添加',exact:true}).click();await page.getByRole('button',{name:'搜索课程资料',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'课程资料'});
 await dialog.getByRole('button',{name:/线性代数讲义/}).click();
 await expect(dialog.locator('iframe[title="预览：线性代数讲义"]')).toHaveAttribute('src','https://materials.example.com/api/materials/21/preview');
 await expect(dialog.locator('iframe[title="预览：线性代数讲义"]')).toHaveAttribute('sandbox','');await expect(dialog).toContainText('课程资料 · MD');expect(accessed).toHaveLength(0);
 await dialog.getByRole('button',{name:'＋ 选择其他资料'}).click();
 const basket=dialog.getByRole('region',{name:'待读清单'});await expect(basket).toContainText('线性代数讲义');await expect(basket).not.toContainText('下载额度');
 await dialog.getByRole('button',{name:/线代笔记/}).click();await expect(dialog).toContainText('该格式暂不支持在线预览');await dialog.getByRole('button',{name:'← 返回搜索'}).click();
 await dialog.getByRole('button',{name:/线代扫描版/}).click();const pdf=dialog.locator('iframe[title="预览：线代扫描版"]');await expect(pdf).toHaveAttribute('src','https://materials.example.com/api/materials/24/preview');await expect(pdf).not.toHaveAttribute('sandbox',/.*/);
 await dialog.getByRole('button',{name:'＋ 选择其他资料'}).click();await expect(basket).toContainText('待读清单 · 2 份文件');await dialog.getByRole('button',{name:'移出：线代扫描版'}).click();await expect(basket).not.toContainText('线代扫描版');
 await dialog.getByRole('button',{name:/线代期末真题/}).click();await expect(dialog.locator('iframe[title="预览：线代期末真题"]')).toHaveAttribute('sandbox','');
 await expect(dialog).toContainText('待读清单里还有 1 项资料');
 await dialog.getByRole('button',{name:'确认读取全部 2 份文件'}).click();await expect(dialog).toHaveCount(0);
 expect(accessed.sort()).toEqual(['21','22']);expect(accessed).not.toContain('24');
 await page.locator('.materials-panel summary').click();
 await expect(page.getByRole('button',{name:'查看文本：线性代数讲义',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'查看文本：线代期末真题',exact:true})).toBeVisible();
});

test('a failed file stays on the reading list with a summary while the others import', async ({ page }) => {
 const user='arxiv-material-fixture';
 const material=(id:string,title:string,format:string)=>({id,kind:'material',title,courseName:'线性代数',format,size:2048,url:`https://materials.example.com/material/${id}`,availability:'available',alreadyDownloaded:false});
 const good=material('31','线代讲义','txt');const broken=material('32','损坏的讲义','pdf');
 await page.route('https://materials.example.com/**',route=>route.fulfill({contentType:'text/plain',body:'preview'}));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(path==='/api/session')return route.fulfill({json:{mode:'old-site',user:{id:user,name:'测试同学'},oldSite:{status:'ready'},initialContext:{},modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-05',limit:100000,used:0}}});
  expect(path).not.toMatch(/\/api\/old-site.*\/(quota|access|content)$/);
  if(path==='/api/old-site/materials')return route.fulfill({json:{items:[good,broken],total:2,page:1,pageSize:20,hasMore:false}});
  const detail=[good,broken].find(m=>path===`/api/old-site/materials/${m.id}`);if(detail)return route.fulfill({json:detail});
  if(path.endsWith('/32/parsed'))return route.fulfill({status:422,json:{error:{code:'FILE_PDF',message:'文件损坏'}}});
  if(path.endsWith('/parsed'))return route.fulfill({json:parsed('特征值与特征向量。')});
  return route.fulfill({status:404});
 });
 await page.goto('/');await page.getByRole('button',{name:'添加',exact:true}).click();await page.getByRole('button',{name:'搜索课程资料',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'课程资料'});
 await dialog.getByRole('button',{name:/线代讲义/}).click();await dialog.getByRole('button',{name:'＋ 选择其他资料'}).click();
 await dialog.getByRole('button',{name:/损坏的讲义/}).click();await dialog.getByRole('button',{name:'＋ 选择其他资料'}).click();
 const basket=dialog.getByRole('region',{name:'待读清单'});await basket.getByRole('button',{name:'确认读取 2 份文件'}).click();
 await expect(dialog.getByRole('alert')).toContainText('已导入 1 份。');await expect(dialog.getByRole('alert')).toContainText('损坏的讲义：文件损坏');
 await expect(basket).toContainText('损坏的讲义');await expect(basket).not.toContainText('线代讲义');
});
