// Бюджет и расходы проекта — только администратор.
//   GET    /api/budget?from=YYYY-MM-DD&to=YYYY-MM-DD   — строки расходов за период + план по сервисам + итоги по месяцам (12 мес.)
//   POST   /api/budget {day, service, item, kind, amount, currency, amount_orig, note}  — добавить строку руками
//   POST   /api/budget {plan: {service, monthly_rub, kind, note}}                        — план/лимит по сервису
//   DELETE /api/budget?id=N                                                              — удалить строку (ручные и импортированные)
import { json, bad, canRead, isAdmin, audit, now } from "./_lib.js";

async function gate(request, env) {
  const user = await canRead(request, env);
  return user && isAdmin(user) && user.login !== "collector" ? user : null;
}

export async function onRequestGet({ request, env }) {
  const me = await gate(request, env);
  if (!me) return bad("только для администратора", 403);
  const u = new URL(request.url);
  const to = u.searchParams.get("to") || new Date().toISOString().slice(0, 10);
  const from = u.searchParams.get("from") || (to.slice(0, 7) + "-01");
  const rows = await env.DB.prepare(
    "SELECT id, day, service, item, kind, amount, currency, amount_orig, qty, note, source, created_by FROM expenses WHERE day >= ? AND day <= ? ORDER BY day DESC, id DESC LIMIT 2000")
    .bind(from, to).all();
  const plan = await env.DB.prepare("SELECT service, monthly_rub, kind, note, updated_at FROM budget_plan ORDER BY kind, service").all();
  const yearAgo = new Date(Date.now() - 370 * 864e5).toISOString().slice(0, 10);
  const months = await env.DB.prepare(
    "SELECT substr(day,1,7) AS month, service, kind, SUM(amount) AS amount, COUNT(*) AS n FROM expenses WHERE day >= ? GROUP BY month, service, kind ORDER BY month")
    .bind(yearAgo).all();
  return json({ ok: true, from, to, rows: rows.results || [], plan: plan.results || [], months: months.results || [] });
}

export async function onRequestPost({ request, env }) {
  const me = await gate(request, env);
  if (!me) return bad("только для администратора", 403);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  if (b.plan) {
    const p = b.plan, service = String(p.service || "").trim().slice(0, 60), v = Number(p.monthly_rub);
    if (!service || !isFinite(v) || v < 0) return bad("нужны service и monthly_rub");
    await env.DB.prepare("INSERT INTO budget_plan (service, monthly_rub, kind, note, updated_by, updated_at) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(service) DO UPDATE SET monthly_rub = excluded.monthly_rub, kind = excluded.kind, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .bind(service, v, p.kind === "fixed" ? "fixed" : "limit", String(p.note || "").slice(0, 300), me.login, now()).run();
    await audit(env, me.login, "budget.plan", service, String(v));
    return json({ ok: true });
  }
  const day = String(b.day || ""), service = String(b.service || "").trim().slice(0, 60), amount = Number(b.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !service || !isFinite(amount)) return bad("нужны day, service, amount");
  const kind = ["spend", "topup", "fixed"].includes(b.kind) ? b.kind : "spend";
  const r = await env.DB.prepare(
    "INSERT INTO expenses (day, service, item, kind, amount, currency, amount_orig, qty, note, source, ref, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,'manual',NULL,?,?)")
    .bind(day, service, String(b.item || "").slice(0, 200), kind, amount, String(b.currency || "RUB").slice(0, 8),
      b.amount_orig == null || b.amount_orig === "" ? null : Number(b.amount_orig), b.qty == null || b.qty === "" ? null : Number(b.qty),
      String(b.note || "").slice(0, 500), me.login, now()).run();
  await audit(env, me.login, "budget.add", service + " " + day, String(amount));
  return json({ ok: true, id: r.meta && r.meta.last_row_id });
}

export async function onRequestDelete({ request, env }) {
  const me = await gate(request, env);
  if (!me) return bad("только для администратора", 403);
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!id) return bad("нужен id");
  const row = await env.DB.prepare("SELECT service, day, amount FROM expenses WHERE id = ?").bind(id).first();
  if (!row) return bad("нет такой строки", 404);
  await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  await audit(env, me.login, "budget.delete", row.service + " " + row.day, String(row.amount));
  return json({ ok: true });
}
