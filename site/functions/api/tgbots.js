// База своих ботов (замена Salebot) — Маркетинг → Телеграм-канал.
// Данные живут в ядре tg-bots-core (Cloudflare Worker + D1 «tg-bots», см.
// shtab-docs/TGBOT-PLAN.md); Штаб проверяет права и пересылает запрос.
//
//   GET /api/tgbots?op=summary            — по ботам
//   GET /api/tgbots?op=tags&group=…       — разбивка по метке / UTM
//   GET /api/tgbots?op=people&…фильтры    — список людей (именной вход)
//   GET /api/tgbots?op=export&…фильтры    — CSV (именной вход, пишется в журнал)
//
// Списки и выгрузка содержат телефоны — только именным пользователям с
// доступом к разделу, общий пароль видит лишь сводку.
// Переменные Pages: TG_CORE_URL (по умолчанию workers.dev ядра), TG_CORE_API_TOKEN (секрет).

import { json, bad, canRead, canView, audit } from "./_lib.js";

const SECTION = "marketing.telegram";
const CORE = "https://tg-bots-core.gitelmanteam.workers.dev";
const PASS = ["bot", "phone", "blocked", "q", "source", "medium", "campaign", "position", "tag", "from", "to", "search", "group", "page", "size"];

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, SECTION)) return bad("нет доступа к разделу «Телеграм-канал»", 403);
  if (!env.TG_CORE_API_TOKEN) return bad("ядро ботов не подключено: нет TG_CORE_API_TOKEN", 500);

  const url = new URL(request.url);
  const op = url.searchParams.get("op") || "summary";
  const path = { summary: "/api/summary", tags: "/api/tags", people: "/api/people", export: "/api/export.csv" }[op];
  if (!path) return bad("op: summary | tags | people | export");

  const named = user.login && user.login !== "shared";
  if ((op === "people" || op === "export") && !named) return bad("список людей — только по именному входу", 403);

  const q = new URLSearchParams();
  for (const k of PASS) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k));
  const r = await fetch(`${env.TG_CORE_URL || CORE}${path}?${q}`, {
    headers: { Authorization: `Bearer ${env.TG_CORE_API_TOKEN}` },
  });

  if (op === "export") {
    await audit(env, user.login, "tgbots.export", q.toString());
    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type": r.headers.get("content-type") || "text/csv; charset=utf-8",
        "Content-Disposition": r.headers.get("content-disposition") || 'attachment; filename="bots.csv"',
      },
    });
  }
  const data = await r.json().catch(() => ({ error: `ядро ответило ${r.status}` }));
  if (!r.ok) return bad(data.error || `ядро ответило ${r.status}`, 502);
  return json({ ok: true, ...data });
}
