// GET /api/audit?limit=100 — журнал действий (только администратор)
import { json, bad, canRead, isAdmin } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user || !isAdmin(user)) return bad("только для администратора", 403);
  const u = new URL(request.url);
  const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get("limit") || "100", 10) || 100));
  const rows = await env.DB.prepare("SELECT at, login, action, target, note FROM audit ORDER BY id DESC LIMIT ?").bind(limit).all();
  return json({ ok: true, rows: rows.results || [] });
}
