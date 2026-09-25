// GET /api/okna?day=YYYY-MM-DD — окна менеджеров Первой линии на день (все менеджеры сразу: в окне видны цифры коллег).
// Без day — последний собранный день. Ответ: {ok, day, days:[...последние дни], rows:[{mgr,key,n,items}], goals:[{mgr,month,goal,base,rate,note}]}
// POST /api/okna {mgr, month, goal, base?, rate?, note?} — цель на месяц (право редактирования Первой линии).
import { json, bad, canRead, level, now, audit } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l1") < 1) return bad("нет доступа", 401);
  const u = new URL(request.url);
  let day = u.searchParams.get("day") || "";
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return bad("day: YYYY-MM-DD");
  const dl = await env.DB.prepare("SELECT day FROM okna GROUP BY day ORDER BY day DESC LIMIT 40").all();
  const days = (dl.results || []).map((r) => r.day);
  if (!day) day = days[0] || "";
  if (!day) return json({ ok: true, day: "", days, rows: [], goals: [] });
  const rows = await env.DB.prepare("SELECT mgr, key, n, items, updated_at FROM okna WHERE day = ? ORDER BY mgr, key").bind(day).all();
  const out = (rows.results || []).map((r) => {
    let items = [];
    try { items = JSON.parse(r.items || "[]"); } catch (e) { items = []; }
    return { mgr: r.mgr, key: r.key, n: r.n, items, updated_at: r.updated_at };
  });
  const month = day.slice(0, 7);
  const gl = await env.DB.prepare("SELECT mgr, month, goal, base, rate, note FROM okna_goals WHERE month <= ? ORDER BY month DESC LIMIT 40").bind(month).all();
  return json({ ok: true, day, days, rows: out, goals: gl.results || [] });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l1") < 2) return bad("нет доступа", 401);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const mgr = String(b.mgr || "").trim().slice(0, 40), month = String(b.month || "");
  const goal = Number(b.goal);
  if (!mgr || !/^\d{4}-\d{2}$/.test(month) || !isFinite(goal) || goal <= 0) return bad("нужны mgr, month, goal");
  await env.DB.prepare(
    "INSERT INTO okna_goals (mgr, month, goal, base, rate, note, set_by, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(mgr, month) DO UPDATE SET goal = excluded.goal, base = excluded.base, rate = excluded.rate, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at")
    .bind(mgr, month, goal, Number(b.base) || 25000, Number(b.rate) || 1500, String(b.note || "").slice(0, 200), user.login, now()).run();
  await audit(env, user.login, "okna.goal", mgr + " " + month, String(goal));
  return json({ ok: true });
}
