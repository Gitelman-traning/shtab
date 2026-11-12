import {refresh} from './core.js';

function authorized(request, env) {
  const a = request.headers.get('authorization') || '', b = env.INGEST_TOKEN ? 'Bearer ' + env.INGEST_TOKEN : '';
  if (!b || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ok:true,service:'shtab-collect-scheduler'});
    if (request.method !== 'POST' || url.pathname !== '/run' || !authorized(request, env)) return new Response(null, {status:404});
    try {return Response.json(await refresh(env, {dry:url.searchParams.get('dry') === '1'}), {headers:{'cache-control':'no-store'}});}
    catch {return Response.json({ok:false,error:'refresh_failed'}, {status:503});}
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env, {at:event.scheduledTime}).then(result => {
      console.log('shtab.collect_refresh', JSON.stringify(result));
    }).catch(error => {console.error('shtab.collect_refresh_failed', error.message); throw error;}));
  },
};
