// Скриншоты в задачах (миграция 34): картинка в KV (task-file:<key>), список в task_files.
//   GET  /api/tasks/file?id=N        — картинка; видит тот, кто видит задачу
//   POST /api/tasks/file?task=N      — тело — сама картинка (png, jpeg, webp, gif до 5 МБ), имя в заголовке x-name
//   POST /api/tasks/file?del=N       — удалить: кто прикрепил, постановщик или админ
import { json, bad, currentUser, isAdmin, now } from "../_lib.js";
import { access } from "./_tasks.js";

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX = 5 * 1024 * 1024;

async function taskFor(env, user, id) {
  const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!t) return { err: bad("задачи нет", 404) };
  if (!(await access(env, user, t))) return { err: bad("задача закрыта для вас", 403) };
  return { t };
}

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return bad("нужен личный вход", 401);
  const f = await env.DB.prepare("SELECT * FROM task_files WHERE id = ?").bind(Number(new URL(request.url).searchParams.get("id") || 0)).first();
  if (!f) return bad("файла нет", 404);
  const { err } = await taskFor(env, user, f.task);
  if (err) return err;
  const body = await env.OKK_KV.get("task-file:" + f.key, "arrayBuffer");
  if (!body) return bad("файл потерялся", 404);
  return new Response(body, { headers: { "content-type": f.type, "cache-control": "private, max-age=86400" } });
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
  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!TYPES.includes(type)) return bad("можно прикрепить картинку: png, jpg, webp или gif");
  const body = await request.arrayBuffer();
  if (!body.byteLength) return bad("пустой файл");
  if (body.byteLength > MAX) return bad("картинка больше 5 МБ");
  let name = "";
  try { name = decodeURIComponent(request.headers.get("x-name") || ""); } catch (e) { /* имя необязательно */ }
  name = name.trim().slice(0, 120) || "скриншот";
  const key = crypto.randomUUID();
  await env.OKK_KV.put("task-file:" + key, body);
  const r = await env.DB.prepare("INSERT INTO task_files (task, login, at, name, type, size, key) VALUES (?,?,?,?,?,?,?)")
    .bind(id, user.login, at, name, type, body.byteLength, key).run();
  await log(id, "file", name);
  await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(at, id).run();
  return json({ ok: true, id: r.meta.last_row_id });
}
