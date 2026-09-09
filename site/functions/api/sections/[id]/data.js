// GET /api/sections/<id>/data?days=90 — данные раздела для его страницы (стандартной или собственного вида).
// Раздел видит только свои показатели (config.metrics). Ответ компактный: дни × показатель × срез.
import { json, bad, canRead, canView } from "../../_lib.js";

export async function onRequestGet({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, params.id)) return bad("раздел закрыт для вашего аккаунта", 403);
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
    "SELECT metric, period, value, asof FROM points p WHERE ptype IN ('potok','month') AND metric IN (" + metrics.map(() => "?").join(",") + ")" +
    " AND asof = (SELECT MAX(asof) FROM points p2 WHERE p2.metric = p.metric AND p2.ptype = p.ptype) ORDER BY metric, period"
  ).bind(...metrics).all();
  const plans = await env.DB.prepare("SELECT metric, ptype, period, dim, value FROM plans WHERE metric IN (" + metrics.map(() => "?").join(",") + ") ORDER BY period").bind(...metrics).all();
  // раздел одного источника: только его срез (лиды по dim = источник, воронка по dim = "src:источник") как итог ('' )
  let out = (rows.results || []).map((r) => [r.metric, r.period, r.dim, r.value]);
  if (cfg.dim) out = out.filter((r) => r[2] === cfg.dim || r[2] === "src:" + cfg.dim).map((r) => [r[0], r[1], "", r[3]]);
  return json({ ok: true, section: sec.id, name: sec.name, from: iso(from), to: iso(to), source: cfg.dim || null,
    metrics: reg.results || [], rows: out,
    stock: (stock.results || []).map((r) => [r.metric, r.period, r.value, r.asof]),
    plans: (plans.results || []).map((r) => [r.metric, r.ptype, r.period, r.dim, r.value]),
    format: "rows: [metric, day YYYY-MM-DD, dim ('' = всего), value]; stock: [metric, месяц YYYY-MM (поток или месяц воронки) или 'shortlist', value, дата снимка]; plans: [metric, ptype, period, dim, план]" });
}
