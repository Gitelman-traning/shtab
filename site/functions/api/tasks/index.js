// Задачи между сотрудниками (как в Битрикс): постановщик, исполнитель, наблюдатели, срок, статусы, комментарии.
// Видят задачу постановщик, исполнитель, наблюдатели, участники её проекта и руководители постановщика или исполнителя
// по структуре HR; админ — все. Участники проекта — наблюдатели всех его задач, пока сами не выйдут (миграция 32).
//   GET  /api/tasks               — {me, people, team, projects, tasks}; закрытые старше 30 дней — только с ?archive=1
//   GET  /api/tasks?id=N          — {task, log, actions, parent, subtasks}
//   POST /api/tasks {action:…}:
//     create  {title, body, assignee, due, important, watchers[], project?, parent?}  — подзадача берёт проект родителя
//     edit    {id, title, body, assignee, due, important, watchers[], project?}   — постановщик или админ
//     status  {id, to, text?}  — переходы см. allowed(); text уходит в ленту комментарием
//     comment {id, text}       — любой, кто видит задачу
//     unwatch {id} / watch {id} — выйти из наблюдения / снова наблюдать
//     project {pid?, name, about, members[], archived}  — завести или изменить проект, только админ
// Статусы: new ждёт → work в работе → review на контроле (если ставил другой) → done; deferred отложена; cancelled отменена.
import { json, bad, currentUser, isAdmin, audit, now } from "../_lib.js";
import { STATUS, OPEN, today, cleanDue, dueText, loadPeople, teamOf, roleIn, loadProjects, watchMap, link, notify } from "./_tasks.js";

const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

async function who(request, env) {
  const user = await currentUser(request, env);
  if (!user) return null;
  return user;
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
  const { projects, members } = await loadProjects(env);
  const id = Number(url.searchParams.get("id") || 0);

  if (id) {
    const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    if (!t) return bad("задачи нет", 404);
    const w = (await watchMap(env, [t], members))[id];
    const role = roleIn(t, user.login, w.all, team, admin, members);
    if (!role) return bad("задача закрыта для вас", 403);
    const log = await env.DB.prepare("SELECT id, at, login, kind, text FROM task_log WHERE task = ? ORDER BY id").bind(id).all();
    const subs = await env.DB.prepare("SELECT id, title, author, assignee, due, important, status FROM tasks WHERE parent = ? ORDER BY id").bind(id).all();
    const parent = t.parent ? await env.DB.prepare("SELECT id, title, status FROM tasks WHERE id = ?").bind(t.parent).first() : null;
    const files = await env.DB.prepare("SELECT id, login, at, name, size FROM task_files WHERE task = ? ORDER BY id").bind(id).all();
    const boss = t.author === user.login || admin, doer = t.assignee === user.login;
    const watching = w.all.includes(user.login);
    return json({
      ok: true, task: Object.assign(t, { watchers: w.all, own_watchers: w.own, role }), log: log.results || [],
      actions: allowed(t, boss, doer), can_edit: boss, parent, subtasks: subs.results || [], files: files.results || [],
      can_unwatch: watching, can_watch: !watching && t.author !== user.login && t.assignee !== user.login,
    });
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
      + " OR t.project IN (SELECT project FROM task_project_members WHERE login = ?)"
      + " OR t.assignee IN (SELECT value FROM json_each(?)) OR t.author IN (SELECT value FROM json_each(?)))" + closed;
    binds = [user.login, user.login, user.login, user.login, t, t].concat(archive ? [] : [since]);
  }
  const rows = (await env.DB.prepare(sql + " ORDER BY t.id DESC LIMIT 1000").bind(...binds).all()).results || [];
  const w = await watchMap(env, rows, members);
  // прогресс подзадач: сколько всего (без отменённых) и сколько готово — одним GROUP BY
  const parents = rows.filter((t) => !t.parent).map((t) => t.id);
  const prog = {};
  if (parents.length) {
    const r = await env.DB.prepare("SELECT parent, COUNT(*) AS n, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS d FROM tasks"
      + " WHERE parent IN (SELECT value FROM json_each(?)) AND status != 'cancelled' GROUP BY parent").bind(JSON.stringify(parents)).all();
    for (const x of r.results || []) prog[x.parent] = { n: x.n, done: x.d };
  }
  // сколько скриншотов у задачи
  const nf = {};
  if (rows.length) {
    const r = await env.DB.prepare("SELECT task, COUNT(*) AS n FROM task_files WHERE task IN (SELECT value FROM json_each(?)) GROUP BY task").bind(JSON.stringify(rows.map((t) => t.id))).all();
    for (const x of r.results || []) nf[x.task] = x.n;
  }
  const tasks = rows.map((t) => Object.assign(t, { watchers: w[t.id].all, role: roleIn(t, user.login, w[t.id].all, team, admin, members), subs: prog[t.id] || null, files: nf[t.id] || 0 }));
  return json({
    ok: true, me: { login: user.login, admin }, today: today(), statuses: STATUS, team,
    projects: projects.map((p) => Object.assign(p, { members: members[p.id] || [], mine: (members[p.id] || []).includes(user.login) })),
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
  const { projects, members } = await loadProjects(env);
  const projName = (pid) => { const p = projects.find((x) => x.id === pid); return p ? p.name : ""; };
  // в проект ставит его участник или админ; 0 — без проекта, null — проекта нет или он закрыт для человека
  const pickProject = (v) => {
    const pid = Number(v || 0);
    if (!pid) return 0;
    const p = projects.find((x) => x.id === pid && !x.archived);
    return p && (admin || (members[pid] || []).includes(user.login)) ? pid : null;
  };

  if (b.action === "project") {
    if (!admin) return bad("проекты заводит админ", 403);
    const name = str(b.name, 80), about = str(b.about, 300);
    if (!name) return bad("нужно название проекта");
    const list = [...new Set((Array.isArray(b.members) ? b.members : []).map(String))].filter((l) => byLogin[l]).slice(0, 50);
    let pid = Number(b.pid || 0);
    if (pid) {
      if (!projects.some((p) => p.id === pid)) return bad("проекта нет", 404);
      await env.DB.prepare("UPDATE task_projects SET name = ?, about = ?, archived = ? WHERE id = ?").bind(name, about, b.archived ? 1 : 0, pid).run();
    } else {
      pid = (await env.DB.prepare("INSERT INTO task_projects (name, about, created_by, created_at) VALUES (?,?,?,?)").bind(name, about, user.login, at).run()).meta.last_row_id;
    }
    const before = members[pid] || [];
    await env.DB.prepare("DELETE FROM task_project_members WHERE project = ?").bind(pid).run();
    for (const l of list) await env.DB.prepare("INSERT OR IGNORE INTO task_project_members (project, login) VALUES (?,?)").bind(pid, l).run();
    await audit(env, user.login, "task.project", String(pid), name + ": " + list.join(","));
    const added = list.filter((l) => !before.includes(l) && l !== user.login);
    if (added.length) await notify(env, people, added, `Вас добавили в проект «${name}» в задачах Штаба. Вы видите все его задачи и получаете по ним уведомления; из ненужной задачи можно выйти кнопкой «Не наблюдать».\n${origin}/tasks/?p=${pid}`);
    return json({ ok: true, pid });
  }

  if (b.action === "create") {
    const title = str(b.title, 200), body = str(b.body, 5000), assignee = str(b.assignee, 40) || user.login;
    const due = cleanDue(b.due);
    if (!title) return bad("нужно название");
    if (!byLogin[assignee]) return bad("исполнителя нет среди пользователей Штаба");
    if (due === null) return bad("срок в формате ГГГГ-ММ-ДД");
    // подзадача: родитель виден человеку и сам не подзадача; проект берётся у родителя
    let parent = null, project = pickProject(b.project);
    if (b.parent) {
      parent = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(Number(b.parent)).first();
      if (!parent) return bad("родительской задачи нет", 404);
      if (parent.parent) return bad("у подзадачи не бывает своих подзадач");
      const pw = (await watchMap(env, [parent], members))[parent.id];
      if (!roleIn(parent, user.login, pw.all, teamOf(user.login, hr, depts), admin, members)) return bad("задача закрыта для вас", 403);
      project = parent.project || 0;
    } else if (project === null) return bad("в этот проект ставят только его участники");
    const r = await env.DB.prepare(
      "INSERT INTO tasks (title, body, author, assignee, due, important, status, created_at, updated_at, project, parent) VALUES (?,?,?,?,?,?,'new',?,?,?,?)"
    ).bind(title, body, user.login, assignee, due || null, b.important ? 1 : 0, at, at, project || null, parent ? parent.id : null).run();
    const id = r.meta.last_row_id;
    const t = { id, author: user.login, assignee, project: project || null, parent: parent ? parent.id : null };
    const watchers = cleanWatchers(b.watchers, t);
    await setWatchers(id, watchers);
    await log(id, "create", "");
    if (parent) await log(parent.id, "sub", title);
    await audit(env, user.login, "task.create", String(id), title);
    const where = (project ? `Проект: ${projName(project)}\n` : "") + (parent ? `Подзадача к «${parent.title}»\n` : "");
    const msg = (to) => `${to}: ${title}\n${where}Срок: ${dueText(due)}${b.important ? " · важная" : ""}\nПоставил: ${nm(user.login)}\n${link(origin, id)}`;
    if (assignee !== user.login) await notify(env, people, [assignee], msg(parent ? "Новая подзадача" : "Новая задача"));
    await notify(env, people, watchers, msg("Вы наблюдатель в задаче"));
    const full = (await watchMap(env, [t], members))[id].all;
    await notify(env, people, full.filter((l) => !watchers.includes(l) && l !== user.login), msg(parent ? "Новая подзадача в проекте" : "Новая задача в проекте"));
    return json({ ok: true, id });
  }

  const id = Number(b.id || 0);
  const t = id && await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!t) return bad("задачи нет", 404);
  const wm = (await watchMap(env, [t], members))[id];
  const w = wm.all;
  const role = roleIn(t, user.login, w, teamOf(user.login, hr, depts), admin, members);
  if (!role) return bad("задача закрыта для вас", 403);
  const boss = t.author === user.login || admin, doer = t.assignee === user.login;
  const others = (extra = []) => [t.author, t.assignee, ...w, ...extra].filter((l) => l && l !== user.login);
  const head = `«${t.title}»`;

  // выйти из наблюдения: ручной наблюдатель удаляется, участник проекта попадает в task_mutes
  if (b.action === "unwatch") {
    if (!w.includes(user.login)) return json({ ok: true });
    await env.DB.prepare("DELETE FROM task_watchers WHERE task = ? AND login = ?").bind(id, user.login).run();
    if (t.project && (members[t.project] || []).includes(user.login))
      await env.DB.prepare("INSERT OR IGNORE INTO task_mutes (task, login) VALUES (?,?)").bind(id, user.login).run();
    await log(id, "watch", "вышел из наблюдателей");
    return json({ ok: true });
  }
  if (b.action === "watch") {
    if (w.includes(user.login) || t.author === user.login || t.assignee === user.login) return json({ ok: true });
    await env.DB.prepare("DELETE FROM task_mutes WHERE task = ? AND login = ?").bind(id, user.login).run();
    if (t.parent) await env.DB.prepare("DELETE FROM task_mutes WHERE task = ? AND login = ?").bind(t.parent, user.login).run();
    const again = (await watchMap(env, [t], members))[id].all;
    if (!again.includes(user.login)) await env.DB.prepare("INSERT OR IGNORE INTO task_watchers (task, login) VALUES (?,?)").bind(id, user.login).run();
    await log(id, "watch", "стал наблюдателем");
    return json({ ok: true });
  }

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
    // проект меняется только у обычной задачи, подзадачи идут за ней
    let project = t.project || 0;
    if (b.project !== undefined && !t.parent && Number(b.project || 0) !== project) {
      project = pickProject(b.project);
      if (project === null) return bad("в этот проект ставят только его участники");
    }
    const changes = [];
    if (title !== t.title) changes.push("название");
    if (body !== t.body) changes.push("описание");
    if ((due || "") !== (t.due || "")) changes.push("срок: " + dueText(t.due) + " → " + dueText(due));
    if (assignee !== t.assignee) changes.push("исполнитель: " + nm(t.assignee) + " → " + nm(assignee));
    if (!!b.important !== !!t.important) changes.push(b.important ? "важная" : "обычная");
    if (project !== (t.project || 0)) changes.push("проект: " + (projName(t.project) || "без проекта") + " → " + (projName(project) || "без проекта"));
    await env.DB.prepare("UPDATE tasks SET title = ?, body = ?, assignee = ?, due = ?, important = ?, updated_at = ?, reminded = ?, project = ? WHERE id = ?")
      .bind(title, body, assignee, due || null, b.important ? 1 : 0, at, (due || "") !== (t.due || "") ? "" : t.reminded, project || null, id).run();
    if (project !== (t.project || 0)) await env.DB.prepare("UPDATE tasks SET project = ? WHERE parent = ?").bind(project || null, id).run();
    const nt = Object.assign({}, t, { assignee });
    const watchers = b.watchers ? cleanWatchers(b.watchers, nt) : wm.own.filter((l) => l !== assignee);
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
