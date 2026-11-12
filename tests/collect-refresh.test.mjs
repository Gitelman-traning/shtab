import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {refresh, yesterdayMSK} from '../refresh/src/core.js';
import worker from '../refresh/src/index.js';

const at = Date.parse('2026-11-12T02:07:00Z'), period = '2026-11-11';
const envs = [];
afterEach(() => {for (const e of envs.splice(0)) e.sqlite.close();});
function env() {const e=fixture();e.GH_DISPATCH_TOKEN='synthetic';envs.push(e);return e;}
function current(e) {
  for (const source of ['deals','participants','activity','plans','metrika','ads','articles','gsc','webmaster']) {
    e.sqlite.prepare('INSERT INTO source_health(source,attempt,state,period,detail,updated,last_success,last_period) VALUES(?,?,?,?,?,?,?,?)')
      .run(source,'now',source==='ads'?'skipped':'success',period,'','now','now',period);
  }
  const channels=['Инстаграм smm','Телеграм канал','Интеграции','YouTube','Реклама FB','GitelmanSiteChat','Сайт'];
  for (const metric of ['mkt.leads','mkt.qual','l1.leads','l1.booked','l2.held','l2.sales']) {
    for (const dim of ['',...(metric==='l1.leads'?[]:channels.map(s=>(metric==='mkt.leads'?'':'src:')+s))]) {
      e.sqlite.prepare("INSERT INTO points(metric,ptype,period,dim,asof,value) VALUES(?,'day',?,?,'',0)").run(metric,period,dim);
    }
  }
}

test('утренний период считается по Москве, включая смену месяца и года',()=>{
  assert.equal(yesterdayMSK(Date.parse('2026-12-31T21:01:00Z')), '2026-12-31');
  assert.equal(yesterdayMSK(Date.parse('2026-11-01T02:07:00Z')), '2026-10-31');
});
test('свежие цифры, включая подтверждённые нули, не запускают повторный сбор',async()=>{
  const e=env();current(e);
  const result=await refresh(e,{at,fetcher:()=>{throw Error('must not dispatch');}});
  assert.equal(result.action,'current');assert.equal(result.missing_points,0);
});
test('отсутствующая точка источника и устаревший сбор требуют обновления',async()=>{
  const e=env();current(e);
  e.sqlite.prepare("DELETE FROM points WHERE metric='l2.sales' AND dim='src:Телеграм канал'").run();
  e.sqlite.prepare("UPDATE source_health SET period='2026-11-10',last_period='2026-11-10' WHERE source='deals'").run();
  let calls=0;
  const fetcher=async(url,init)=>{calls++;assert.match(url,/\/dispatches$/);assert.equal(JSON.parse(init.body).event_type,'shtab_collect');return new Response(null,{status:204});};
  const first=await refresh(e,{at,fetcher});assert.equal(first.action,'dispatched');assert.equal(first.missing_points,1);
  assert.equal((await refresh(e,{at:at+15*60000,fetcher})).action,'waiting');
  assert.equal((await refresh(e,{at:at+45*60000,fetcher})).action,'dispatched');assert.equal(calls,2);
});
test('параллельные проверки резервируют один запуск',async()=>{
  const e=env();let calls=0;const fetcher=async()=>{calls++;return new Response(null,{status:204});};
  const results=await Promise.all([refresh(e,{at,fetcher}),refresh(e,{at,fetcher})]);
  assert.equal(calls,1);assert.deepEqual(results.map(r=>r.action).sort(),['dispatched','waiting']);
});
test('сбой GitHub не считается успехом и следующая проверка повторяет запуск',async()=>{
  const e=env();await assert.rejects(refresh(e,{at,fetcher:async()=>new Response(null,{status:503})}),/dispatch_http_503/);
  assert.equal(e.sqlite.prepare('SELECT state FROM collector_refresh').get().state,'error');
  assert.equal((await refresh(e,{at:at+15*60000,fetcher:async()=>new Response(null,{status:204})})).action,'dispatched');
});
test('частичный источник не считается готовым, пробная проверка ничего не меняет',async()=>{
  const e=env();current(e);e.sqlite.prepare("UPDATE source_health SET state='partial' WHERE source='metrika'").run();
  const result=await refresh(e,{at,dry:true});assert.equal(result.action,'would_dispatch');assert.deepEqual(result.missing_sources,['metrika']);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM collector_refresh').get().n,0);
});
test('запуск извне защищён, открытая проверка связи не раскрывает данные',async()=>{
  const e=env();
  assert.equal((await worker.fetch(new Request('https://synthetic/run',{method:'POST'}),e)).status,404);
  assert.deepEqual(await(await worker.fetch(new Request('https://synthetic/health'),e)).json(),{ok:true,service:'shtab-collect-scheduler'});
});
