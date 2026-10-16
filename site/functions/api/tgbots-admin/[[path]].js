// Редактор своих ботов (Маркетинг → Телеграм-канал → Материалы и опросы):
// материалы по ссылке, файлы, опросы, списки. Пересылает в служебное API ядра
// tg-bots-core (/api/admin/*). Смотреть — доступ к разделу, менять — правка
// раздела marketing.telegram. Кто менял — уходит в ядро (X-Shtab-User) и в журнал.
// Рассылки: черновик, счёт сегмента, тест себе (Telegram ID из users.tg_id), запуск, стоп.

import { bad, canRead, canView, canEdit, audit } from "../_lib.js";

const SECTION = "marketing.telegram";
const CORE = "https://tg-bots-core.gitelmanteam.workers.dev";
const WRITE = new Set(["materials", "material-file", "polls", "delete",
  "broadcasts", "broadcasts/count", "broadcasts/test", "broadcasts/start", "broadcasts/stop",
  "templates", "templates/preview", "launches", "launch-circle", "launch-circle-request"]);
const READ = new Set(["materials", "polls", "lists", "bots", "broadcasts", "templates", "launches"]);

async function forward(request, env, path, user) {
  const url = new URL(request.url);
  const headers = {
    Authorization: `Bearer ${env.TG_CORE_API_TOKEN}`,
    "X-Shtab-User": user.login || "?",
  };
  // Тест рассылки уходит проверяющему в Telegram — его ID из входа в Штаб.
  if ((path === "broadcasts/test" || path === "templates/preview" || path === "launch-circle-request") && user.login) {
    const u = await env.DB.prepare("SELECT tg_id FROM users WHERE login = ?").bind(user.login).first().catch(() => null);
    if (u && u.tg_id) headers["X-Shtab-User-Tg"] = String(u.tg_id);
  }
  for (const h of ["content-type", "x-file-name"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  const r = await fetch(`${env.TG_CORE_URL || CORE}/api/admin/${path}${url.search}`, {
    method: request.method, headers, body: request.method === "POST" ? request.body : undefined,
  });
  return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("content-type") || "application/json" } });
}

export async function onRequest({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!env.TG_CORE_API_TOKEN) return bad("ядро ботов не подключено", 500);
  const path = [].concat(params.path || []).join("/");

  if (request.method === "GET") {
    if (!READ.has(path)) return bad("не найдено", 404);
    if (!canView(user, SECTION)) return bad("нет доступа к разделу «Телеграм-канал»", 403);
    return forward(request, env, path, user);
  }
  if (request.method === "POST") {
    if (!WRITE.has(path)) return bad("не найдено", 404);
    if (!canEdit(user, SECTION) || user.login === "shared") return bad("менять может только тот, у кого правка раздела «Телеграм-канал»", 403);
    const res = await forward(request, env, path, user);
    await audit(env, user.login, "tgbots." + path, new URL(request.url).searchParams.get("key") || "");
    return res;
  }
  return bad("метод не поддерживается", 405);
}
