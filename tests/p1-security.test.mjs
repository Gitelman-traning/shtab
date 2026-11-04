import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fixture, request, rows, root } from './helpers.mjs';
import * as lib from '../site/functions/api/_lib.js';
import {beginLogin,reserveCode,confirmCode,redeemCode} from '../site/functions/api/_tg-login.js';
import { canReadMetric } from '../site/functions/api/_metric-access.js';
import { onRequest } from '../site/functions/_middleware.js';
import * as points from '../site/functions/api/points.js';
import * as metrics from '../site/functions/api/metrics.js';
import * as status from '../site/functions/api/status.js';
import * as view from '../site/functions/api/sections/[id]/view.js';
import * as data from '../site/functions/api/sections/[id]/data.js';
import * as versions from '../site/functions/api/sections/[id]/versions.js';
import * as users from '../site/functions/api/users.js';
import * as me from '../site/functions/api/me.js';
import * as leave from '../site/functions/api/hr/leave.js';
import * as structure from '../site/functions/api/hr/structure.js';
import * as prep from '../site/functions/api/prep.js';
import * as pings from '../site/functions/api/pings.js';
import * as ingest from '../site/functions/api/ingest.js';
import * as ask from '../site/functions/__ask.js';
import * as chat from '../site/functions/api/chat.js';
import { isolatedView, VIEW_CSP } from '../site/functions/api/sections/_isolated-view.js';

globalThis.fetch=async()=>{throw Error('External network disabled in tests');};
const envs=[];const env=(...args)=>{const e=fixture(...args);envs.push(e);return e;};
afterEach(()=>{for(const e of envs.splice(0))e.sqlite.close();globalThis.fetch=async()=>{throw Error('External network disabled in tests');};});
const point=(e,metric,value=42,ptype='day',dim='')=>{
  const yesterday=new Date(Date.now()-864e5).toISOString().slice(0,10);
  e.sqlite.prepare('INSERT INTO points (metric,ptype,period,dim,asof,value) VALUES (?,?,?,?,?,?)').run(metric,ptype,yesterday,dim,ptype==='day'?'':yesterday,value);
};
const section=(e)=>{
  e.sqlite.prepare("INSERT OR REPLACE INTO sections (id,name,config) VALUES ('sales','Synthetic','{\"metrics\":[\"l1.booked\",\"l2.sales\"]}')").run();
  e.sqlite.prepare("INSERT INTO section_versions (section,version,html,prompt,active) VALUES ('sales',1,'<!doctype html><html><body>ACTIVE</body></html>','PRIVATE PROMPT',1),('sales',2,'<!doctype html><html><body>DRAFT</body></html>','DRAFT PROMPT',0)").run();
};
const llm=()=>{const calls=[];globalThis.fetch=async(url,init)=>{assert.match(String(url),/^https:\/\/model.invalid\//);calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:'synthetic answer'}}]});};return calls;};

test('P2-9 AI distinguishes absent, confirmed zero and incomplete periods',async()=>{
  const e=env(),calls=llm();e.LLM_API_KEY='fixture';e.LLM_BASE_URL='https://model.invalid';
  const askForData=async()=>{
    const response=await chat.onRequestPost({request:request('/api/chat',{messages:[{role:'user',content:'итоги'}]}),env:e});
    assert.equal(response.status,200);return calls.at(-1).messages[0].content;
  };
  const empty=await askForData();assert.match(empty,/Суточные показатели: данных нет/);assert.doesNotMatch(empty,/вчера 0/);
  point(e,'l1.booked',0);const present=await askForData();assert.match(present,/\[l1.booked\]: вчера 0/);assert.match(present,/\[l2.sales\]: вчера нет данных/);
});

test('P2-9 Telegram cards keep source figures with a forbidden total and show gaps as dashes',async()=>{
  const elements=new Map();const node=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:''});return elements.get(id);};
  const document={getElementById:node,querySelectorAll:()=>[],querySelector:()=>null,documentElement:{removeAttribute(){},setAttribute(){}}};
  class November4 extends Date { constructor(...args){super(...(args.length?args:['2026-11-04T09:00:00Z']));} static now(){return Date.parse('2026-11-04T09:00:00Z');} }
  const allRows=[1,2,3].map((n)=>({period:'2026-11-0'+n,value:n===1?2:1}));
  const context={document,Date:November4,fetch:async address=>{
    const u=new URL(address,'https://test.invalid');const m=u.searchParams.get('metric');
    if(u.searchParams.get('dim')==='')return Response.json({ok:false},{status:403});
    if(m==='mkt.leads')return Response.json({ok:true,rows:allRows});
    if(m==='l2.sales')return Response.json({ok:true,rows:allRows.map(r=>({...r,value:0}))});
    return Response.json({ok:true,rows:[]});
  }};
  runInNewContext(readFileSync(new URL('site/public/ui.js',root),'utf8'),context);
  const html=readFileSync(new URL('site/public/marketing/telegram/index.html',root),'utf8');
  for(const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))runInNewContext(script,context);
  await new Promise(resolve=>setImmediate(resolve));
  const funnel=node('funnel').innerHTML;assert.match(funnel,/Лиды<\/div><div class="v">4</);assert.match(funnel,/Продажи<\/div><div class="v">0</);assert.match(funnel,/ЦА<\/div><div class="v">—</);
  assert.match(node('stamp').textContent,/часть показателей недоступна/);assert.doesNotMatch(node('kpis').innerHTML+node('trend').innerHTML,/null|undefined|NaN/);
});

for(const metric of ['l2.sales','fun.l2.paid','cv.l2.held.paid','pay.full','seg.sales'])test('P1-1 denies closed sales through '+metric,async()=>{
  const e=env({'sales.l2':0});point(e,metric);
  const r=await points.onRequestGet({request:request('/api/points?metric='+metric),env:e});
  assert.equal(r.status,403);assert(!e.DB.calls.some(c=>/FROM points/.test(c.sql)));
});
test('P1-1 allows permitted points; denies anonymous and unknown metrics',async()=>{
  const e=env();point(e,'l1.booked');
  assert.equal((await (await points.onRequestGet({request:request('/api/points?metric=l1.booked'),env:e})).json()).rows[0].value,42);
  assert.equal((await points.onRequestGet({request:request('/api/points?metric=l1.booked',undefined,{auth:'none'}),env:e})).status,401);
  assert.equal((await points.onRequestGet({request:request('/api/points?metric=unregistered'),env:e})).status,403);
});
test('P1-1 mixed request cannot leak a forbidden metric',async()=>{
  const e=env({'sales.l2':0});point(e,'l1.booked');point(e,'l2.sales');
  assert.equal((await points.onRequestGet({request:request('/api/points?metric=l1.booked,l2.sales'),env:e})).status,403);
});
test('P1-1 source restrictions deny totals and accept an explicitly allowed source',async()=>{
  const e=env({'marketing':0,'marketing.youtube':1});point(e,'mkt.leads',7,'day','YouTube');
  assert.equal((await points.onRequestGet({request:request('/api/points?metric=mkt.leads'),env:e})).status,403);
  const r=await points.onRequestGet({request:request('/api/points?metric=mkt.leads&dim=YouTube'),env:e});
  assert.equal(r.status,200);assert.equal((await r.json()).rows.length,1);
});
test('P1-1 registry and status omit closed metrics',async()=>{
  const e=env({'sales.l2':0});point(e,'l2.sales');point(e,'l1.booked');
  const m=await (await metrics.onRequestGet({request:request('/api/metrics'),env:e})).json();assert(!m.metrics.some(x=>x.id==='l2.sales'));
  const s=await (await status.onRequestGet({request:request('/api/status'),env:e})).json();assert(!s.coverage.some(x=>x.metric==='l2.sales'));
});
test('P1-1 closed section rejects both views and version history',async()=>{
  const e=env({sales:0});section(e);
  for(const endpoint of [view,versions])assert.equal((await endpoint.onRequestGet({request:request('/api/sections/sales/view'),env:e,params:{id:'sales'}})).status,403);
});
test('P1-1 viewer sees published version but not draft or prompts; editor can preview',async()=>{
  const e=env();section(e);
  const v=await (await versions.onRequestGet({request:request('/api/sections/sales/versions'),env:e,params:{id:'sales'}})).json();
  assert.equal(v.versions.length,1);assert.equal(v.versions[0].prompt,undefined);
  assert.equal((await view.onRequestGet({request:request('/api/sections/sales/view?v=2'),env:e,params:{id:'sales'}})).status,404);
  e.sqlite.prepare("INSERT INTO perms (login,section,level) VALUES ('reader','sales',2)").run();
  assert.equal((await view.onRequestGet({request:request('/api/sections/sales/view?v=2'),env:e,params:{id:'sales'}})).status,200);
});
test('P1-1 aggregate section snapshot excludes closed child data',async()=>{
  const e=env({'sales.l2':0});section(e);point(e,'l1.booked');point(e,'l2.sales',987654);
  const r=await (await data.onRequestGet({request:request('/api/sections/sales/data'),env:e,params:{id:'sales'}})).json();
  assert.equal(r.rows.length,1);assert.equal(r.rows[0][0],'l1.booked');assert(!JSON.stringify(r).includes('987654'));
});
test('P1-2 hub preview with all stock metrics stays within the D1 parameter limit',async()=>{
  const e=env({},'admin');
  const cfg=JSON.parse(e.sqlite.prepare("SELECT config FROM sections WHERE id='hub'").get().config);
  const stocks=cfg.metrics.filter(id=>/^(pay|fun|cv)\./.test(id));
  assert(stocks.length>33,'fixture must reproduce the production-sized hub');
  for(const [i,id] of stocks.entries())point(e,id,i+1,id.startsWith('pay.')?'potok':'month');
  e.sqlite.prepare("INSERT INTO section_versions (section,version,html,active) VALUES ('hub',1,'<!doctype html><html><body>Existing hub view</body></html>',1)").run();
  const snapshot=await data.onRequestGet({request:request('/api/sections/hub/data?days=120'),env:e,params:{id:'hub'}});
  assert.equal(snapshot.status,200);assert.equal((await snapshot.json()).stock.length,stocks.length);
  const result=await view.onRequestGet({request:request('/api/sections/hub/view?v=1'),env:e,params:{id:'hub'}});
  assert.equal(result.status,200);assert.match(await result.text(),/Existing hub view/);
  assert(e.DB.calls.every(call=>call.args.length<=100));
});
test('P1-1 meeting assistant enforces section before reading transcript/model',async()=>{
  const e=env({'sales.l2.okk':0});e.LLM_API_KEY='fixture';e.LLM_BASE_URL='https://model.invalid';e.kv.set('t:1','PRIVATE TRANSCRIPT');const calls=llm();
  assert.equal((await ask.onRequestPost({request:request('/__ask',{deal:1,question:'summary'}),env:e})).status,403);
  assert.equal(calls.length,0);assert.equal(e.kvCalls.length,0);
});
test('P1-1 permitted meeting assistant remains usable',async()=>{
  const e=env();e.LLM_API_KEY='fixture';e.LLM_BASE_URL='https://model.invalid';e.kv.set('t:1','SYNTHETIC TRANSCRIPT');const calls=llm();
  assert.equal((await ask.onRequestPost({request:request('/__ask',{deal:1,question:'summary'}),env:e})).status,200);assert.equal(calls.length,1);
});
test('P1-1 AI context contains allowed data only, including lookup',async()=>{
  const e=env({'sales.l2':0});point(e,'l1.booked',321);point(e,'l2.sales',987654);point(e,'l2.held',987654,'day','PRIVATE MANAGER');
  e.sqlite.prepare("INSERT INTO knowledge (title,text) VALUES ('Private','PRIVATE KNOWLEDGE')").run();
  e.LLM_API_KEY='fixture';e.LLM_BASE_URL='https://model.invalid';const calls=llm();
  const r=await chat.onRequestPost({request:request('/api/chat',{messages:[{role:'user',content:'покажи менеджера PRIVATE и блогера'}]}),env:e});
  assert.equal(r.status,200);assert.equal(calls.length,1);const prompt=calls[0].messages[0].content;
  assert(prompt.includes('321'));for(const text of ['987654','PRIVATE MANAGER','PRIVATE KNOWLEDGE','[l2.sales]'])assert(!prompt.includes(text),text);
});
test('P1-2 published document has opaque-origin sandbox even when opened directly',async()=>{
  const e=env();section(e);
  const r=await view.onRequestGet({request:request('/api/sections/sales/view'),env:e,params:{id:'sales'}});
  assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/sandbox allow-scripts;/);assert(!VIEW_CSP.includes('allow-same-origin'));assert.match(VIEW_CSP,/connect-src 'none'/);
  assert(!readFileSync(new URL('site/public/section-editor.js',root),'utf8').includes('allow-same-origin'));
});
test('P1-2 snapshot bridge serves only its exact read URL and escapes script payloads',async()=>{
  const snapshot={value:'</script><script>throw Error("injected")</script>'}, url='https://audit.invalid/api/sections/sales/data?days=120';
  const html=isolatedView('<html><body>View</body></html>',snapshot,url);
  const context={window:{},URL,Response,TypeError,Promise};runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  assert.deepEqual(await (await context.window.fetch('/api/sections/sales/data?days=120')).json(),snapshot);
  for(const [target,options] of [['/api/users',{}],[url,{method:'POST'}],['https://external.invalid',{}]])await assert.rejects(context.window.fetch(target,options));
  assert.equal(Object.getOwnPropertyDescriptor(context.window,'fetch').writable,false);
});
for(const [method,handler,body] of [['GET',users.onRequestGet,undefined],['POST',users.onRequestPost,{login:'rogue',role:'admin'}],['PATCH',users.onRequestPatch,{login:'reader',action:'perms',role:'admin'}]])test('P1-3 collector cannot '+method+' users',async()=>{
  const e=env();const before=rows(e,'users');const r=await handler({request:request('/api/users',body,{method,auth:'collector'}),env:e});assert.equal(r.status,403);assert.deepEqual(rows(e,'users'),before);
});
test('P1-3 collector retains explicit ingestion and read operations without admin role',async()=>{
  const e=env();const req=request('/api/points?metric=l1.booked',undefined,{auth:'collector'});const who=await lib.canRead(req,e);assert.equal(who.role,'service');assert.equal(lib.isAdmin(who),false);assert.equal(lib.canEdit(who,'users'),false);
  const r=await ingest.onRequestPost({request:request('/api/ingest',{points:[{metric:'l1.booked',ptype:'day',period:'2026-11-03',value:5}]},{auth:'collector'}),env:e});assert.equal(r.status,200);
  assert.equal((await points.onRequestGet({request:req,env:e})).status,200);
  assert.equal(await lib.canRead(request('/api/chat',{},{auth:'collector'}),e),null);
  assert.equal(lib.canEdit({login:'collector',role:'viewer'},'users'),false);
});
test('P1-3 personal administrator can create a user',async()=>{
  const e=env({},'admin');const r=await users.onRequestPost({request:request('/api/users',{login:'new-member',role:'member'}),env:e});assert.equal(r.status,200);assert.equal(rows(e,'users').length,2);
});
test('P1-3 collector keeps preparation and ping read access without write permissions',async()=>{
  const e=env();
  for(const [path,handler] of [['/api/prep?mode=debriefs',prep.onRequestGet],['/api/prep?mode=collector',prep.onRequestGet],['/api/pings?manager=synthetic',pings.onRequestGet]]) {
    const r=await handler({request:request(path,undefined,{auth:'collector'}),env:e});assert.equal(r.status,200,path);
  }
  const user=await lib.canRead(request('/api/prep',undefined,{auth:'collector'}),e);
  assert.equal(lib.canView(user,'sales.l2'),true);assert.equal(lib.canEdit(user,'sales.l2'),false);assert.equal(lib.canView(user,'hr.team'),false);
  for(const path of ['/api/users','/api/audit','/api/budget','/api/sections'])assert.equal(await lib.canRead(request(path,undefined,{auth:'collector'}),e),null,path);
  assert.equal(await lib.canRead(request('/api/prep',{action:'queue'},{auth:'collector'}),e),null);
});
test('P1-3 recipient lookup exposes only one active Telegram address to the collector',async()=>{
  const e=env();e.sqlite.prepare("UPDATE users SET tg_id='synthetic-chat' WHERE login='reader'").run();
  const path='/api/pings?mode=recipient&match=Synthetic';
  const r=await pings.onRequestGet({request:request(path,undefined,{auth:'collector'}),env:e});assert.deepEqual(await r.json(),{ok:true,tg_id:'synthetic-chat'});
  assert.equal((await pings.onRequestGet({request:request(path),env:e})).status,403);
  e.sqlite.prepare("INSERT INTO users (login,name,pass_hash,salt,role,active,tg_id) VALUES ('another','Synthetic Other','','','member',1,'another-chat')").run();
  assert.equal((await(await pings.onRequestGet({request:request(path,undefined,{auth:'collector'}),env:e})).json()).tg_id,null);
  e.sqlite.prepare("UPDATE users SET active=0 WHERE login='another'").run();
  assert.equal((await(await pings.onRequestGet({request:request(path,undefined,{auth:'collector'}),env:e})).json()).tg_id,'synthetic-chat');
});
test('P1-4 valid legacy HMAC cookie no longer authenticates pages or APIs',async()=>{
  const e=env();const password='synthetic-legacy';e.kv.set('password',password);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('okk-dashboard'))).toString('hex');
  const req=new Request('https://audit.invalid/hr/team/',{headers:{cookie:'okk_auth='+sig}});let reached=false;
  assert.equal((await onRequest({request:req,env:e,next:async()=>{reached=true;return new Response('private');}})).status,401);assert.equal(reached,false);assert.equal(await lib.canRead(req,e),null);assert(!e.kvCalls.some(x=>x[1]==='password'));
});
test('P1-4 setup remains disabled even with empty KV; ordinary login page still loads',async()=>{
  const e=env();for(const method of ['GET','POST'])assert.equal((await onRequest({request:new Request('https://audit.invalid/__setup',{method}),env:e,next:async()=>new Response('unexpected')})).status,410);
  const r=await onRequest({request:request('/',undefined,{auth:'none'}),env:e,next:async()=>new Response('unexpected')});assert.equal(r.status,401);assert.match(await r.text(),/__login/);assert.equal(e.kvCalls.length,0);
});
test('P1-4 personal password and Telegram login still issue personal sessions',async()=>{
  const e=env();const salt='fixture-salt',hash=await lib.hashPassword('fixture-password',salt);e.sqlite.prepare("UPDATE users SET pass_hash=?,salt=? WHERE login='reader'").run(hash,salt);
  const req=new Request('https://audit.invalid/__login',{method:'POST',body:new URLSearchParams({login:'reader',password:'fixture-password'})});
  const r=await onRequest({request:req,env:e,next:async()=>new Response('unused')});assert.equal(r.status,303);assert.match(r.headers.get('set-cookie'),/^shtab_s=/);
  e.TG_BOT_TOKEN='fixture';e.sqlite.prepare("UPDATE users SET tg_id=1234 WHERE login='reader'").run();
  const grant=await beginLogin(e,request('/__tglink'));assert(await reserveCode(e,grant.code,1234));await confirmCode(e,grant.code,1234,true);
  const poll=new Request('https://audit.invalid/__tglink?code='+grant.code,{headers:{cookie:grant.cookie.split(';')[0]}});
  const t=await onRequest({request:poll,env:e,next:async()=>new Response('unused')});assert.equal(t.status,200);assert.match(t.headers.get('set-cookie'),/^shtab_s=/);
});
test('P2-7 concurrent browser and Telegram redemption issues exactly one session',async()=>{
  const e=env();e.sqlite.prepare("UPDATE users SET tg_id=1234 WHERE login='reader'").run();
  const grant=await beginLogin(e,request('/__tglink')),plain=request('/__tglink');
  const browser=new Request(plain.url,{headers:{cookie:grant.cookie.split(';')[0]}});
  assert(await reserveCode(e,grant.code,1234));assert.equal(await reserveCode(e,grant.code,5678),false);
  const go=await confirmCode(e,grant.code,1234,true);
  assert.equal((await redeemCode(e,plain,grant.code,false)).status,'expired');
  assert.equal((await redeemCode(e,plain,grant.code,true)).status,'expired');
  const before=rows(e,'sessions').length;
  const results=await Promise.all([redeemCode(e,browser,grant.code,false),redeemCode(e,plain,go,true),redeemCode(e,browser,grant.code,false)]);
  assert.equal(results.filter(r=>r.cookie).length,1);assert.equal(rows(e,'sessions').length,before+1);
  assert.equal((await redeemCode(e,plain,go,true)).status,'expired');
});
test('P2-7 server expiry and pending-account state cannot issue a session',async()=>{
  const e=env();const grant=await beginLogin(e,request('/__tglink'));assert(await reserveCode(e,grant.code,1234));
  const go=await confirmCode(e,grant.code,1234,false);assert.equal((await redeemCode(e,request('/'),go,true)).status,'pending');
  e.sqlite.exec("UPDATE tg_login_codes SET expires='2000-01-01'");assert.equal((await redeemCode(e,request('/'),go,true)).status,'expired');
});
test('P2-8 temporary password blocks pages/API, rotation revokes every previous device',async()=>{
  const e=env();const hash=await lib.hashPassword('temporary-secret','salt');
  e.sqlite.prepare("UPDATE users SET pass_hash=?,salt='salt',must_change=1,temp_expires='2099-01-01'").run(hash);
  e.sqlite.exec("INSERT INTO sessions(id,login,expires) VALUES('device-two','reader','2099-01-01')");
  assert.equal((await points.onRequestGet({request:request('/api/points?metric=l1.booked'),env:e})).status,401);
  const page=await onRequest({request:request('/sales/l1/'),env:e,next:async()=>new Response('data')});assert.match(page.headers.get('location'),/^\/__password/);
  const r=await me.onRequestPut({request:request('/api/me',{password:'temporary-secret',new_password:'personal-secret'},{method:'PUT'}),env:e});assert.equal(r.status,200);
  const sessions=rows(e,'sessions');assert.equal(sessions.length,1);assert(!['device-two','fixture-session'].includes(sessions[0].id));
  assert.equal(await lib.currentUser(request('/'),e),null);assert.equal(rows(e,'users')[0].must_change,0);
  assert(await lib.currentUser(new Request('https://test.invalid/',{headers:{cookie:r.headers.get('set-cookie').split(';')[0]}}),e));
});
test('P2-8 expired temporary passwords and sessions cannot be used; Telegram-only can set a first password',async()=>{
  const e=env();e.sqlite.exec("UPDATE users SET must_change=1,temp_expires='2000-01-01'");
  assert.equal(await lib.createSession(e,'reader'),null);assert.equal(await lib.currentUser(request('/'),e,true),null);
  e.sqlite.exec("UPDATE users SET must_change=0,tg_id=123");
  assert.equal((await me.onRequestPut({request:request('/api/me',{new_password:'first-personal-password'},{method:'PUT'}),env:e})).status,200);
});
test('P1-4 section checks cover trailing slash and meeting endpoint',async()=>{
  const e=env({'sales.l2.okk':0});for(const path of ['/users/','/users.html','/__ask'])assert.equal((await onRequest({request:request(path),env:e,next:async()=>new Response('unexpected')})).status,403);
});
test('P1-5 HR viewer can read private leave but cannot add or delete',async()=>{
  const e=env({'hr.team':1});const before=rows(e,'hr_leave');
  const get=await (await leave.onRequestGet({request:request('/api/hr/leave'),env:e})).json();assert.equal(get.is_hr,true);assert.equal(get.can_edit,false);
  for(const body of [{action:'del',id:1},{action:'add',person:1,date_from:'2026-11-03',date_to:'2026-11-04'}])assert.equal((await leave.onRequestPost({request:request('/api/hr/leave',body),env:e})).status,403);
  assert.deepEqual(rows(e,'hr_leave'),before);
});
test('P1-5 full HR editor can add and delete; explicit leave denial wins',async()=>{
  const e=env({hr:2});e.sqlite.prepare("INSERT INTO hr_people (name,status) VALUES ('Synthetic Person','active')").run();
  const person=rows(e,'hr_people').at(-1).id;const r=await leave.onRequestPost({request:request('/api/hr/leave',{action:'add',person,date_from:'2026-11-03',date_to:'2026-11-04'}),env:e});assert.equal(r.status,200);const id=(await r.json()).id;
  assert.equal((await leave.onRequestPost({request:request('/api/hr/leave',{action:'del',id}),env:e})).status,200);
  e.sqlite.prepare("INSERT INTO perms (login,section,level) VALUES ('reader','hr.leave',0)").run();
  assert.equal((await leave.onRequestPost({request:request('/api/hr/leave',{action:'del',id}),env:e})).status,403);
});
test('P1-5 structure editor with read-only HR cannot alter private fields or cascade-delete leave',async()=>{
  const e=env({'hr.structure':2,'hr.team':1});e.sqlite.prepare("INSERT INTO hr_people (name,status,birth) VALUES ('Synthetic Person','active','1990-01-01')").run();
  const person=rows(e,'hr_people').at(-1).id,before=rows(e,'hr_people');
  const info=await(await structure.onRequestGet({request:request('/api/hr/structure'),env:e})).json();assert.equal(info.can_edit,true);assert.equal(info.can_edit_private,false);assert.equal(info.can_delete,false);
  for(const body of [{action:'person_save',id:person,name:'Changed',birth:'1991-01-01'},{action:'person_del',id:person}])assert.equal((await structure.onRequestPost({request:request('/api/hr/structure',body),env:e})).status,403);
  assert.deepEqual(rows(e,'hr_people'),before);
  assert.equal((await structure.onRequestPost({request:request('/api/hr/structure',{action:'person_save',id:person,name:'Public name changed'}),env:e})).status,200);
  assert.equal(rows(e,'hr_people').at(-1).birth,'1990-01-01');
});
test('P1-5 HR editor can update private fields and remove a person with leave',async()=>{
  const e=env({hr:2});
  const r=await structure.onRequestPost({request:request('/api/hr/structure',{action:'person_save',name:'Synthetic Person',birth:'1990-01-01',children:[]}),env:e});assert.equal(r.status,200);const person=(await r.json()).id;
  assert.equal((await leave.onRequestPost({request:request('/api/hr/leave',{action:'add',person,date_from:'2026-11-03',date_to:'2026-11-04'}),env:e})).status,200);
  assert.equal((await structure.onRequestPost({request:request('/api/hr/structure',{action:'person_del',id:person}),env:e})).status,200);
  assert.equal(rows(e,'hr_people').some(row=>row.id===person),false);assert.equal(rows(e,'hr_leave').length,0);
});

const put=(e,body)=>ingest.onRequestPost({request:request('/api/ingest',body,{auth:'collector'}),env:e});
test('P2-10 oversized and malformed batches fail before writing sibling records',async()=>{
  const e=env();const row={metric:'l1.booked',ptype:'month',period:'2026-11',value:5};
  const r=await put(e,{points:[row],plans:Array(501).fill(row)});assert.equal(r.status,413);
  const b=await r.json();assert.equal(b.received,502);assert.equal(b.rejected,502);assert.equal(rows(e,'points').length,0);
  assert.equal((await put(e,{points:[row],plans:[{}]})).status,400);assert.equal(rows(e,'points').length,0);
});
test('P2-10 points never report a truncated response as complete',async()=>{
  const e=env();e.sqlite.exec("WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<20001) INSERT INTO points(metric,ptype,period,dim,value) SELECT 'l1.booked','day','2026-11-01',printf('%05d',v),v FROM n");
  const get=q=>points.onRequestGet({request:request('/api/points?metric=l1.booked'+q),env:e});
  const r=await get('');assert.equal(r.status,413);assert.equal((await r.json()).truncated,true);
  const a=await(await get('&page=1&page_size=2')).json(), b=await(await get('&page=2&page_size=2')).json();
  assert.deepEqual(a.rows.map(r=>r.value),[1,2]);assert.equal(a.next_page,2);assert.deepEqual(b.rows.map(r=>r.value),[3,4]);
  const last=await(await get('&page=10001&page_size=2')).json();assert.deepEqual(last.rows.map(r=>r.value),[20001]);assert.equal(last.has_more,false);
});
const paid=(id)=>({id,created_at:100,price:id});
test('P1-6 failed paid replacement rolls back real SQLite deletion and preceding inserts',async()=>{
  const e=env();assert.equal((await put(e,{yt_paid:{replace:true,rows:[paid(1)]}})).status,200);
  e.sqlite.exec("CREATE TRIGGER fail_paid BEFORE INSERT ON yt_paid WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.equal((await put(e,{yt_paid:{replace:true,rows:[paid(2),paid(3)]}})).status,503);assert.deepEqual(rows(e,'yt_paid').map(r=>r.id),[1]);
});
test('P1-6 full YouTube and payments publish together or roll back together',async()=>{
  const e=env();await put(e,{yt_paid:{replace:true,rows:[paid(1)]},yt_leads_replace:{rows:[paid(1)]}});
  e.sqlite.exec("CREATE TRIGGER fail_leads BEFORE INSERT ON yt_leads WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.equal((await put(e,{yt_paid:{replace:true,rows:[paid(2)]},yt_leads_replace:{rows:[paid(3)]}})).status,503);
  for(const table of ['yt_paid','yt_leads'])assert.deepEqual(rows(e,table).map(r=>r.id),[1]);
});
test('P1-6 alumni replacement rollback preserves previous rows',async()=>{
  const e=env();await put(e,{prep_alumni:{replace:true,rows:[{say:'OLD'}]}});
  e.sqlite.exec("CREATE TRIGGER fail_alumni BEFORE INSERT ON prep_alumni WHEN NEW.say='FAIL' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.equal((await put(e,{prep_alumni:{replace:true,rows:[{say:'NEW'},{say:'FAIL'}]}})).status,503);assert.deepEqual(rows(e,'prep_alumni').map(r=>r.say),['OLD']);
});
test('P1-6 successful replacement retains every row beyond the old 5000 limit',async()=>{
  const e=env();await put(e,{yt_paid:{replace:true,rows:[paid(99999)]}});
  const r=await put(e,{yt_paid:{replace:true,rows:Array.from({length:5001},(_,i)=>paid(i+1))}});assert.equal(r.status,200);assert.equal((await r.json()).written,5001);assert.equal(rows(e,'yt_paid').length,5001);assert(!rows(e,'yt_paid').some(r=>r.id===99999));
});
test('P1-6 failure in a later JSON chunk rolls back earlier chunks',async()=>{
  const e=env();await put(e,{yt_paid:{replace:true,rows:[paid(99999)]}});
  e.sqlite.exec("CREATE TRIGGER fail_last BEFORE INSERT ON yt_paid WHEN NEW.id=3000 BEGIN SELECT RAISE(ABORT,'synthetic later chunk failure'); END");
  e.DB.calls.length=0;
  const input=Array.from({length:3000},(_,i)=>({...paid(i+1),name:'я'.repeat(160),contact_name:'ю'.repeat(160)}));
  assert.equal((await put(e,{yt_paid:{replace:true,rows:input}})).status,503);
  assert(e.DB.calls.filter(c=>c.sql.startsWith('INSERT INTO yt_paid')).length>1,'failure must follow a completed insert chunk');
  assert.deepEqual(rows(e,'yt_paid').map(r=>r.id),[99999]);
});
test('P1-6 oversized snapshot rejects before deletion',async()=>{
  const e=env();await put(e,{yt_paid:{replace:true,rows:[paid(99999)]}});
  assert.equal((await put(e,{yt_paid:{replace:true,rows:Array.from({length:20001},(_,i)=>paid(i+1))}})).status,400);
  assert.deepEqual(rows(e,'yt_paid').map(r=>r.id),[99999]);
});
test('P1-6 invalid snapshot rejects entire request before any mutations',async()=>{
  const e=env();await put(e,{yt_paid:{replace:true,rows:[paid(1)]}});
  for(const input of [[paid(2),{}],[paid(2),paid(2)]]){
    assert.equal((await put(e,{points:[{metric:'l1.booked',ptype:'day',period:'2026-11-03',value:7}],yt_paid:{replace:true,rows:input}})).status,400);
    assert.deepEqual(rows(e,'yt_paid').map(r=>r.id),[1]);assert.equal(rows(e,'points').length,0);
  }
});
test('P1-6 unsafe old reset protocol is rejected; explicit complete empty snapshot works',async()=>{
  const e=env();await put(e,{yt_leads_replace:{rows:[paid(1)]}});
  assert.equal((await put(e,{yt_reset:true,yt_leads:[paid(2)]})).status,400);assert.deepEqual(rows(e,'yt_leads').map(r=>r.id),[1]);
  assert.equal((await put(e,{yt_leads_replace:{rows:[]}})).status,200);assert.equal(rows(e,'yt_leads').length,0);
});
test('P1-6 incremental YouTube update preserves unrelated rows',async()=>{
  const e=env();await put(e,{yt_leads_replace:{rows:[paid(1)]}});
  assert.equal((await put(e,{yt_leads:[paid(2)]})).status,200);assert.deepEqual(rows(e,'yt_leads').map(r=>r.id),[1,2]);
});
