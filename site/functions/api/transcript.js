// Расшифровки встреч Zoom (15.10.2026) — общее хранилище, чтобы одна запись шла в Deepgram один раз.
// GET  /api/transcript?deal=ID — токен сборщика: {ok, row: {deal, minutes, text, utt, source, created_at} | null}
// POST /api/transcript {deal, minutes, text, utt, source, share_url} — токен сборщика: сохранить (повтор не перезаписывает).
import { json, bad, hasIngestToken, now } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  const deal = Number(new URL(request.url).searchParams.get("deal"));
  if (!deal) return bad("нужен deal");
  const row = await env.DB.prepare("SELECT deal, minutes, text, utt, source, created_at FROM transcript WHERE deal = ?").bind(deal).first();
  return json({ ok: true, row: row || null });
}

export async function onRequestPost({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const deal = Number(b.deal);
  if (!deal || !(b.text || b.utt)) return bad("нужны deal и text/utt");
  const utt = typeof b.utt === "string" ? b.utt : JSON.stringify(b.utt || []);
  const r = await env.DB.prepare("INSERT INTO transcript (deal, minutes, text, utt, source, share_url, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(deal) DO NOTHING")
    .bind(deal, Number(b.minutes) || 0, String(b.text || "").slice(0, 300000), utt.slice(0, 500000), String(b.source || "").slice(0, 40), String(b.share_url || "").slice(0, 300), now()).run();
  return json({ ok: true, saved: (r.meta && r.meta.changes) || 0 });
}
