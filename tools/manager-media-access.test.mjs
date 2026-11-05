import {test} from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../site/functions/api/tgbots-admin/[[path]].js';

function envFor(login,role='admin'){
  return {TG_CORE_API_TOKEN:'private-core-token',DB:{prepare(sql){return {bind(){return {
    first:async()=>sql.includes('FROM sessions')?{login,role,must_change:0}:sql.includes('tg_id')?{tg_id:'123'}:null,
    all:async()=>({results:[]}),run:async()=>({meta:{changes:1}}),
  };}};}}};
}
function context(login,method='GET',action='manager-media'){
  return {env:envFor(login),params:{path:action.split('/')},request:new Request('https://shtab.test/api/tgbots-admin/'+action,{method,headers:{cookie:'shtab_s=fake-session','content-type':'application/json'},body:method==='POST'?'{}':undefined})};
}
test('other admins and editors cannot read or change the template library',async()=>{
  assert.equal((await onRequest(context('anna'))).status,403);
  assert.equal((await onRequest(context('anna','POST'))).status,403);
  const ctx=context('nikita');ctx.env=envFor('nikita','member');
  assert.equal((await onRequest(ctx)).status,403);
});
test('owner identity is supplied from server session and DB, including authenticated previews',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers['X-Shtab-User'],'nikita');
    assert.equal(options.headers['X-Shtab-User-Tg'],'123');
    assert.equal(options.headers.Authorization,'Bearer private-core-token');
    return Response.json({ok:true,rows:[]});
  };
  try{
    assert.equal((await onRequest(context('nikita'))).status,200);
    assert.equal((await onRequest(context('nikita','GET','manager-media/file'))).status,200);
  }finally{globalThis.fetch=original;}
});
