// Утренние напоминания по задачам (GitHub Actions tasks-remind.yml, будни 09:00 МСК), по токену сборщика.
//   POST /api/tasks/remind        — разослать; ?dry=1 — только показать тексты
// Исполнителю — одно сообщение: просрочено, срок сегодня, срок завтра.
// Постановщику — задачи, которые ждут его проверки, и чужие задачи, просроченные со вчерашнего дня (один раз на задачу).
import { json, bad, hasIngestToken } from "../_lib.js";
import { today, addDays, dueText, loadPeople, link, notify } from "./_tasks.js";

export async function onRequestPost({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  const url = new URL(request.url);
  const dry = url.searchParams.get("dry") === "1";
  const t0 = today(), t1 = addDays(t0, 1);
  const { people } = await loadPeople(env);
  const byLogin = {}; for (const p of people) byLogin[p.login] = p;
  const nm = (l) => (byLogin[l] && byLogin[l].name) || l;
  const rows = (await env.DB.prepare(
    "SELECT id, title, author, assignee, due, status, reminded FROM tasks WHERE status IN ('new', 'work', 'review')"
  ).all()).results || [];

  const box = {};   // login → {late:[], today:[], tomorrow:[], check:[], lateOthers:[]}
  const get = (l) => (box[l] = box[l] || { late: [], today: [], tomorrow: [], check: [], lateOthers: [] });
  const markLate = [];
  for (const t of rows) {
    if (t.status === "review") { if (t.author !== t.assignee) get(t.author).check.push(t); continue; }
    if (!t.due) continue;
    const d = t.due.slice(0, 10);
    if (d < t0) {
      get(t.assignee).late.push(t);
      if (t.author !== t.assignee && !String(t.reminded).includes("late")) { get(t.author).lateOthers.push(t); markLate.push(t.id); }
    } else if (d === t0) get(t.assignee).today.push(t);
    else if (d === t1) get(t.assignee).tomorrow.push(t);
  }

  const origin = url.origin;
  const line = (t, who) => `• ${t.title}${who ? " — " + nm(who) : ""} (${dueText(t.due)})\n  ${link(origin, t.id)}`;
  const out = [];
  for (const [login, b] of Object.entries(box)) {
    const parts = [];
    if (b.late.length) parts.push("Просрочено:\n" + b.late.map((t) => line(t)).join("\n"));
    if (b.today.length) parts.push("Срок сегодня:\n" + b.today.map((t) => line(t)).join("\n"));
    if (b.tomorrow.length) parts.push("Срок завтра:\n" + b.tomorrow.map((t) => line(t)).join("\n"));
    if (b.check.length) parts.push("Ждут вашей проверки:\n" + b.check.map((t) => `• ${t.title} — ${nm(t.assignee)}\n  ${link(origin, t.id)}`).join("\n"));
    if (b.lateOthers.length) parts.push("Просрочены у исполнителей:\n" + b.lateOthers.map((t) => line(t, t.assignee)).join("\n"));
    if (!parts.length) continue;
    const text = "Задачи на " + dueText(t0) + "\n\n" + parts.join("\n\n");
    const sent = dry ? [] : await notify(env, people, [login], text);
    out.push({ login, tg: !!(byLogin[login] && byLogin[login].tg), sent: sent.length > 0, text: dry ? text : undefined });
  }
  if (!dry) for (const id of markLate) await env.DB.prepare("UPDATE tasks SET reminded = reminded || ',late' WHERE id = ?").bind(id).run();
  return json({ ok: true, dry, date: t0, people: out.length, sent: out.filter((x) => x.sent).length, out });
}
