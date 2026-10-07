// HR · Структура компании: отделы и сотрудники.
//   GET  /api/hr/structure            — {depts, people, can_edit}; уволенных видят только те, кто может править
//   POST /api/hr/structure {action:…}  — правка, уровень «правка» на разделе hr.structure:
//     dept_save {id?, name, parent, head, sort}   · dept_del {id}  (только пустой отдел без подотделов)
//     person_save {id?, name, position, dept, manager, login, status, hired, birth, leave_year, leave_adj, children:[{name,birth}]}   · person_del {id}
//       год рождения и дети — только для сотрудников HR: остальным GET отдаёт день и месяц рождения, детей не отдаёт
//     import {rows:[{name, position, dept, manager}]} — пачкой; dept — id или название отдела, manager — имя
import { json, bad, canRead, canEdit, canView, audit, now } from "../_lib.js";
import { isHR, cleanDate } from "./_hr.js";

const SEC = "hr.structure";
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
// «Тамахина Илона» и «Илона Тамахина» — один человек: сравниваем по набору слов
const nameKey = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean).sort().join(" ");
const int = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Math.trunc(Number(v)));

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, SEC)) return bad("раздел закрыт", 403);
  const edit = canEdit(user, SEC);
  const depts = await env.DB.prepare("SELECT id, name, parent, head, sort FROM hr_depts ORDER BY sort, name").all();
  const hr = isHR(user);
  const people = (await env.DB.prepare(
    "SELECT id, name, position, dept, manager, login, status, sort, birth, hired, leave_year, leave_adj FROM hr_people" + (edit ? "" : " WHERE status = 'active'") + " ORDER BY sort, name"
  ).all()).results || [];
  if (!hr) for (const p of people) { p.birth = p.birth ? "--" + p.birth.slice(-5) : ""; delete p.leave_adj; delete p.leave_year; }
  const children = hr ? ((await env.DB.prepare("SELECT id, person, name, birth FROM hr_children ORDER BY birth").all()).results || []) : [];
  return json({ ok: true, can_edit: edit, is_hr: hr, depts: depts.results || [], people, children });
}

async function deptExists(env, id) {
  return !!(await env.DB.prepare("SELECT 1 FROM hr_depts WHERE id = ?").bind(id).first());
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canEdit(user, SEC)) return bad("править структуру может только тот, у кого уровень «правка»", 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const action = String(body.action || "");
  const t = now();

  if (action === "dept_save") {
    const name = str(body.name, 80);
    if (!name) return bad("укажите название отдела");
    const parent = str(body.parent, 40);
    let id = str(body.id, 40);
    const isNew = !id || !(await deptExists(env, id));
    if (!id) id = "d" + Date.now().toString(36);
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return bad("id отдела: латиница, цифры, дефис");
    if (parent && (parent === id || !(await deptExists(env, parent)))) return bad("нет такого вышестоящего отдела");
    if (parent) {   // не даём сделать отдел подотделом собственного подотдела
      const p = await env.DB.prepare("SELECT parent FROM hr_depts WHERE id = ?").bind(parent).first();
      if (p && p.parent === id) return bad("получится круг: этот отдел уже вышестоящий для выбранного");
    }
    const sort = int(body.sort) ?? 100;
    await env.DB.prepare("INSERT INTO hr_depts (id, name, parent, head, sort, updated_at) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent = excluded.parent, head = excluded.head, sort = excluded.sort, updated_at = excluded.updated_at")
      .bind(id, name, parent, int(body.head), sort, t).run();
    await audit(env, user.login, isNew ? "hr.dept_add" : "hr.dept_edit", id, name);
    return json({ ok: true, id });
  }

  if (action === "dept_del") {
    const id = str(body.id, 40);
    const kids = await env.DB.prepare("SELECT COUNT(*) AS n FROM hr_depts WHERE parent = ?").bind(id).first();
    const ppl = await env.DB.prepare("SELECT COUNT(*) AS n FROM hr_people WHERE dept = ?").bind(id).first();
    if ((kids && kids.n) || (ppl && ppl.n)) return bad("в отделе есть люди или подотделы: сначала перенесите их");
    await env.DB.prepare("DELETE FROM hr_depts WHERE id = ?").bind(id).run();
    await audit(env, user.login, "hr.dept_del", id);
    return json({ ok: true });
  }

  if (action === "person_save") {
    const name = str(body.name, 80);
    if (!name) return bad("укажите имя");
    const dept = str(body.dept, 40);
    if (dept && !(await deptExists(env, dept))) return bad("нет такого отдела");
    const status = body.status === "left" ? "left" : "active";
    const id = int(body.id);
    const manager = int(body.manager);
    if (id && manager === id) return bad("человек не может быть руководителем самому себе");
    const hired = cleanDate(body.hired, false);
    if (hired === null) return bad("дата выхода: ГГГГ-ММ-ДД");
    const vals = [name, str(body.position, 120), dept, manager, str(body.login, 32), status, int(body.sort) ?? 100, hired, t];
    let pid = id;
    if (id) {
      await env.DB.prepare("UPDATE hr_people SET name = ?, position = ?, dept = ?, manager = ?, login = ?, status = ?, sort = ?, hired = ?, updated_at = ? WHERE id = ?")
        .bind(...vals, id).run();
      await audit(env, user.login, "hr.person_edit", String(id), name);
    } else {
      const r = await env.DB.prepare("INSERT INTO hr_people (name, position, dept, manager, login, status, sort, hired, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(...vals, t).run();
      pid = r.meta && r.meta.last_row_id;
      await audit(env, user.login, "hr.person_add", String(pid || ""), name);
    }
    // личное — дата рождения, дети, поправка отпуска — пишет только сотрудник HR
    if (isHR(user) && pid) {
      const birth = cleanDate(body.birth, true);
      if (birth === null) return bad("дата рождения: ГГГГ-ММ-ДД или --ММ-ДД");
      const kids = Array.isArray(body.children) ? body.children.slice(0, 10) : [];
      const st = [env.DB.prepare("UPDATE hr_people SET birth = ?, leave_year = ?, leave_adj = ? WHERE id = ?")
        .bind(birth, Number(body.leave_year) > 0 ? Number(body.leave_year) : 28, Number(body.leave_adj) || 0, pid),
        env.DB.prepare("DELETE FROM hr_children WHERE person = ?").bind(pid)];
      for (const k of kids) {
        const kn = str(k.name, 60), kb = cleanDate(k.birth, true);
        if (kn && kb !== null) st.push(env.DB.prepare("INSERT INTO hr_children (person, name, birth) VALUES (?,?,?)").bind(pid, kn, kb));
      }
      await env.DB.batch(st);
    }
    return json({ ok: true, id: pid });
  }

  if (action === "person_del") {
    const id = int(body.id);
    if (!id) return bad("нет id");
    await env.DB.batch([
      env.DB.prepare("UPDATE hr_people SET manager = NULL WHERE manager = ?").bind(id),
      env.DB.prepare("UPDATE hr_depts SET head = NULL WHERE head = ?").bind(id),
      env.DB.prepare("DELETE FROM hr_children WHERE person = ?").bind(id),
      env.DB.prepare("DELETE FROM hr_leave WHERE person = ?").bind(id),
      env.DB.prepare("DELETE FROM hr_people WHERE id = ?").bind(id)
    ]);
    await audit(env, user.login, "hr.person_del", String(id));
    return json({ ok: true });
  }

  if (action === "import") {
    // загрузка пачкой из таблицы: сначала создаём людей, потом проставляем руководителей по именам
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 500) : [];
    if (!rows.length) return bad("пустой список");
    const depts = (await env.DB.prepare("SELECT id, name FROM hr_depts").all()).results || [];
    const byName = {};
    for (const d of depts) { byName[d.id] = d.id; byName[d.name.toLowerCase()] = d.id; }
    const added = [];
    for (const r of rows) {
      const name = str(r.name, 80);
      if (!name) continue;
      const dept = byName[str(r.dept, 80).toLowerCase()] || "";
      const res = await env.DB.prepare("INSERT INTO hr_people (name, position, dept, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .bind(name, str(r.position, 120), dept, r.status === "left" ? "left" : "active", t, t).run();
      added.push({ id: res.meta && res.meta.last_row_id, manager: str(r.manager, 80) });
    }
    const all = (await env.DB.prepare("SELECT id, name FROM hr_people").all()).results || [];
    const pid = {};
    for (const p of all) pid[nameKey(p.name)] = p.id;
    const upd = added.filter((a) => a.manager && pid[nameKey(a.manager)] && pid[nameKey(a.manager)] !== a.id)
      .map((a) => env.DB.prepare("UPDATE hr_people SET manager = ? WHERE id = ?").bind(pid[nameKey(a.manager)], a.id));
    if (upd.length) await env.DB.batch(upd);
    await audit(env, user.login, "hr.import", "", added.length + " чел.");
    return json({ ok: true, added: added.length, linked: upd.length });
  }

  return bad("неизвестное действие");
}
