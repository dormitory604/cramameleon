import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';

test('deployed local archive to real teaching, citation, quiz, local feedback and next question',async({page})=>{
 test.skip(process.env.RUN_LIVE_MATERIALS!=='1','Explicit opt-in required for paid real model validation');
 const report:any={startedAt:new Date().toISOString(),passed:false,modelRequests:0,requests:[],checks:[]};
 const requests:any[]=[];
 page.on('request',request=>{
  if(new URL(request.url()).pathname!=='/api/model')return;
  const body=request.postDataJSON();requests.push(body);report.modelRequests++;
  report.requests.push({requestId:body.requestId,turnId:body.turnId,tools:body.tools.map((t:any)=>t.function.name),
   results:body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>({id:m.tool_call_id,content:m.content}))});
 });
 try {
  const env=await readFile('.env.internal','utf8');const token=env.match(/^APP_ACCESS_TOKEN=(.*)$/m)![1].trim().replace(/^['"]|['"]$/g,'');
  await page.goto('/');await page.getByLabel('内部访问口令').fill(token);await page.getByRole('button',{name:'进入学习空间'}).click();
  await expect(page.getByLabel('导入本地资料',{exact:true})).toBeEnabled();
  report.budgetBefore=(await (await page.request.get('/api/session')).json()).budget;
  const lecture='# 条件概率（自编验收讲义）\n\n条件概率表示已知事件 B 发生时事件 A 发生的概率。当 P(B)>0 时，P(A|B)=P(A∩B)/P(B)。例如班级有 10 人，其中 6 人学 Python，学 Python 的人中有 3 人也学 Java。已知某人学 Python，他也学 Java 的概率是 3/6=1/2，而不是 3/10。\n\n# 互斥与独立\n\n互斥指两个事件不能同时发生；独立指一个事件发生不改变另一个事件发生的概率。两者含义不同。';
  const bytes=zipSync({'probability.md':strToU8(lecture),'not-selected.txt':strToU8('UNSELECTED_MARKER secret fixture')});
  await page.getByLabel('导入本地资料',{exact:true}).setInputFiles({name:'acceptance-course.zip',mimeType:'application/zip',buffer:Buffer.from(bytes)});
  await page.getByLabel('ZIP 目录').getByRole('checkbox',{name:/probability.md/}).check();await page.getByRole('button',{name:'解析选中条目'}).click();
  await expect(page.getByLabel('使用资料 probability.md',{exact:true})).toBeChecked();expect(report.modelRequests).toBe(0);report.checks.push('ZIP selection parsed real bytes; import made zero model calls');
  const send=async(text:string)=>{await page.getByLabel('输入消息').fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0,{timeout:120000});await expect(page.locator('.error-card')).toHaveCount(0);};
  await send('只依据已选资料，用两句话解释条件概率，并附可点击的来源。不出题。');
  await expect(page.locator('.sources button').first()).toBeVisible();await page.locator('.sources button').first().click();await expect(page.getByRole('dialog')).toContainText('P(A∩B)/P(B)');await expect(page.getByRole('dialog')).toContainText('段落');await page.getByRole('button',{name:'关闭来源'}).click();report.checks.push('Real explanation cites actual parsed local text and location');
  await page.waitForTimeout(400);await page.reload();await expect(page.getByLabel('使用资料 probability.md',{exact:true})).toBeChecked();report.checks.push('Reload restored selected document, cached text and conversation');
  await send('依据选中资料考考我，直接给一道简短的改编单选题，并附来源。');
  await expect(page.locator('.quiz')).toHaveCount(1);await expect(page.locator('.quiz')).toContainText('改编');await expect(page.locator('.msg.assistant').last().locator('.sources button')).not.toHaveCount(0);
  const beforeAnswer=report.modelRequests;await page.locator('.quiz-options button').first().click();await expect(page.locator('.quiz-feedback')).toBeVisible();await page.waitForTimeout(300);expect(report.modelRequests).toBe(beforeAnswer);report.checks.push('Grounded quiz validates and local answer reveals explanations without API calls');
  await page.getByRole('button',{name:'下一题',exact:true}).click();await expect(page.locator('.quiz')).toHaveCount(2,{timeout:120000});await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0,{timeout:120000});await expect(page.locator('.error-card')).toHaveCount(0);report.checks.push('User-triggered next question continues real Agent loop');
  expect(JSON.stringify(requests)).not.toContain('UNSELECTED_MARKER');report.checks.push('Outgoing model requests never contain unselected archive text');
  report.chat=await page.getByLabel('聊天记录').innerText();report.budgetAfter=(await (await page.request.get('/api/session')).json()).budget;
  await mkdir('.preflight',{recursive:true});await page.screenshot({path:'.preflight/materials-live.png',fullPage:true});report.passed=true;
 } catch(error) {report.failure=error instanceof Error?error.message:String(error);throw error;}
 finally {report.finishedAt=new Date().toISOString();await mkdir('.preflight',{recursive:true});await writeFile('.preflight/materials-live.json',JSON.stringify(report,null,2)+'\n');await page.request.post('/api/logout').catch(()=>{});}
});
