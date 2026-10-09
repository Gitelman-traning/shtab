// /api/tgtask — задачи из Telegram для личного дашборда Никиты (Настройки → Дашборд проектов).
// Вебхук бота Штаба (TG_BOT_TOKEN — тот же, что у входа через Telegram). Слушает только администраторов:
// отправитель ищется в users по tg_id с role = admin, остальные сообщения молча пропускаются.
// С задачами Штаба (/tasks) не связано: это личный список Никиты, он живёт в Local/dashboard/tasks.json.
//
// Что умеет:
//   переслать боту сообщение коллеги  → задача с пометкой «переслано от …», текст целиком в заметке
//   написать текст                    → задача от себя; хвост задаёт срок: «2д», «до 10.10», «до пт», «завтра»
//   под каждой записанной задачей кнопки: ✅ Готово, Отложить, Удалить, сменить проект;
//   проект не угадан → сразу кнопки выбора проекта
//   «список» / /list                   → открытые задачи с номерами и кнопками «✅ N»
//   «готово 3» / «сделано 3»           → закрыть задачу № из последнего списка; «отложи 3» → отложить
// Проект угадывается по ключевым словам из projects.json (их присылает sync.mjs в KV dash:projects),
// а пока их нет — по запасному списку ниже.
// Данные: KV dash:tasks — копия tasks.json (присылает sync.mjs с компьютера Никиты), dash:inbox — очередь правок
// (add / status / project / delete), которую sync.mjs забирает перед каждой сборкой дашборда и применяет к tasks.json.
//
// Настройка вебхука: POST /api/tgtask?setup=1 с Bearer INGEST_TOKEN — ставит setWebhook на этот адрес
// с секретом (KV dash:tg-secret), слушает message и callback_query. GET с тем же токеном — куда смотрит вебхук.
import { json, bad, hasIngestToken, randomId, tgSend, tgRequestAccess } from "./_lib.js";

const K = { tasks: "dash:tasks", inbox: "dash:inbox", secret: "dash:tg-secret", list: "dash:tg-list", projects: "dash:projects" };
// запасной список, пока sync.mjs не прислал projects.json; слова отсюда добавляются и к присланным
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
// короткие подписи для кнопок и списка (в projects.json названия длинные)
const NAMES = { shtab: "Штаб", "amo-auto": "Отчёты amo", "site-chat": "Чат", okk: "ОКК", hh: "HH", bot: "Salebot", journal: "Журнал", potok: "Поток", youtube: "YouTube", inbox: "Без проекта" };
const DOW = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0 };
const STATUS = { open: "в работе", waiting: "ждём", done: "✅ сделано", parked: "отложено", deleted: "удалено" };

const msk = () => new Date(Date.now() + 3 * 3600e3);
const today = () => msk().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const workdays = (d, n) => { let x = d, left = n; while (left > 0) { x = addDays(x, 1); const w = new Date(x + "T00:00:00Z").getUTCDay(); if (w !== 0 && w !== 6) left--; } return x; };
const dm = (d) => d ? `${+d.slice(8, 10)}.${d.slice(5, 7)}` : "";

async function readJson(env, key, fallback) { try { return JSON.parse((await env.OKK_KV.get(key)) || "") ?? fallback; } catch { return fallback; } }
const writeJson = (env, key, v) => env.OKK_KV.put(key, JSON.stringify(v));

async function tg(env, method, payload) {
  if (!env.TG_BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    return await r.json();
  } catch { return null; }
}

async function isAdminTg(env, tgId) {
  if (!env.DB || !tgId) return null;
  const r = await env.DB.prepare("SELECT login, name FROM users WHERE tg_id = ? AND role = 'admin' AND active = 1").bind(tgId).first();
  return r || null;
}

// [{id, label, words}] — из projects.json (через sync.mjs) плюс запасные слова; «Без проекта» не входит
async function loadProjects(env) {
  const sent = await readJson(env, K.projects, []);
  const list = (Array.isArray(sent) && sent.length ? sent : Object.keys(PROJECTS).map((id) => ({ id })))
    .filter((p) => p && p.id && p.id !== "inbox")
    .map((p) => ({
      id: p.id,
      label: NAMES[p.id] || p.short || String(p.name || p.id).slice(0, 20),
      words: [...new Set([...(p.keywords || []), ...(PROJECTS[p.id] || []), ...(NAMES[p.id] ? [NAMES[p.id]] : [])]
        .map((w) => String(w).toLowerCase()).filter((w) => w.trim().length >= 2))],
    }));
  return list;
}
const labelOf = (projects, id) => (projects.find((p) => p.id === id) || {}).label || NAMES[id] || id;

// проект с наибольшим числом совпавших слов; ничья или ноль → «Без проекта» (кнопками выберет сам)
function projectOf(projects, text) {
  const t = " " + text.toLowerCase().replace(/ё/g, "е") + " ";
  let best = "inbox", score = 0, tie = false;
  for (const p of projects) {
    const n = p.words.filter((w) => t.includes(w.replace(/ё/g, "е"))).length;
    if (n > score) { best = p.id; score = n; tie = false; } else if (n && n === score) tie = true;
  }
  return tie ? "inbox" : best;
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

// что за вложение, если текста нет: голосовое, фото, файл…
function mediaKind(msg) {
  if (msg.voice || msg.video_note) return "голосовое";
  if (msg.photo) return "фото";
  if (msg.video) return "видео";
  if (msg.document) return "файл " + (msg.document.file_name || "");
  if (msg.sticker) return "стикер";
  return "";
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

// карточка задачи: текст + кнопки под ним (callback_data до 64 байт: «д:<id>»)
function card(projects, t, from, menu) {
  const lines = [
    (t.status === "open" ? "Записал: " : "") + t.title,
    [labelOf(projects, t.project), t.status === "open" ? (t.due ? "до " + dm(t.due) : "") : STATUS[t.status] || t.status, from ? "от " + from : ""].filter(Boolean).join(" · "),
  ];
  if (t.status === "deleted") return { text: "Удалил: " + t.title, reply_markup: { inline_keyboard: [[{ text: "Вернуть", callback_data: "o:" + t.id }]] } };
  const kb = [];
  if (menu || (t.status === "open" && t.project === "inbox")) {
    if (!menu) lines.push("Проект не угадал — выбери:");
    const opts = projects.filter((p) => p.id !== t.project).map((p) => ({ text: p.label, callback_data: `j:${p.id}:${t.id}` }));
    if (t.project !== "inbox") opts.push({ text: "Без проекта", callback_data: `j:inbox:${t.id}` });
    for (let i = 0; i < opts.length; i += 3) kb.push(opts.slice(i, i + 3));
  }
  if (t.status === "open" || t.status === "waiting") {
    kb.push([{ text: "✅ Готово", callback_data: "d:" + t.id }, { text: "Отложить", callback_data: "p:" + t.id }, { text: "Удалить", callback_data: "x:" + t.id }]);
    if (!menu && t.project !== "inbox") kb.push([{ text: "Сменить проект", callback_data: "m:" + t.id }]);
  } else {
    kb.push([{ text: "Вернуть в работу", callback_data: "o:" + t.id }]);
  }
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: kb } };
}

const HELP = "Перешли мне сообщение коллеги — запишу задачей и сам подберу проект. Или напиши задачу сам: «Проверить таблицу hh 2д», «Ключ Wazzup в Doppler до пт».\nПод каждой задачей кнопки: ✅ Готово, Отложить, сменить проект.\n«список» — открытые задачи, «готово 3» — закрыть третью из списка.";

// «удалено» в tasks.json не попадает: sync.mjs убирает задачу, а «Вернуть» присылает её заново целиком
async function setStatus(env, tasks, t, status) {
  const wasDeleted = t.status === "deleted";
  t.status = status; if (status === "done") t.done = today(); else delete t.done;
  await writeJson(env, K.tasks, tasks);
  if (status === "deleted") await pushInbox(env, { action: "delete", taskId: t.id });
  else if (wasDeleted) await pushInbox(env, { action: "add", task: { ...t } });
  else await pushInbox(env, { action: "status", taskId: t.id, status });
}

async function handle(env, msg) {
  const chat = msg.chat && msg.chat.id;
  const from = forwardedFrom(msg);
  let text = String(msg.text || msg.caption || "").trim();
  if (!text && from && mediaKind(msg)) text = `${mediaKind(msg)} от ${from}`.trim();
  const low = text.toLowerCase();
  const tasks = await readJson(env, K.tasks, []);
  const projects = await loadProjects(env);

  if (!text || low === "/start" || /^(помощь|help|\/help)$/.test(low)) { await tgSend(env, chat, HELP); return; }

  if (!from && /^(\/list|список|задачи)$/.test(low)) {
    const list = openTasks(tasks);
    if (!list.length) { await tgSend(env, chat, "Открытых задач нет."); return; }
    const map = {};
    const shown = list.slice(0, 30);
    const lines = shown.map((t, i) => { map[i + 1] = t.id; return `${i + 1}. [${labelOf(projects, t.project)}] ${t.title}${t.status === "waiting" ? " · ждём" : t.due ? " · до " + dm(t.due) : ""}`; });
    await writeJson(env, K.list, { at: msk().toISOString(), map });
    const kb = [];
    for (let i = 0; i < shown.length; i += 6) kb.push(shown.slice(i, i + 6).map((t, j) => ({ text: `✅ ${i + j + 1}`, callback_data: "d:" + t.id })));
    await tg(env, "sendMessage", {
      chat_id: chat, disable_web_page_preview: true, reply_markup: { inline_keyboard: kb },
      text: lines.join("\n") + (list.length > 30 ? `\n…и ещё ${list.length - 30}` : "") + "\n\nКнопка ✅ N — закрыть. Текстом: «готово N», «отложи N».",
    });
    return;
  }

  const cmd = !from && /^(готово|сделано|закрой|закрыть|отложи|отложить|верни|вернуть)\s+(\d+)\s*$/i.exec(text);
  if (cmd) {
    const list = await readJson(env, K.list, { map: {} });
    const id = list.map && list.map[cmd[2]];
    const t = id && tasks.find((x) => x.id === id);
    if (!t) { await tgSend(env, chat, "Не нашёл номер " + cmd[2] + " — сначала «список»."); return; }
    const status = /^(готово|сделано|закрой|закрыть)/i.test(cmd[1]) ? "done" : /^(верни|вернуть)/i.test(cmd[1]) ? "open" : "parked";
    await setStatus(env, tasks, t, status);
    await tgSend(env, chat, (status === "done" ? "Закрыл: " : status === "parked" ? "Отложил: " : "Вернул в работу: ") + t.title);
    return;
  }

  // новая задача — своя или пересланная
  const parsed = parseDue(from ? text.split("\n")[0] : text.replace(/^\+\s*/, ""));
  const title = parsed.title.slice(0, 160) || "задача из Telegram";
  const project = projectOf(projects, text);
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
  await tg(env, "sendMessage", { chat_id: chat, disable_web_page_preview: true, reply_to_message_id: msg.message_id, ...card(projects, task, from) });
}

// нажатие кнопки под задачей
async function handleButton(env, cq) {
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: text || "" });
  const m = /^([dpxomj]):(?:([^:]+):)?(.+)$/.exec(String(cq.data || ""));
  if (!m) return answer();
  const [, op, proj, id] = m;
  const tasks = await readJson(env, K.tasks, []);
  const projects = await loadProjects(env);
  const t = tasks.find((x) => x.id === id);
  if (!t) return answer("Задача не найдена — возможно, уже удалена в дашборде");
  const fromLine = t.source === "telegram-forward" ? (/переслано от (.+?), \d/.exec(t.why || "") || [])[1] : null;
  let menu = false, note = "";
  if (op === "d") { await setStatus(env, tasks, t, "done"); note = "Закрыл"; }
  else if (op === "p") { await setStatus(env, tasks, t, "parked"); note = "Отложил"; }
  else if (op === "x") { await setStatus(env, tasks, t, "deleted"); note = "Удалил"; }
  else if (op === "o") { await setStatus(env, tasks, t, "open"); note = "Вернул в работу"; }
  else if (op === "m") { menu = true; }
  else if (op === "j") {
    t.project = proj;
    await writeJson(env, K.tasks, tasks);
    await pushInbox(env, { action: "project", taskId: t.id, project: proj });
    note = "Проект: " + labelOf(projects, proj);
  }
  // в списке задач кнопки «✅ N» — сам список не перерисовываем, только подтверждаем
  if (cq.message && !/^Кнопка ✅|\n\nКнопка ✅/.test(cq.message.text || "")) {
    await tg(env, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, disable_web_page_preview: true, ...card(projects, t, fromLine, menu) });
  }
  return answer(note ? note + ": " + t.title.slice(0, 60) : "");
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
      body: JSON.stringify({ url: hook, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
    });
    return json({ ok: r.ok, hook, telegram: await r.json().catch(() => null) });
  }

  // вебхук Telegram
  const secret = await env.OKK_KV.get(K.secret);
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return bad("нет доступа", 403);
  const update = await request.json().catch(() => null);
  const cq = update && update.callback_query;
  if (cq) {
    if (cq.from && await isAdminTg(env, cq.from.id)) {
      try { await handleButton(env, cq); } catch (e) { await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось: " + (e.message || e) }); }
    }
    return json({ ok: true });
  }
  const msg = update && update.message;
  if (!msg || !msg.from || msg.chat?.type !== "private") return json({ ok: true });
  // вход с сайта: «/start <код>» — код выдан страницей входа (/__tglink), привязываем к нему аккаунт
  const start = /^\/start\s+([a-f0-9]{32})\s*$/.exec(String(msg.text || ""));
  if (start && env.DB) {
    const key = "tglogin:" + start[1];
    const st = await env.OKK_KV.get(key);
    if (!st) { await tgSend(env, msg.chat.id, "Ссылка для входа устарела. Откройте " + url.origin + " и нажмите «Войти через Telegram» ещё раз."); return json({ ok: true }); }
    try {
      const req = await tgRequestAccess(env, msg.from, url.origin);
      if (req.status === "active") {
        await env.OKK_KV.put(key, JSON.stringify({ status: "ok", login: req.login }), { expirationTtl: 600 });
        await env.DB.prepare("UPDATE users SET tg_username = ? WHERE login = ?").bind(msg.from.username || "", req.login).run();
        await tgSend(env, msg.chat.id, "Готово: вернитесь во вкладку Штаба, она откроется сама.");
      } else {
        await env.OKK_KV.put(key, JSON.stringify({ status: "pending" }), { expirationTtl: 600 });
        if (req.status === "pending") await tgSend(env, msg.chat.id, "Заявка уже отправлена, ждёт подтверждения администратора. Напишем, когда доступ откроют.");
      }
    } catch (e) { await tgSend(env, msg.chat.id, "Не получилось: " + (e.message || e)); }
    return json({ ok: true });
  }
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
