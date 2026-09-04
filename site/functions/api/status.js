// GET /api/status — что и когда собрано: последние прогоны и покрытие по показателям
import { json, bad, canRead } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const runs = await env.DB.prepare(
    "SELECT collector, started, finished, points, note FROM runs ORDER BY id DESC LIMIT 10").all();
  const coverage = await env.DB.prepare(
    "SELECT metric, ptype, COUNT(*) AS n, MIN(period) AS first, MAX(period) AS last, MAX(asof) AS asof, MAX(updated_at) AS updated " +
    "FROM points GROUP BY metric, ptype ORDER BY metric").all();
  return json({ ok: true, user: { login: user.login, role: user.role }, runs: runs.results || [], coverage: coverage.results || [] });
}
