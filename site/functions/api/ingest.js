// POST /api/ingest — сборщик присылает пачку точек. Идемпотентно: одна и та же точка перезаписывается.
// Тело: {"collector": "amo-sheet", "points": [{"metric","ptype","period","dim","asof","value"}, ...], "plans": [{"metric","ptype","period","dim","value"}, ...]}
import { json, bad, hasIngestToken, now } from "./_lib.js";

const CHUNK = 80;   // D1 принимает пачки запросов; держим их небольшими

export async function onRequestPost({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return bad("тело не JSON");
  }
  const points = Array.isArray(body.points) ? body.points : [];
  const plans = Array.isArray(body.plans) ? body.plans : [];
  const collector = String(body.collector || "unknown").slice(0, 60);
  if (!points.length && !plans.length) return bad("пустая пачка");

  const stamp = now();
  const stmt = env.DB.prepare(
    "INSERT INTO points (metric, ptype, period, dim, asof, value, source, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(metric, ptype, period, dim, asof) DO UPDATE SET value = excluded.value, " +
    "source = excluded.source, updated_at = excluded.updated_at"
  );
  let written = 0;
  for (let i = 0; i < points.length; i += CHUNK) {
    const batch = [];
    for (const p of points.slice(i, i + CHUNK)) {
      if (!p || !p.metric || !p.ptype || !p.period || typeof p.value !== "number" || !isFinite(p.value)) continue;
      batch.push(stmt.bind(String(p.metric), String(p.ptype), String(p.period),
        String(p.dim || ""), String(p.asof || ""), p.value, collector, stamp));
    }
    if (batch.length) {
      await env.DB.batch(batch);
      written += batch.length;
    }
  }
  if (plans.length) {
    const ps = env.DB.prepare(
      "INSERT INTO plans (metric, ptype, period, dim, value, set_by, updated_at) VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(metric, ptype, period, dim) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, updated_at = excluded.updated_at");
    const batch = [];
    for (const p of plans.slice(0, 500)) {
      if (!p || !p.metric || !p.ptype || !p.period || typeof p.value !== "number" || !isFinite(p.value)) continue;
      batch.push(ps.bind(String(p.metric), String(p.ptype), String(p.period), String(p.dim || ""), p.value, "collector:" + collector, stamp));
    }
    if (batch.length) { await env.DB.batch(batch); written += batch.length; }
  }
  if (body.run_note !== undefined || body.finalize) {
    await env.DB.prepare("INSERT INTO runs (collector, started, finished, points, note) VALUES (?,?,?,?,?)")
      .bind(collector, body.started || stamp, stamp, body.total_points || written, String(body.run_note || "")).run();
  }
  return json({ ok: true, written });
}
