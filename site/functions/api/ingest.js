// POST /api/ingest — сборщик присылает пачку точек. Идемпотентно: одна и та же точка перезаписывается.
// Тело: {"collector": "amo-sheet", "points": [{"metric","ptype","period","dim","asof","value"}, ...], "plans": [{"metric","ptype","period","dim","value"}, ...],
//        "okna": [{"day","mgr","key","n","items"}, ...], "goals": [{"mgr","month","goal","base","rate","note"}, ...]}
import { json, bad, hasIngestToken, now, tgSend } from "./_lib.js";

// диагносту в Telegram: «подготовка готова». Пользователь Штаба ищется по имени (все слова его имени есть в имени диагноста из amo);
// шлём, только если совпадение одно. PREP_TG_CC — чат, которому дублировать всё (пилот).
async function notifyPrepReady(env, origin, rows) {
  const users = (await env.DB.prepare("SELECT login, name, tg_id FROM users WHERE active = 1 AND tg_id IS NOT NULL AND tg_id != ''").all()).results || [];
  for (const r of rows) {
    const who = (r.client || "клиент") + (r.company ? " · " + r.company : "");
    const when = r.meet_at ? ", встреча " + String(r.meet_at).replace(/^(\d+)-(\d+)-(\d+)/, "$3.$2.$1") + " МСК" : "";
    const text = "Подготовка к встрече готова: " + who + when + ".\nОткрыть: " + origin + "/sales/l2/prep/#deal=" + r.deal;
    const m = String(r.manager || "").toLowerCase();
    const hits = m ? users.filter((u) => { const w = String(u.name || "").toLowerCase().split(/\s+/).filter((x) => x.length >= 3); return w.length && w.every((x) => m.includes(x)); }) : [];
    const sent = new Set();
    if (hits.length === 1) { await tgSend(env, hits[0].tg_id, text); sent.add(String(hits[0].tg_id)); }
    if (env.PREP_TG_CC && !sent.has(String(env.PREP_TG_CC))) await tgSend(env, env.PREP_TG_CC, (r.manager ? "Диагност " + r.manager + (hits.length === 1 ? "" : " (в Штабе не найден, уведомление не ушло)") + ". " : "Диагност не определён. ") + text);
  }
}

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
  const has = (k) => Array.isArray(body[k]) && body[k].length;
  if (!points.length && !plans.length && !has("okna") && !has("goals") && !has("pings") && !has("prep") && !has("prep_cases") && !has("prep_growth") && !has("prep_manager") && !has("prep_style") && !has("expenses")) return bad("пустая пачка");

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
  // окна менеджеров: показатель дня с пруф-списком (collector/okna.py)
  const okna = Array.isArray(body.okna) ? body.okna : [];
  if (okna.length) {
    const os = env.DB.prepare(
      "INSERT INTO okna (day, mgr, key, n, items, updated_at) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(day, mgr, key) DO UPDATE SET n = excluded.n, items = excluded.items, updated_at = excluded.updated_at");
    const batch = [];
    for (const r of okna.slice(0, 200)) {
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.day || "")) || !r.mgr || !r.key) continue;
      const items = Array.isArray(r.items) ? r.items : [];
      batch.push(os.bind(String(r.day), String(r.mgr).slice(0, 40), String(r.key).slice(0, 40), Number(r.n) || items.length, JSON.stringify(items), stamp));
    }
    for (let i = 0; i < batch.length; i += 20) { await env.DB.batch(batch.slice(i, i + 20)); written += Math.min(20, batch.length - i); }
  }
  // журнал пингов Второй линии (collector/pings.py)
  const pings = Array.isArray(body.pings) ? body.pings : [];
  if (pings.length) {
    const ps2 = env.DB.prepare(
      "INSERT INTO pings (day, manager, deal, text, reason, updated_at) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(day, manager, deal) DO UPDATE SET text = excluded.text, reason = excluded.reason, updated_at = excluded.updated_at");
    const batch = [];
    for (const r of pings.slice(0, 200)) {
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.day || "")) || !r.manager || !Number(r.deal)) continue;
      batch.push(ps2.bind(String(r.day), String(r.manager).slice(0, 40), Number(r.deal), String(r.text || "").slice(0, 2000), String(r.reason || "").slice(0, 200), stamp));
    }
    if (batch.length) { await env.DB.batch(batch); written += batch.length; }
  }
  // подготовка к встрече (collector/prep.py): одна строка на сделку, перезаписывается целиком
  const prep = Array.isArray(body.prep) ? body.prep : [];
  const readyPrep = [];
  if (prep.length) {
    const s = (v, n = 200) => String(v == null ? "" : v).slice(0, n);
    const st = env.DB.prepare(
      "INSERT INTO prep (deal, contact, meet_at, manager, client, company, niche, turn, staff, geo, quiz_url, status, facts, sources, cases, brief, model, tokens_in, tokens_out, searches, amo_url, error, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(deal) DO UPDATE SET contact = excluded.contact, meet_at = excluded.meet_at, manager = excluded.manager, client = excluded.client, company = excluded.company, niche = excluded.niche, turn = excluded.turn, staff = excluded.staff, geo = excluded.geo, quiz_url = excluded.quiz_url, " +
      "status = excluded.status, facts = CASE WHEN excluded.status = 'ready' THEN excluded.facts ELSE prep.facts END, sources = CASE WHEN excluded.status = 'ready' THEN excluded.sources ELSE prep.sources END, " +
      "cases = CASE WHEN excluded.status = 'ready' THEN excluded.cases ELSE prep.cases END, brief = CASE WHEN excluded.status = 'ready' THEN excluded.brief ELSE prep.brief END, " +
      "model = excluded.model, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, searches = excluded.searches, amo_url = excluded.amo_url, error = excluded.error, updated_at = excluded.updated_at");
    for (const r of prep.slice(0, 50)) {
      if (!r || !Number(r.deal)) continue;
      const status = ["ready", "error", "queued"].includes(r.status) ? r.status : "ready";
      await st.bind(Number(r.deal), Number(r.contact) || null, s(r.meet_at, 20), s(r.manager, 80), s(r.client, 80), s(r.company), s(r.niche), s(r.turn, 20), s(r.staff, 20), s(r.geo, 120), s(r.quiz_url, 300),
        status, s(r.facts, 60000), JSON.stringify(Array.isArray(r.sources) ? r.sources.slice(0, 60) : []), JSON.stringify(Array.isArray(r.cases) ? r.cases.slice(0, 10) : []), s(r.brief, 80000),
        s(r.model, 60), Number(r.tokens_in) || 0, Number(r.tokens_out) || 0, Number(r.searches) || 0, s(r.amo_url, 200), s(r.error, 300), stamp, stamp).run();
      written++;
      if (status === "ready" && r.brief) readyPrep.push(r);
    }
    if (readyPrep.length) {
      try { await notifyPrepReady(env, new URL(request.url).origin, readyPrep); } catch (e) { /* уведомление не должно ронять приём */ }
    }
  }
  // база участников для подбора кейсов (prep.py cases)
  const cases = Array.isArray(body.prep_cases) ? body.prep_cases : [];
  if (cases.length) {
    const s = (v, n = 120) => String(v == null ? "" : v).slice(0, n);
    const cs = env.DB.prepare(
      "INSERT INTO prep_cases (deal, pipeline, name, company, niche, sphere, turn, staff, site, role, city, country, paid_at, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(deal) DO UPDATE SET pipeline = excluded.pipeline, name = excluded.name, company = excluded.company, niche = excluded.niche, sphere = excluded.sphere, turn = excluded.turn, staff = excluded.staff, site = excluded.site, role = excluded.role, city = excluded.city, country = excluded.country, paid_at = excluded.paid_at, source = excluded.source, updated_at = excluded.updated_at");
    const batch = [];
    for (const r of cases.slice(0, 200)) {
      if (!r || !Number(r.deal)) continue;
      batch.push(cs.bind(Number(r.deal), Number(r.pipeline) || null, s(r.name), s(r.company), s(r.niche), s(r.sphere), s(r.turn, 20), s(r.staff, 20), s(r.site), s(r.role, 60), s(r.city), s(r.country), s(r.paid_at, 10), r.source === "sheet" ? "sheet" : "amo", stamp));
    }
    for (let i = 0; i < batch.length; i += 40) { await env.DB.batch(batch.slice(i, i + 40)); written += Math.min(40, batch.length - i); }
  }
  // расходы (collector/expenses.py, pings.py): ref — ключ автоимпорта, повтор не дублирует
  const expenses = Array.isArray(body.expenses) ? body.expenses : [];
  if (expenses.length) {
    const es = env.DB.prepare(
      "INSERT INTO expenses (day, service, item, kind, amount, currency, amount_orig, qty, note, source, ref, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(ref) WHERE ref IS NOT NULL DO UPDATE SET day = excluded.day, amount = excluded.amount, qty = excluded.qty, note = excluded.note, item = excluded.item");
    const batch = [];
    for (const r of expenses.slice(0, 500)) {
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.day || "")) || !r.service || typeof r.amount !== "number" || !isFinite(r.amount)) continue;
      batch.push(es.bind(String(r.day), String(r.service).slice(0, 60), String(r.item || "").slice(0, 200), String(r.kind || "spend"), r.amount,
        String(r.currency || "RUB"), r.amount_orig == null ? null : Number(r.amount_orig), r.qty == null ? null : Number(r.qty),
        String(r.note || "").slice(0, 500), "collector:" + collector, r.ref ? String(r.ref).slice(0, 200) : null, "collector:" + collector, stamp));
    }
    for (let i = 0; i < batch.length; i += 20) { await env.DB.batch(batch.slice(i, i + 20)); written += Math.min(20, batch.length - i); }
  }
  // диагност, определённый сборщиком позже (копия на Второй линии появилась после подготовки)
  const pm = Array.isArray(body.prep_manager) ? body.prep_manager : [];
  for (const r of pm.slice(0, 50)) {
    if (!r || !Number(r.deal) || !r.manager) continue;
    await env.DB.prepare("UPDATE prep SET manager = ?, updated_at = ? WHERE deal = ? AND manager = ''").bind(String(r.manager).slice(0, 80), stamp, Number(r.deal)).run();
    written++;
  }
  // стиль вопросов диагноста (prep.py style)
  const pst = Array.isArray(body.prep_style) ? body.prep_style : [];
  for (const r of pst.slice(0, 20)) {
    if (!r || !r.manager || !r.text) continue;
    await env.DB.prepare("INSERT INTO prep_style (manager, text, meetings, updated_at) VALUES (?,?,?,?) ON CONFLICT(manager) DO UPDATE SET text = excluded.text, meetings = excluded.meetings, updated_at = excluded.updated_at")
      .bind(String(r.manager).slice(0, 80), String(r.text).slice(0, 8000), Number(r.meetings) || 0, stamp).run();
    written++;
  }
  // база «было → стало»: результат проверки роста участника (prep.py growth), ночная пересборка базы его не трогает
  const growth = Array.isArray(body.prep_growth) ? body.prep_growth : [];
  if (growth.length) {
    const gs2 = env.DB.prepare("UPDATE prep_cases SET result = ?, checked_at = ?, updated_at = ? WHERE deal = ?");
    const batch = [];
    for (const r of growth.slice(0, 200)) {
      if (!r || !Number(r.deal)) continue;
      batch.push(gs2.bind(String(r.result || "").slice(0, 3000), String(r.checked_at || stamp.slice(0, 10)).slice(0, 10), stamp, Number(r.deal)));
    }
    for (let i = 0; i < batch.length; i += 40) { await env.DB.batch(batch.slice(i, i + 40)); written += Math.min(40, batch.length - i); }
  }
  const goals = Array.isArray(body.goals) ? body.goals : [];
  if (goals.length) {
    const gs = env.DB.prepare(
      "INSERT INTO okna_goals (mgr, month, goal, base, rate, note, set_by, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(mgr, month) DO UPDATE SET goal = excluded.goal, base = excluded.base, rate = excluded.rate, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at");
    const batch = [];
    for (const g of goals.slice(0, 50)) {
      if (!g || !g.mgr || !/^\d{4}-\d{2}$/.test(String(g.month || "")) || typeof g.goal !== "number") continue;
      batch.push(gs.bind(String(g.mgr).slice(0, 40), String(g.month), g.goal, Number(g.base) || 25000, Number(g.rate) || 1500, String(g.note || "").slice(0, 200), "collector:" + collector, stamp));
    }
    if (batch.length) { await env.DB.batch(batch); written += batch.length; }
  }
  if (body.run_note !== undefined || body.finalize) {
    await env.DB.prepare("INSERT INTO runs (collector, started, finished, points, note) VALUES (?,?,?,?,?)")
      .bind(collector, body.started || stamp, stamp, body.total_points || written, String(body.run_note || "")).run();
  }
  return json({ ok: true, written });
}
