// /api/dashboard — личный дашборд проектов Никиты (раздел «Настройки → Дашборд проектов», только админ).
// Страницы собираются локально (Local/dashboard, build.mjs) и приходят сюда готовым HTML по токену
// сборщика: PUT {"page": "projects"|"tasks"|"brief"|"months", "html": "…"}. Лежат в KV, в git не попадают —
// в них имена коллег и внутренние планы, а репозиторий публичный.
// GET ?page=… отдаёт страницу (её показывает iframe на /settings/dashboard/), GET ?meta=1 — когда что обновлялось.
//
// Обмен задачами с Telegram-ботом (/api/tgtask), всё по токену сборщика:
//   PUT  {"tasks": [...], "projects": [...]} — копия tasks.json и проекты с ключевыми словами (бот подбирает проект)
//   GET  ?inbox=1           — очередь правок, накопленных ботом (новые задачи, закрытия)
//   POST ?ack=1 {"ids":[…]} — убрать из очереди уже применённые
// Кнопки на вкладке «Задачи и сроки» (сессия владельца дашборда):
//   POST ?task=1 {"id", "op": "prio"|"status", "value"} — приоритет high/low/null, статус open/waiting/parked/done/archived;
//   правка ложится в ту же очередь, что и у бота, в tasks.json её забирает sync.mjs
import { json, bad, hasIngestToken, currentUser, isAdmin, now, randomId } from "./_lib.js";

const PAGES = ["projects", "tasks", "brief", "months"];
const KEY = (p) => "dash:" + p;

async function put({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  const body = await request.json().catch(() => null);
  if (!body) return bad("нужен json");
  if (Array.isArray(body.tasks)) {
    // не KEY("tasks")/KEY("projects") — под ними лежат страницы дашборда
    await env.OKK_KV.put("dash:tg-tasks", JSON.stringify(body.tasks));
    if (Array.isArray(body.projects)) await env.OKK_KV.put("dash:tg-projects", JSON.stringify(body.projects));
    return json({ ok: true, tasks: body.tasks.length, projects: Array.isArray(body.projects) ? body.projects.length : undefined });
  }
  if (!PAGES.includes(body.page) || typeof body.html !== "string" || !body.html.trim()) return bad("нужны page (" + PAGES.join("|") + ") и html, или tasks");
  await env.OKK_KV.put(KEY(body.page), body.html);
  const meta = JSON.parse((await env.OKK_KV.get(KEY("meta"))) || "{}");
  meta[body.page] = now();
  await env.OKK_KV.put(KEY("meta"), JSON.stringify(meta));
  return json({ ok: true, page: body.page, size: body.html.length });
}
export const onRequestPut = put;

const STATUSES = ["open", "waiting", "parked", "done", "archived"];
async function taskEdit({ request, env }) {
  const user = await currentUser(request, env);
  if (!isAdmin(user) || user.login !== (env.DASH_OWNER || "nikita")) return bad("только владелец дашборда", 403);
  const b = await request.json().catch(() => ({}));
  const tasks = JSON.parse((await env.OKK_KV.get("dash:tg-tasks")) || "[]");
  const t = tasks.find((x) => x.id === b.id);
  if (!t) return bad("задача не найдена — пересоберите дашборд", 404);
  const ts = new Date(Date.now() + 3 * 3600e3).toISOString();
  let entry;
  if (b.op === "prio") {
    if (![null, "high", "low"].includes(b.value ?? null)) return bad("prio: high | low | null");
    if (b.value) t.prio = b.value; else delete t.prio;
    entry = { action: "prio", taskId: t.id, prio: t.prio || null };
  } else if (b.op === "status") {
    if (!STATUSES.includes(b.value)) return bad("status: " + STATUSES.join(" | "));
    t.status = b.value; if (b.value === "done") t.done = ts.slice(0, 10); else delete t.done;
    entry = { action: "status", taskId: t.id, status: b.value };
  } else return bad("op: prio | status");
  await env.OKK_KV.put("dash:tg-tasks", JSON.stringify(tasks));
  const inbox = JSON.parse((await env.OKK_KV.get(KEY("inbox"))) || "[]");
  inbox.push({ id: randomId(6), ts, source: "web", ...entry });
  await env.OKK_KV.put(KEY("inbox"), JSON.stringify(inbox));
  return json({ ok: true, task: { id: t.id, status: t.status, prio: t.prio || null } });
}

export async function onRequestPost(ctx) {
  const url = new URL(ctx.request.url);
  if (url.searchParams.get("task")) return taskEdit(ctx);
  if (!url.searchParams.get("ack")) return put(ctx);
  if (!hasIngestToken(ctx.request, ctx.env)) return bad("нет доступа", 401);
  const body = await ctx.request.json().catch(() => ({}));
  const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
  const inbox = JSON.parse((await ctx.env.OKK_KV.get(KEY("inbox"))) || "[]");
  const left = inbox.filter((e) => !ids.has(e.id));
  await ctx.env.OKK_KV.put(KEY("inbox"), JSON.stringify(left));
  return json({ ok: true, removed: inbox.length - left.length, left: left.length });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("inbox")) {
    if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
    return json({ ok: true, inbox: JSON.parse((await env.OKK_KV.get(KEY("inbox"))) || "[]") });
  }
  const user = await currentUser(request, env);
  if (!isAdmin(user)) return bad("только администратор", 403);
  if (url.searchParams.get("meta")) return json({ ok: true, pages: JSON.parse((await env.OKK_KV.get(KEY("meta"))) || "{}") });
  const page = url.searchParams.get("page") || "";
  if (!PAGES.includes(page)) return bad("page");
  const html = await env.OKK_KV.get(KEY(page));
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (!html) return new Response('<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;padding:24px;color:#777">Страница ещё не загружена — появится после ближайшей сборки дашборда (node dashboard/publish.mjs).</p>', { status: 404, headers });
  return new Response(html, { headers });
}
