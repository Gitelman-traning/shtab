// Секреты сайта из Doppler. В Cloudflare задаётся одна переменная — DOPPLER_TOKEN (service token конфига prd_cf_shtab),
// остальное (INGEST_TOKEN, LLM_*, TG_*, модели) читается из Doppler и кладётся в env перед обработкой запроса.
// Значения из Doppler имеют приоритет над переменными панели: Doppler — источник правды. Без DOPPLER_TOKEN всё работает по-старому.
// Кэш: в памяти изолята на 5 минут и в KV (ключ doppler:secrets) на 5 минут, чтобы не ходить в Doppler на каждый запрос;
// если Doppler недоступен — берём последнюю копию из KV, какой бы старой она ни была.

const TTL = 300;                 // секунд
const SKIP = new Set(["DOPPLER_TOKEN", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT", "DOPPLER_PROJECT"]);
let mem = { at: 0, data: null };

async function fetchDoppler(token) {
  const r = await fetch("https://api.doppler.com/v3/configs/config/secrets/download?format=json", {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
  });
  if (!r.ok) throw new Error("Doppler " + r.status);
  const data = await r.json();
  const out = {};
  for (const [k, v] of Object.entries(data)) if (!SKIP.has(k) && typeof v === "string") out[k] = v;
  return out;
}

export async function loadSecrets(env, ctx) {
  const token = env.DOPPLER_TOKEN;
  if (!token) return env;
  const nowS = Date.now() / 1000;
  let data = mem.data && nowS - mem.at < TTL ? mem.data : null;
  if (!data && env.OKK_KV) {
    try {
      const raw = await env.OKK_KV.get("doppler:secrets", { cacheTtl: 60 });
      if (raw) { const c = JSON.parse(raw); if (nowS - (c.at || 0) < TTL) data = c.data; else data = null; mem.stale = c.data; }
    } catch (e) { /* кэш не обязателен */ }
  }
  if (!data) {
    try {
      data = await fetchDoppler(token);
      mem = { at: nowS, data, stale: data };
      if (env.OKK_KV) {
        const put = env.OKK_KV.put("doppler:secrets", JSON.stringify({ at: nowS, data }));
        if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
      }
    } catch (e) {
      data = mem.stale || null;      // Doppler недоступен — последняя известная копия
    }
  } else {
    mem = { at: nowS, data, stale: data };
  }
  if (data) { for (const [k, v] of Object.entries(data)) env[k] = v; env.SECRETS_SOURCE = "doppler:" + Object.keys(data).length; }
  return env;
}
