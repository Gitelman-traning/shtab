// GET /api/pings?manager=krotov[&days=120] — журнал подготовленных пингов (сборщик — токеном; люди — с правом на Вторую линию).
import { json, bad, canRead, level } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "sales.l2") < 1) return bad("нет доступа", 401);
  const u = new URL(request.url);
  const manager = (u.searchParams.get("manager") || "").slice(0, 40);
  const days = Math.min(Number(u.searchParams.get("days")) || 120, 400);
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const q = manager
    ? env.DB.prepare("SELECT day, manager, deal, text, reason FROM pings WHERE manager = ? AND day >= ? ORDER BY day DESC LIMIT 5000").bind(manager, from)
    : env.DB.prepare("SELECT day, manager, deal, text, reason FROM pings WHERE day >= ? ORDER BY day DESC LIMIT 5000").bind(from);
  const rows = await q.all();
  return json({ ok: true, rows: rows.results || [] });
}
