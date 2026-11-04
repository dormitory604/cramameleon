import { test, expect } from '@playwright/test';
const session={user:{id:'browser-user',name:'test'},mode:'internal',modelReady:true,model:'deepseek-flash',limits:{maxToolCalls:6,timeoutSeconds:120,maxOutputTokens:512},budget:{day:'2026-11-04',limit:100000,used:0}};
test('multi-session history, retry, local quiz feedback, persistence and delete',async({page})=>{
 let loggedIn=false;const requests:any[]=[];
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/health')return route.fulfill({json:{status:'ok'}});
  if(path==='/api/internal/session'){loggedIn=true;return route.fulfill({json:session});}
  if(path==='/api/session')return route.fulfill({status:loggedIn?200:401,json:loggedIn?session:{error:{code:'AUTH_REQUIRED'}}});
  if(path==='/api/model'){
   const body=route.request().postDataJSON();requests.push(body);
   const last=body.messages.at(-1);
   if(last.content==='失败请求'&&requests.filter(v=>v.messages.at(-1).content==='失败请求').length===1)return route.fulfill({status:502,json:{error:{code:'MODEL_UNAVAILABLE',message:'测试故障'}}});
   const quiz=last.content==='出题';
   const events=[{type:'start',requestId:body.requestId},...(quiz?[{type:'tool_call',id:'q-1',name:'present_quiz',arguments:{question:'1+1 等于多少？',options:[{id:'A',text:'2',explanation:'相加得到2'},{id:'B',text:'3',explanation:'3不正确'}],correctOptionId:'A'}}]:[{type:'text_delta',delta:'回答：'+(last.role==='tool'?'请选择选项':last.content)}]),{type:'usage',usage:{input:10,output:2,total:12}},{type:'finish',stopReason:quiz?'toolUse':'stop'}];
   return route.fulfill({contentType:'text/event-stream',body:events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')});
  }
  return route.fulfill({status:404});
 });
 await page.goto('/');await page.getByLabel('内部访问口令').fill('test-token');await page.getByRole('button',{name:'进入学习空间'}).click();
 const send=async(text:string)=>{await page.getByLabel('输入消息').fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByRole('button',{name:'停止',exact:true})).toHaveCount(0);};
 await send('记住课程是概率论');await expect(page.getByText('回答：记住课程是概率论',{exact:true})).toBeVisible();
 await send('接着讲');expect(requests[1].messages.some((m:any)=>m.content==='记住课程是概率论')).toBeTruthy();
 const firstSession=requests[0].sessionId;
 await page.getByRole('button',{name:'新对话'}).click();await send('另一课程');
 expect(requests[2].sessionId).not.toBe(firstSession);expect(requests[2].messages.some((m:any)=>m.content==='记住课程是概率论')).toBeFalsy();
 await send('失败请求');await expect(page.getByText('测试故障')).toBeVisible();await page.getByRole('button',{name:'重试',exact:true}).click();await expect(page.getByText('回答：失败请求',{exact:true})).toBeVisible();
 expect(requests.at(-1).messages.filter((m:any)=>m.content==='失败请求')).toHaveLength(1);
 expect(page.locator('.msg.user')).toHaveCount(2);
 await send('出题');await expect(page.getByText('1+1 等于多少？')).toBeVisible();
 const before=requests.length;await page.locator('.quiz-option').first().click();await expect(page.getByText('回答正确',{exact:true})).toBeVisible();expect(requests.length).toBe(before);
 await expect(page.getByText('已保存到当前浏览器')).toBeVisible();await page.waitForTimeout(300);
 await page.reload();await expect(page.getByText('回答正确',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'删除对话 另一课程'}).click();await page.waitForTimeout(350);await page.reload();await expect(page.getByText('1+1 等于多少？')).toHaveCount(0);
});
test('missing key disables send and clearly explains setup',async({page})=>{
 await page.route('**/api/session',r=>r.fulfill({json:{...session,modelReady:false}}));
 await page.route('**/api/health',r=>r.fulfill({json:{status:'ok'}}));
 await page.goto('/');await expect(page.getByText('模型尚未配置。请在服务器环境文件填写真实 API 密钥并重启服务。')).toBeVisible();await expect(page.getByLabel('输入消息')).toBeDisabled();await expect(page.getByRole('button',{name:'发送消息',exact:true})).toBeDisabled();
});

test('learning scope and chapter survive reload and preference editing',async({page})=>{
 let count=0;
 await page.route('**/api/session',r=>r.fulfill({json:session}));
 await page.route('**/api/health',r=>r.fulfill({json:{status:'ok'}}));
 await page.route('**/api/model',async route=>{
  const body=route.request().postDataJSON();count++;
  const state=count<=3?{course:'概率论',chapter:'',progress:'选择复习部分',phase:'scope'}:{course:'概率论',chapter:'条件概率',progress:'理解条件概率',phase:'learning'};
  const step=count===1?{type:'tool_call',id:'skill',name:'read_skill',arguments:{name:'review'}}:
   count===2||count===4?{type:'tool_call',id:'state-'+count,name:'update_learning_state',arguments:state}:
   {type:'text_delta',delta:count===3?'想先复习哪一部分？':'条件概率是已知条件下的概率。'};
  const events=[{type:'start',requestId:body.requestId},step,{type:'usage',usage:{input:1,output:1,total:2}},{type:'finish',stopReason:step.type==='tool_call'?'toolUse':'stop'}];
  await route.fulfill({contentType:'text/event-stream',body:events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')});
 });
 await page.goto('/');await page.getByLabel('输入消息').fill('带我复习概率论');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByLabel('学习进度')).toContainText('概率论');await expect(page.getByText('等待你的选择')).toBeVisible();
 await page.getByLabel('输入消息').fill('我选条件概率');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await expect(page.getByLabel('学习进度')).toContainText('条件概率');await expect(page.getByRole('button',{name:'继续学习',exact:true})).toBeVisible();
 await page.getByText('当前对话偏好',{exact:true}).click();await page.getByPlaceholder('例如：回答简短，不主动出题').fill('回答简短');
 await page.waitForTimeout(350);await page.reload();await expect(page.getByLabel('学习进度')).toContainText('条件概率');
});
