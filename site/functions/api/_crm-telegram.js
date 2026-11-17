// The shared bot stays on /api/tgtask. Only reserved CRM confirmations go to CRM.
export function isCrmTelegramUpdate(update){
  const callback=update?.callback_query,item=callback||update?.message,chat=callback?.message?.chat||item?.chat,from=item?.from;
  if(!Number.isSafeInteger(update?.update_id)||!chat||chat.type!=='private'||!Number.isSafeInteger(from?.id)||from.id<=0||from.is_bot||chat.id!==from.id)return false;
  return callback?/^crm:(?:link|login):[a-f0-9]{32}:[a-f0-9]{16}$/.test(callback.data||''):/^\/start(?:@[A-Za-z0-9_]+)?\s+c[a-f0-9]{32}\s*$/.test(item?.text||'');
}
const unavailable=()=>Response.json({ok:false,error:'Подключение CRM временно недоступно'},{status:503,headers:{'Cache-Control':'no-store'}});
export async function routeCrmTelegram(update,env,{fetcher=fetch}={}){
  if(!isCrmTelegramUpdate(update))return null;
  let url;try{url=new URL(env.CRM_STAFF_TELEGRAM_URL);}catch{return unavailable();}
  const secret=env.CRM_STAFF_TELEGRAM_WEBHOOK_SECRET;
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/api/staff-telegram/webhook'||!(url.hostname==='crm.gitelman.team'||/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname))||!(/^[A-Za-z0-9_-]{16,256}$/.test(secret||'')))return unavailable();
  try{
    const response=await fetcher(url.href,{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update),redirect:'error',signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok||result?.ok!==true)return unavailable();
    return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
  }catch{return unavailable();}
}
