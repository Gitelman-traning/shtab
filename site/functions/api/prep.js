// Подготовка диагноста к встрече (collector/prep.py, страница /sales/l2/prep/).
// GET  /api/prep?days=14            — список подготовок (право sales.l2): встречи от вчера и на две недели вперёд + очередь и ошибки.
//                                     Заодно дотягивает диагноста из копии сделки на Второй линии для подготовок, где он не определён (до 3 за запрос).
// GET  /api/prep?deal=ID            — одна подготовка целиком (досье, участники, текст, обратная связь)
// GET  /api/prep?mode=managers      — список людей amo для выбора диагноста (кэш в KV на сутки)
// GET  /api/prep?mode=collector     — для сборщика (токен): {queued, known, no_manager, done_today, cases, styles}
// GET  /api/prep?mode=transcripts&deals=1,2,3 — для сборщика (токен): расшифровки встреч из KV (t:<deal>), которые есть
// POST /api/prep {action:"recalc", deal}                       — поставить в очередь (сборщик подхватит в ближайший прогон)
// POST /api/prep {action:"feedback", deal, useful, comment}    — «полезно / не полезно»
// POST /api/prep {action:"manager", deal, manager}             — диагност вручную
import { json, bad, canRead, level, now, audit, hasIngestToken } from "./_lib.js";

const LIST_COLS = "deal, contact, meet_at, manager, client, company, niche, turn, staff, geo, status, error, model, tokens_in, tokens_out, searches, amo_url, updated_at";
const AMO = "https://pavelgitelman.amocrm.ru/api/v4";
const L2_PIPES = [9701010, 8733518];

async function amoGet(env, path, params) {
  if (!env.AMO_TOKEN) return null;
  const u = new URL(AMO + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: "Bearer " + env.AMO_TOKEN } });
  if (r.status === 204) return {};
  if (!r.ok) return null;
  return r.json();
}

// люди amo: id → имя, кэш в KV на сутки
async function amoUsers(env) {
  let users = null;
  try { const raw = await env.OKK_KV.get("prep:amo-users"); if (raw) users = JSON.parse(raw); } catch (e) { users = null; }
  if (!users) {
    const j = await amoGet(env, "/users", { limit: 250 });
    users = {};
    for (const u of ((j && j._embedded && j._embedded.users) || [])) if (u.rights ? u.rights.is_active !== false : true) users[u.id] = u.name || String(u.id);
    if (Object.keys(users).length) await env.OKK_KV.put("prep:amo-users", JSON.stringify(users), { expirationTtl: 86400 });
  }
  return users;
}

// диагност = ответственный открытой копии сделки на Второй линии (через контакт); "" если копии ещё нет
async function findManager(env, deal) {
  const lead = await amoGet(env, "/leads/" + deal, { with: "contacts" });
  const cs = (lead && lead._embedded && lead._embedded.contacts) || [];
  const main = cs.find((c) => c.is_main) || cs[0];
  if (!main) return "";
  const contact = await amoGet(env, "/contacts/" + main.id, { with: "leads" });
  const users = await amoUsers(env);
  for (const x of ((contact && contact._embedded && contact._embedded.leads) || [])) {
    if (x.id === deal) continue;
    const l = await amoGet(env, "/leads/" + x.id);
    if (l && L2_PIPES.includes(l.pipeline_id) && l.status_id !== 142 && l.status_id !== 143) return users[l.responsible_user_id] || String(l.responsible_user_id);
  }
  return "";
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const mode = u.searchParams.get("mode") || "";
  if (mode === "collector" || mode === "transcripts") {
    if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
    if (mode === "transcripts") {
      const ids = String(u.searchParams.get("deals") || "").split(",").map((x) => Number(x)).filter(Boolean).slice(0, 60);
      const out = [];
      for (const d of ids) {
        const t = await env.OKK_KV.get("t:" + d);
        if (t) out.push({ deal: d, text: t.slice(0, 60000) });
        if (out.length >= 12) break;
      }
      return json({ ok: true, transcripts: out });
    }
    const q = await env.DB.prepare("SELECT deal FROM prep WHERE status = 'queued'").all();
    const k = await env.DB.prepare("SELECT deal FROM prep WHERE status != 'queued'").all();
    const nm = await env.DB.prepare("SELECT deal FROM prep WHERE manager = '' AND status = 'ready' AND updated_at > ?").bind(new Date(Date.now() - 14 * 864e5).toISOString()).all();
    const today = new Date().toISOString().slice(0, 10);
    const dt = await env.DB.prepare("SELECT COUNT(*) AS n FROM prep WHERE status = 'ready' AND created_at >= ?").bind(today).first();
    const c = await env.DB.prepare("SELECT deal, pipeline, name, company, niche, sphere, turn, staff, site, role, city, country, paid_at, result, checked_at FROM prep_cases").all();
    const st = await env.DB.prepare("SELECT manager, text FROM prep_style").all();
    return json({ ok: true, queued: (q.results || []).map((r) => r.deal), known: (k.results || []).map((r) => r.deal), no_manager: (nm.results || []).map((r) => r.deal),
      done_today: (dt && dt.n) || 0, cases: c.results || [], styles: st.results || [] });
  }
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l2") < 1) return bad("нет доступа", 401);
  if (mode === "managers") {
    const users = await amoUsers(env);
    return json({ ok: true, managers: Object.values(users).sort((a, b) => a.localeCompare(b, "ru")) });
  }
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
  const rows = (await env.DB.prepare(
    "SELECT " + LIST_COLS + " FROM prep WHERE (meet_at >= ? AND meet_at <= ?) OR status != 'ready' OR meet_at = '' ORDER BY meet_at DESC, updated_at DESC LIMIT 300")
    .bind(from, to).all()).results || [];
  // диагност не определён — копия на Второй линии могла появиться позже; дотягиваем прямо здесь, не дожидаясь сборщика
  const pending = rows.filter((r) => !r.manager && r.status === "ready").slice(0, 3);
  if (pending.length && env.AMO_TOKEN) {
    const work = (async () => {
      for (const r of pending) {
        try {
          const m = await findManager(env, r.deal);
          if (m) { await env.DB.prepare("UPDATE prep SET manager = ?, updated_at = ? WHERE deal = ? AND manager = ''").bind(m, now(), r.deal).run(); r.manager = m; }
        } catch (e) { /* в следующий раз */ }
      }
    })();
    await work;
  }
  const cases = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN result != '' THEN 1 ELSE 0 END) AS checked FROM prep_cases").first();
  return json({ ok: true, rows, cases: (cases && cases.n) || 0, checked: (cases && cases.checked) || 0, me: user.login });
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
  if (b.action === "manager") {
    const manager = String(b.manager || "").trim().slice(0, 80);
    await env.DB.prepare("UPDATE prep SET manager = ?, updated_at = ? WHERE deal = ?").bind(manager, stamp, deal).run();
    await audit(env, user.login, "prep.manager", String(deal), manager);
    return json({ ok: true });
  }
  return bad("неизвестное действие");
}
