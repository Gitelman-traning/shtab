// GET  /api/pings?manager=krotov[&days=120] — журнал подготовленных пингов (сборщик — токеном; люди — с правом на Вторую линию).
// GET  /api/pings?mode=suggest[&days=60]   — предложения пингов (15.10.2026): повод из разбора встречи, текст и сценарий кружочка.
// POST /api/pings {action:"decide", id, status: text|video|skip|new} — менеджер отметил, что сделал с предложением.
// POST /api/pings {action:"suggest", rows:[{deal, manager, client, company, due_day, reason, loyalty, text, script, model}]} — сборщик (токен):
//      добавить предложения; что уже пора — сразу в Telegram менеджеру.
// POST /api/pings {action:"notify_due"} — сборщик (токен), утром: разослать в Telegram предложения, у которых наступил день.
import { json, bad, canRead, level, now, audit, hasIngestToken, tgSend } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l2") < 1) return bad("нет доступа", 401);
  const u = new URL(request.url);
  if (u.searchParams.get("mode") === "suggest") {
    const days = Math.min(Number(u.searchParams.get("days")) || 60, 400);
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    let rows = [];
    try {
      rows = (await env.DB.prepare("SELECT id, deal, manager, client, company, due_day, reason, loyalty, text, script, status, decided_by, decided_at, model, created_at " +
        "FROM ping_suggest WHERE due_day >= ? ORDER BY due_day, id LIMIT 1000").bind(from).all()).results || [];
    } catch (e) { rows = []; }
    return json({ ok: true, rows, today: new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10) });
  }
  const manager = (u.searchParams.get("manager") || "").slice(0, 40);
  const days = Math.min(Number(u.searchParams.get("days")) || 120, 400);
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const q = manager
    ? env.DB.prepare("SELECT day, manager, deal, text, reason FROM pings WHERE manager = ? AND day >= ? ORDER BY day DESC LIMIT 5000").bind(manager, from)
    : env.DB.prepare("SELECT day, manager, deal, text, reason FROM pings WHERE day >= ? ORDER BY day DESC LIMIT 5000").bind(from);
  const rows = await q.all();
  return json({ ok: true, rows: rows.results || [] });
}

const MSK = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

// предложения, у которых наступил день и уведомление ещё не уходило → Telegram менеджеру (по имени в Штабе) + копия PREP_TG_CC
async function notifyDue(env, origin) {
  const due = (await env.DB.prepare("SELECT * FROM ping_suggest WHERE status = 'new' AND notified_at = '' AND due_day <= ? ORDER BY due_day, id LIMIT 30").bind(MSK()).all()).results || [];
  if (!due.length) return 0;
  const users = (await env.DB.prepare("SELECT login, name, tg_id FROM users WHERE active = 1 AND tg_id IS NOT NULL AND tg_id != ''").all()).results || [];
  for (const r of due) {
    const m = String(r.manager || "").toLowerCase();
    const hits = m ? users.filter((x) => { const w = String(x.name || "").toLowerCase().split(/\s+/).filter((y) => y.length >= 3); return w.length && w.every((y) => m.includes(y)); }) : [];
    const text = "Пинг на сегодня: " + (r.client || "клиент") + (r.company ? " · " + r.company : "") + (r.loyalty ? " · лояльность " + r.loyalty + "/10" : "") +
      "
Повод: " + r.reason + "

Текст:
" + r.text + "

Или кружочек, что сказать:
" + r.script +
      "

Отметить: " + origin + "/sales/l2/pings/#id=" + r.id;
    const sent = new Set();
    if (hits.length === 1) { await tgSend(env, hits[0].tg_id, text); sent.add(String(hits[0].tg_id)); }
    if (env.PREP_TG_CC && !sent.has(String(env.PREP_TG_CC))) await tgSend(env, env.PREP_TG_CC, (hits.length === 1 ? "" : "(менеджер " + r.manager + " в Штабе не найден) ") + text);
    await env.DB.prepare("UPDATE ping_suggest SET notified_at = ? WHERE id = ?").bind(now(), r.id).run();
  }
  return due.length;
}

export async function onRequestPost({ request, env }) {
  const origin = new URL(request.url).origin;
  if (hasIngestToken(request, env)) {
    let b;
    try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
    if (b.action === "suggest") {
      const v = (x, n) => String(x == null ? "" : x).slice(0, n);
      let added = 0;
      for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 50)) {
        if (!r || !Number(r.deal) || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.due_day || "")) || !(r.text || r.script)) continue;
        await env.DB.prepare("INSERT INTO ping_suggest (deal, manager, client, company, due_day, reason, loyalty, text, script, model, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(Number(r.deal), v(r.manager, 80), v(r.client, 80), v(r.company, 120), r.due_day, v(r.reason, 600), Number(r.loyalty) || null, v(r.text, 3000), v(r.script, 3000), v(r.model, 80), now()).run();
        added++;
      }
      const notified = await notifyDue(env, origin);
      return json({ ok: true, added, notified });
    }
    if (b.action === "notify_due") return json({ ok: true, notified: await notifyDue(env, origin) });
  }
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l2") < 1) return bad("нет доступа", 401);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  if (b.action === "decide") {
    const id = Number(b.id), status = String(b.status || "");
    if (!id || !["text", "video", "skip", "new"].includes(status)) return bad("нужны id и status");
    await env.DB.prepare("UPDATE ping_suggest SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?")
      .bind(status, status === "new" ? "" : user.login, status === "new" ? "" : now(), id).run();
    await audit(env, user.login, "ping.decide", String(id), status);
    return json({ ok: true });
  }
  return bad("неизвестное действие");
}
