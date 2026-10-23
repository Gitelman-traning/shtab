// Файлы в задачах: скриншоты задачи (миграция 34) и файлы комментариев (миграция 35). Сам файл в KV (task-file:<key>), список в task_files.
//   GET  /api/tasks/file?id=N[&dl=1]          — файл тем, кто видит задачу: картинки смотрятся в браузере, md/txt/csv — простым текстом,
//                                               остальное скачивается; dl=1 — скачать всегда
//   POST /api/tasks/file?task=N               — скриншот задачи: тело — картинка (png, jpeg, webp, gif до 5 МБ), имя в заголовке x-name
//   POST /api/tasks/file?task=N&comment=M     — файл любого типа до 10 МБ к своему комментарию M (task_log.id)
//   POST /api/tasks/file?del=N                — удалить: кто прикрепил, постановщик или админ
import { json, bad, currentUser, isAdmin, now } from "../_lib.js";
import { access } from "./_tasks.js";

const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT = /\.(md|markdown|txt|csv|json|log)$/i;
const MAX_IMAGE = 5 * 1024 * 1024, MAX_FILE = 10 * 1024 * 1024;

async function taskFor(env, user, id) {
  const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!t) return { err: bad("задачи нет", 404) };
  if (!(await access(env, user, t))) return { err: bad("задача закрыта для вас", 403) };
  return { t };
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return bad("нужен личный вход", 401);
  const url = new URL(request.url);
  const f = await env.DB.prepare("SELECT * FROM task_files WHERE id = ?").bind(Number(url.searchParams.get("id") || 0)).first();
  if (!f) return bad("файла нет", 404);
  const { err } = await taskFor(env, user, f.task);
  if (err) return err;
  const body = await env.OKK_KV.get("task-file:" + f.key, "arrayBuffer");
  if (!body) return bad("файл потерялся", 404);
  // чужой html или svg с нашего адреса не открываем: всё, кроме картинок и простого текста, — только скачиванием
  const dl = url.searchParams.get("dl") === "1";
  const image = IMAGES.includes(f.type), text = TEXT.test(f.name);
  const type = image ? f.type : text ? "text/plain; charset=utf-8" : "application/octet-stream";
  const disp = (dl || (!image && !text) ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(f.name);
  return new Response(body, { headers: { "content-type": type, "content-disposition": disp, "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400" } });
}

export async function onRequestPost({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return bad("нужен личный вход", 401);
  const url = new URL(request.url);
  const at = now();
  const log = (task, kind, text) => env.DB.prepare("INSERT INTO task_log (task, at, login, kind, text) VALUES (?,?,?,?,?)").bind(task, at, user.login, kind, text).run();

  const del = Number(url.searchParams.get("del") || 0);
  if (del) {
    const f = await env.DB.prepare("SELECT * FROM task_files WHERE id = ?").bind(del).first();
    if (!f) return json({ ok: true });
    const { t, err } = await taskFor(env, user, f.task);
    if (err) return err;
    if (f.login !== user.login && t.author !== user.login && !isAdmin(user)) return bad("удалить может тот, кто прикрепил, или постановщик", 403);
    await env.DB.prepare("DELETE FROM task_files WHERE id = ?").bind(del).run();
    await env.OKK_KV.delete("task-file:" + f.key);
    await log(f.task, "unfile", f.name);
    return json({ ok: true });
  }

  const id = Number(url.searchParams.get("task") || 0);
  const { err } = await taskFor(env, user, id);
  if (err) return err;
  // файл комментария: комментарий этой задачи и написан этим человеком
  const comment = Number(url.searchParams.get("comment") || 0) || null;
  if (comment) {
    const c = await env.DB.prepare("SELECT task, login, kind FROM task_log WHERE id = ?").bind(comment).first();
    if (!c || c.task !== id || c.kind !== "comment" || c.login !== user.login) return bad("файл можно прикрепить только к своему комментарию");
  }
  let type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase().slice(0, 100);
  if (!comment && !IMAGES.includes(type)) return bad("можно прикрепить картинку: png, jpg, webp или gif");
  if (!type) type = "application/octet-stream";
  const body = await request.arrayBuffer();
  if (!body.byteLength) return bad("пустой файл");
  const max = comment ? MAX_FILE : MAX_IMAGE;
  if (body.byteLength > max) return bad("файл больше " + max / 1024 / 1024 + " МБ");
  let name = "";
  try { name = decodeURIComponent(request.headers.get("x-name") || ""); } catch (e) { /* имя необязательно */ }
  name = name.replace(/[\r\n"\\/]/g, " ").trim().slice(0, 120) || (comment ? "файл" : "скриншот");
  const key = crypto.randomUUID();
  await env.OKK_KV.put("task-file:" + key, body);
  const r = await env.DB.prepare("INSERT INTO task_files (task, login, at, name, type, size, key, comment) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, user.login, at, name, type, body.byteLength, key, comment).run();
  if (!comment) await log(id, "file", name);   // у комментария файл виден под ним, отдельная строка в ленте не нужна
  await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(at, id).run();
  return json({ ok: true, id: r.meta.last_row_id });
}
