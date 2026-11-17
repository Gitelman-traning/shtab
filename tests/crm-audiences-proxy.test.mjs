import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request} from './helpers.mjs';
import {onRequest} from '../site/functions/api/tgbots-admin/[[path]].js';

async function run(e,path,body){return onRequest({request:request('/api/tgbots-admin/'+path,body),env:{...e,TG_CORE_API_TOKEN:'fixture-core-key'},params:{path:path.split('/')}});}

test('audience preview follows read permissions; collecting and starting need edit permission',async()=>{
 const e=fixture({'marketing.telegram':1});const before=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({rows:[]});};
 try{
  assert.equal((await run(e,'crm-audiences')).status,200);
  assert.equal(calls[0].url,'https://tg-l1-campaigns.gitelmanteam.workers.dev/api/admin/crm-audiences');
  assert.equal((await run(e,'crm-audiences',{})).status,403);
  assert.equal((await run(e,'crm-audiences/start',{id:'x'})).status,403);
  assert.equal(calls.length,1);
 }finally{globalThis.fetch=before;e.sqlite.close();}
});

test('test recipient is taken from authenticated user, not from the request body',async()=>{
 const e=fixture({'marketing.telegram':2});e.sqlite.prepare("UPDATE users SET tg_id=999 WHERE login='reader'").run();
 const before=globalThis.fetch;let forwarded;
 globalThis.fetch=async(url,options)=>{forwarded=options;return Response.json({ok:true});};
 try{
  const response=await run(e,'crm-audiences/test',{id:'draft',chatId:1234});assert.equal(response.status,200);
  assert.equal(forwarded.headers['X-Shtab-User-Tg'],'999');assert.equal(forwarded.headers['X-Shtab-User'],'reader');
  assert.equal(forwarded.headers.Authorization,'Bearer fixture-core-key');
 }finally{globalThis.fetch=before;e.sqlite.close();}
});

test('unknown audience actions and anonymous callers are rejected',async()=>{
 const e=fixture({},'admin');const before=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('No network expected');};
 try{
  assert.equal((await run(e,'crm-audiences/delete-everything',{})).status,404);
  const response=await onRequest({request:request('/api/tgbots-admin/crm-audiences',undefined,{auth:'none'}),env:e,params:{path:['crm-audiences']}});
  assert.equal(response.status,401);
 }finally{globalThis.fetch=before;e.sqlite.close();}
});
