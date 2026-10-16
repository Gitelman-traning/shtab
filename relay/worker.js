// prep-relay — пересылка вебхука amoCRM в Штаб (подготовка диагноста к встрече).
// Зачем: ни amo, ни Timeweb не достукиваются до *.pages.dev, а до *.workers.dev доходят (проверено 07.10.2026).
// amo → POST https://prep-relay.gitelmanteam.workers.dev/hook?key=<PREP_HOOK_KEY> → shtab-20v.pages.dev/api/prep/hook?key=…
// Ключ здесь не хранится и не проверяется: уходит дальше в адресе, проверяет его Штаб. Секретов у воркера нет.
// 16.10.2026: ещё и часы цепочки «разбор встречи → пинги». Расписание GitHub срабатывает через раз (15.10 — 2 запуска из ~28),
// поэтому воркер сам раз в 30 минут днём шлёт repository_dispatch «debrief_auto» (секрет GH_DISPATCH_TOKEN — тот же, что у Штаба).
// Выкладка: cd shtab/relay && npx wrangler deploy
const UPSTREAM = "https://shtab-20v.pages.dev/api/prep/hook";

export default {
  async scheduled(event, env, ctx) {
    if (!env.GH_DISPATCH_TOKEN) return;
    ctx.waitUntil(fetch("https://api.github.com/repos/Gitelman-traning/shtab/dispatches", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.GH_DISPATCH_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "prep-relay" },
      body: JSON.stringify({ event_type: "debrief_auto" }),
    }));
  },
  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === "/health") return Response.json({ ok: true, upstream: UPSTREAM });
    if (request.method !== "POST" || u.pathname !== "/hook") return new Response("prep-relay", { status: 404 });
    const key = u.searchParams.get("key") || "";
    const body = await request.arrayBuffer();
    try {
      const r = await fetch(UPSTREAM + "?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") || "application/x-www-form-urlencoded", "user-agent": "prep-relay" },
        body,
      });
      // amo важно получить 200, иначе после нескольких ошибок он отключит вебхук; ответ Штаба отдаём как есть
      return new Response(await r.text(), { status: r.status === 401 ? 401 : 200, headers: { "content-type": "application/json; charset=utf-8" } });
    } catch (e) {
      return Response.json({ ok: false, error: "Штаб не ответил", why: String(e && e.message) }, { status: 200 });
    }
  },
};
