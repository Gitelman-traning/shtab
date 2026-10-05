// Подготовка диагноста к встрече (collector/prep.py, страница /sales/l2/prep/).
// GET  /api/prep?days=14            — список подготовок (право sales.l2): встречи от вчера и на две недели вперёд + очередь и ошибки
// GET  /api/prep?deal=ID            — одна подготовка целиком (досье, участники, текст, обратная связь)
// GET  /api/prep?mode=collector     — для сборщика (токен): {queued:[deal], known:[deal], cases:[...]}
// POST /api/prep {action:"recalc", deal}                       — поставить в очередь (сборщик подхватит в ближайший прогон)
// POST /api/prep {action:"feedback", deal, useful, comment}    — «полезно / не полезно»
import { json, bad, canRead, level, now, audit, hasIngestToken } from "./_lib.js";

const LIST_COLS = "deal, contact, meet_at, manager, client, company, niche, turn, staff, geo, status, error, model, tokens_in, tokens_out, searches, amo_url, updated_at";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (u.searchParams.get("mode") === "collector") {
    if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
    const q = await env.DB.prepare("SELECT deal FROM prep WHERE status = 'queued'").all();
    const k = await env.DB.prepare("SELECT deal FROM prep WHERE status != 'queued'").all();
    const c = await env.DB.prepare("SELECT deal, pipeline, name, company, niche, sphere, turn, staff, site, role, city, country, paid_at, result, checked_at FROM prep_cases").all();
    return json({ ok: true, queued: (q.results || []).map((r) => r.deal), known: (k.results || []).map((r) => r.deal), cases: c.results || [] });
  }
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l2") < 1) return bad("нет доступа", 401);
  const deal = Number(u.searchParams.get("deal"));
  if (deal) {
    const row = await env.DB.prepare("SELECT * FROM prep WHERE deal = ?").bind(deal).first();
    if (!row) return bad("подготовки нет", 404);
    let sources = [], cases = [];
    try { sources = JSON.parse(row.sources || "[]"); } catch (e) { sources = []; }
    try { cases = JSON.parse(row.cases || "[]"); } catch (e) { cases = []; }
    const fb = await env.DB.prepare("SELECT login, useful, comment, at FROM prep_feedback WHERE deal = ? ORDER BY at DESC").bind(deal).all();
    return json({ ok: true, row: { ...row, sources, cases }, feedback: fb.results || [], me: user.login });
  }
  const days = Math.min(Number(u.searchParams.get("days")) || 14, 60);
  const from = new Date(Date.now() - 1 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10) + " 99";
  const rows = await env.DB.prepare(
    "SELECT " + LIST_COLS + " FROM prep WHERE (meet_at >= ? AND meet_at <= ?) OR status != 'ready' OR meet_at = '' ORDER BY meet_at DESC, updated_at DESC LIMIT 300")
    .bind(from, to).all();
  const cases = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN result != '' THEN 1 ELSE 0 END) AS checked FROM prep_cases").first();
  return json({ ok: true, rows: rows.results || [], cases: (cases && cases.n) || 0, checked: (cases && cases.checked) || 0, me: user.login });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l2") < 1) return bad("нет доступа", 401);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const deal = Number(b.deal);
  if (!deal) return bad("нужна сделка");
  const stamp = now();
  if (b.action === "recalc") {
    await env.DB.prepare(
      "INSERT INTO prep (deal, status, queued_by, amo_url, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?) " +
      "ON CONFLICT(deal) DO UPDATE SET status = 'queued', queued_by = excluded.queued_by, error = '', updated_at = excluded.updated_at")
      .bind(deal, user.login, "https://pavelgitelman.amocrm.ru/leads/detail/" + deal, stamp, stamp).run();
    await audit(env, user.login, "prep.recalc", String(deal), "");
    return json({ ok: true });
  }
  if (b.action === "feedback") {
    const useful = b.useful ? 1 : 0;
    const comment = String(b.comment || "").slice(0, 1000);
    await env.DB.prepare(
      "INSERT INTO prep_feedback (deal, login, useful, comment, at) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(deal, login) DO UPDATE SET useful = excluded.useful, comment = excluded.comment, at = excluded.at")
      .bind(deal, user.login, useful, comment, stamp).run();
    await audit(env, user.login, "prep.feedback", String(deal), (useful ? "полезно" : "не полезно") + (comment ? ": " + comment.slice(0, 100) : ""));
    return json({ ok: true });
  }
  return bad("неизвестное действие");
}
