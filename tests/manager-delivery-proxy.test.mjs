import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request} from './helpers.mjs';
import {onRequest} from '../site/functions/api/tgbots-admin/[[path]].js';

test('delivery journal is read-only, uses section permissions and server credentials',async()=>{
 const e=fixture({'marketing.telegram':1}),before=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({rows:[]});};
 const run=body=>onRequest({request:request('/api/tgbots-admin/manager-delivery?limit=100',body),env:{...e,TG_CORE_API_TOKEN:'fixture-key'},params:{path:['manager-delivery']}});
 try{
  assert.equal((await run()).status,200);assert.equal(calls[0].url,'https://tg-bots-core.gitelmanteam.workers.dev/api/admin/manager-delivery?limit=100');
  assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-key');
  assert.equal((await run({retry:true})).status,404);assert.equal(calls.length,1);
 }finally{globalThis.fetch=before;e.sqlite.close();}
});
test('journal denies users without Telegram access',async()=>{
 const e=fixture({'marketing.telegram':0}),before=globalThis.fetch;globalThis.fetch=async()=>{throw Error('no network expected');};
 try{const r=await onRequest({request:request('/api/tgbots-admin/manager-delivery'),env:{...e,TG_CORE_API_TOKEN:'fixture-key'},params:{path:['manager-delivery']}});assert.equal(r.status,403);}
 finally{globalThis.fetch=before;e.sqlite.close();}
});
