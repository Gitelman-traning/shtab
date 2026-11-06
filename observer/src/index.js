import { messages, ingest, processDue, cleanup } from './core.js';

function same(a,b) { if (!a || !b || a.length!==b.length) return false; let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0; }
async function limitedBody(request) {
  const reader=request.body?.getReader();if(!reader)return '';
  const decoder=new TextDecoder();let size=0,text='';
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw Error('size');}text+=decoder.decode(value,{stream:true});}
  return text+decoder.decode();
}
const answer=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    if(url.pathname==='/health' && request.method==='GET')return answer({ok:true,mode:'observe',crm_writes:false});
    if(!url.pathname.startsWith('/hook/') || !same(url.pathname.slice(6),env.HOOK_KEY))return answer({ok:false},404);
    if(request.method!=='POST')return answer({ok:false},405);
    let items;
    try{items=messages(await limitedBody(request),request.headers.get('content-type')||'',env.AMO_ACCOUNT_ID);}
    catch{return answer({ok:false,error:'invalid_event'},400);}
    try {
      const count=await ingest(env,items);
      ctx.waitUntil(processDue(env,{limit:5}).catch(()=>console.error('amo_observer.initial_read_failed')));
      return answer({ok:true,received:items.length,inserted:count});
    } catch {console.error('amo_observer.persist_failed');return answer({ok:false},503);}
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil((async()=>{await processDue(env);await cleanup(env);})().catch(()=>console.error('amo_observer.tick_failed')));
  }
};
