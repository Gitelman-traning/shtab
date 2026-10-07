// HR · Отпуска и больничные.
//   GET  /api/hr/leave — всем: кто отсутствует сейчас и в ближайшие 60 дней («в отпуске» / «отсутствует», без причин);
//        сотруднику HR: все записи, больничные и остатки отпуска по каждому.
//   POST /api/hr/leave {action:"add", person, kind, date_from, date_to, days?, note} | {action:"del", id} — только HR
import { json, bad, canRead, canView, audit, now } from "../_lib.js";
import { isHR, today, addDays, daysBetween, cleanDate, balance } from "./_hr.js";

const KINDS = ["vacation", "sick", "unpaid"];

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, "hr.leave")) return bad("раздел закрыт", 403);
  const hr = isHR(user), day = today();
  const people = (await env.DB.prepare("SELECT id, name, position, dept, status, hired, leave_year, leave_adj FROM hr_people" + (hr ? "" : " WHERE status = 'active'") + " ORDER BY name").all()).results || [];
  const depts = (await env.DB.prepare("SELECT id, name FROM hr_depts").all()).results || [];
  if (!hr) {
    const rows = (await env.DB.prepare("SELECT person, kind, date_from, date_to FROM hr_leave WHERE date_to >= ? AND date_from <= ? ORDER BY date_from")
      .bind(day, addDays(day, 60)).all()).results || [];
    const ids = new Set(people.map((p) => p.id));
    const away = rows.filter((r) => ids.has(r.person))
      .map((r) => ({ person: r.person, kind: r.kind === "vacation" ? "vacation" : "away", date_from: r.date_from, date_to: r.date_to }));
    return json({ ok: true, is_hr: false, today: day, people: people.map(({ id, name, position, dept }) => ({ id, name, position, dept })), depts, away });
  }
  const leaves = (await env.DB.prepare("SELECT id, person, kind, date_from, date_to, days, note, created_by FROM hr_leave ORDER BY date_from DESC").all()).results || [];
  const away = leaves.filter((r) => r.date_to >= day && r.date_from <= addDays(day, 60))
    .map((r) => ({ person: r.person, kind: r.kind, date_from: r.date_from, date_to: r.date_to }))
    .sort((a, b) => a.date_from.localeCompare(b.date_from));
  for (const p of people) p.balance = balance(p, leaves, day);
  return json({ ok: true, is_hr: true, today: day, people, depts, away, leaves });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!isHR(user)) return bad("отпуска ведут сотрудники HR", 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  if (body.action === "del") {
    const id = parseInt(body.id, 10);
    if (!id) return bad("нет id");
    await env.DB.prepare("DELETE FROM hr_leave WHERE id = ?").bind(id).run();
    await audit(env, user.login, "hr.leave_del", String(id));
    return json({ ok: true });
  }
  if (body.action !== "add") return bad("неизвестное действие");
  const person = parseInt(body.person, 10);
  const p = person ? await env.DB.prepare("SELECT id FROM hr_people WHERE id = ?").bind(person).first() : null;
  if (!p) return bad("выберите сотрудника");
  const kind = KINDS.includes(body.kind) ? body.kind : "vacation";
  const from = cleanDate(body.date_from, false), to = cleanDate(body.date_to, false);
  if (!from || !to) return bad("укажите даты начала и конца");
  if (to < from) return bad("конец раньше начала");
  const cal = daysBetween(from, to) + 1;
  const days = body.days === "" || body.days == null ? cal : Number(body.days);
  if (!(days >= 0) || days > 366) return bad("дней: от 0 до 366");
  const r = await env.DB.prepare("INSERT INTO hr_leave (person, kind, date_from, date_to, days, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(person, kind, from, to, days, String(body.note || "").trim().slice(0, 200), user.login, now()).run();
  await audit(env, user.login, "hr.leave_add", String(person), kind + " " + from + "…" + to);
  return json({ ok: true, id: r.meta && r.meta.last_row_id });
}
