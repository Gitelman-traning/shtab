// GET /api/me — кто вошёл; PUT /api/me {password, new_password} — сменить свой пароль (только именные)
// PATCH /api/me {notify: ["journal", …]} — свои уведомления в Telegram
import { json, bad, canRead, currentUser, hashPassword, verifyPassword, randomId, audit, now, effectivePerms, NOTIFY, notifyList, sessionTicket, SESSION_COOKIE, getCookie } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  // админу — сколько заявок на доступ ждут подтверждения (бейдж в меню «Пользователи»)
  let pending = 0;
  if (user.role === "admin" && user.login !== "collector") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'pending'").first();
    pending = (r && r.n) || 0;
  }
  const personal = user.login !== "shared" && user.login !== "collector";
  let tg = false, notify = "";
  if (personal) {
    const r = await env.DB.prepare("SELECT tg_id, notify FROM users WHERE login = ?").bind(user.login).first();
    tg = !!(r && r.tg_id); notify = (r && r.notify) || "";
  }
  return json({ ok: true, user: { login: user.login, name: user.name || "", role: user.role, sections: user.sections || "",
    personal, must_change: !!user.must_change, perms: effectivePerms(user), tg, notify }, pending, topics: NOTIFY });
}

export async function onRequestPatch({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return bad("уведомления настраивает только именной пользователь", 401);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const notify = notifyList(body.notify);
  await env.DB.prepare("UPDATE users SET notify = ? WHERE login = ?").bind(notify, user.login).run();
  await audit(env, user.login, "user.notify", user.login, notify || "выключены");
  return json({ ok: true, notify });
}

export async function onRequestPut({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  return changePassword(request,env,body);
}

export async function changePassword(request,env,body) {
  const user = await currentUser(request, env, true);
  if (!user) return bad("сменить пароль может только именной пользователь", 401);
  const oldP = String(body.password || ""), newP = String(body.new_password || "");
  if (newP.length < 8 || newP.length > 1024 || newP === oldP) return bad("нужен новый пароль от 8 до 1024 символов");
  const row = await env.DB.prepare("SELECT pass_hash,salt,tg_id FROM users WHERE login=?").bind(user.login).first();
  if (!row || (row.pass_hash ? !(await verifyPassword(oldP,row.salt,row.pass_hash)) : !row.tg_id || oldP !== '')) return bad("текущий пароль не подошёл",403);
  const salt=randomId(16), hash=await hashPassword(newP,salt), ticket=sessionTicket();
  const result=await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash=?,salt=?,must_change=0,temp_expires=NULL WHERE login=? AND active=1 AND pass_hash=? AND salt=? AND EXISTS (SELECT 1 FROM sessions WHERE id=? AND login=? AND expires>?)')
      .bind(hash,salt,user.login,row.pass_hash,row.salt,getCookie(request,SESSION_COOKIE),user.login,now()),
    env.DB.prepare('DELETE FROM sessions WHERE login=? AND EXISTS (SELECT 1 FROM users WHERE login=? AND salt=?)').bind(user.login,user.login,salt),
    env.DB.prepare('INSERT INTO sessions (id,login,expires) SELECT ?,login,? FROM users WHERE login=? AND salt=?').bind(ticket.id,ticket.expires,user.login,salt),
  ]);
  if (!result[0].meta.changes) return bad('Сессия или пароль уже изменились. Войдите снова.',409);
  await audit(env, user.login, "user.password", user.login);
  return json({ ok: true },200,{'Set-Cookie':ticket.cookie});
}
