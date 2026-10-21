// Кнопка «Статья вышла» на странице Журнала: сообщение в Telegram всем, у кого в уведомлениях тема journal.
//   GET  /api/journal-publish                  — кому уйдёт (имена) и последние отправки из журнала
//   POST /api/journal-publish {title, url}     — отправить «Опубликовано: <название>» + ссылка
// Пишет бот Штаба (TG_BOT_TOKEN), только sendMessage: вебхук бота занят входом и задачами.
// Нажать может тот, у кого «правка» на разделе marketing.site. Повтор той же ссылки в течение 10 минут не шлётся.
import { json, bad, canRead, canEdit, canView, audit } from "./_lib.js";

const SECTION = "marketing.site";
const RE_URL = /^https:\/\/journal\.gitelman\.team\/[a-z0-9-]+\/?$/;

async function recipients(env) {
  const r = await env.DB.prepare(
    "SELECT login, name, tg_id FROM users WHERE active = 1 AND tg_id IS NOT NULL AND (',' || notify || ',') LIKE '%,journal,%' ORDER BY login").all();
  return r.results || [];
}

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user || !canView(user, SECTION)) return bad("нет доступа", 403);
  const to = await recipients(env);
  const log = await env.DB.prepare(
    "SELECT at, login, action, target, note FROM audit WHERE action IN ('journal.publish','journal.publish.fail') ORDER BY at DESC LIMIT 5").all();
  return json({ ok: true, can: canEdit(user, SECTION), to: to.map((u) => u.name || u.login), log: log.results || [] });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user || !canEdit(user, SECTION)) return bad("отправлять может тот, у кого «правка» на разделе «Сайт»", 403);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const title = String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  let url = String(b.url || "").trim();
  if (!title) return bad("впишите название статьи");
  if (url && !/\/$/.test(url)) url += "/";
  if (!RE_URL.test(url)) return bad("ссылка должна быть вида https://journal.gitelman.team/<адрес-статьи>/");
  if (!env.TG_BOT_TOKEN) return bad("бот Штаба не настроен: нет TG_BOT_TOKEN", 500);
  const to = await recipients(env);
  if (!to.length) return bad("никто не подписан на «Вышла статья журнала»: галочка ставится на странице «Пользователи»", 409);

  const key = "journal-publish:" + url;
  if (env.OKK_KV && await env.OKK_KV.get(key)) return bad("эту статью уже отправляли последние 10 минут", 409);

  const text = "Опубликовано: " + title + "\n" + url;
  const sent = [], failed = [];
  for (const u of to) {
    let err = "";
    try {
      const r = await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: u.tg_id, text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) err = d.description || ("HTTP " + r.status);
    } catch (e) { err = "Telegram не ответил"; }
    (err ? failed : sent).push({ name: u.name || u.login, error: err });
  }
  if (sent.length && env.OKK_KV) await env.OKK_KV.put(key, "1", { expirationTtl: 600 });
  const note = title + " → " + (sent.map((x) => x.name).join(", ") || "никому") + (failed.length ? "; не ушло: " + failed.map((x) => x.name + " (" + x.error + ")").join(", ") : "");
  await audit(env, user.login, failed.length ? "journal.publish.fail" : "journal.publish", url, note);
  return json({ ok: !failed.length, sent: sent.map((x) => x.name), failed, error: failed.length ? "не дошло: " + failed.map((x) => x.name + " — " + x.error).join("; ") : undefined });
}
