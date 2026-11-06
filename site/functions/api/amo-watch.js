import {currentUser,isAdmin,json,bad,audit} from './_lib.js';
import {rules,validateRule,parse,seconds,RETENTION_DAYS} from '../../../observer/src/core.js';

const STATES=new Set(['pending','ok','missing','no_rule','condition_mismatch','unresolved','error','mixed']);
async function allowed(request,env){const user=await currentUser(request,env);return isAdmin(user)?user:null;}
const unpack = row => ({...row,latest:parse(row.latest_json),initial:parse(row.initial_json),rules:parse(row.rules_json,[]),latest_json:undefined,initial_json:undefined,rules_json:undefined});
export async function onRequestGet({request,env}) {
  if(!await allowed(request,env))return bad('Журнал доступен администратору',403);
  const u=new URL(request.url);
  if(u.searchParams.has('id')){
    const id=Number(u.searchParams.get('id'));
    if(!Number.isSafeInteger(id)||id<=0)return bad('Неверный ID');
    const row=await env.DB.prepare('SELECT * FROM amo_watch_events WHERE id=?').bind(id).first();
    if(!row)return bad('Запись не найдена',404);
    const checks=(await env.DB.prepare('SELECT * FROM amo_watch_checks WHERE event_id=? ORDER BY phase').bind(id).all()).results.map(c=>({...c,snapshot:parse(c.snapshot_json),results:parse(c.results_json,[]),snapshot_json:undefined,results_json:undefined}));
    return json({ok:true,mode:'observe',row:unpack(row),checks});
  }
  const now=seconds(),from=Number(u.searchParams.get('from')||now-7*86400),to=Number(u.searchParams.get('to')||now+1);
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from)return bad('Неверный период');
  const clauses=['received_at>=?','received_at<?'],args=[Math.max(from,now-RETENTION_DAYS*86400),to];
  for(const [key,column] of [['lead','lead_id'],['contact','contact_id']])if(u.searchParams.get(key)){
    const n=Number(u.searchParams.get(key));if(!Number.isSafeInteger(n)||n<=0)return bad('Неверный ID');clauses.push(column+'=?');args.push(n);
  }
  const state=u.searchParams.get('result');if(state){if(!STATES.has(state))return bad('Неверный результат');clauses.push('result=?');args.push(state);}
  const rule=u.searchParams.get('rule');if(rule){if(!/^[a-zA-Z0-9_-]{1,64}$/.test(rule))return bad('Неверное правило');clauses.push('instr(matched_rules,?)>0');args.push('|'+rule+'|');}
  const where=clauses.join(' AND ');
  const summary=(await env.DB.prepare('SELECT result,COUNT(*) AS n FROM amo_watch_events WHERE '+where+' GROUP BY result').bind(...args).all()).results;
  const before=Number(u.searchParams.get('before')||0);
  if(!Number.isSafeInteger(before)||before<0)return bad('Неверная страница');
  if(before){clauses.push('id<?');args.push(before);}
  const found=(await env.DB.prepare('SELECT id,created_at,received_at,lead_id,contact_id,origin,message_type,substr(message_text,1,240) AS message_text,result,detail,phase,next_check_at,updated_at,latest_json FROM amo_watch_events WHERE '+clauses.join(' AND ')+' ORDER BY id DESC LIMIT 101').bind(...args).all()).results;
  const health=(await env.DB.prepare('SELECT id,value,updated_at FROM amo_watch_health').all()).results;
  const recent=await env.DB.prepare('SELECT received_at FROM amo_watch_events ORDER BY id DESC LIMIT 1').first();
  return json({ok:true,mode:'observe',retention_days:RETENTION_DAYS,rows:found.slice(0,100).map(unpack),next:found.length>100?found[99].id:null,summary,health,last_event_at:recent?.received_at||null,rules:await rules(env.DB)});
}

export async function onRequestPost({request,env}) {
  const user=await allowed(request,env);if(!user)return bad('Правила наблюдения доступны администратору',403);
  const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return bad('Недопустимый источник запроса',403);
  let rule;
  try{const raw=await request.text();if(raw.length>20000)return bad('Слишком большое правило');rule=validateRule(JSON.parse(raw));}catch(e){return bad(e.message||'Неверное правило');}
  const n=await env.DB.prepare('SELECT COUNT(*) AS n FROM amo_watch_rules').first();
  if(n.n>=200&&!await env.DB.prepare('SELECT id FROM amo_watch_rules WHERE id=?').bind(rule.id).first())return bad('Лимит: 200 правил');
  await env.DB.prepare('INSERT INTO amo_watch_rules (id,name,match_text,pipeline_id,status_id,expected_tags,source_field_id,source_enum_id,source_value,enabled,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,match_text=excluded.match_text,pipeline_id=excluded.pipeline_id,status_id=excluded.status_id,expected_tags=excluded.expected_tags,source_field_id=excluded.source_field_id,source_enum_id=excluded.source_enum_id,source_value=excluded.source_value,enabled=excluded.enabled,updated_at=excluded.updated_at')
    .bind(rule.id,rule.name,rule.match_text,rule.pipeline_id,rule.status_id,JSON.stringify(rule.expected_tags),rule.source_field_id,rule.source_enum_id,rule.source_value,rule.enabled,seconds()).run();
  await audit(env,user.login,'amo_watch.rule',rule.id,'Обновлена копия правила наблюдения; amoCRM не изменялась');
  return json({ok:true,mode:'observe'});
}
