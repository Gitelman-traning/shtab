const SOURCES = ['deals', 'participants', 'activity', 'plans', 'metrika', 'ads', 'articles', 'gsc', 'webmaster'];
const CHANNELS = ['Инстаграм smm', 'Телеграм канал', 'Интеграции', 'YouTube', 'Реклама FB', 'GitelmanSiteChat', 'Сайт'];
const METRICS = ['mkt.leads', 'mkt.qual', 'l1.leads', 'l1.booked', 'l2.held', 'l2.sales'];
const COOLDOWN = 40 * 60 * 1000; // Больше таймаута задания (30 минут).

export function yesterdayMSK(at = Date.now()) {
  return new Date(at + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
}

export async function freshness(db, period) {
  const sources = (await db.prepare('SELECT source,state,period,last_period FROM source_health').all()).results || [];
  const missing = SOURCES.filter(name => {
    const s = sources.find(row => row.source === name);
    return !s || !(s.period >= period && (s.state === 'success' && s.last_period >= period || s.state === 'skipped' && name !== 'deals'));
  });
  const points = (await db.prepare("SELECT metric,dim FROM points WHERE ptype='day' AND period=? AND metric IN ('mkt.leads','mkt.qual','l1.leads','l1.booked','l2.held','l2.sales') AND (dim='' OR dim IN (SELECT value FROM json_each(?)))")
    .bind(period, JSON.stringify([...CHANNELS, ...CHANNELS.map(s => 'src:' + s)])).all()).results || [];
  const found = new Set(points.map(p => p.metric + '|' + p.dim));
  const expected = METRICS.flatMap(m => [m + '|', ...(m === 'l1.leads' ? [] : CHANNELS.map(s => m + '|' + (m === 'mkt.leads' ? s : 'src:' + s)))]);
  const missingPoints = expected.filter(key => !found.has(key)).length;
  return {ready: missing.length === 0 && missingPoints === 0, missing_sources: missing, missing_points: missingPoints};
}

export async function refresh(env, {at = Date.now(), fetcher = fetch, dry = false} = {}) {
  const period = yesterdayMSK(at);
  const status = await freshness(env.DB, period);
  if (dry) return {ok: true, period, action: status.ready ? 'current' : 'would_dispatch', ...status};
  if (status.ready) {
    await env.DB.prepare("INSERT INTO collector_refresh(period,state,checked_at) VALUES(?,'ready',?) ON CONFLICT(period) DO UPDATE SET state='ready',checked_at=excluded.checked_at,detail=''").bind(period, at).run();
    return {ok: true, period, action: 'current', ...status};
  }
  if (!env.GH_DISPATCH_TOKEN) throw Error('dispatch_not_configured');
  const lease = await env.DB.prepare("INSERT INTO collector_refresh(period,state,attempts,dispatched_at,checked_at) VALUES(?,'dispatching',1,?,?) ON CONFLICT(period) DO UPDATE SET state='dispatching',attempts=collector_refresh.attempts+1,dispatched_at=excluded.dispatched_at,checked_at=excluded.checked_at WHERE collector_refresh.dispatched_at<=?")
    .bind(period, at, at, at - COOLDOWN).run();
  if (!lease.meta.changes) return {ok: true, period, action: 'waiting', ...status};
  try {
    const response = await fetcher('https://api.github.com/repos/Gitelman-traning/shtab/dispatches', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: {Authorization: 'Bearer ' + env.GH_DISPATCH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'shtab-collect-scheduler'},
      body: JSON.stringify({event_type: 'shtab_collect', client_payload: {period}}),
    });
    if (response.status !== 204) throw Error('dispatch_http_' + response.status);
    await env.DB.prepare("UPDATE collector_refresh SET state='dispatched',detail='' WHERE period=? AND dispatched_at=?").bind(period, at).run();
    return {ok: true, period, action: 'dispatched', ...status};
  } catch (error) {
    const detail = /^dispatch_http_\d+$/.test(error.message) ? error.message : 'dispatch_unavailable';
    await env.DB.prepare("UPDATE collector_refresh SET state='error',detail=?,dispatched_at=0 WHERE period=? AND dispatched_at=?").bind(detail, period, at).run();
    throw Error(detail);
  }
}
