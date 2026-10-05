// POST /api/prep/hook?key=…  — вебхук amoCRM: сделка попала на «Встреча подтверждена» (70704326) Первой линии.
// Подходит и для «Webhooks» в интеграциях (событие «смена этапа»), и для триггера digital pipeline на самом этапе.
// Тело amo — form-urlencoded: leads[status|update|add][N][id], …[status_id], …[pipeline_id]. Если триггер стоит на этапе,
// status_id может не прийти — тогда берём сделку как есть (триггер и так срабатывает только на этом этапе).
// Ставим сделку в очередь и дёргаем прогон сборщика в GitHub Actions (repository_dispatch), если задан GH_DISPATCH_TOKEN.
// Ключ в адресе (PREP_HOOK_KEY в Doppler) — единственная защита: amo вебхуки не подписывает. Отвечаем 200 всегда, чтобы amo не отключил хук.
import { json, now } from "../_lib.js";

const STAGE = 70704326;
const PIPE = 8733326;
const REPO = "Gitelman-traning/shtab";

export async function onRequestPost({ request, env, waitUntil }) {
  const u = new URL(request.url);
  if (!env.PREP_HOOK_KEY || u.searchParams.get("key") !== env.PREP_HOOK_KEY) return json({ ok: false }, 401);
  let text = "";
  try { text = await request.text(); } catch (e) { return json({ ok: true, skipped: "пустое тело" }); }
  const p = new URLSearchParams(text);
  const found = {};
  for (const [k, v] of p.entries()) {
    const m = k.match(/^leads\[(\w+)\]\[(\d+)\]\[(id|status_id|pipeline_id)\]$/);
    if (!m) continue;
    const key = m[1] + ":" + m[2];
    (found[key] = found[key] || {})[m[3]] = Number(v);
  }
  const deals = [];
  for (const f of Object.values(found)) {
    if (!f.id) continue;
    if (f.status_id && f.status_id !== STAGE) continue;
    if (f.pipeline_id && f.pipeline_id !== PIPE) continue;
    if (!deals.includes(f.id)) deals.push(f.id);
  }
  if (!deals.length) return json({ ok: true, skipped: "не тот этап", seen: Object.keys(found).length });
  const stamp = now();
  for (const d of deals) {
    await env.DB.prepare(
      "INSERT INTO prep (deal, status, queued_by, amo_url, created_at, updated_at) VALUES (?, 'queued', 'amo-hook', ?, ?, ?) " +
      "ON CONFLICT(deal) DO UPDATE SET status = CASE WHEN prep.status = 'ready' AND prep.updated_at > ? THEN prep.status ELSE 'queued' END, updated_at = excluded.updated_at")
      .bind(d, "https://pavelgitelman.amocrm.ru/leads/detail/" + d, stamp, stamp, new Date(Date.now() - 3 * 864e5).toISOString()).run();
  }
  if (env.GH_DISPATCH_TOKEN) {
    const run = fetch("https://api.github.com/repos/" + REPO + "/dispatches", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.GH_DISPATCH_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "shtab-prep-hook" },
      body: JSON.stringify({ event_type: "prep", client_payload: { deals } }),
    }).catch(() => {});
    if (waitUntil) waitUntil(run); else await run;
  }
  return json({ ok: true, queued: deals });
}
