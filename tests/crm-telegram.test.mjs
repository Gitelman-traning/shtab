import test from 'node:test';
import assert from 'node:assert/strict';
import {isCrmTelegramUpdate,routeCrmTelegram} from '../site/functions/api/_crm-telegram.js';
import {onRequestPost} from '../site/functions/api/tgtask.js';
const secret='synthetic-shared-webhook-secret',id='a'.repeat(32),nonce='b'.repeat(16),url='https://synthetic-crm.trycloudflare.com/api/staff-telegram/webhook';
const env={CRM_STAFF_TELEGRAM_URL:url,CRM_STAFF_TELEGRAM_WEBHOOK_SECRET:secret};
const message=text=>({update_id:1,message:{from:{id:11,is_bot:false},chat:{id:11,type:'private'},text}});
const callback=()=>({update_id:2,callback_query:{from:{id:11,is_bot:false},message:{chat:{id:11,type:'private'},message_id:42},data:`crm:link:${id}:${nonce}`}});
test('shared Telegram bot routes only private CRM prefix, preserves Shtab login/task/business messages',async()=>{
 for(const text of ['/start '+id,'/start','Новая задача','/start c'+id+' лишнее'])assert.equal(isCrmTelegramUpdate(message(text)),false);
 for(const data of [{update_id:3,business_message:{}},{update_id:4,business_connection:{}},message('/start c'+id)]){
  if(data.message){data.message.chat.type='supergroup';}assert.equal(await routeCrmTelegram(data,env,{fetcher:()=>assert.fail('Must stay in Shtab')}),null);
 }
 assert.equal(isCrmTelegramUpdate(message('/start c'+id)),true);assert.equal(isCrmTelegramUpdate(callback()),true);
 const forged=message('/start c'+id);forged.message.from.id=22;assert.equal(isCrmTelegramUpdate(forged),false);
});
test('shared Telegram forwarding uses fixed trusted HTTPS route, dedicated secret and no redirects',async()=>{
 for(const update of [message('/start c'+id),callback()]){
  let calls=0;const response=await routeCrmTelegram(update,env,{fetcher:async(target,init)=>{calls++;assert.equal(target,url);assert.equal(init.redirect,'error');assert.equal(init.headers['X-Telegram-Bot-Api-Secret-Token'],secret);assert.deepEqual(JSON.parse(init.body),update);assert.equal(init.headers.Authorization,undefined);return Response.json({ok:true});}});assert.equal(response.status,200);assert.equal(calls,1);
 }
});
test('missing/bad relay configuration never leaks confirmations or falls through to Shtab tasks',async()=>{
 for(const target of [undefined,'http://127.0.0.1/api/staff-telegram/webhook','https://other.example/api/staff-telegram/webhook',url+'?secret=bad','https://u:p@synthetic-crm.trycloudflare.com/api/staff-telegram/webhook']){
  const response=await routeCrmTelegram(message('/start c'+id),{...env,CRM_STAFF_TELEGRAM_URL:target},{fetcher:()=>assert.fail('Must not fetch')});assert.equal(response.status,503);assert.ok(!(await response.text()).includes(secret));
 }
});
test('relay failures are retriable and do not acknowledge a lost update',async()=>{
 for(const fetcher of [async()=>{throw Error('sensitive details');},async()=>Response.json({ok:false},{status:503}),async()=>Response.json({ok:false})]){
  const response=await routeCrmTelegram(message('/start c'+id),env,{fetcher});assert.equal(response.status,503);assert.ok(!(await response.text()).includes('sensitive'));
 }
});
test('shared webhook verifies existing Shtab secret before forwarding a CRM confirmation',async()=>{
 const oldFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({ok:true});};
 const config={...env,OKK_KV:{get:async key=>key==='dash:tg-secret'?'existing-shtab-webhook-secret':null}};
 const request=token=>new Request('https://shtab-20v.pages.dev/api/tgtask',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':token},body:JSON.stringify(message('/start c'+id))});
 try{assert.equal((await onRequestPost({request:request('wrong'),env:config})).status,403);assert.equal(calls,0);assert.equal((await onRequestPost({request:request('existing-shtab-webhook-secret'),env:config})).status,200);assert.equal(calls,1);}finally{globalThis.fetch=oldFetch;}
});
