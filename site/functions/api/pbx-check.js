// Проверка связи с АТС (onlinePBX), страница /pbx-check — открыта без входа (23.10.2026).
// GET  /api/pbx-check                 — журнал проверок (последние 200), только со входом в Штаб: страница /pbx-check-log.
// GET  /api/pbx-check?mode=ping       — пустой ответ для замера задержки до Штаба.
// GET  /api/pbx-check?mode=bytes&n=N  — N случайных байт (до 2 МБ) для замера скорости загрузки.
// POST /api/pbx-check?mode=sink       — принимает тело и отвечает размером (замер скорости отдачи).
// GET  /api/pbx-check?mode=whoami     — какой адрес и провайдера видит Cloudflare, и отвечает ли АТС из облака.
// POST /api/pbx-check {name, verdict, summary, details} — сохранить результат в журнал.
import { json, bad, now, canRead } from "./_lib.js";

const PBX = "pbx20965.onpbx.ru";
const TABLE = "CREATE TABLE IF NOT EXISTS pbx_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, name TEXT, verdict TEXT, summary TEXT, details TEXT, ip TEXT, place TEXT, ua TEXT)";

function place(request) {
  const cf = request.cf || {};
  return [cf.city, cf.country, cf.asOrganization].filter(Boolean).join(", ");
}

async function probe(url) {
  const t = Date.now();
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    return { ok: true, status: r.status, ms: Date.now() - t };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120), ms: Date.now() - t };
  }
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const mode = u.searchParams.get("mode");
  if (mode === "ping") return new Response("", { headers: { "cache-control": "no-store" } });
  if (mode === "bytes") {
    const n = Math.min(Math.max(Number(u.searchParams.get("n")) || 0, 1), 2_000_000);
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, n)));
    return new Response(buf, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }
  if (mode === "whoami") {
    const cf = request.cf || {};
    const [web, rtc] = await Promise.all([probe(`https://${PBX}/`), probe(`https://${PBX}:8082/`)]);
    return json({ ok: true, ip: request.headers.get("CF-Connecting-IP") || "", place: place(request), colo: cf.colo || "", tz: cf.timezone || "", pbx: { web, rtc } });
  }
  if (!(await canRead(request, env))) return bad("нужен вход в Штаб", 401);
  await env.DB.prepare(TABLE).run();
  const rows = (await env.DB.prepare("SELECT id, at, name, verdict, summary, details, ip, place FROM pbx_checks ORDER BY id DESC LIMIT 200").all()).results || [];
  // адрес в журнале показываем без последней части: для сравнения провайдеров хватает
  rows.forEach((r) => { r.ip = String(r.ip || "").replace(/([.:])[^.:]+$/, "$1*"); });
  return json({ ok: true, rows });
}

export async function onRequestPost({ request, env }) {
  const u = new URL(request.url);
  if (u.searchParams.get("mode") === "sink") {
    const body = await request.arrayBuffer();
    return json({ ok: true, size: body.byteLength });
  }
  let d;
  try { d = await request.json(); } catch (e) { return bad("нужен JSON"); }
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const verdict = ["ok", "warn", "bad"].includes(d.verdict) ? d.verdict : "warn";
  const details = s(typeof d.details === "string" ? d.details : JSON.stringify(d.details || {}), 30000);
  await env.DB.prepare(TABLE).run();
  await env.DB.prepare("INSERT INTO pbx_checks (at, name, verdict, summary, details, ip, place, ua) VALUES (?,?,?,?,?,?,?,?)")
    .bind(now(), s(d.name, 80).trim(), verdict, s(d.summary, 500), details, request.headers.get("CF-Connecting-IP") || "", place(request), s(request.headers.get("User-Agent"), 300))
    .run();
  return json({ ok: true });
}
