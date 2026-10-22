// Задачи между сотрудниками (как в Битрикс): постановщик, исполнитель, наблюдатели, срок, статусы, комментарии.
// Видят задачу постановщик, исполнитель, наблюдатели и руководители любого из первых двух по структуре HR; админ — все.
//   GET  /api/tasks               — {me, people, team, tasks}; закрытые старше 30 дней — только с ?archive=1
//   GET  /api/tasks?id=N          — {task, watchers, log, actions}
//   POST /api/tasks {action:…}:
//     create  {title, body, assignee, due, important, watchers[]}
//     edit    {id, title, body, assignee, due, important, watchers[]}   — постановщик или админ
//     status  {id, to, text?}  — переходы см. allowed(); text уходит в ленту комментарием
//     comment {id, text}       — любой, кто видит задачу
// Статусы: new ждёт → work в работе → review на контроле (если ставил другой) → done; deferred отложена; cancelled отменена.
import { json, bad, currentUser, isAdmin, audit, now } from "../_lib.js";
import { STATUS, OPEN, today, cleanDue, dueText, loadPeople, teamOf, roleIn, link, notify } from "./_tasks.js";

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

async function who(request, env) {
  const user = await currentUser(request, env);
  if (!user) return null;
  return user;
}

async function watchersOf(env, ids) {
  if (!ids.length) return {};
  const r = await env.DB.prepare("SELECT task, login FROM task_watchers WHERE task IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all();
  const out = {}; for (const w of r.results || []) (out[w.task] = out[w.task] || []).push(w.login);
  return out;
}

// какие переходы доступны человеку; boss = постановщик или админ, doer = исполнитель
function allowed(t, boss, doer) {
  const self = t.author === t.assignee;
  const out = [];
  const add = (to, label) => out.push({ to, label });
  if (t.status === "new" && doer) add("work", "Начать");
  if ((t.status === "new" || t.status === "work") && doer) add(self ? "done" : "review", self ? "Готово" : "Сдать на проверку");
  if (t.status === "review" && boss) { add("done", "Принять"); add("work", "Вернуть на доработку"); }
  if ((t.status === "new" || t.status === "work") && boss && !doer) add("done", "Закрыть");
  if ((t.status === "new" || t.status === "work") && (doer || boss)) add("deferred", "Отложить");
  if (t.status === "deferred" && (doer || boss)) add("work", "Вернуть в работу");
  if (t.status === "done" && boss) add("work", "Возобновить");
  if (OPEN.includes(t.status) && boss) add("cancelled", "Отменить");
  return out;
}

export async function onRequestGet({ request, env }) {
  const user = await who(request, env);
  if (!user) return bad("задачи доступны только с личным входом", 401);
  const url = new URL(request.url);
  const admin = isAdmin(user);
  const { people, hr, depts } = await loadPeople(env);
  const team = teamOf(user.login, hr, depts);
  const id = Number(url.searchParams.get("id") || 0);

  if (id) {
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    if (!t) return bad("задачи нет", 404);
    const w = (await watchersOf(env, [id]))[id] || [];
    const role = roleIn(t, user.login, w, team, admin);
    if (!role) return bad("задача закрыта для вас", 403);
    const log = await env.DB.prepare("SELECT id, at, login, kind, text FROM task_log WHERE task = ? ORDER BY id").bind(id).all();
    const boss = t.author === user.login || admin, doer = t.assignee === user.login;
    return json({ ok: true, task: Object.assign(t, { watchers: w, role }), log: log.results || [], actions: allowed(t, boss, doer), can_edit: boss });
  }

  const archive = url.searchParams.get("archive") === "1";
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const closed = archive ? "" : " AND (t.status NOT IN ('done', 'cancelled') OR t.updated_at >= ?)";
  let sql, binds;
  if (admin) {
    sql = "SELECT t.* FROM tasks t WHERE 1 = 1" + closed; binds = archive ? [] : [since];
  } else {
    const t = JSON.stringify(team);
    sql = "SELECT t.* FROM tasks t WHERE (t.author = ? OR t.assignee = ?"
      + " OR t.id IN (SELECT task FROM task_watchers WHERE login = ?)"
      + " OR t.assignee IN (SELECT value FROM json_each(?)) OR t.author IN (SELECT value FROM json_each(?)))" + closed;
    binds = [user.login, user.login, user.login, t, t].concat(archive ? [] : [since]);
  }
  const rows = (await env.DB.prepare(sql + " ORDER BY t.id DESC LIMIT 1000").bind(...binds).all()).results || [];
  const w = await watchersOf(env, rows.map((t) => t.id));
  const tasks = rows.map((t) => Object.assign(t, { watchers: w[t.id] || [], role: roleIn(t, user.login, w[t.id] || [], team, admin) }));
  return json({
    ok: true, me: { login: user.login, admin }, today: today(), statuses: STATUS, team,
    people: people.map((p) => ({ login: p.login, name: p.name, position: p.position, dept: p.dept, tg: p.tg })),
    depts: depts.map((d) => ({ id: d.id, name: d.name, parent: d.parent })),
    tasks,
  });
}

export async function onRequestPost({ request, env }) {
  const user = await who(request, env);
  if (!user) return bad("задачи доступны только с личным входом", 401);
  const b = await request.json().catch(() => null);
  if (!b || !b.action) return bad("нужен action");
  const origin = new URL(request.url).origin;
  const admin = isAdmin(user);
  const { people, hr, depts } = await loadPeople(env);
  const byLogin = {}; for (const p of people) byLogin[p.login] = p;
  const nm = (l) => (byLogin[l] && byLogin[l].name) || l;
  const at = now();
  const log = (id, kind, text) => env.DB.prepare("INSERT INTO task_log (task, at, login, kind, text) VALUES (?,?,?,?,?)").bind(id, at, user.login, kind, text || "").run();
  const cleanWatchers = (list, t) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((l) => byLogin[l] && l !== t.author && l !== t.assignee).slice(0, 20);
  const setWatchers = async (id, list) => {
    await env.DB.prepare("DELETE FROM task_watchers WHERE task = ?").bind(id).run();
    for (const l of list) await env.DB.prepare("INSERT OR IGNORE INTO task_watchers (task, login) VALUES (?,?)").bind(id, l).run();
  };

  if (b.action === "create") {
    const title = str(b.title, 200), body = str(b.body, 5000), assignee = str(b.assignee, 40) || user.login;
    const due = cleanDue(b.due);
    if (!title) return bad("нужно название");
    if (!byLogin[assignee]) return bad("исполнителя нет среди пользователей Штаба");
    if (due === null) return bad("срок в формате ГГГГ-ММ-ДД");
    const r = await env.DB.prepare(
      "INSERT INTO tasks (title, body, author, assignee, due, important, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'new',?,?)"
    ).bind(title, body, user.login, assignee, due || null, b.important ? 1 : 0, at, at).run();
    const id = r.meta.last_row_id;
    const t = { id, author: user.login, assignee };
    const watchers = cleanWatchers(b.watchers, t);
    await setWatchers(id, watchers);
    await log(id, "create", "");
    await audit(env, user.login, "task.create", String(id), title);
    const msg = (to) => `${to}: ${title}\nСрок: ${dueText(due)}${b.important ? " · важная" : ""}\nПоставил: ${nm(user.login)}\n${link(origin, id)}`;
    if (assignee !== user.login) await notify(env, people, [assignee], msg("Новая задача"));
    await notify(env, people, watchers, msg("Вы наблюдатель в задаче"));
    return json({ ok: true, id });
  }

  const id = Number(b.id || 0);
  const t = id && await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!t) return bad("задачи нет", 404);
  const w = (await watchersOf(env, [id]))[id] || [];
  const role = roleIn(t, user.login, w, teamOf(user.login, hr, depts), admin);
  if (!role) return bad("задача закрыта для вас", 403);
  const boss = t.author === user.login || admin, doer = t.assignee === user.login;
  const others = (extra = []) => [t.author, t.assignee, ...w, ...extra].filter((l) => l && l !== user.login);
  const head = `«${t.title}»`;

  if (b.action === "comment") {
    const text = str(b.text, 3000);
    if (!text) return bad("пустой комментарий");
    await log(id, "comment", text);
    await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(at, id).run();
    await notify(env, people, others(), `${nm(user.login)} в задаче ${head}:\n${text.slice(0, 600)}\n${link(origin, id)}`);
    return json({ ok: true });
  }

  if (b.action === "status") {
    const to = String(b.to || "");
    if (!allowed(t, boss, doer).some((a) => a.to === to)) return bad("так задачу сейчас не перевести");
    const text = str(b.text, 3000);
    await env.DB.prepare("UPDATE tasks SET status = ?, updated_at = ?, done_at = ? WHERE id = ?")
      .bind(to, at, to === "done" ? at : null, id).run();
    await log(id, "status", t.status + ">" + to);
    if (text) await log(id, "comment", text);
    await audit(env, user.login, "task.status", String(id), t.status + ">" + to);
    const tail = (text ? "\n" + text.slice(0, 600) : "") + "\n" + link(origin, id);
    let msg = "";
    if (to === "review") msg = `Сдана на проверку: ${head}\nИсполнитель: ${nm(t.assignee)}. Примите или верните на доработку.`;
    else if (to === "done" && t.status === "review") msg = `Принята: ${head}`;
    else if (to === "done") msg = `Готово: ${head} (${nm(user.login)})`;
    else if (to === "work" && t.status === "review") msg = `Вернули на доработку: ${head}`;
    else if (to === "work" && t.status === "done") msg = `Возобновлена: ${head}`;
    else if (to === "work" && t.status === "new") msg = `Взята в работу: ${head}`;
    else if (to === "work") msg = `Снова в работе: ${head}`;
    else if (to === "deferred") msg = `Отложена: ${head} (${nm(user.login)})`;
    else if (to === "cancelled") msg = `Отменена: ${head} (${nm(user.login)})`;
    // начало работы постановщику не шлём, чтобы не шуметь; наблюдателям — только итог (готово, отменена)
    const pair = [t.author, t.assignee].filter((l) => l !== user.login);
    if (msg && !(to === "work" && t.status === "new")) await notify(env, people, to === "done" || to === "cancelled" ? others() : pair, msg + tail);
    return json({ ok: true });
  }

  if (b.action === "edit") {
    if (!boss) return bad("менять задачу может постановщик");
    const title = str(b.title, 200) || t.title, body = b.body == null ? t.body : str(b.body, 5000);
    const assignee = str(b.assignee, 40) || t.assignee;
    const due = b.due === undefined ? (t.due || "") : cleanDue(b.due);
    if (!byLogin[assignee]) return bad("исполнителя нет среди пользователей Штаба");
    if (due === null) return bad("срок в формате ГГГГ-ММ-ДД");
    const changes = [];
    if (title !== t.title) changes.push("название");
    if (body !== t.body) changes.push("описание");
    if ((due || "") !== (t.due || "")) changes.push("срок: " + dueText(t.due) + " → " + dueText(due));
    if (assignee !== t.assignee) changes.push("исполнитель: " + nm(t.assignee) + " → " + nm(assignee));
    if (!!b.important !== !!t.important) changes.push(b.important ? "важная" : "обычная");
    await env.DB.prepare("UPDATE tasks SET title = ?, body = ?, assignee = ?, due = ?, important = ?, updated_at = ?, reminded = ? WHERE id = ?")
      .bind(title, body, assignee, due || null, b.important ? 1 : 0, at, (due || "") !== (t.due || "") ? "" : t.reminded, id).run();
    const nt = Object.assign({}, t, { assignee });
    const watchers = b.watchers ? cleanWatchers(b.watchers, nt) : w.filter((l) => l !== assignee);
    await setWatchers(id, watchers);
    if (changes.length) await log(id, "edit", changes.join("; "));
    if (assignee !== t.assignee) {
      await notify(env, people, [assignee].filter((l) => l !== user.login), `Вам передали задачу: «${title}»\nСрок: ${dueText(due)}\nПоставил: ${nm(t.author)}\n${link(origin, id)}`);
      await notify(env, people, [t.assignee].filter((l) => l !== user.login), `Задачу «${title}» передали другому исполнителю: ${nm(assignee)}`);
    } else if ((due || "") !== (t.due || "")) {
      await notify(env, people, [assignee].filter((l) => l !== user.login), `Новый срок задачи «${title}»: ${dueText(due)}\n${link(origin, id)}`);
    }
    return json({ ok: true });
  }

  return bad("неизвестное действие");
}
