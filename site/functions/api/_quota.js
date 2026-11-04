// Один условный INSERT резервирует квоту на primary D1 даже при параллельных запросах.
const DAY=86400, LOGIN_WINDOW=900;
export class QuotaError extends Error {
  constructor(seconds){super('Лимит запросов исчерпан. Повторите позже.');this.seconds=seconds;}
}
export function quotaResponse(e){return Response.json({ok:false,error:e.message,retry_after:e.seconds},{status:429,headers:{'Retry-After':String(e.seconds),'Cache-Control':'no-store'}});}
function limit(env,key,fallback){const n=Number(env[key]);return env[key]!==undefined && Number.isSafeInteger(n) && n>=0 ? n : fallback;}
async function fingerprint(env,value){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode((env.INGEST_TOKEN || '')+'\n'+value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function reserve(env,request,kind,subject){
  const ai=kind.startsWith('ai.'), now=Math.floor(Date.now()/1000), window=ai?DAY:LOGIN_WINDOW;
  const id=crypto.randomUUID(), ip=await fingerprint(env,request.headers.get('cf-connecting-ip') || 'local');
  const actor=await fingerprint(env,subject || ip);
  const cap=ai ? limit(env,'AI_USER_DAILY_REQUESTS',kind==='ai.draft'?6:50) : limit(env,'LOGIN_ATTEMPTS',12);
  const ipCap=ai?300:120;
  const clauses=['(SELECT COUNT(*) FROM security_usage WHERE kind=? AND actor=? AND at>?) < ?', '(SELECT COUNT(*) FROM security_usage WHERE kind=? AND ip=? AND at>?) < ?'];
  const filters=[kind,actor,now-window,cap,kind,ip,now-window,ipCap];
  if(ai){
    clauses.push('(SELECT COUNT(*) FROM security_usage WHERE actor=? AND lease_until>?) < ?', '(SELECT COUNT(*) FROM security_usage WHERE lease_until>?) < ?', "(SELECT COUNT(*) FROM security_usage WHERE kind LIKE 'ai.%' AND at>?) < ?");
    filters.push(actor,now,limit(env,'AI_USER_CONCURRENCY',2),now,limit(env,'AI_GLOBAL_CONCURRENCY',8),now-DAY,limit(env,'AI_DAILY_REQUESTS',250));
  }
  const results=await env.DB.batch([
    env.DB.prepare('DELETE FROM security_usage WHERE at<=? AND lease_until<=?').bind(now-DAY,now),
    env.DB.prepare('INSERT INTO security_usage(id,kind,actor,ip,at,lease_until) SELECT ?,?,?,?,?,? WHERE '+clauses.join(' AND '))
      .bind(id,kind,actor,ip,now,ai?now+185:0,...filters),
  ]);
  if(!results[1].meta.changes) {
    if(!ai) throw new QuotaError(window);
    const daily=await env.DB.prepare("SELECT ((SELECT COUNT(*) FROM security_usage WHERE kind=? AND actor=? AND at>?)>=? OR (SELECT COUNT(*) FROM security_usage WHERE kind=? AND ip=? AND at>?)>=? OR (SELECT COUNT(*) FROM security_usage WHERE kind LIKE 'ai.%' AND at>?)>=?) AS blocked")
      .bind(kind,actor,now-DAY,cap,kind,ip,now-DAY,ipCap,now-DAY,limit(env,'AI_DAILY_REQUESTS',250)).first();
    throw new QuotaError(daily.blocked?DAY:185);
  }
  return id;
}

export async function withAiSlot(env,request,user,kind,run){
  let id;
  try{id=await reserve(env,request,'ai.'+kind,user.login);return await run();}
  catch(e){if(e instanceof QuotaError)return quotaResponse(e);throw e;}
  finally{if(id)await env.DB.prepare('UPDATE security_usage SET lease_until=0 WHERE id=?').bind(id).run();}
}

// Перед каждой попыткой у провайдера учитываем консервативную оценку входа и max_tokens ответа.
export async function reserveTokens(env,messages,maxTokens){
  const now=Math.floor(Date.now()/1000), units=new TextEncoder().encode(JSON.stringify(messages)).length+maxTokens+64;
  const result=await env.DB.prepare("INSERT INTO security_usage(id,kind,actor,ip,at,units) SELECT ?,'tokens','','',?,? WHERE (SELECT COALESCE(SUM(units),0) FROM security_usage WHERE kind='tokens' AND at>?)+?<=?")
    .bind(crypto.randomUUID(),now,units,now-DAY,units,limit(env,'AI_DAILY_TOKEN_BUDGET',5000000)).run();
  if(!result.meta.changes)throw new QuotaError(DAY);
}
