// Пользователи (только администратор; создать первого можно токеном сборщика).
//   GET   /api/users                      — список
//   POST  /api/users {login,name,role,sections}            — создать, вернёт временный пароль
//   PATCH /api/users {login, action, ...}  — reset (новый временный пароль) / disable / enable / update {name,role,sections}
import { json, bad, canRead, isAdmin, hasIngestToken, hashPassword, randomId, audit, now, tgSend, SECTIONS } from "./_lib.js";

const ROLES = ["admin", "head", "member", "viewer"];
const RE_LOGIN = /^[a-z0-9._-]{3,32}$/;

function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => abc[x % abc.length]).join("");
}

async function gate(request, env) {
  if (hasIngestToken(request, env)) return { login: "collector", role: "admin" };
  const user = await canRead(request, env);
  if (!user || !isAdmin(user)) return null;
  return user;
}

export async function onRequestGet({ request, env }) {
  const me = await gate(request, env);
  if (!me) return bad("только для администратора", 403);
  const rows = await env.DB.prepare(
    "SELECT login, name, role, sections, active, created_at, last_login, must_change, tg_id, tg_username, photo FROM users ORDER BY role, login").all();
  const pr = await env.DB.prepare("SELECT login, section, level FROM perms").all();
  const byLogin = {};
  for (const r of (pr.results || [])) (byLogin[r.login] = byLogin[r.login] || {})[r.section] = Number(r.level);
  const users = (rows.results || []).map((u) => Object.assign(u, { perms: byLogin[u.login] || null }));
  return json({ ok: true, users, sections: SECTIONS });
}

export async function onRequestPost({ request, env }) {
  const me = await gate(request, env);
  if (!me) return bad("только для администратора", 403);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const login = String(b.login || "").trim().toLowerCase();
  if (!RE_LOGIN.test(login)) return bad("логин: 3–32 символа, латиница, цифры, точка, дефис");
  if (login === "admin") return bad("«admin» занят общим входом");
  const role = ROLES.includes(b.role) ? b.role : "member";
  const sections = String(b.sections || "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
  const exists = await env.DB.prepare("SELECT login FROM users WHERE login = ?").bind(login).first();
  if (exists) return bad("такой логин уже есть", 409);
  const password = tempPassword(), salt = randomId(16);
  await env.DB.prepare(
    "INSERT INTO users (login, pass_hash, salt, name, role, sections, active, must_change, created_at) VALUES (?,?,?,?,?,?,1,1,?)")
    .bind(login, await hashPassword(password, salt), salt, String(b.name || "").slice(0, 80), role, sections, now()).run();
  await audit(env, me.login, "user.create", login, role + (sections ? " " + sections : ""));
  return json({ ok: true, login, password });
}

export async function onRequestPatch({ request, env }) {
  const me = await gate(request, env);
  if (!me) return bad("только для администратора", 403);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const login = String(b.login || "").trim().toLowerCase();
  const row = await env.DB.prepare("SELECT login, role FROM users WHERE login = ?").bind(login).first();
  if (!row) return bad("пользователь не найден", 404);
  const action = String(b.action || "");
  if (action === "reset") {
    const password = tempPassword(), salt = randomId(16);
    await env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ?, must_change = 1 WHERE login = ?")
      .bind(await hashPassword(password, salt), salt, login).run();
    // чужие сессии закрываем; свою — оставляем, иначе админ выкинет сам себя, не успев прочитать пароль
    if (login !== me.login) await env.DB.prepare("DELETE FROM sessions WHERE login = ?").bind(login).run();
    await audit(env, me.login, "user.reset", login);
    return json({ ok: true, password });
  }
  if (action === "disable" || action === "enable") {
    if (action === "disable" && login === me.login) return bad("нельзя отключить себя");
    await env.DB.prepare("UPDATE users SET active = ? WHERE login = ?").bind(action === "enable" ? 1 : 0, login).run();
    if (action === "disable") await env.DB.prepare("DELETE FROM sessions WHERE login = ?").bind(login).run();
    await audit(env, me.login, "user." + action, login);
    return json({ ok: true });
  }
  if (action === "approve") {
    if (row.role !== "pending") return bad("это не заявка");
    const role = ROLES.includes(b.role) ? b.role : "member";
    const sections = String(b.sections || "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
    await env.DB.prepare("UPDATE users SET role = ?, sections = ?, active = 1 WHERE login = ?").bind(role, sections, login).run();
    await audit(env, me.login, "user.approve", login, role + (sections ? " " + sections : ""));
    const u = await env.DB.prepare("SELECT tg_id FROM users WHERE login = ?").bind(login).first();
    if (u && u.tg_id) await tgSend(env, u.tg_id, "Доступ в Штаб открыт. Войти: https://okk-dashboard.pages.dev/ — кнопка «Войти через Telegram».");
    return json({ ok: true });
  }
  if (action === "reject") {
    if (row.role !== "pending") return bad("это не заявка");
    await env.DB.prepare("DELETE FROM users WHERE login = ? AND role = 'pending'").bind(login).run();
    await audit(env, me.login, "user.reject", login);
    return json({ ok: true });
  }
  if (action === "perms") {
    // полный набор прав: {section: 0|1|2}; отсутствующие разделы наследуют отдел
    const perms = (b.perms && typeof b.perms === "object") ? b.perms : {};
    const stmts = [env.DB.prepare("DELETE FROM perms WHERE login = ?").bind(login)];
    const note = [];
    for (const s of Object.keys(perms)) {
      if (!SECTIONS.includes(s)) continue;
      const lv = Math.max(0, Math.min(2, parseInt(perms[s], 10) || 0));
      stmts.push(env.DB.prepare("INSERT INTO perms (login, section, level) VALUES (?,?,?)").bind(login, s, lv));
      note.push(s + "=" + lv);
    }
    if (b.role && ROLES.includes(b.role) && !(login === me.login && b.role !== "admin")) {
      stmts.push(env.DB.prepare("UPDATE users SET role = ? WHERE login = ?").bind(b.role, login));
    }
    if (typeof b.name === "string") stmts.push(env.DB.prepare("UPDATE users SET name = ? WHERE login = ?").bind(b.name.slice(0, 80), login));
    await env.DB.batch(stmts);
    await audit(env, me.login, "user.perms", login, note.join(" "));
    return json({ ok: true });
  }
  if (action === "update") {
    const role = ROLES.includes(b.role) ? b.role : row.role;
    if (login === me.login && role !== "admin") return bad("нельзя снять с себя администратора");
    const sections = String(b.sections || "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
    await env.DB.prepare("UPDATE users SET name = ?, role = ?, sections = ? WHERE login = ?")
      .bind(String(b.name || "").slice(0, 80), role, sections, login).run();
    await audit(env, me.login, "user.update", login, role + (sections ? " " + sections : ""));
    return json({ ok: true });
  }
  return bad("неизвестное действие");
}
