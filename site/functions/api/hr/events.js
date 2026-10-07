// HR · Праздники: GET /api/hr/events?days=30 — дни рождения и годовщины в компании; дети сотрудников — только для HR
import { json, bad, canRead, canView } from "../_lib.js";
import { isHR, today, upcoming } from "./_hr.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, "hr.events")) return bad("раздел закрыт", 403);
  const days = Math.min(366, Math.max(1, parseInt(new URL(request.url).searchParams.get("days"), 10) || 30));
  const hr = isHR(user);
  const people = (await env.DB.prepare("SELECT id, name, position, dept, status, birth, hired FROM hr_people WHERE status = 'active'").all()).results || [];
  const children = hr ? ((await env.DB.prepare("SELECT person, name, birth FROM hr_children").all()).results || []) : [];
  const from = today();
  const byId = {}; for (const p of people) byId[p.id] = p;
  const events = upcoming(people, children, from, days, hr).map((e) => Object.assign(e, { position: byId[e.person].position, dept: byId[e.person].dept }));
  const depts = (await env.DB.prepare("SELECT id, name FROM hr_depts").all()).results || [];
  return json({ ok: true, today: from, days, is_hr: hr, events, depts });
}
