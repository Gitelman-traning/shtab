// GET /api/sections/<id>/view[?v=N] — HTML собственного вида раздела (активная версия или заданная) для iframe.
import { bad, canRead } from "../../_lib.js";

export async function onRequestGet({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const u = new URL(request.url);
  const v = parseInt(u.searchParams.get("v") || "0", 10);
  const row = v
    ? await env.DB.prepare("SELECT html, version FROM section_versions WHERE section = ? AND version = ?").bind(params.id, v).first()
    : await env.DB.prepare("SELECT html, version FROM section_versions WHERE section = ? AND active = 1").bind(params.id).first();
  if (!row) return new Response("<!doctype html><meta charset=utf-8><p style=\"font-family:Inter,Arial;color:#7b766f;padding:20px\">Собственного вида ещё нет.</p>",
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  return new Response(row.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      // страница раздела может ходить только на свой сайт; внешние ресурсы запрещены
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'self'",
    },
  });
}
