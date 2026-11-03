// GET /api/status — что и когда собрано: последние прогоны и покрытие по показателям
import { json, bad, canRead, canView, isAdmin } from "./_lib.js";
import { readableMetrics } from "./_metric-access.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, "status")) return bad("раздел закрыт", 403);
  const allowed = (await readableMetrics(env, user)).map(m => m.id);
  const runs = isAdmin(user) || user.role === "service" ? await env.DB.prepare(
    "SELECT collector, started, finished, points, note FROM runs ORDER BY id DESC LIMIT 10").all() : { results: [] };
  const coverage = await env.DB.prepare(
    "SELECT metric, ptype, COUNT(*) AS n, MIN(period) AS first, MAX(period) AS last, MAX(asof) AS asof, MAX(updated_at) AS updated " +
    "FROM points WHERE metric IN (SELECT value FROM json_each(?)) GROUP BY metric, ptype ORDER BY metric").bind(JSON.stringify(allowed)).all();
  return json({ ok: true, user: { login: user.login, role: user.role }, secrets: env.SECRETS_SOURCE || "panel", runs: runs.results || [], coverage: coverage.results || [] });
}
