// GET  /api/metrics — реестр показателей
// POST /api/metrics — сборщик синхронизирует реестр из metrics.json (по токену)
import { json, bad, canRead, hasIngestToken, now } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const rows = await env.DB.prepare("SELECT * FROM metrics ORDER BY section, id").all();
  return json({ ok: true, metrics: rows.results || [] });
}

export async function onRequestPost({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  let list;
  try {
    list = await request.json();
  } catch (e) {
    return bad("тело не JSON");
  }
  if (!Array.isArray(list)) return bad("ожидается массив");
  const stmt = env.DB.prepare(
    "INSERT INTO metrics (id, name, section, unit, kind, better, definition, updated_at) VALUES (?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(id) DO UPDATE SET name=excluded.name, section=excluded.section, unit=excluded.unit, " +
    "kind=excluded.kind, better=excluded.better, definition=excluded.definition, updated_at=excluded.updated_at"
  );
  const stamp = now();
  const batch = list.filter((m) => m && m.id && m.name && m.section).map((m) =>
    stmt.bind(m.id, m.name, m.section, m.unit || "шт", m.kind || "flow", m.better || "up", m.definition || "", stamp));
  if (batch.length) await env.DB.batch(batch);
  return json({ ok: true, written: batch.length });
}
