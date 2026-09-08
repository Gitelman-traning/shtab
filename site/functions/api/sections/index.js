// GET /api/sections — список разделов, у которых может быть свой вид и владельцы (для выбора в «Пользователях»)
import { json, bad, canRead } from "../_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const rows = await env.DB.prepare("SELECT id, name, owner FROM sections ORDER BY name").all();
  return json({ ok: true, sections: rows.results || [] });
}
