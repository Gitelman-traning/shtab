// GET /api/points?metric=mkt.leads,l1.booked&ptype=day&from=2026-08-01&to=2026-08-31&dim=
// Возвращает сырые точки; недели и месяцы складываются на клиенте из дней.
// Для stock-показателей (ptype=potok/month) без asof отдаёт последний снимок. С &plans=1 добавляет планы из таблицы plans.
import { json, bad, canRead } from "./_lib.js";
import { readableMetrics } from "./_metric-access.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const u = new URL(request.url);
  const metrics = (u.searchParams.get("metric") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!metrics.length) return bad("укажите metric");
  if (metrics.length > 30) return bad("слишком много показателей");
  const paged = u.searchParams.has('page') || u.searchParams.has('page_size');
  const page = Number(u.searchParams.get('page') || 1), size = Number(u.searchParams.get('page_size') || 1000);
  if (!Number.isSafeInteger(page) || page<1 || !Number.isInteger(size) || size<1 || size>5000 || !Number.isSafeInteger((page-1)*size)) return bad('неверные page/page_size');
  const rowsLimit = paged ? size : 20000, plansLimit = paged ? size : 5000, offset = paged ? (page-1)*size : 0;
  const ptype = u.searchParams.get("ptype") || "day";
  const from = u.searchParams.get("from") || "";
  const to = u.searchParams.get("to") || "";
  const dim = u.searchParams.get("dim");            // null = все срезы; '' = только итог
  const asof = u.searchParams.get("asof") || "";
  const allowed = new Set((await readableMetrics(env, user, dim)).map(m => m.id));
  if (metrics.some(m => !allowed.has(m))) return bad("нет доступа к запрошенным показателям", 403);

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
      where.push("(metric,asof) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))");
      args.push(JSON.stringify(pairs.map(r=>[r.metric,r.a])));

    }
  }
  const rows = await env.DB.prepare(
    "SELECT metric, ptype, period, dim, asof, value, updated_at FROM points WHERE " + where.join(" AND ") +
    " ORDER BY period,dim,metric,asof LIMIT ? OFFSET ?"
  ).bind(...args,rowsLimit+1,offset).all();
  let plans = [];
  if (u.searchParams.get("plans")) {
    const pw = ["metric IN (" + metrics.map(() => "?").join(",") + ")", "ptype = ?"];
    const pa = [...metrics, ptype];
    if (from) { pw.push("period >= ?"); pa.push(from); }
    if (to) { pw.push("period <= ?"); pa.push(to); }
    if (dim !== null) { pw.push("dim = ?"); pa.push(dim); }
    const pr = await env.DB.prepare("SELECT metric, ptype, period, dim, value FROM plans WHERE " + pw.join(" AND ") + " ORDER BY period,dim,metric LIMIT ? OFFSET ?").bind(...pa,plansLimit+1,offset).all();
    plans = pr.results || [];
  }
  const found=rows.results || [], more=found.length>rowsLimit || plans.length>plansLimit;
  if (more && !paged) return json({ok:false,truncated:true,error:"Слишком много строк. Уточните период или используйте page и page_size."},413);
  return json({ok:true,rows:found.slice(0,rowsLimit),plans:plans.slice(0,plansLimit),has_more:more,next_page:more?page+1:null});
}
