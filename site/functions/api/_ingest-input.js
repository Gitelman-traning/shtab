import { goalTerms } from './_goal-terms.js';
// Проверяем весь запрос до первой записи, в том числе до замены полных снимков.
const deal = row => Number.isSafeInteger(Number(row?.deal)) && Number(row.deal) > 0;
const metric = row => row?.metric && row.ptype && row.period && Number.isFinite(row.value);
const yt = row => Number.isSafeInteger(Number(row?.id)) && Number(row.id)>0 && Number.isSafeInteger(Number(row.created_at)) && Number(row.created_at)>0;
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const batches = {
  points:[20000,metric], plans:[500,metric], okna:[200,r=>date(r?.day)&&r.mgr&&r.key],
  goals:[50,r=>r?.mgr&&/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month)&&goalTerms(r)],
  pings:[200,r=>deal(r)&&r.manager&&date(r.day)],
  prep:[50,r=>deal(r)&&(r.sources==null || (Array.isArray(r.sources)&&r.sources.length<=60))&&(r.cases==null || Array.isArray(r.cases))], prep_cases:[200,deal],
  prep_growth:[200,deal], prep_manager:[50,r=>deal(r)&&r.manager], prep_style:[20,r=>r?.manager&&r.text],
  prep_debrief:[20,r=>deal(r)&&r.text], prep_debrief_versions:[30,r=>deal(r)&&r.text], debrief_status:[200,deal],
  expenses:[500,r=>date(r?.day)&&r.service&&Number.isFinite(r.amount)], yt_leads:[1000,yt],
  yt_drop:[5000,id=>Number.isSafeInteger(Number(id))&&Number(id)>0],
};

export function inspectIngest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {error:'нужен объект JSON',status:400,received:0};
  const inputs=Object.entries(batches).map(([key,[max,valid]])=>[key,body[key],max,valid]);
  for(const key of ['prep_alumni','yt_paid','yt_leads_replace']) {
    if(body[key]===undefined) continue;
    const full=body[key]?.replace || key==='yt_leads_replace';
    inputs.push([key,body[key]?.rows,full?20000:key==='yt_paid'?5000:1000,key==='prep_alumni'?r=>r&&(r.say||r.changed):yt]);
    if(!Array.isArray(body[key]?.rows))return {error:key+': нужен массив rows',status:400,received:0};
  }
  const received=inputs.reduce((n,[,rows])=>n+(Array.isArray(rows)?rows.length:0),0);
  for(const [key,rows,max,valid] of inputs) {
    if(rows===undefined) continue;
    if(!Array.isArray(rows))return {error:key+': нужен массив',status:400,received};
    if(rows.length>max)return {error:key+': не более '+max+' строк в одном запросе',status:body[key]?.replace || key==='yt_leads_replace' ? 400 : 413,received};
    const invalid=rows.findIndex(row=>!valid(row));
    if(invalid>=0)return {error:key+': неверная строка '+(invalid+1),status:400,received};
  }
  return {received};
}
