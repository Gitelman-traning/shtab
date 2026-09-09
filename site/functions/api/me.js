// GET /api/me — кто вошёл; PUT /api/me {password, new_password} — сменить свой пароль (только именные)
import { json, bad, canRead, currentUser, hashPassword, verifyPassword, randomId, audit, now, effectivePerms } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  return json({ ok: true, user: { login: user.login, name: user.name || "", role: user.role, sections: user.sections || "",
    personal: user.login !== "shared" && user.login !== "collector", must_change: !!user.must_change, perms: effectivePerms(user) } });
}

export async function onRequestPut({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return bad("сменить пароль может только именной пользователь", 401);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const oldP = String(body.password || ""), newP = String(body.new_password || "");
  if (newP.length < 8) return bad("новый пароль короче 8 символов");
  const row = await env.DB.prepare("SELECT pass_hash, salt FROM users WHERE login = ?").bind(user.login).first();
  if (!row || !(await verifyPassword(oldP, row.salt, row.pass_hash))) return bad("текущий пароль не подошёл", 403);
  const salt = randomId(16);
  await env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ?, must_change = 0 WHERE login = ?")
    .bind(await hashPassword(newP, salt), salt, user.login).run();
  await audit(env, user.login, "user.password", user.login);
  return json({ ok: true });
}
