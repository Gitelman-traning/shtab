import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request} from './helpers.mjs';
import {onRequestGet} from '../site/functions/api/youtube.js';
import {onRequestPost} from '../site/functions/api/ingest.js';

const envs=[];
afterEach(()=>{for(const e of envs.splice(0))e.sqlite.close();});
const at=(date)=>Date.parse(date+'T12:00:00Z')/1000;
function env(){
 const e=fixture({'marketing.youtube.deals':1});envs.push(e);
 function lead(id,pipeline,contact,created,closed,meeting,paid,price,camp){
  e.sqlite.prepare('INSERT INTO yt_leads (id,pipeline_id,contact_id,created_at,closed_at,status_id,meeting,paid,price,utm_campaign,utm_content,updated_at) VALUES (?,?,?,?,?,142,?,?,?,?,?,?)')
   .run(id,pipeline,contact,at(created),closed?at(closed):null,meeting,paid,price,camp,camp+'-video','now');
 }
 function payment(id,pipeline,contact,price){
  e.sqlite.prepare('INSERT INTO yt_paid (id,pipeline_id,contact_id,price,created_at,closed_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(id,pipeline,contact,price,at('2026-10-01'),at('2026-11-08'),'now');
 }
 lead(101,8733326,10,'2026-11-05',null,0,0,0,'l1');
 lead(102,8733326,20,'2026-10-20','2026-11-07',1,0,0,'held');
 lead(103,9701010,30,'2026-11-01','2026-11-08',0,1,100,'sale');
 // Stale rows already in D1 must be ignored immediately, even with success flags.
 lead(201,10637862,50,'2026-11-01','2026-11-08',1,1,900,'reanimation');
 lead(202,10242466,30,'2026-09-01',null,1,0,0,'wrong-earliest');
 lead(203,10639774,60,'2026-11-01',null,0,0,0,'duplicates');
 lead(204,8733518,40,'2026-10-01','2026-11-09',0,1,50,'archive');
 payment(103,9701010,30,100); // direct YouTube payment
 payment(301,9701010,10,70);  // other source, valid first-line contact
 payment(302,9701010,50,80);  // only excluded reanimation as YouTube evidence
 payment(303,10637862,30,900);// valid contact, payment in excluded pipeline
 payment(304,8733518,10,60); // archive must not inflate contact revenue
 payment(305,9701010,60,300);// only excluded duplicate as YouTube evidence
 return e;
}
async function run(e,q=''){
 const r=await onRequestGet({request:request('/api/youtube'+q),env:e});
 assert.equal(r.status,200);return r.json();
}
test('только действующие линии входят в итоги, месяцы, кампании и выпуски',async()=>{
 const d=await run(env());
 assert.deepEqual(d.total,{leads:3,meetings:1,receipts:0,paid:1,revenue:100,cpaid:2,crevenue:170});
 assert.deepEqual(d.months,['2026-11','2026-10']);
 assert.deepEqual(d.campaigns.map(r=>r.key).sort(),['held','l1','sale']);
 assert.deepEqual(d.contents.map(r=>r.key).sort(),['held-video','l1-video','sale-video']);
 const nov=d.rows.find(r=>r.month==='2026-11');assert.equal(nov.leads,2);assert.equal(nov.meetings,1);
 assert.equal(d.rows.find(r=>r.month==='2026-10').leads,1);
});
test('все списки по клику используют тот же фильтр, что и показатели',async()=>{
 const e=env();
 for(const [metric,ids] of [['leads',[101,102,103]],['meetings',[102]],['paid',[103]]]){
  const d=await run(e,'?detail='+metric+'&table=total');assert.deepEqual(d.items.map(r=>r.id).sort(),ids);
 }
 const empty=await run(e,'?detail=leads&table=camp&key=reanimation');assert.deepEqual(empty.items,[]);
 const month=await run(e,'?detail=leads&table=month&key=2026-11');assert.deepEqual(month.items.map(r=>r.id).sort(),[101,103]);
});
test('по контакту учитываются даже закрытые сделки двух действующих линий',async()=>{
 const e=env();
 e.sqlite.prepare('UPDATE yt_leads SET status_id=143,closed_at=? WHERE id=101').run(at('2026-11-06'));
 const d=await run(e,'?detail=cpaid&table=total');
 assert.deepEqual(d.items.map(r=>r.paid.id).sort(),[103,301]);
 const direct=d.items.find(r=>r.paid.id===103);assert.equal(direct.direct,true);assert.equal(direct.via.id,103);assert.equal(direct.via.campaign,'sale');
 const via=d.items.find(r=>r.paid.id===301);assert.equal(via.direct,false);assert.equal(via.via.id,101);
 assert.equal((await run(e,'?detail=cpaid&table=camp&key=wrong-earliest')).items.length,0);
 assert.equal((await run(e,'?detail=cpaid&table=cont&key=sale-video')).items.length,1);
 e.sqlite.prepare('UPDATE yt_leads SET pipeline_id=9701010 WHERE id=101').run();
 const closedL2=await run(e,'?detail=cpaid&table=total');
 assert.deepEqual(closedL2.items.map(r=>[r.paid.id,r.via.id]).sort(),[[103,103],[301,101]]);
});
test('ограничение периода сохраняет раннюю разрешённую YouTube-сделку для связи оплаты',async()=>{
 const d=await run(env(),'?from=2026-11&to=2026-11');
 assert.equal(d.total.leads,2);assert.equal(d.total.meetings,1);assert.equal(d.total.crevenue,170);
 assert.equal((await run(env(),'?from=2026-12&to=2026-12')).total.leads,0);
});

test('чеки зачисляются по дате перехода, включая оплаченные сделки, и открываются из годового итога',async()=>{
 const e=env();
 e.sqlite.prepare('UPDATE yt_leads SET created_at=? WHERE id=103').run(at('2025-12-27'));
 const put=(yt_receipts)=>onRequestPost({request:request('/api/ingest',{collector:'amo-youtube',yt_receipts},{auth:'collector'}),env:e});
 assert.equal((await run(e)).receipts_ready,false);
 assert.equal((await put([{id:103,at:at('2026-11-02')},{id:103,at:at('2026-01-02')},
   {id:201,at:at('2025-12-29')},{id:101,at:at('2026-11-05')}])).status,200);
 assert.equal((await put([{id:103,at:'bad'}])).status,400);
 const d=await run(e);
 assert.equal(d.receipts_ready,true);
 assert.deepEqual(d.years.map(r=>[r.year,r.leads,r.receipts,r.paid]),[['2026',2,1,1],['2025',1,0,0]]);
 assert.equal(d.rows.find(r=>r.month==='2026-01').receipts,1);
 assert.equal(d.campaigns.find(r=>r.key==='sale').receipts,1);
 assert.equal(d.contents.find(r=>r.key==='sale-video').receipts,1);
 const list=await run(e,'?detail=receipts&table=year&key=2026');
 assert.deepEqual(list.items.map(r=>[r.id,r.receipt]),[[103,'2026-01-02']]);
 assert.equal((await run(e,'?detail=receipts&table=year&key=2025')).items.length,0);
 const partial=await run(e,'?from=2026-11&to=2026-11');
 assert.equal(partial.years[0].receipts,0);
 assert.equal((await run(e,'?detail=receipts&table=year&key=2026&from=2026-11')).items.length,0);
});
