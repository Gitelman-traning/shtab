import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request,rows} from './helpers.mjs';
import {messages,ingest,processDue,evaluate,validateRule,cleanup,amoGet} from '../observer/src/core.js';
import worker from '../observer/src/index.js';
import * as api from '../site/functions/api/amo-watch.js';
import {sectionOf,level} from '../site/functions/api/_lib.js';

const envs=[];
const env=()=>{const e=fixture({},'admin');Object.assign(e,{AMO_ACCOUNT_ID:'29640721',AMO_BASE_URL:'https://crm.invalid',AMO_TOKEN:'fixture-token',HOOK_KEY:'synthetic-private-hook'});envs.push(e);return e;};
afterEach(()=>{for(const e of envs.splice(0))e.sqlite.close();globalThis.fetch=async()=>{throw Error('Network disabled');};});
const time=1900000000;
const payload=(text='Я от Ильнары, тренинг Команда')=>({account:{id:29640721},message:{add:[{id:'synthetic-message',text,created_at:time,contact_id:42,talk_id:7,chat_id:'chat-fixture',origin:'wazzup',message_type:'text'}]}});
const items=(text)=>messages(JSON.stringify(payload(text)),'application/json',29640721);
const lead=(tags=[],source='',status=70705174)=>({id:123,pipeline_id:8733326,status_id:status,_embedded:{contacts:[{id:42}],tags:tags.map(name=>({name}))},custom_fields_values:source?[{field_id:1439087,values:[{value:source,enum_id:source==='Интеграции'?1223105:1223772}]}]:[]});
function crm(makeLead){const calls=[];globalThis.fetch=async(url,init)=>{
  assert.equal(init.method,'GET','observer must never write CRM');assert.equal(init.redirect,'error');assert.equal(new URL(url).origin,'https://crm.invalid');calls.push(new URL(url).pathname);
  return Response.json(String(url).includes('/talks/')?{entity_type:'lead',entity_id:123,contact_id:42,chat_id:'chat-fixture'}:makeLead());
};return calls;}

test('webhook parses official form format, exact text and ignores outgoing events',()=>{
  const p=new URLSearchParams({'account[id]':'29640721','message[add][0][id]':'msg','message[add][0][text]':' Hello \n','message[add][0][created_at]':String(time),'message[add][0][element_id]':'123','message[add][0][element_type]':'2'});
  const r=messages(p.toString(),'application/x-www-form-urlencoded',29640721);assert.equal(r[0].message_text,' Hello \n');assert.equal(r[0].lead_id,123);
  assert.equal(messages(JSON.stringify({account:{id:29640721},outgoing_message:{add:[{id:'out'}]}}),'application/json',29640721).length,0);
  assert.throws(()=>messages(JSON.stringify(payload()),'application/json',1),/account/);
  const d=payload();d.message.add.push({...d.message.add[0]});assert.equal(messages(JSON.stringify(d),'application/json',29640721).length,1);
});

test('deduplicates delivery and freezes rules; changing a rule cannot rewrite old observations',async()=>{
  const e=env();assert.equal(await ingest(e,items(),time),1);assert.equal(await ingest(e,items(),time+5),0);
  const before=rows(e,'amo_watch_events')[0];e.sqlite.exec("UPDATE amo_watch_rules SET match_text='different',expected_tags='[\"other\"]'");
  const saved=rows(e,'amo_watch_events')[0];assert.equal(saved.rules_json,before.rules_json);assert.equal(saved.received_at,time);
  assert.equal(saved.matched_rules,'|f5-131|');
});

test('observes missing then present tags/source at 0, 1, 5 minutes; reads CRM only',async()=>{
  const e=env();await ingest(e,items(),time);let current=lead();const calls=crm(()=>current);
  assert.equal(await processDue(e,{now:time}),1);let event=rows(e,'amo_watch_events')[0];assert.equal(event.result,'missing');assert.equal(event.next_check_at,time+60);
  current=lead(['13.10_Ильнара'],'Интеграции',71054662);
  await processDue(e,{now:time+60});event=rows(e,'amo_watch_events')[0];assert.equal(event.result,'ok','later stage move must not reinterpret original conditions');assert.equal(event.next_check_at,time+300);
  await processDue(e,{now:time+300});event=rows(e,'amo_watch_events')[0];assert.equal(event.next_check_at,null);assert.equal(event.phase,3);assert.equal(rows(e,'amo_watch_checks').length,3);assert.equal(calls.filter(p=>p.startsWith('/api/v4/leads/')).length,3);
});

test('greeting prefix is not an exact match, source mismatch remains distinct from success',async()=>{
  const e=env();await ingest(e,items('Добрый день. Я от Ильнары, тренинг Команда'),time);crm(()=>lead(['13.10_Ильнара'],'Интеграции'));
  await processDue(e,{now:time});assert.equal(rows(e,'amo_watch_events')[0].result,'no_rule');
  const r=JSON.parse(rows(e,'amo_watch_events')[0].rules_json);const cur={pipeline_id:8733326,status_id:70705174,tags:['13.10_Ильнара'],fields:[{id:1439087,values:[{value:'Сайт',enum_id:1223772}]}]};
  const v=evaluate({message_text:r[0].match_text,rules_json:JSON.stringify(r)},cur,cur);assert.equal(v.result,'missing');assert.equal(v.results[0].source_ok,false);assert.deepEqual(v.results[0].missing_tags,[]);
});

test('never guesses latest contact deal; retry unresolved talk, preserve matched text',async()=>{
  const e=env();await ingest(e,items(),time);globalThis.fetch=async()=>Response.json({entity_type:null,entity_id:null});
  await processDue(e,{now:time});let event=rows(e,'amo_watch_events')[0];assert.equal(event.result,'unresolved');assert.equal(event.lead_id,null);assert.equal(event.phase,0);
  crm(()=>lead());await processDue(e,{now:time+60});event=rows(e,'amo_watch_events')[0];assert.equal(event.lead_id,123);assert.equal(JSON.parse(event.initial_json).observed_at,time+60);
});

test('duplicate workers cannot process the same phase concurrently; failures are bounded',async()=>{
  const e=env();await ingest(e,items(),time);crm(()=>lead());const processed=await Promise.all([processDue(e,{now:time}),processDue(e,{now:time})]);assert.equal(processed.reduce((a,b)=>a+b,0),1);assert.equal(rows(e,'amo_watch_checks').length,1);
  globalThis.fetch=async()=>new Response('',{status:429});for(let i=1;i<=12;i++)await processDue(e,{now:time+60*i});
  assert.equal(rows(e,'amo_watch_events')[0].next_check_at,null);assert.equal(rows(e,'amo_watch_events')[0].result,'error');assert.equal(rows(e,'amo_watch_checks').length,3);
});

test('hook requires secret, account and durable database insert before acknowledgement',async()=>{
  const e=env(),pending=[],ctx={waitUntil:p=>pending.push(p)};crm(()=>lead());
  const call=(key,body)=>worker.fetch(new Request('https://observer.invalid/hook/'+key,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),e,ctx);
  assert.equal((await call('wrong',payload())).status,404);assert.equal(rows(e,'amo_watch_events').length,0);
  const wrong=payload();wrong.account.id=1;assert.equal((await call(e.HOOK_KEY,wrong)).status,400);
  const good=await call(e.HOOK_KEY,payload());assert.equal(good.status,200);assert.equal(rows(e,'amo_watch_events').length,1);await Promise.all(pending);
  const again=await call(e.HOOK_KEY,payload());assert.equal((await again.json()).inserted,0);await Promise.all(pending);
  const broken={...e,DB:{prepare(){throw Error('disk unavailable');}}};const response=await worker.fetch(new Request('https://observer.invalid/hook/'+e.HOOK_KEY,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload())}),broken,ctx);assert.equal(response.status,503);
});

test('admin API denies anonymous, collectors, ordinary users and foreign-origin rule writes',async()=>{
  const e=env();for(const auth of ['none','collector','shared'])assert.equal((await api.onRequestGet({request:request('/api/amo-watch',undefined,{auth}),env:e})).status,403);
  e.sqlite.exec("UPDATE users SET role='member'");assert.equal((await api.onRequestGet({request:request('/api/amo-watch'),env:e})).status,403);
  assert.equal((await api.onRequestPost({request:request('/api/amo-watch',{}),env:e})).status,403);
  e.sqlite.exec("UPDATE users SET role='admin'");const req=request('/api/amo-watch',{});req.headers.set('origin','https://other.invalid');assert.equal((await api.onRequestPost({request:req,env:e})).status,403);
  assert.equal(sectionOf('/settings/amo-watch/'),'users');assert.equal(level({role:'member',perms:{'*':2}},'users'),0);
});

test('API filters events, validates rule updates, retains old snapshot and only writes local state',async()=>{
  const e=env();const now=Math.floor(Date.now()/1000);await ingest(e,items(),now);crm(()=>lead());await processDue(e,{now});
  const response=await api.onRequestGet({request:request('/api/amo-watch?rule=f5-131&lead=123'),env:e});const data=await response.json();assert.equal(data.rows.length,1);assert.equal(data.mode,'observe');
  assert.equal((await api.onRequestGet({request:request('/api/amo-watch?result=bogus'),env:e})).status,400);
  const details=await (await api.onRequestGet({request:request('/api/amo-watch?id=1'),env:e})).json();assert.equal(details.checks.length,1);assert.equal(details.row.rules[0].id,'f5-131');
  const rule={...data.rules[0],name:'Synthetic change',enabled:false};assert.equal((await api.onRequestPost({request:request('/api/amo-watch',rule),env:e})).status,200);assert.equal(rows(e,'amo_watch_rules')[0].enabled,0);assert.notEqual(JSON.parse(rows(e,'amo_watch_events')[0].rules_json)[0].name,rule.name);
  assert.throws(()=>validateRule({...rule,id:'x|y'}));assert.throws(()=>validateRule({...rule,source_value:'',source_enum_id:null,expected_tags:[]}));
});

test('retention deletes message bodies and checks after 30 days, keeps newer rows',async()=>{
  const e=env();await ingest(e,items(),time);crm(()=>lead());await processDue(e,{now:time});await cleanup(e,time+31*86400);assert.equal(rows(e,'amo_watch_events').length,0);assert.equal(rows(e,'amo_watch_checks').length,0);
  await ingest(e,items(),time+31*86400);await cleanup(e,time+31*86400);assert.equal(rows(e,'amo_watch_events').length,1);
  await assert.rejects(()=>amoGet(e,'/api/v4/leads'),/unsupported_path/);
});
