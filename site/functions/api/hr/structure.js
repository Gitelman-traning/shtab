// HR · Структура компании: отделы и сотрудники.
//   GET  /api/hr/structure            — {depts, people, can_edit}; уволенных видят только те, кто может править
//   POST /api/hr/structure {action:…}  — правка, уровень «правка» на разделе hr.structure:
//     dept_save {id?, name, parent, head, sort}   · dept_del {id}  (только пустой отдел без подотделов)
//     person_save {id?, name, position, dept, manager, login, tg, status, hired, birth, leave_year, leave_adj, children:[{name,birth}]}   · person_del {id}
//       год рождения и дети — только для сотрудников HR: остальным GET отдаёт день и месяц рождения, детей не отдаёт
//     import {rows:[{name, position, dept, manager}]} — пачкой; dept — id или название отдела, manager — имя
import { json, bad, canRead, canEdit, canView, audit, now } from "../_lib.js";
import { isHR, canManageHR, canManageLeave, cleanDate } from "./_hr.js";

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
    // tg — что внесли в карточку; tg_auto — @username из входа в Штаб через Telegram, если человек связан с логином
    "SELECT p.id, p.name, p.position, p.dept, p.manager, p.login, p.tg, u.tg_username AS tg_auto, p.status, p.sort, p.birth, p.hired, p.leave_year, p.leave_adj " +
    "FROM hr_people p LEFT JOIN users u ON u.login = p.login AND p.login != ''" + (edit ? "" : " WHERE p.status = 'active'") + " ORDER BY p.sort, p.name"
  ).all()).results || [];
  if (!hr) for (const p of people) { p.birth = p.birth ? "--" + p.birth.slice(-5) : ""; delete p.leave_adj; delete p.leave_year; }
  const children = hr ? ((await env.DB.prepare("SELECT id, person, name, birth FROM hr_children ORDER BY birth").all()).results || []) : [];
  return json({ ok: true, can_edit: edit, can_edit_private: edit && canManageHR(user), can_delete: edit && canManageLeave(user), is_hr: hr, depts: depts.results || [], people, children });
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
    const sort = int(body.sort) ?? 100;
    // Проверка и запись одной командой: параллельные перемещения не образуют цикл.
    const saved=await env.DB.prepare("WITH RECURSIVE chain(id,parent) AS (SELECT id,parent FROM hr_depts WHERE id=? UNION SELECT d.id,d.parent FROM hr_depts d JOIN chain c ON d.id=c.parent) " +
      "INSERT INTO hr_depts (id,name,parent,head,sort,updated_at) SELECT ?,?,?,?,?,? WHERE ?='' OR (EXISTS (SELECT 1 FROM chain WHERE parent='') AND NOT EXISTS (SELECT 1 FROM chain WHERE id=?)) " +
      "ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent = excluded.parent, head = excluded.head, sort = excluded.sort, updated_at = excluded.updated_at")
      .bind(parent,id,name,parent,int(body.head),sort,t,parent,id).run();
    if (!saved.meta.changes) return bad('Нельзя перенести отдел: в цепочке родителей есть цикл.');
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
    const privateFields = ["birth", "children", "leave_year", "leave_adj"];
    if (!canManageHR(user) && privateFields.some(key => Object.prototype.hasOwnProperty.call(body, key))) return bad("личные поля может менять только редактор HR", 403);
    const name = str(body.name, 80);
    if (!name) return bad("укажите имя");
    const dept = str(body.dept, 40);
    if (dept && !(await deptExists(env, dept))) return bad("нет такого отдела");
    const status = body.status === "left" ? "left" : "active";
    const id = int(body.id);
    // руководитель человека в структуре не показывается (решение 09.10), но поле живёт для «Задач» → без manager в запросе не трогаем
    const hasMgr = Object.prototype.hasOwnProperty.call(body, "manager");
    const manager = int(body.manager);
    if (id && manager === id) return bad("человек не может быть руководителем самому себе");
    const hired = cleanDate(body.hired, false);
    if (hired === null) return bad("дата выхода: ГГГГ-ММ-ДД");
    const birth=cleanDate(body.birth,true);
    if(birth===null) return bad("дата рождения: ГГГГ-ММ-ДД или --ММ-ДД");
    if(body.children!==undefined && (!Array.isArray(body.children) || body.children.length>10)) return bad("укажите до 10 детей");
    const kids=(body.children || []).map(k=>({name:str(k?.name,60),birth:cleanDate(k?.birth,true)}));
    if(kids.some(k=>!k.name || k.birth===null)) return bad("проверьте имена и даты рождения детей");
    // Telegram: принимаем @user, user или ссылку t.me/user
    const tg = str(body.tg, 80).replace(/^https?:\/\/(www\.)?t(elegram)?\.me\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
    if (tg && !/^[A-Za-z0-9_]{4,32}$/.test(tg)) return bad("Telegram: @username латиницей, от 4 символов");
    const vals = [name, str(body.position, 120), dept, manager, str(body.login, 32), tg, status, int(body.sort) ?? 100, hired, t];
    let pid = id;
    if (id) {
      await env.DB.prepare("UPDATE hr_people SET name = ?, position = ?, dept = ?, manager = CASE WHEN ? THEN ? ELSE manager END, login = ?, tg = ?, status = ?, sort = ?, hired = ?, updated_at = ? WHERE id = ?")
        .bind(vals[0], vals[1], vals[2], hasMgr ? 1 : 0, vals[3], ...vals.slice(4), id).run();
      await audit(env, user.login, "hr.person_edit", String(id), name);
    } else {
      const r = await env.DB.prepare("INSERT INTO hr_people (name, position, dept, manager, login, tg, status, sort, hired, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(...vals, t).run();
      pid = r.meta && r.meta.last_row_id;
      await audit(env, user.login, "hr.person_add", String(pid || ""), name);
    }
    // личное — дата рождения, дети, поправка отпуска — пишет только сотрудник HR
    if (canManageHR(user) && pid) {
      const st=[env.DB.prepare("UPDATE hr_people SET birth=COALESCE(?,birth),leave_year=COALESCE(?,leave_year),leave_adj=COALESCE(?,leave_adj) WHERE id=?")
        .bind(body.birth===undefined?null:birth,body.leave_year===undefined?null:Number(body.leave_year)>0?Number(body.leave_year):28,body.leave_adj===undefined?null:Number(body.leave_adj)||0,pid)];
      if(body.children!==undefined) {
        st.push(env.DB.prepare("DELETE FROM hr_children WHERE person=?").bind(pid));
        for(const k of kids) st.push(env.DB.prepare("INSERT INTO hr_children (person,name,birth) VALUES (?,?,?)").bind(pid,k.name,k.birth));
      }
      await env.DB.batch(st);
    }
    return json({ ok: true, id: pid });
  }

  if (action === "person_del") {
    // Удаление человека также удаляет его отпуска и личные HR-данные.
    if (!canManageLeave(user)) return bad("для удаления сотрудника нужно право редактирования HR и отпусков", 403);
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
