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
    const hits = m ? users.filter((u) => { const w = String(u.name || "").split("|")[0].toLowerCase().split(/[^a-zа-яё]+/i).filter((x) => x.length >= 3); /* имя до «|»: «Евгений Кротов|GitelmanTeam» */ return w.length && w.every((x) => m.includes(x)); }) : [];
    const sent = new Set();
    if (hits.length === 1) { await tgSend(env, hits[0].tg_id, text); sent.add(String(hits[0].tg_id)); }
    if (env.PREP_TG_CC && !sent.has(String(env.PREP_TG_CC))) await tgSend(env, env.PREP_TG_CC, (r.manager ? "Диагност " + r.manager + (hits.length === 1 ? "" : " (в Штабе не найден, уведомление не ушло)") + ". " : "Диагност не определён. ") + text);
  }
}

// подготовка не запустилась (16.10.2026): тому, кто нажал «Подготовить» (prep.queued_by), — причина и что сделать; копия PREP_TG_CC
async function notifyPrepError(env, origin, rows) {
  for (const r of rows) {
    const q = await env.DB.prepare("SELECT p.queued_by AS login, u.tg_id AS tg FROM prep p LEFT JOIN users u ON u.login = p.queued_by AND u.active = 1 WHERE p.deal = ?").bind(Number(r.deal)).first();
    const text = "Подготовка по сделке " + r.deal + " не запустилась: " + String(r.error || "ошибка") + ".\nОткрыть: " + origin + "/sales/l2/prep/#deal=" + r.deal;
    const sent = new Set();
    if (q && q.tg) { await tgSend(env, q.tg, text); sent.add(String(q.tg)); }
    if (env.PREP_TG_CC && !sent.has(String(env.PREP_TG_CC))) await tgSend(env, env.PREP_TG_CC, (q && q.login ? "Запускал " + q.login + (q.tg ? "" : " (нет Telegram в Штабе)") + ". " : "") + text);
  }
}

async function saveDebriefVersion(env, r, stamp) {
  try {
    await env.DB.prepare("INSERT INTO prep_debrief_ver (deal, label, text, loyalty, model, cost, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(Number(r.deal), String(r.label || r.model || "").slice(0, 80), String(r.text).slice(0, 30000), Number(r.loyalty) || null,
            String(r.model || "").slice(0, 120), String(r.cost || "").slice(0, 60), stamp).run();
  } catch (e) { /* таблицы версий может ещё не быть */ }
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
  if (!points.length && !plans.length && !has("okna") && !has("goals") && !has("pings") && !has("prep") && !has("prep_cases") && !has("prep_growth") && !has("prep_manager") && !has("prep_style") && !has("prep_debrief") && !has("prep_debrief_versions") && !has("debrief_status") && !(body.prep_alumni && body.prep_alumni.rows) && !has("expenses")) return bad("пустая пачка");

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
  const readyPrep = [], errorPrep = [];
  if (prep.length) {
    const s = (v, n = 200) => String(v == null ? "" : v).slice(0, n);
    const st = env.DB.prepare(
      "INSERT INTO prep (deal, contact, meet_at, manager, client, company, niche, turn, staff, geo, quiz_url, status, facts, sources, cases, brief, model, tokens_in, tokens_out, searches, amo_url, error, created_at, updated_at, inputs) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(deal) DO UPDATE SET contact = COALESCE(excluded.contact, prep.contact), meet_at = CASE WHEN excluded.meet_at != '' THEN excluded.meet_at ELSE prep.meet_at END, manager = CASE WHEN excluded.manager != '' THEN excluded.manager ELSE prep.manager END, client = CASE WHEN excluded.client != '' THEN excluded.client ELSE prep.client END, company = CASE WHEN excluded.company != '' THEN excluded.company ELSE prep.company END, niche = CASE WHEN excluded.niche != '' THEN excluded.niche ELSE prep.niche END, turn = CASE WHEN excluded.turn != '' THEN excluded.turn ELSE prep.turn END, staff = CASE WHEN excluded.staff != '' THEN excluded.staff ELSE prep.staff END, geo = CASE WHEN excluded.geo != '' THEN excluded.geo ELSE prep.geo END, quiz_url = CASE WHEN excluded.quiz_url != '' THEN excluded.quiz_url ELSE prep.quiz_url END, " +
      "status = excluded.status, facts = CASE WHEN excluded.status = 'ready' THEN excluded.facts ELSE prep.facts END, sources = CASE WHEN excluded.status = 'ready' THEN excluded.sources ELSE prep.sources END, " +
      "cases = CASE WHEN excluded.status = 'ready' THEN excluded.cases ELSE prep.cases END, brief = CASE WHEN excluded.status = 'ready' THEN excluded.brief ELSE prep.brief END, " +
      "model = excluded.model, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, searches = excluded.searches, amo_url = excluded.amo_url, error = excluded.error, updated_at = excluded.updated_at, inputs = CASE WHEN excluded.inputs != '' THEN excluded.inputs ELSE prep.inputs END");
    for (const r of prep.slice(0, 50)) {
      if (!r || !Number(r.deal)) continue;
      const status = ["ready", "error", "queued"].includes(r.status) ? r.status : "ready";
      await st.bind(Number(r.deal), Number(r.contact) || null, s(r.meet_at, 20), s(r.manager, 80), s(r.client, 80), s(r.company), s(r.niche), s(r.turn, 20), s(r.staff, 20), s(r.geo, 120), s(r.quiz_url, 300),
        status, s(r.facts, 60000), JSON.stringify(Array.isArray(r.sources) ? r.sources.slice(0, 60) : []), JSON.stringify(Array.isArray(r.cases) ? r.cases.slice(0, 10) : []), s(r.brief, 80000),
        s(r.model, 60), Number(r.tokens_in) || 0, Number(r.tokens_out) || 0, Number(r.searches) || 0, s(r.amo_url, 200), s(r.error, 300), stamp, stamp,
        r.inputs && typeof r.inputs === "object" ? JSON.stringify(r.inputs).slice(0, 1000) : "").run();
      written++;
      if (status === "ready" && r.brief) readyPrep.push(r);
      if (status === "error" && r.error) errorPrep.push(r);
    }
    if (readyPrep.length) {
      try { await notifyPrepReady(env, new URL(request.url).origin, readyPrep); } catch (e) { /* уведомление не должно ронять приём */ }
    }
    if (errorPrep.length) {
      try { await notifyPrepError(env, new URL(request.url).origin, errorPrep); } catch (e) { /* уведомление не должно ронять приём */ }
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
  // короткое уведомление админу в Telegram от сборщика (collector/ai_visibility.py: появились / пропали в ИИ-ответах)
  if (body.notify && env.TG_ADMIN_CHAT) await tgSend(env, env.TG_ADMIN_CHAT, String(body.notify).slice(0, 3500));
  // диагност, определённый сборщиком позже (копия на Второй линии появилась после подготовки)
  const pm = Array.isArray(body.prep_manager) ? body.prep_manager : [];
  for (const r of pm.slice(0, 50)) {
    if (!r || !Number(r.deal) || !r.manager) continue;
    await env.DB.prepare("UPDATE prep SET manager = ?, updated_at = ? WHERE deal = ? AND manager IN ('', 'Администратор')").bind(String(r.manager).slice(0, 80), stamp, Number(r.deal)).run();
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
  // разбор встречи (13.10.2026): лояльность, ключ для следующей встречи, PING_CONTEXT — одна строка на сделку
  const deb = Array.isArray(body.prep_debrief) ? body.prep_debrief : [];
  for (const r of deb.slice(0, 20)) {
    if (!r || !Number(r.deal) || !r.text) continue;
    const v = (x, n) => String(x || "").slice(0, n);
    await env.DB.prepare("INSERT INTO prep_debrief (deal, text, loyalty, client, company, manager, meeting_at, model, cost, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(deal) DO UPDATE SET text = excluded.text, loyalty = excluded.loyalty, client = excluded.client, company = excluded.company, manager = excluded.manager, " +
      "meeting_at = excluded.meeting_at, model = excluded.model, cost = excluded.cost, updated_at = excluded.updated_at")
      .bind(Number(r.deal), v(r.text, 30000), Number(r.loyalty) || null, v(r.client, 80), v(r.company, 120), v(r.manager, 80), v(r.meeting_at, 20), v(r.model, 120), v(r.cost, 60), stamp, stamp).run();
    written++;
    if (r.version !== false) await saveDebriefVersion(env, r, stamp);   // каждая выгрузка — ещё и версия для сравнения
  }
  // состояние цепочки разбора (15.10.2026): по сделке с подготовкой — что сейчас с разбором (раздел «Разбор встречи», блок «В работе»)
  const dst = Array.isArray(body.debrief_status) ? body.debrief_status : [];
  if (dst.length) {
    const v = (x, n) => String(x || "").slice(0, n);
    const q = env.DB.prepare("INSERT INTO debrief_queue (deal, l2, status, note, client, company, manager, meet_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(deal) DO UPDATE SET l2 = COALESCE(excluded.l2, debrief_queue.l2), status = excluded.status, note = excluded.note, client = excluded.client, " +
      "company = excluded.company, manager = excluded.manager, meet_at = excluded.meet_at, updated_at = excluded.updated_at");
    const batch = dst.slice(0, 200).filter((r) => r && Number(r.deal))
      .map((r) => q.bind(Number(r.deal), Number(r.l2) || null, v(r.status, 20), v(r.note, 300), v(r.client, 80), v(r.company, 120), v(r.manager, 80), v(r.meet_at, 20), stamp));
    try { for (let i = 0; i < batch.length; i += 40) { await env.DB.batch(batch.slice(i, i + 40)); written += Math.min(40, batch.length - i); } } catch (e) { /* таблицы может ещё не быть */ }
  }
  // база кейсов выпускников из отчётных презентаций (19.10.2026): {replace: true, rows: [...]} — заливается целиком
  if (body.prep_alumni && Array.isArray(body.prep_alumni.rows)) {
    const v = (x, n) => String(x == null ? "" : x).slice(0, n);
    const F = ["file_id", "stream", "company", "person", "niche", "region", "size", "evidence", "problems", "results", "grow", "pct",
               "changed", "say", "confirmed", "cannot", "when_use", "transition", "takeaway", "question", "ask_alumni"];
    if (body.prep_alumni.replace) await env.DB.prepare("DELETE FROM prep_alumni").run();
    const q = env.DB.prepare("INSERT INTO prep_alumni (" + F.join(", ") + ", updated_at) VALUES (" + F.map(() => "?").join(",") + ",?)");
    const batch = body.prep_alumni.rows.slice(0, 1000).filter((r) => r && (r.say || r.changed))
      .map((r) => q.bind(...F.map((k) => v(r[k], k === "say" || k === "changed" || k === "confirmed" || k === "cannot" ? 1500 : 600)), stamp));
    for (let i = 0; i < batch.length; i += 40) { await env.DB.batch(batch.slice(i, i + 40)); written += Math.min(40, batch.length - i); }
  }
  // версии разбора без смены текущего (сравнение моделей, ручные эталоны)
  const dver = Array.isArray(body.prep_debrief_versions) ? body.prep_debrief_versions : [];
  for (const r of dver.slice(0, 30)) { if (r && Number(r.deal) && r.text) { await saveDebriefVersion(env, r, stamp); written++; } }
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
