// Версии собственного вида раздела.
//   GET  /api/sections/<id>/versions                 — список (без html)
//   POST /api/sections/<id>/versions {action:"publish"|"rollback"|"unpublish", version}
import { json, bad, canRead, canEdit, audit, now } from "../../_lib.js";

export async function onRequestGet({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const rows = await env.DB.prepare(
    "SELECT version, prompt, author, created_at, active, length(html) AS size FROM section_versions WHERE section = ? ORDER BY version DESC LIMIT 50"
  ).bind(params.id).all();
  return json({ ok: true, section: params.id, can_edit: canEdit(user, params.id), versions: rows.results || [] });
}

export async function onRequestPost({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user || !canEdit(user, params.id)) return bad("менять этот раздел могут его владельцы и администратор", 403);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const action = String(b.action || "");
  if (action === "unpublish") {
    await env.DB.prepare("UPDATE section_versions SET active = 0 WHERE section = ?").bind(params.id).run();
    await audit(env, user.login, "section.unpublish", params.id);
    return json({ ok: true });
  }
  const version = parseInt(b.version, 10);
  if (!version) return bad("укажите версию");
  const row = await env.DB.prepare("SELECT version FROM section_versions WHERE section = ? AND version = ?").bind(params.id, version).first();
  if (!row) return bad("версии нет", 404);
  if (action === "publish" || action === "rollback") {
    await env.DB.batch([
      env.DB.prepare("UPDATE section_versions SET active = 0 WHERE section = ?").bind(params.id),
      env.DB.prepare("UPDATE section_versions SET active = 1 WHERE section = ? AND version = ?").bind(params.id, version),
    ]);
    await audit(env, user.login, "section." + action, params.id, "v" + version);
    return json({ ok: true, active: version });
  }
  return bad("неизвестное действие");
}
