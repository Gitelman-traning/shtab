// Никаких операций записи в CRM. Исходный текст и копия правил фиксируются при приёме.
export const PHASES = [0, 60, 300];
export const RETENTION_DAYS = 30;
const MAX_TEXT = 32000;
export const seconds = () => Math.floor(Date.now() / 1000);
const integer = x => /^\d+$/.test(String(x ?? '')) && Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null;
export const parse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };

export function validateRule(input) {
  if (!input || typeof input !== 'object') throw Error('Неверное правило');
  const id = String(input.id || '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Error('ID: латиница, цифры, дефис, до 64 знаков');
  const name = String(input.name || '').trim(), match_text = input.match_text;
  if (!name || name.length > 120 || typeof match_text !== 'string' || !match_text.trim() || match_text.length > 4000) throw Error('Укажите название и точный текст до 4000 знаков');
  const ids = {};
  for (const key of ['pipeline_id','status_id','source_enum_id']) {
    ids[key] = input[key] == null || input[key] === '' ? null : integer(input[key]);
    if (input[key] != null && input[key] !== '' && !ids[key]) throw Error('Неверный ID: ' + key);
  }
  const tags = input.expected_tags;
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(x => typeof x !== 'string' || !x.trim() || x.length > 150)) throw Error('Укажите до 20 тегов');
  const source_value = String(input.source_value || '').trim();
  if (source_value.length > 200 || (!tags.length && !source_value && !ids.source_enum_id)) throw Error('Укажите ожидаемый тег или источник');
  const source_field_id = integer(input.source_field_id || 1439087);
  if (!source_field_id) throw Error('Неверный ID поля источника');
  return { id, name, match_text, ...ids, expected_tags: [...new Set(tags.map(t=>t.trim()))], source_field_id, source_value, enabled: input.enabled === false || input.enabled === 0 ? 0 : 1 };
}

export async function rules(db) {
  return (await db.prepare('SELECT * FROM amo_watch_rules ORDER BY name,id').all()).results.map(r=>({...r,expected_tags:parse(r.expected_tags,[])}));
}

export function messages(body, contentType, accountId) {
  let obj;
  if (contentType.includes('application/json')) {
    obj = JSON.parse(body);
  } else {
    const p = new URLSearchParams(body);
    obj = { account: { id: p.get('account[id]') }, message: { add: [] } };
    const groups = new Map();
    for (const [k,v] of p) {
      const m = /^message\[add\]\[(\d+)\]\[(id|text|talk_id|contact_id|chat_id|origin|created_at|message_type|element_id|element_type)\]$/.exec(k);
      if (m) { if (!groups.has(m[1])) groups.set(m[1],{}); groups.get(m[1])[m[2]] = v; }
    }
    obj.message.add = [...groups.values()];
  }
  if (integer(obj.account?.id) !== integer(accountId)) throw Error('account');
  const items = obj.message?.add || [];
  if (!Array.isArray(items) || items.length > 100) throw Error('batch');
  const seen = new Set();
  return items.map(m=>{
    const id = typeof m.id === 'string' ? m.id : String(m.id || '');
    if (!id || id.length > 200 || !integer(m.created_at)) throw Error('message');
    const text = typeof m.text === 'string' ? m.text : '';
    return {message_id:id,created_at:integer(m.created_at),contact_id:integer(m.contact_id),talk_id:integer(m.talk_id),
      chat_id:String(m.chat_id || '').slice(0,200),origin:String(m.origin || '').slice(0,200),message_type:String(m.message_type || '').slice(0,40),
      message_text:text.slice(0,MAX_TEXT),text_truncated:text.length>MAX_TEXT?1:0,
      lead_id: ['lead','leads','2'].includes(String(m.element_type)) ? integer(m.element_id) : null};
  }).filter(m=>{if(seen.has(m.message_id)) return false;seen.add(m.message_id);return true;});
}

export async function ingest(env, items, now = seconds()) {
  // Снимок только действующих правил, редактирование правил не переписывает историю.
  const active = (await rules(env.DB)).filter(r=>r.enabled);
  const snapshot = JSON.stringify(active);
  if (!items.length) return 0;
  const results = await env.DB.batch(items.map(m=>env.DB.prepare(
    'INSERT OR IGNORE INTO amo_watch_events (account_id,message_id,created_at,received_at,contact_id,talk_id,chat_id,origin,message_type,message_text,text_truncated,rules_json,matched_rules,lead_id,next_check_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(Number(env.AMO_ACCOUNT_ID),m.message_id,m.created_at,now,m.contact_id,m.talk_id,m.chat_id,m.origin,m.message_type,m.message_text,m.text_truncated,snapshot,
    active.filter(r=>!m.text_truncated&&r.match_text===m.message_text).map(r=>'|'+r.id+'|').join(''),m.lead_id,now,now)));
  return results.reduce((n,r)=>n+(r.meta?.changes||0),0);
}

// Единственная функция доступа к amo, метод GET задан явно. Адреса нельзя передать из запроса.
export async function amoGet(env, path) {
  if (!/^\/api\/v4\/(talks\/\d+|leads\/\d+)\??[^#]*$/.test(path)) throw Error('unsupported_path');
  const token = String(env.AMO_TOKEN || '').replace(/^bearer\s+/i,'').trim();
  if (!token) throw Error('amo_credentials');
  const response = await fetch(new URL(path,env.AMO_BASE_URL), {method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw Error('amo_' + response.status);
  return response.status === 204 ? null : response.json();
}

export function snapshot(lead, now) {
  return {lead_id:lead.id,pipeline_id:lead.pipeline_id,status_id:lead.status_id,observed_at:now,
    tags:(lead._embedded?.tags||[]).map(t=>t.name), fields:(lead.custom_fields_values||[]).map(f=>({id:f.field_id,values:(f.values||[]).map(v=>({value:v.value,enum_id:v.enum_id??null}))}))};
}

export function evaluate(event, current, initial) {
  const matching = parse(event.rules_json,[]).filter(r=>!event.text_truncated && r.match_text === event.message_text);
  if (!matching.length) return {result:'no_rule',detail:event.text_truncated?'Длинный текст: точное сравнение пропущено':'Нет точного совпадения с правилами наблюдения',results:[]};
  const results = matching.map(r=>{
    const reasons=[];
    if (r.pipeline_id && r.pipeline_id !== initial.pipeline_id) reasons.push('Воронка при первом чтении: '+initial.pipeline_id+'; ожидается '+r.pipeline_id);
    if (r.status_id && r.status_id !== initial.status_id) reasons.push('Статус при первом чтении: '+initial.status_id+'; ожидается '+r.status_id);
    const source = current.fields.find(f=>f.id===r.source_field_id)?.values || [];
    const actual_source = source.map(v=>String(v.value)).join(', ');
    const source_ok = r.source_enum_id ? source.some(v=>v.enum_id===r.source_enum_id) : !r.source_value || source.some(v=>v.value===r.source_value);
    const missing_tags = r.expected_tags.filter(t=>!current.tags.includes(t));
    return {id:r.id,name:r.name,result:reasons.length?'condition_mismatch':missing_tags.length||!source_ok?'missing':'ok',
      reasons,missing_tags,expected_tags:r.expected_tags,source_ok,expected_source:r.source_value,actual_source,
      note:'Условия проверены по первому доступному чтению amoCRM, не по внутреннему снимку F5'};
  });
  const distinct = [...new Set(results.map(r=>r.result))];
  const result = distinct.includes('missing')?'missing':distinct.length===1?distinct[0]:'mixed';
  const detail = result==='ok'?'Ожидаемые тег и источник присутствуют (автор изменения не определён)':result==='condition_mismatch'?'Условия отличаются при первом чтении; это не доказательство отказа F5':'См. сравнение ожидаемой и фактической разметки';
  return {result,detail,results};
}

async function inspect(env, event, now) {
  let leadId = event.lead_id;
  if (!leadId && event.talk_id) {
    const talk = await amoGet(env,'/api/v4/talks/'+event.talk_id);
    if (talk?.entity_type === 'lead' && integer(talk.entity_id) && (!event.contact_id || talk.contact_id === event.contact_id) && (!event.chat_id || talk.chat_id === event.chat_id)) leadId = talk.entity_id;
  }
  if (!leadId) return {result:'unresolved',detail:'Сообщение пока не связано с однозначной сделкой',results:[],current:null,initial:null};
  const lead = await amoGet(env,'/api/v4/leads/'+leadId+'?with=contacts');
  if (!lead || (event.contact_id && !(lead._embedded?.contacts||[]).some(c=>c.id===event.contact_id))) return {result:'unresolved',detail:'Связь сообщения и контакта со сделкой не подтверждена',results:[],current:null,initial:null};
  const current = snapshot(lead,now), initial = parse(event.initial_json) || current;
  return {...evaluate(event,current,initial),current,initial};
}

export async function processDue(env, {now = seconds(),limit = 15} = {}) {
  const due = (await env.DB.prepare('SELECT * FROM amo_watch_events WHERE next_check_at<=? AND lease_until<? ORDER BY next_check_at,id LIMIT ?').bind(now,now,limit).all()).results;
  let processed = 0;
  for (const e of due) {
    const claim = await env.DB.prepare('UPDATE amo_watch_events SET lease_until=? WHERE id=? AND lease_until<? AND phase=? AND next_check_at<=?').bind(now+240,e.id,now,e.phase,now).run();
    if (!claim.meta.changes) continue;
    let verdict;
    try { verdict = await inspect(env,e,now); }
    catch (error) { verdict = {result:'error',detail:/^amo_\d+$/.test(error.message)?'Чтение amoCRM: HTTP '+error.message.slice(4):'Не удалось прочитать amoCRM; повторим наблюдение',results:[],current:null,initial:null}; }
    const retry = ['error','unresolved'].includes(verdict.result) && e.failures < 2;
    const nextPhase = retry ? e.phase : e.phase+1;
    const next = retry ? now+60 : nextPhase < PHASES.length ? Math.max(now+1,e.received_at+PHASES[nextPhase]) : null;
    // Запись результата и переход очереди одной транзакцией; потерянный процесс освобождается по lease.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO amo_watch_checks (event_id,phase,checked_at,result,detail,snapshot_json,results_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id,phase) DO UPDATE SET checked_at=excluded.checked_at,result=excluded.result,detail=excluded.detail,snapshot_json=excluded.snapshot_json,results_json=excluded.results_json')
        .bind(e.id,e.phase,now,verdict.result,verdict.detail,verdict.current?JSON.stringify(verdict.current):null,JSON.stringify(verdict.results)),
      env.DB.prepare('UPDATE amo_watch_events SET lead_id=COALESCE(?,lead_id),initial_json=COALESCE(initial_json,?),phase=?,next_check_at=?,lease_until=0,failures=?,result=?,detail=?,latest_json=?,updated_at=? WHERE id=?')
        .bind(verdict.current?.lead_id||null,verdict.initial?JSON.stringify(verdict.initial):null,nextPhase,next,retry?e.failures+1:0,verdict.result,verdict.detail,JSON.stringify({snapshot:verdict.current,results:verdict.results}),now,e.id)
    ]);
    processed++;
  }
  await env.DB.prepare("INSERT INTO amo_watch_health (id,value,updated_at) VALUES ('cron','ok',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(now).run();
  return processed;
}

export async function cleanup(env, now = seconds()) {
  const cutoff = now-RETENTION_DAYS*86400;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM amo_watch_checks WHERE event_id IN (SELECT id FROM amo_watch_events WHERE received_at<? LIMIT 1000)').bind(cutoff),
    env.DB.prepare('DELETE FROM amo_watch_events WHERE id IN (SELECT id FROM amo_watch_events WHERE received_at<? LIMIT 1000)').bind(cutoff)
  ]);
}
