// /api/tgtask — задачи из Telegram для личного дашборда Никиты (Настройки → Дашборд проектов).
// Вебхук бота Штаба (TG_BOT_TOKEN — тот же, что у входа через Telegram). Слушает только администраторов:
// отправитель ищется в users по tg_id с role = admin, остальные сообщения молча пропускаются.
//
// Что умеет:
//   переслать боту сообщение коллеги  → задача с пометкой «переслано от …», текст целиком в заметке
//   написать текст                    → задача от себя; хвост задаёт срок: «2д», «до 10.10», «до пт», «завтра»
//   «список» / /list                   → открытые задачи с номерами
//   «готово 3» / «сделано 3»           → закрыть задачу № из последнего списка; «отложи 3» → отложить
// Данные: KV dash:tasks — копия tasks.json (присылает sync.mjs с компьютера Никиты), dash:inbox — очередь правок,
// которую sync.mjs забирает перед каждой сборкой дашборда и применяет к tasks.json.
//
// Настройка вебхука один раз: POST /api/tgtask?setup=1 с Bearer INGEST_TOKEN — ставит setWebhook на этот адрес
// с секретом (KV dash:tg-secret). GET ?setup=1 с тем же токеном — показать, куда сейчас смотрит вебхук.
import { json, bad, hasIngestToken, randomId, tgSend, tgRequestAccess } from "./_lib.js";

const K = { tasks: "dash:tasks", inbox: "dash:inbox", secret: "dash:tg-secret", list: "dash:tg-list" };
const PROJECTS = {
  shtab: ["штаб", "shtab", "витрин", "doppler", "пинг", "окна", "окно"],
  "amo-auto": ["amo", "амо", "заявк", "отчёт", "отчет", "выгруз", "телефони", "wazzup", "сторож", "зин", "воронк"],
  "site-chat": ["чат", "блогер", "ссылк", "инфлюенс", "quiz", "анкет"],
  okk: ["окк", "диагност", "коуч", "zoom", "зум"],
  hh: ["hh", "резюме", "ваканс", "отклик"],
  bot: ["salebot", "сейлбот", "бот"],
  journal: ["журнал", "timeweb"],
  potok: ["поток", "potok"],
  youtube: ["youtube", "ютуб", "google ads"],
};
const NAMES = { shtab: "Штаб", "amo-auto": "Отчёты amo", "site-chat": "Чат", okk: "ОКК", hh: "HH", bot: "Salebot", journal: "Журнал", potok: "Поток", youtube: "YouTube", inbox: "Без проекта" };
const DOW = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0 };

const msk = () => new Date(Date.now() + 3 * 3600e3);
const today = () => msk().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const workdays = (d, n) => { let x = d, left = n; while (left > 0) { x = addDays(x, 1); const w = new Date(x + "T00:00:00Z").getUTCDay(); if (w !== 0 && w !== 6) left--; } return x; };
const dm = (d) => d ? `${+d.slice(8, 10)}.${d.slice(5, 7)}` : "";

async function readJson(env, key, fallback) { try { return JSON.parse((await env.OKK_KV.get(key)) || "") ?? fallback; } catch { return fallback; } }
const writeJson = (env, key, v) => env.OKK_KV.put(key, JSON.stringify(v));

async function isAdminTg(env, tgId) {
  if (!env.DB || !tgId) return null;
  const r = await env.DB.prepare("SELECT login, name FROM users WHERE tg_id = ? AND role = 'admin' AND active = 1").bind(tgId).first();
  return r || null;
}

function projectOf(text) {
  const t = text.toLowerCase();
  let best = "inbox", score = 0;
  for (const [id, words] of Object.entries(PROJECTS)) {
    const n = words.filter((w) => t.includes(w)).length;
    if (n > score) { best = id; score = n; }
  }
  return best;
}

// срок из хвоста: «2д», «3 дня», «до 10.10», «до пт», «завтра», «сегодня»; возвращает {due, est, title без хвоста}
function parseDue(title) {
  const t0 = today();
  let due = null, est = null, s = title;
  let m;
  if ((m = /(?:^|\s)(\d{1,2})\s*(?:д|дн|дня|дней)\b\.?$/i.exec(s))) { est = +m[1]; due = workdays(t0, est); s = s.slice(0, m.index); }
  else if ((m = /\bдо\s+(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\s*$/i.exec(s))) {
    let y = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : t0.slice(0, 4);
    due = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (!m[3] && due < t0) due = `${+y + 1}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    s = s.slice(0, m.index);
  } else if ((m = /\bдо\s+(пн|вт|ср|чт|пт|сб|вс)\b\.?$/i.exec(s))) {
    const want = DOW[m[1].toLowerCase()]; let d = t0;
    do { d = addDays(d, 1); } while (new Date(d + "T00:00:00Z").getUTCDay() !== want);
    due = d; s = s.slice(0, m.index);
  } else if (/\bзавтра\b\.?$/i.test(s)) { due = workdays(t0, 1); s = s.replace(/\s*завтра\.?$/i, ""); }
  else if (/\bсегодня\b\.?$/i.test(s)) { due = t0; s = s.replace(/\s*сегодня\.?$/i, ""); }
  if (!est) { est = 1; if (!due) due = workdays(t0, 1); }
  return { due, est, title: s.replace(/[\s,;:—-]+$/, "").trim() };
}

function forwardedFrom(msg) {
  const o = msg.forward_origin;
  if (o) {
    if (o.type === "user" && o.sender_user) return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ");
    if (o.type === "hidden_user") return o.sender_user_name || "скрытый отправитель";
    if (o.chat) return o.chat.title || o.chat.username || "чат";
  }
  if (msg.forward_from) return [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(" ");
  if (msg.forward_sender_name) return msg.forward_sender_name;
  if (msg.forward_from_chat) return msg.forward_from_chat.title || "чат";
  return null;
}

async function pushInbox(env, entry) {
  const inbox = await readJson(env, K.inbox, []);
  inbox.push({ id: randomId(6), ts: msk().toISOString(), ...entry });
  await writeJson(env, K.inbox, inbox);
}

function openTasks(tasks) {
  const rank = (t) => (t.status === "open" ? 0 : 1);
  return tasks.filter((t) => t.status === "open" || t.status === "waiting")
    .sort((a, b) => rank(a) - rank(b) || (a.due || "9999").localeCompare(b.due || "9999"));
}

const HELP = "Перешли мне сообщение коллеги — запишу задачей. Или напиши задачу сам: «Проверить таблицу hh 2д», «Ключ Wazzup в Doppler до пт».\n«список» — открытые задачи, «готово 3» — закрыть третью из списка, «отложи 3» — отложить.";

async function handle(env, msg) {
  const chat = msg.chat && msg.chat.id;
  const text = String(msg.text || msg.caption || "").trim();
  const low = text.toLowerCase();
  const tasks = await readJson(env, K.tasks, []);

  if (!text || low === "/start" || /^(помощь|help|\/help)$/.test(low)) { await tgSend(env, chat, HELP); return; }

  if (/^(\/list|список|задачи)$/.test(low)) {
    const list = openTasks(tasks);
    if (!list.length) { await tgSend(env, chat, "Открытых задач нет."); return; }
    const map = {};
    const lines = list.slice(0, 30).map((t, i) => { map[i + 1] = t.id; return `${i + 1}. [${NAMES[t.project] || t.project}] ${t.title}${t.status === "waiting" ? " · ждём" : t.due ? " · до " + dm(t.due) : ""}`; });
    await writeJson(env, K.list, { at: msk().toISOString(), map });
    await tgSend(env, chat, lines.join("\n") + (list.length > 30 ? `\n…и ещё ${list.length - 30}` : "") + "\n\nЗакрыть: «готово N». Отложить: «отложи N».");
    return;
  }

  const cmd = /^(готово|сделано|закрой|закрыть|отложи|отложить|верни|вернуть)\s+(\d+)\s*$/i.exec(text);
  if (cmd) {
    const list = await readJson(env, K.list, { map: {} });
    const id = list.map && list.map[cmd[2]];
    const t = id && tasks.find((x) => x.id === id);
    if (!t) { await tgSend(env, chat, "Не нашёл номер " + cmd[2] + " — сначала «список»."); return; }
    const status = /^(готово|сделано|закрой|закрыть)/i.test(cmd[1]) ? "done" : /^(верни|вернуть)/i.test(cmd[1]) ? "open" : "parked";
    t.status = status; if (status === "done") t.done = today(); else delete t.done;
    await writeJson(env, K.tasks, tasks);
    await pushInbox(env, { action: "status", taskId: t.id, status });
    await tgSend(env, chat, (status === "done" ? "Закрыл: " : status === "parked" ? "Отложил: " : "Вернул в работу: ") + t.title);
    return;
  }

  // новая задача — своя или пересланная
  const from = forwardedFrom(msg);
  const parsed = parseDue(from ? text.split("\n")[0] : text.replace(/^\+\s*/, ""));
  const title = (from ? parsed.title : parsed.title).slice(0, 160) || "задача из Telegram";
  const project = projectOf(text);
  const id = `${project}-tg${Date.now().toString(36)}`;
  const task = {
    id, project, title, created: today(), estimateDays: parsed.est, due: parsed.due, status: "open",
    source: from ? "telegram-forward" : "telegram",
    why: from ? `переслано от ${from}, ${dm(today())}` : `написал в Telegram ${dm(today())}`,
  };
  if (from || text.length > title.length) task.note = text.slice(0, 1500);
  tasks.push(task);
  await writeJson(env, K.tasks, tasks);
  await pushInbox(env, { action: "add", task });
  await tgSend(env, chat, `Записал: ${title}\n${NAMES[project]} · до ${dm(parsed.due)} · оценка ${parsed.est} дн${from ? " · от " + from : ""}${project === "inbox" ? "\nПроект не угадал — утренний бриф привяжет или оставит в «Без проекта»." : ""}`);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);

  // настройка вебхука — по токену сборщика
  if (url.searchParams.get("setup")) {
    if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
    if (!env.TG_BOT_TOKEN) return bad("TG_BOT_TOKEN не задан", 500);
    let secret = await env.OKK_KV.get(K.secret);
    if (!secret) { secret = randomId(24); await env.OKK_KV.put(K.secret, secret); }
    const hook = `${url.origin}/api/tgtask`;
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: hook, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true }),
    });
    return json({ ok: r.ok, hook, telegram: await r.json().catch(() => null) });
  }

  // вебхук Telegram
  const secret = await env.OKK_KV.get(K.secret);
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return bad("нет доступа", 403);
  const update = await request.json().catch(() => null);
  const msg = update && update.message;
  if (!msg || !msg.from || msg.chat?.type !== "private") return json({ ok: true });
  const admin = await isAdminTg(env, msg.from.id);
  if (!admin) {
    // не администратор: единственное, что умеет бот в личке, — принять заявку на доступ в Штаб (запасной путь к виджету на сайте)
    if (!env.DB) return json({ ok: true });
    try {
      const req = await tgRequestAccess(env, msg.from, url.origin);
      if (req.status === "pending") await tgSend(env, msg.chat.id, "Заявка уже отправлена, ждёт подтверждения администратора. Напишем, когда доступ откроют.");
      if (req.status === "active") await tgSend(env, msg.chat.id, "Доступ уже есть: откройте " + url.origin + " и нажмите «Войти через Telegram».");
    } catch (e) { /* молча: чужим не отвечаем ошибками */ }
    return json({ ok: true });
  }
  try { await handle(env, msg); } catch (e) { await tgSend(env, msg.chat.id, "Не получилось записать: " + (e.message || e)); }
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
  if (!env.TG_BOT_TOKEN) return bad("TG_BOT_TOKEN не задан", 500);
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getWebhookInfo`);
  return json({ ok: r.ok, webhook: await r.json().catch(() => null), inbox: (await readJson(env, K.inbox, [])).length });
}
