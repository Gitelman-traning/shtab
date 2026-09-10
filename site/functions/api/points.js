// GET /api/points?metric=mkt.leads,l1.booked&ptype=day&from=2026-08-01&to=2026-08-31&dim=
// Возвращает сырые точки; недели и месяцы складываются на клиенте из дней.
// Для stock-показателей (ptype=potok/month) без asof отдаёт последний снимок. С &plans=1 добавляет планы из таблицы plans.
import { json, bad, canRead } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const u = new URL(request.url);
  const metrics = (u.searchParams.get("metric") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!metrics.length) return bad("укажите metric");
  if (metrics.length > 30) return bad("слишком много показателей");
  const ptype = u.searchParams.get("ptype") || "day";
  const from = u.searchParams.get("from") || "";
  const to = u.searchParams.get("to") || "";
  const dim = u.searchParams.get("dim");            // null = все срезы; '' = только итог
  const asof = u.searchParams.get("asof") || "";

  const where = ["metric IN (" + metrics.map(() => "?").join(",") + ")", "ptype = ?"];
  const args = [...metrics, ptype];
  if (from) { where.push("period >= ?"); args.push(from); }
  if (to) { where.push("period <= ?"); args.push(to); }
  if (dim !== null) { where.push("dim = ?"); args.push(dim); }
  const dimlike = u.searchParams.get("dimlike");   // префикс среза, например «Сайт|t|%»
  if (dimlike) { where.push("dim LIKE ?"); args.push(dimlike); }
  if (ptype !== "day") {
    if (asof) { where.push("asof = ?"); args.push(asof); }
    else {
      // последний снимок по каждому показателю — одним запросом, а не подзапросом на каждую строку (это выжигало лимит чтений D1)
      const mx = await env.DB.prepare("SELECT metric, MAX(asof) AS a FROM points WHERE metric IN (" + metrics.map(() => "?").join(",") + ") AND ptype = ? GROUP BY metric")
        .bind(...metrics, ptype).all();
      const pairs = (mx.results || []).filter((r) => r.a != null);
      if (!pairs.length) return json({ ok: true, rows: [], plans: [] });
      where.push("(" + pairs.map(() => "(metric = ? AND asof = ?)").join(" OR ") + ")");
      for (const r of pairs) args.push(r.metric, r.a);
    }
  }
  const rows = await env.DB.prepare(
    "SELECT metric, ptype, period, dim, asof, value, updated_at FROM points WHERE " + where.join(" AND ") +
    " ORDER BY period, dim LIMIT 20000"
  ).bind(...args).all();
  let plans = [];
  if (u.searchParams.get("plans")) {
    const pw = ["metric IN (" + metrics.map(() => "?").join(",") + ")", "ptype = ?"];
    const pa = [...metrics, ptype];
    if (from) { pw.push("period >= ?"); pa.push(from); }
    if (to) { pw.push("period <= ?"); pa.push(to); }
    if (dim !== null) { pw.push("dim = ?"); pa.push(dim); }
    const pr = await env.DB.prepare("SELECT metric, ptype, period, dim, value FROM plans WHERE " + pw.join(" AND ") + " ORDER BY period, dim LIMIT 5000").bind(...pa).all();
    plans = pr.results || [];
  }
  return json({ ok: true, rows: rows.results || [], plans });
}
