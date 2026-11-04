import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { txt, docx, pptx, pdf } from '../materialFixtures.ts';
const session={user:{id:'material-user',name:'test'},mode:'internal',modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-04',limit:100000,used:0}};
const file=(name:string,bytes:Uint8Array)=>({name,mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});
test('all formats run in real workers; ZIP selection, grounded quiz, cache, scope and deletion close the loop',async({page})=>{
 test.setTimeout(90000);
 const requests:any[]=[];let refs:any[]=[];
 await page.route('**/api/session',r=>r.fulfill({json:session}));await page.route('**/api/health',r=>r.fulfill({json:{status:'ok'}}));
 await page.route('**/api/model',async route=>{
  const b=route.request().postDataJSON();requests.push(b);const last=b.messages.at(-1);let step:any;
  if(last.role==='user')step={type:'tool_call',id:'search',name:'search_context',arguments:{query:'条件概率'}};
  else if(last.tool_call_id==='search'){
   const chunks=JSON.parse(last.content).chunks;expect(chunks.length).toBeGreaterThan(0);expect(chunks.every((c:any)=>c.title==='lecture.txt')).toBeTruthy();refs=chunks.slice(0,1).map(({documentId,chunkId}:any)=>({documentId,chunkId}));
   step={type:'tool_call',id:'cite',name:'cite_sources',arguments:{refs}};
  } else if(last.tool_call_id==='cite')step={type:'tool_call',id:'quiz',name:'present_quiz',arguments:{question:'条件概率的分母是什么？',options:[{id:'A',text:'P(B)',explanation:'资料给出分母为P(B)'},{id:'B',text:'P(A)',explanation:'分母应该是条件事件概率'}],correctOptionId:'A',origin:'adapted',sourceRefs:refs}};
  else step={type:'text_delta',delta:'请作答，来源已附在下方。'};
  const events=[{type:'start',requestId:b.requestId},step,{type:'usage',usage:{input:1,output:1,total:2}},{type:'finish',stopReason:step.type==='tool_call'?'toolUse':'stop'}];
  await route.fulfill({contentType:'text/event-stream',body:events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')});
 });
 await page.goto('/');const upload=page.getByLabel('导入本地资料',{exact:true});await expect(upload).toBeEnabled();
 await upload.setInputFiles([file('lecture.txt',strToU8(txt)),file('notes.md',strToU8('# 条件概率\n\n根据条件计算概率')),file('word.docx',docx()),file('deck.pptx',pptx()),file('pages.pdf',pdf())]);
 await expect(page.getByText('已导入 5 份资料。',{exact:true})).toBeVisible({timeout:45000});
 expect(requests.length).toBe(0);
 await page.getByRole('button',{name:'查看文本：pages.pdf',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('第 1 页');await expect(page.getByRole('dialog')).toContainText('Conditional probability');
 await page.getByLabel('文本位置').selectOption('chunk-2');await expect(page.getByRole('dialog')).toContainText('第 2 页');await page.getByRole('button',{name:'关闭来源'}).click();
 await page.getByRole('button',{name:'查看文本：deck.pptx',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('第一张');await page.getByLabel('文本位置').selectOption('chunk-2');await expect(page.getByRole('dialog')).toContainText('第二张');await page.getByRole('button',{name:'关闭来源'}).click();
 const archive=zipSync({'selected.txt':strToU8('选中条目'),'unused.txt':strToU8('UNSELECTED_SECRET'),'image.png':new Uint8Array([1,2])});
 await upload.setInputFiles(file('course.zip',archive));await expect(page.getByLabel('ZIP 目录')).toBeVisible();
 await expect(page.getByLabel('ZIP 目录').getByRole('checkbox',{name:/image/})).toBeDisabled();
 await page.getByLabel('ZIP 目录').getByRole('checkbox',{name:/selected.txt/}).check();await page.getByRole('button',{name:'解析选中条目'}).click();await expect(page.getByRole('button',{name:'查看文本：selected.txt',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'查看文本：unused.txt',exact:true})).toHaveCount(0);expect(requests.length).toBe(0);
 await upload.setInputFiles(file('duplicate.txt',strToU8(txt)));await expect(page.getByText(/已有相同内容/)).toBeVisible();await expect(page.getByRole('button',{name:'查看文本：duplicate.txt',exact:true})).toHaveCount(0);
 for(const name of ['notes.md','word.docx','deck.pptx','pages.pdf','selected.txt'])await page.getByLabel('使用资料 '+name,{exact:true}).uncheck();
 await page.waitForTimeout(400);await page.reload();await expect(page.getByLabel('使用资料 lecture.txt',{exact:true})).toBeChecked();await expect(page.getByLabel('使用资料 pages.pdf',{exact:true})).not.toBeChecked();
 await page.getByLabel('输入消息').fill('依据选中资料出一道题，并引用来源');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('条件概率的分母是什么？',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0);
 const count=requests.length;await page.getByRole('button',{name:'A P(B)',exact:true}).click();await expect(page.getByText('回答正确',{exact:true})).toBeVisible();expect(requests.length).toBe(count);
 expect(JSON.stringify(requests)).not.toContain('UNSELECTED_SECRET');expect(JSON.stringify(requests)).not.toContain('第一张：事件');
 await page.getByRole('button',{name:'▧ lecture.txt',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('P(A∩B)/P(B)');await page.getByRole('button',{name:'关闭来源'}).click();
 await page.getByRole('button',{name:'新对话',exact:false}).click();await expect(page.getByLabel('使用资料 lecture.txt',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:/删除对话 lecture.txt/}).click();await page.waitForTimeout(400);await page.reload();await expect(page.getByLabel('使用资料 lecture.txt',{exact:true})).toHaveCount(0);
});
test('parser failures and cancellation do not save partial data or issue model requests',async({page})=>{
 let modelCalls=0;
 await page.route('**/api/session',r=>r.fulfill({json:session}));await page.route('**/api/health',r=>r.fulfill({json:{status:'ok'}}));await page.route('**/api/model',r=>{modelCalls++;return r.abort();});
 await page.goto('/');const upload=page.getByLabel('导入本地资料',{exact:true});await expect(upload).toBeEnabled();
 await upload.setInputFiles(file('scan.pdf',pdf(true)));await expect(page.getByText(/未提取到文本/)).toBeVisible({timeout:30000});
 await upload.setInputFiles(file('broken.pdf',strToU8('%PDF-1.4 corrupted')));await expect(page.getByText(/PDF 无法解析/)).toBeVisible();
 await upload.setInputFiles(file('nested.zip',zipSync({'inner.zip':zipSync({'a.txt':strToU8('x')})})));await expect(page.getByText(/禁止嵌套/)).toBeVisible();
 // Delay worker loading so the cancellation occurs before parsing can return.
 await page.route(/material\.worker[.-]/,async route=>{await new Promise(r=>setTimeout(r,1000));await route.continue().catch(()=>{});});
 await upload.setInputFiles(file('cancel.txt',strToU8(txt)));await page.getByRole('button',{name:'取消导入'}).click();await expect(page.getByText(/已取消，未提交/)).toBeVisible();
 await page.waitForTimeout(1200);await expect(page.getByLabel('使用资料 cancel.txt',{exact:true})).toHaveCount(0);expect(modelCalls).toBe(0);
 await upload.setInputFiles(file('retry.txt',strToU8(txt)));await expect(page.getByLabel('使用资料 retry.txt',{exact:true})).toBeChecked();
});
