// GET /api/sections/<id>/view[?v=N] — HTML собственного вида раздела (активная версия или заданная) для iframe.
import { bad, canRead, canView, canEdit } from "../../_lib.js";
import { onRequestGet as sectionData } from "./data.js";
import { isolatedView, VIEW_CSP } from "../_isolated-view.js";

export async function onRequestGet({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, params.id)) return bad("раздел закрыт", 403);
  const u = new URL(request.url);
  const v = parseInt(u.searchParams.get("v") || "0", 10);
  const row = v
    ? await env.DB.prepare("SELECT html, version FROM section_versions WHERE section = ? AND version = ?" + (canEdit(user, params.id) ? "" : " AND active = 1")).bind(params.id, v).first()
    : await env.DB.prepare("SELECT html, version FROM section_versions WHERE section = ? AND active = 1").bind(params.id).first();
  if (!row) return new Response("<!doctype html><meta charset=utf-8><p style=\"font-family:Inter,Arial;color:#7b766f;padding:20px\">Собственного вида ещё нет.</p>",
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const theme = u.searchParams.get("theme");
  let body = row.html;
  if (theme === "light" || theme === "dark") body = body.replace(/<html(\s[^>]*)?>/i, (m, a) => "<html" + (a || "") + ' data-theme="' + theme + '">');
  const dataUrl = new URL("/api/sections/" + encodeURIComponent(params.id) + "/data?days=120", u.origin).href;
  const data = await sectionData({ request: new Request(dataUrl, { headers: request.headers }), env, params });
  if (!data.ok) return data;
  return new Response(isolatedView(body, await data.json(), dataUrl), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": VIEW_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
