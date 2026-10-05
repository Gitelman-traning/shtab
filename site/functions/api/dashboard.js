// /api/dashboard — личный дашборд проектов Никиты (раздел «Настройки → Дашборд проектов», только админ).
// Страницы собираются локально (Local/dashboard, build.mjs) и приходят сюда готовым HTML по токену
// сборщика: PUT {"page": "projects"|"tasks"|"brief"|"months", "html": "…"}. Лежат в KV, в git не попадают —
// в них имена коллег и внутренние планы, а репозиторий публичный.
// GET ?page=… отдаёт страницу (её показывает iframe на /settings/dashboard/), GET ?meta=1 — когда что обновлялось.
import { json, bad, hasIngestToken, currentUser, isAdmin, now } from "./_lib.js";

const PAGES = ["projects", "tasks", "brief", "months"];
const KEY = (p) => "dash:" + p;

async function put({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  const body = await request.json().catch(() => null);
  if (!body || !PAGES.includes(body.page) || typeof body.html !== "string" || !body.html.trim()) return bad("нужны page (" + PAGES.join("|") + ") и html");
  await env.OKK_KV.put(KEY(body.page), body.html);
  const meta = JSON.parse((await env.OKK_KV.get(KEY("meta"))) || "{}");
  meta[body.page] = now();
  await env.OKK_KV.put(KEY("meta"), JSON.stringify(meta));
  return json({ ok: true, page: body.page, size: body.html.length });
}
export const onRequestPut = put;
export const onRequestPost = put;

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!isAdmin(user)) return bad("только администратор", 403);
  const url = new URL(request.url);
  if (url.searchParams.get("meta")) return json({ ok: true, pages: JSON.parse((await env.OKK_KV.get(KEY("meta"))) || "{}") });
  const page = url.searchParams.get("page") || "";
  if (!PAGES.includes(page)) return bad("page");
  const html = await env.OKK_KV.get(KEY(page));
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (!html) return new Response('<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;padding:24px;color:#777">Страница ещё не загружена — появится после ближайшей сборки дашборда (node dashboard/publish.mjs).</p>', { status: 404, headers });
  return new Response(html, { headers });
}
