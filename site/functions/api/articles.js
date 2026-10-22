// Очередь статей журнала: какие статьи и когда выходят. Лежит в KV (OKK_KV, ключ articles:journal), миграция не нужна.
//   GET  /api/articles                — {items:[{id,title,slug,date,time,note,status,done_at,done_by,live}]}; читают все, кто видит «Сайт»
//   POST /api/articles {action:"save", id?, title, slug, date, time, note}   — добавить или поправить (правка раздела «Сайт»)
//   POST /api/articles {action:"done", id} | {action:"undone", id} | {action:"del", id}
//   «done» у статьи с адресом шлёт в Telegram «Опубликовано: <название>» + ссылку подписанным на тему journal (ответ: notify {sent, failed})
// live — страница journal.gitelman.team/<slug>/ отвечает 200 (проверяем только у статей, чей день уже наступил).
import { json, bad, canRead, level, audit, now, randomId, notifyTopic } from "./_lib.js";

const KEY = "articles:journal";
const HOST = "https://journal.gitelman.team/";
const SEED = [   // расписание из треда «Статьи коллеги на публикацию», 21.10.2026
  { title: "ИИ для бизнеса: четыре эпохи", slug: "ii-dlya-biznesa-chetyre-epohi", date: "2026-10-21", time: "20:00" },
  { title: "Профиль должности", slug: "profil-dolzhnosti", date: "2026-10-22", time: "20:00" },
  { title: "ИИ для HR", slug: "ii-dlya-hr", date: "2026-10-23", time: "20:00" },
  { title: "Директор по маркетингу", slug: "", date: "", time: "", note: "дата не назначена" },
];

async function load(env) {
  const raw = await env.OKK_KV.get(KEY);
  if (raw) return JSON.parse(raw);
  const items = SEED.map((s) => ({ id: randomId(6), note: "", status: "plan", ...s }));
  await env.OKK_KV.put(KEY, JSON.stringify(items));
  return items;
}

const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "marketing.site") < 1) return bad("нет доступа", 401);
  const items = await load(env);
  const today = mskToday();
  await Promise.all(items.map(async (it) => {
    if (!it.slug || !it.date || it.date > today) return;
    try { it.live = (await fetch(HOST + it.slug + "/", { method: "HEAD", redirect: "follow" })).status === 200; } catch (e) { it.live = null; }
  }));
  return json({ ok: true, items, can_edit: level(user, "marketing.site") >= 2 });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, "marketing.site") < 2) return bad("нужно право правки раздела «Сайт»", 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const items = await load(env);
  const action = String(body.action || "");
  let notify = null;
  const it = items.find((x) => x.id === body.id);
  if (action === "save") {
    const title = String(body.title || "").trim().slice(0, 200);
    const slug = String(body.slug || "").trim().toLowerCase().replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "").slice(0, 120);
    const date = String(body.date || "").trim();
    const time = String(body.time || "").trim();
    if (!title) return bad("укажите название");
    if (slug && !/^[a-z0-9-]+$/.test(slug)) return bad("адрес — латиница, цифры и дефисы");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad("дата в виде ГГГГ-ММ-ДД");
    if (time && !/^\d{2}:\d{2}$/.test(time)) return bad("время в виде ЧЧ:ММ");
    const fields = { title, slug, date, time, note: String(body.note || "").trim().slice(0, 300) };
    if (it) Object.assign(it, fields); else items.push({ id: randomId(6), status: "plan", ...fields });
  } else if (!it) {
    return bad("статья не найдена", 404);
  } else if (action === "done") {
    const first = it.status !== "done";
    Object.assign(it, { status: "done", done_at: now(), done_by: user.login });
    if (first && it.slug) notify = await notifyTopic(env, "journal", "Опубликовано: " + it.title + "\n" + HOST + it.slug + "/");
  } else if (action === "undone") {
    Object.assign(it, { status: "plan", done_at: null, done_by: null });
  } else if (action === "del") {
    items.splice(items.indexOf(it), 1);
  } else return bad("action: save, done, undone, del");
  await env.OKK_KV.put(KEY, JSON.stringify(items));
  await audit(env, user.login, "articles." + action, String(body.title || (it && it.title) || ""),
    notify ? "Telegram: " + (notify.sent.join(", ") || "никому") + (notify.failed.length ? "; не дошло: " + notify.failed.map((x) => x.name + " (" + x.error + ")").join(", ") : "") : "");
  return json({ ok: true, items, notify });
}
