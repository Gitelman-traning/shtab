import {bad,json,canRead,canView,hasIngestToken,now} from './_lib.js';

const sources={
  deals:['Сделки amo',['hub','sales.l1','sales.l2','marketing','marketing.telegram','marketing.instagram','marketing.fb','marketing.youtube','marketing.influence','marketing.site','marketing.sitechat']],
  participants:['Участники',['sales.l2']], activity:['Активность менеджеров',['sales.l1']], plans:['План и факт',['hub','sales']],
  metrika:['Яндекс Метрика',['marketing.site']], ads:['Google Ads',['marketing.site']], articles:['Статьи',['marketing.site']],
  gsc:['Search Console',['marketing.site']], webmaster:['Вебмастер',['marketing.site']],
};
export async function sourceHealth(env,user){
  const rows=(await env.DB.prepare('SELECT * FROM source_health ORDER BY source').all()).results || [];
  return rows.filter(r=>sources[r.source] && (user.role==='service'||sources[r.source][1].some(s=>canView(user,s))))
    .map(r=>({...r,name:sources[r.source][0],stale:r.state!=='skipped' && (!r.last_success || Date.now()-Date.parse(r.last_success)>36*3600000)}));
}
export async function onRequestGet({request,env}){
  const user=await canRead(request,env);if(!user)return bad('нет доступа',401);
  return json({ok:true,sources:await sourceHealth(env,user)});
}
export async function onRequestPost({request,env}){
  if(!hasIngestToken(request,env))return bad('нет доступа',401);
  const b=await request.json().catch(()=>null);
  if(!b || !Object.hasOwn(sources,b.source) || !['running','success','partial','failed','skipped','empty'].includes(b.state) || !/^\d{4}-\d{2}-\d{2}$/.test(b.period) || !Number.isFinite(Date.parse(b.attempt)))return bad('неверное состояние источника');
  const at=now(), success=b.state==='success', attempt=new Date(b.attempt).toISOString();
  await env.DB.prepare('INSERT INTO source_health(source,attempt,state,period,detail,updated,last_success,last_period) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET attempt=excluded.attempt,state=excluded.state,period=excluded.period,detail=excluded.detail,updated=excluded.updated,last_success=COALESCE(excluded.last_success,source_health.last_success),last_period=COALESCE(excluded.last_period,source_health.last_period) WHERE excluded.attempt>=source_health.attempt')
    .bind(b.source,attempt,b.state,b.period,String(b.detail||'').slice(0,200),at,success?at:null,success?b.period:null).run();
  return json({ok:true});
}
