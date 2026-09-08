// GET /api/sections/<id>/data?days=90 — данные раздела для его страницы (стандартной или собственного вида).
// Раздел видит только свои показатели (config.metrics). Ответ компактный: дни × показатель × срез.
import { json, bad, canRead } from "../../_lib.js";

export async function onRequestGet({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const sec = await env.DB.prepare("SELECT id, name, config FROM sections WHERE id = ?").bind(params.id).first();
  if (!sec) return bad("раздела нет", 404);
  let cfg = {};
  try { cfg = JSON.parse(sec.config || "{}"); } catch (e) {}
  const metrics = Array.isArray(cfg.metrics) ? cfg.metrics : [];
  if (!metrics.length) return json({ ok: true, section: sec.id, name: sec.name, days: [], metrics: [], rows: [] });
  const u = new URL(request.url);
  const days = Math.min(400, Math.max(7, parseInt(u.searchParams.get("days") || "90", 10) || 90));
  const to = new Date(); to.setUTCHours(0, 0, 0, 0); to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - days + 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  const rows = await env.DB.prepare(
    "SELECT metric, period, dim, value FROM points WHERE ptype = 'day' AND metric IN (" + metrics.map(() => "?").join(",") + ")" +
    " AND period >= ? AND period <= ? ORDER BY period"
  ).bind(...metrics, iso(from), iso(to)).all();
  const reg = await env.DB.prepare("SELECT id, name, unit, kind, definition FROM metrics WHERE id IN (" + metrics.map(() => "?").join(",") + ")").bind(...metrics).all();
  // снимки (участники по потокам): последний срез по каждому показателю
  const stock = await env.DB.prepare(
    "SELECT metric, period, value, asof FROM points p WHERE ptype = 'potok' AND metric IN (" + metrics.map(() => "?").join(",") + ")" +
    " AND asof = (SELECT MAX(asof) FROM points p2 WHERE p2.metric = p.metric AND p2.ptype = 'potok') ORDER BY metric, period"
  ).bind(...metrics).all();
  return json({ ok: true, section: sec.id, name: sec.name, from: iso(from), to: iso(to),
    metrics: reg.results || [], rows: (rows.results || []).map((r) => [r.metric, r.period, r.dim, r.value]),
    stock: (stock.results || []).map((r) => [r.metric, r.period, r.value, r.asof]),
    format: "rows: [metric, day YYYY-MM-DD, dim ('' = всего), value]; stock: [metric, месяц потока YYYY-MM или 'shortlist', value, дата снимка]" });
}
