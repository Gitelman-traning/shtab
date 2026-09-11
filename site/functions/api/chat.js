// Чат с ИИ на общем экране: вопросы по цифрам Штаба и по компании.
//   POST /api/chat {messages:[{role:"user"|"assistant", content}]} → {ok, answer}
// Модель получает сводку витрины (последние два месяца, источники, менеджеры, план/факт, участники, сайт),
// определения показателей из реестра и справочные записи из таблицы knowledge (структура компании, карта разделов).
import { json, bad, canRead, llmChat, audit } from "./_lib.js";

const DAY_METRICS = ["mkt.leads", "mkt.qual", "l1.leads", "l1.booked", "l2.held", "l2.sales"];
const NAMES = { "mkt.leads": "лиды", "mkt.qual": "ЦА/УЦА (квалифицированные лиды)", "l1.leads": "лиды Первой линии (все воронки)", "l1.booked": "назначено диагностик", "l2.held": "проведено диагностик", "l2.sales": "продажи (прислали чек)" };
const FUN = [["fun.l1.leads", "Лиды"], ["fun.l1.reached", "Дозвон/ответил"], ["fun.l1.q3", "Ответили на 3 вопроса"], ["fun.l1.qual", "Квалифицированы ЦА/УЦА"], ["fun.l1.booked", "Назначено встреч"], ["fun.l1.confirmed", "Подтверждено"], ["fun.l1.held", "Проведено встреч"],
             ["fun.l2.booked", "2 линия: назначено на диагностику"], ["fun.l2.held", "2 линия: диагностика проведена"], ["fun.l2.committee", "2 линия: заявка на комитет"], ["fun.l2.selected", "2 линия: отбор проведён"], ["fun.l2.invoiced", "2 линия: счёт отправлен"], ["fun.l2.paid", "2 линия: прислал чек"]];

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function dmy(s) { return s.slice(8, 10) + "." + s.slice(5, 7); }
function pct(a, b) { return b ? Math.round(100 * a / b) + "%" : "—"; }

async function digest(env) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const yesterday = addDays(today, -1);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const pmStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const from = addDays(yesterday, -70);
  const month = iso(monthStart).slice(0, 7), pmonth = iso(pmStart).slice(0, 7);
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results || []);
  const [days, srcs, mgr2, mgr1, fun, plans, pay, web, reg, know] = await Promise.all([
    q("SELECT metric, period, value FROM points WHERE ptype='day' AND dim='' AND metric IN (" + DAY_METRICS.map(() => "?").join(",") + ") AND period >= ? AND period <= ?", ...DAY_METRICS, iso(from), iso(yesterday)),
    q("SELECT dim, SUM(value) v FROM points WHERE ptype='day' AND metric='mkt.leads' AND dim <> '' AND dim NOT LIKE 'tag:%' AND period >= ? AND period <= ? GROUP BY dim ORDER BY v DESC", iso(monthStart), iso(yesterday)),
    q("SELECT metric, dim, SUM(value) v FROM points WHERE ptype='day' AND metric IN ('l2.held','l2.sales') AND dim <> '' AND dim NOT LIKE 'src:%' AND period >= ? AND period <= ? GROUP BY metric, dim", iso(monthStart), iso(yesterday)),
    q("SELECT metric, dim, SUM(value) v FROM points WHERE ptype='day' AND metric IN ('l1m.leads','l1m.held') AND dim <> '' AND period >= ? AND period <= ? GROUP BY metric, dim", iso(monthStart), iso(yesterday)),
    q("SELECT metric, period, value, asof FROM points WHERE ptype='month' AND dim='' AND metric LIKE 'fun.%' AND period = ?", month),
    q("SELECT metric, value FROM plans WHERE ptype='month' AND dim='' AND metric LIKE 'fun.%' AND period = ?", month),
    q("SELECT metric, period, value, asof FROM points WHERE ptype='potok' AND metric IN ('pay.participants','pay.full','pay.prepaid','pay.receipts') AND asof = (SELECT MAX(asof) FROM points WHERE ptype='potok' AND metric='pay.participants') ORDER BY period"),
    q("SELECT dim, SUM(value) v FROM points WHERE ptype='day' AND metric='web.visits' AND period >= ? AND period <= ? GROUP BY dim", iso(monthStart), iso(yesterday)),
    q("SELECT id, name, definition FROM metrics ORDER BY id"),
    env.DB.prepare("SELECT title, text FROM knowledge ORDER BY id").all().then((r) => r.results || []).catch(() => []),
  ]);
  const byDay = {}; days.forEach((r) => { (byDay[r.metric] = byDay[r.metric] || {})[r.period] = r.value; });
  const sum = (m, a, b) => { let s = 0; for (let d = new Date(a); d <= b; d = addDays(d, 1)) s += (byDay[m] && byDay[m][iso(d)]) || 0; return s; };
  const lastDay = Object.keys(byDay["mkt.leads"] || {}).sort().pop() || iso(yesterday);
  const mtdDays = yesterday.getUTCDate();
  const pmEnd = new Date(Date.UTC(pmStart.getUTCFullYear(), pmStart.getUTCMonth(), Math.min(mtdDays, new Date(Date.UTC(pmStart.getUTCFullYear(), pmStart.getUTCMonth() + 1, 0)).getUTCDate())));
  // неделя как на страницах: с понедельника по вчера; прошлая — те же дни неделей раньше; полные недели пн–вс
  const dow = (yesterday.getUTCDay() + 6) % 7, wkStart = addDays(yesterday, -dow);
  const wk = (k) => k === 0 ? [wkStart, yesterday] : [addDays(wkStart, -7 * k), addDays(wkStart, -7 * k + 6)];
  const wkPrevSame = [addDays(wkStart, -7), addDays(yesterday, -7)];
  const L = [];
  L.push("ДАННЫЕ ПО " + dmy(lastDay) + "." + lastDay.slice(0, 4) + " (сегодня " + dmy(iso(today)) + "). Месяц = с 1-го числа по вчера; прошлый месяц взят по то же число.");
  L.push("Итоги по дням (все источники):");
  for (const m of DAY_METRICS) {
    const y = (byDay[m] && byDay[m][iso(yesterday)]) || 0;
    const [ws, we] = wk(0);
    L.push(`- ${NAMES[m]} [${m}]: вчера ${y}; неделя с ${dmy(iso(ws))} по ${dmy(iso(we))}: ${sum(m, ws, we)} (та же часть прошлой недели ${sum(m, wkPrevSame[0], wkPrevSame[1])}); месяц ${sum(m, monthStart, yesterday)} (прошлый месяц по то же число ${sum(m, pmStart, pmEnd)})`);
  }
  const mL = sum("mkt.leads", monthStart, yesterday), mQ = sum("mkt.qual", monthStart, yesterday), mB = sum("l1.booked", monthStart, yesterday), mH = sum("l2.held", monthStart, yesterday), mS = sum("l2.sales", monthStart, yesterday);
  L.push(`Конверсии за месяц (по датам событий, не когорта): лид→ЦА ${pct(mQ, mL)}, лид→назначено ${pct(mB, mL)}, назначено→проведено ${pct(mH, mB)}, проведено→продажа ${pct(mS, mH)}.`);
  L.push("Недели (пн–вс; первая — текущая, неполная; лиды / назначено / проведено / продажи), от свежей к старой:");
  for (let k = 0; k < 8; k++) { const [s, e] = wk(k); L.push(`- ${dmy(iso(s))}–${dmy(iso(e))}: ${sum("mkt.leads", s, e)} / ${sum("l1.booked", s, e)} / ${sum("l2.held", s, e)} / ${sum("l2.sales", s, e)}`); }
  if (srcs.length) L.push("Лиды по источникам за месяц: " + srcs.map((r) => `${r.dim} ${r.v}`).join(", ") + ".");
  const m2 = {}; mgr2.forEach((r) => { (m2[r.dim] = m2[r.dim] || {})[r.metric] = r.v; });
  if (Object.keys(m2).length) L.push("Вторая линия за месяц по менеджерам (проведено / продажи): " + Object.keys(m2).map((n) => `${n} ${m2[n]["l2.held"] || 0}/${m2[n]["l2.sales"] || 0}`).join(", ") + ".");
  const m1 = {}; mgr1.forEach((r) => { (m1[r.dim] = m1[r.dim] || {})[r.metric] = r.v; });
  if (Object.keys(m1).length) L.push("Первая линия за месяц по менеджерам (лиды / проведено встреч): " + Object.keys(m1).map((n) => `${n} ${m1[n]["l1m.leads"] || 0}/${m1[n]["l1m.held"] || 0}`).join(", ") + ".");
  if (fun.length) {
    const f = {}; fun.forEach((r) => { f[r.metric] = r.value; }); const p = {}; plans.forEach((r) => { p[r.metric] = r.value; });
    const dim = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate(), done = mtdDays;
    L.push(`План/факт воронки за ${month} из листа «Общ экран» (факт → план на месяц → прогноз при текущем темпе = факт/${done}×${dim}):`);
    for (const [id, name] of FUN) if (f[id] != null) L.push(`- ${name}: факт ${f[id]}, план ${p[id] ?? "—"}, прогноз ${Math.round(f[id] / done * dim)}${p[id] ? " (" + pct(Math.round(f[id] / done * dim), p[id]) + " плана)" : ""}`);
  }
  if (pay.length) {
    const byP = {}; pay.forEach((r) => { (byP[r.period] = byP[r.period] || {})[r.metric] = r.value; });
    L.push("Участники по потокам (снимок " + (pay[0].asof || "") + "; участники = полные + предоплаты; чек = прислали чек): " + Object.keys(byP).map((k) => `${k}: участников ${byP[k]["pay.participants"] ?? "—"}, полных ${byP[k]["pay.full"] ?? "—"}, предоплат ${byP[k]["pay.prepaid"] ?? "—"}, чеков ${byP[k]["pay.receipts"] ?? "—"}`).join("; ") + ".");
  }
  if (web.length) L.push("Визиты за месяц по Яндекс Метрике: " + web.map((r) => `${r.dim === "site" ? "сайт gitelman.team" : r.dim === "journal" ? "журнал" : r.dim} ${r.v}`).join(", ") + ".");
  const regText = reg.map((r) => `${r.id} — ${r.name}: ${r.definition}`).join("\n");
  const knowText = know.map((r) => `### ${r.title}\n${r.text}`).join("\n\n");
  return { data: L.join("\n"), reg: regText, know: knowText };
}

const SYSTEM = `Ты — помощник «Штаба», внутреннего центра показателей компании Gitelman Team (обучение предпринимателей: лиды из маркетинга → квалификация Первой линией → диагностика Второй линией → продажа → участие в потоке).
Отвечай по-русски, коротко и по делу, без вступлений. Цифры бери только из блока ДАННЫЕ и всегда называй период («за сентябрь по 09.09», «за неделю 07–13.09»).
Если в данных нужного нет — так и скажи и подскажи, на какой странице Штаба это смотреть (см. КАРТА РАЗДЕЛОВ). Не выдумывай цифры и имена.
На общие вопросы (не про данные компании) отвечать можно — как обычный ассистент, кратко.
Формат: обычный текст, короткие абзацы или список через «- »; без заголовков и таблиц.`;

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return bad("нужен вопрос");
  const d = await digest(env);
  const system = SYSTEM + "\n\n=== ДАННЫЕ ===\n" + d.data + "\n\n=== ОПРЕДЕЛЕНИЯ ПОКАЗАТЕЛЕЙ ===\n" + d.reg + (d.know ? "\n\n=== СПРАВКА ===\n" + d.know : "");
  let answer;
  try {
    const r = await llmChat(env, [{ role: "system", content: system }, ...msgs], { max_tokens: 1200, temperature: 0.3 });
    answer = r.text;
  } catch (e) {
    await audit(env, user.login, "chat.fail", msgs[msgs.length - 1].content.slice(0, 120), String(e.message || e).slice(0, 200));
    return bad("модель не ответила: " + (e.message || e), 502);
  }
  await audit(env, user.login, "chat.ask", msgs[msgs.length - 1].content.slice(0, 200));
  return json({ ok: true, answer: String(answer || "").trim() });
}
