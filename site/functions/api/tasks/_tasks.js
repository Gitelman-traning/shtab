// Общее для задач: люди Штаба, подчинённые по структуре HR, права на задачу, уведомления в Telegram.
import { tgSend } from "../_lib.js";

export const STATUS = { new: "Ждёт", work: "В работе", review: "На контроле", done: "Готово", deferred: "Отложена", cancelled: "Отменена" };
export const OPEN = ["new", "work", "review", "deferred"];

// сегодня по Москве, ГГГГ-ММ-ДД
export function today() {
  return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// «8 октября» или «8 октября, 15:00»
export function dueText(due) {
  if (!due) return "без срока";
  const s = +due.slice(8, 10) + " " + MON[+due.slice(5, 7) - 1];
  return due.length > 10 ? s + ", " + due.slice(11, 16) : s;
}
// срок: ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ; пусто — без срока; иначе null (ошибка)
export function cleanDue(v) {
  const s = String(v || "").trim().replace(" ", "T");
  if (!s) return "";
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s) ? s : null;
}

// все, у кого есть вход в Штаб: имя из структуры HR (если человек там есть), должность, отдел, Telegram
export async function loadPeople(env) {
  const users = await env.DB.prepare(
    "SELECT login, name, tg_id FROM users WHERE active = 1 AND role != 'pending' AND login NOT IN ('collector', 'shared')"
  ).all();
  let hr = { results: [] }, depts = { results: [] };
  try {
    hr = await env.DB.prepare("SELECT id, name, position, dept, manager, login, status FROM hr_people").all();
    depts = await env.DB.prepare("SELECT id, name, parent, head FROM hr_depts").all();
  } catch (e) { /* структуры ещё нет — работаем без неё */ }
  const byLogin = {};
  for (const p of hr.results || []) if (p.login && p.status === "active") byLogin[p.login.toLowerCase()] = p;
  const people = (users.results || []).map((u) => {
    const h = byLogin[u.login.toLowerCase()];
    return { login: u.login, name: (h && h.name) || u.name || u.login, position: (h && h.position) || "", dept: (h && h.dept) || "", tg: !!u.tg_id, tg_id: u.tg_id || null };
  }).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return { people, hr: hr.results || [], depts: depts.results || [] };
}

// логины всех, кто ниже человека по структуре: прямые подчинённые и люди отделов (с подотделами), которыми он руководит,
// дальше их подчинённые и т. д.
export function teamOf(login, hr, depts) {
  const me = hr.find((p) => p.login && p.login.toLowerCase() === String(login).toLowerCase() && p.status === "active");
  if (!me) return [];
  const kids = (id) => depts.filter((d) => (d.parent || "") === id);
  const seen = new Set([me.id]), queue = [me.id], out = new Set();
  while (queue.length) {
    const pid = queue.shift();
    const below = hr.filter((p) => p.manager === pid);
    const led = []; const walk = (d) => { led.push(d.id); kids(d.id).forEach(walk); };
    depts.filter((d) => d.head === pid).forEach(walk);
    for (const p of hr) if (led.includes(p.dept)) below.push(p);
    for (const p of below) {
      if (seen.has(p.id) || p.status !== "active") continue;
      seen.add(p.id); queue.push(p.id);
      if (p.login) out.add(p.login);
    }
  }
  return [...out];
}

// роль человека в задаче: author · assignee · watcher · lead (руководитель участника) · admin; null — не видит
export function roleIn(task, login, watchers, team, admin) {
  if (task.author === login) return "author";
  if (task.assignee === login) return "assignee";
  if (watchers.includes(login)) return "watcher";
  if (team.includes(task.assignee) || team.includes(task.author)) return "lead";
  if (admin) return "admin";
  return null;
}

export function link(origin, id) {
  return origin + "/tasks/?t=" + id;
}

// уведомление участникам; кому нет Telegram — молча пропускаем
export async function notify(env, people, logins, text) {
  const tg = {}; for (const p of people) if (p.tg_id) tg[p.login] = p.tg_id;
  const sent = [];
  for (const l of [...new Set(logins)]) if (tg[l] && await tgSend(env, tg[l], text)) sent.push(l);
  return sent;
}
