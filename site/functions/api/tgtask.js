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
//   POST ?digest=1 (токен сборщика)     → утренний разбор хвоста: до 10 самых старых просроченных с кнопками,
//                                         ⏩ переносит на 2 рабочих дня и считает переносы (поле moved)
//
// Задачи из чатов сами, без пересылки (с 19.10.2026) — два пути, оба без api_id и выгрузок:
//   группы:   бота добавляют в группу (в BotFather /setprivacy → Disable, либо бот — админ группы). На первое сообщение
//             бот спрашивает Никиту в личке: «Все сообщения» / «Только с @упоминанием или ответом мне» / «Не записывать».
//   личные:   Telegram Business (нужен Premium): Настройки → Telegram Business → Чат-боты → этот бот → выбрать чаты.
//             У бота в BotFather должен быть включён Business Mode. Сообщения выбранных собеседников приходят как
//             business_message, записываются все (чаты выбраны в самом Telegram); свои исходящие пропускаем.
//   Карточка задачи с кнопками идёт в личку Никите, в сам чат бот НИКОГДА не пишет (в бизнес-чате это было бы «от Никиты»).
//   Пропускаем: свои сообщения, ботов, «ок/спасибо/👍» и короче 3 букв. В заметке — текст и ссылка на сообщение (супергруппы).
//   «чаты» → список известных чатов с кнопками режима. Режимы в KV dash:tg-watch, бизнес-подключения — dash:tg-biz.
//
// Проект угадывается по ключевым словам из projects.json (их присылает sync.mjs в KV dash:tg-projects),
// а пока их нет — по запасному списку ниже.
// Данные: KV dash:tg-tasks — копия tasks.json (присылает sync.mjs с компьютера Никиты), dash:inbox — очередь правок
// (add / status / project / due / delete), которую sync.mjs забирает перед каждой сборкой дашборда и применяет к tasks.json.
//
// Настройка вебхука: POST /api/tgtask?setup=1 с Bearer INGEST_TOKEN — ставит setWebhook на этот адрес
// с секретом (KV dash:tg-secret), слушает message, callback_query, business_connection и business_message.
// GET с тем же токеном — куда смотрит вебхук.
import { handleAmoButton } from "./influence-links.js";
import { json, bad, hasIngestToken, randomId, tgSend, tgRequestAccess } from "./_lib.js";

// dash:tasks / dash:projects заняты страницами дашборда (/api/dashboard?page=…) — данные бота живут под dash:tg-*
const K = { tasks: "dash:tg-tasks", inbox: "dash:inbox", secret: "dash:tg-secret", list: "dash:tg-list", projects: "dash:tg-projects", watch: "dash:tg-watch", biz: "dash:tg-biz" };
// режимы чата: all — все сообщения, mention — только с @упоминанием/ответом Никите, off — не записывать, ask — ждём ответа Никиты
const MODES = { all: "все сообщения", mention: "только @упоминания и ответы мне", off: "не записывать", ask: "ждёт выбора" };
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
const STATUS = { open: "в работе", waiting: "ждём", done: "✅ сделано", parked: "⏸ на паузе", archived: "📦 в архиве", deleted: "удалено" };
// приоритет задачи (поле prio): high — 🔥 первым в плане, low — ↓ в конец; без поля — обычный
const PRIO_UP = { low: null, undefined: "high", null: "high", high: "high" };
const PRIO_DOWN = { high: null, undefined: "low", null: "low", low: "low" };
const prioMark = (t) => (t.prio === "high" ? "🔥 " : t.prio === "low" ? "↓ " : "");

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

// дашборд личный: задачи принимаем только от его владельца (DASH_OWNER, по умолчанию nikita), другие админы — как все
async function isAdminTg(env, tgId) {
  if (!env.DB || !tgId) return null;
  const r = await env.DB.prepare("SELECT login, name FROM users WHERE tg_id = ? AND role = 'admin' AND active = 1 AND login = ?").bind(tgId, env.DASH_OWNER || "nikita").first();
  return r || null;
}

// владелец дашборда — кому слать карточки из чатов и чьи сообщения пропускать: {tg_id, tg_username}
async function owner(env) {
  if (!env.DB) return null;
  const r = await env.DB.prepare("SELECT tg_id, tg_username FROM users WHERE login = ? AND role = 'admin' AND active = 1").bind(env.DASH_OWNER || "nikita").first();
  return r && r.tg_id ? { id: Number(r.tg_id), username: String(r.tg_username || "").replace(/^@/, "").toLowerCase() } : null;
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
// (без \b: в JS он не видит границ кириллических слов — до 19.10 хвосты не распознавались вовсе)
function parseDue(title) {
  const t0 = today();
  let due = null, est = null, s = title;
  let m;
  if ((m = /(?:^|\s)(\d{1,2})\s*(?:д|дн|дня|дней)\.?$/i.exec(s))) { est = +m[1]; due = workdays(t0, est); s = s.slice(0, m.index); }
  else if ((m = /(?:^|\s)до\s+(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\.?\s*$/i.exec(s))) {
    let y = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : t0.slice(0, 4);
    due = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (!m[3] && due < t0) due = `${+y + 1}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    s = s.slice(0, m.index);
  } else if ((m = /(?:^|\s)до\s+(пн|вт|ср|чт|пт|сб|вс)\.?$/i.exec(s))) {
    const want = DOW[m[1].toLowerCase()]; let d = t0;
    do { d = addDays(d, 1); } while (new Date(d + "T00:00:00Z").getUTCDay() !== want);
    due = d; s = s.slice(0, m.index);
  } else if (/(?:^|\s)завтра\.?$/i.test(s)) { due = workdays(t0, 1); s = s.replace(/\s*завтра\.?$/i, ""); }
  else if (/(?:^|\s)сегодня\.?$/i.test(s)) { due = t0; s = s.replace(/\s*сегодня\.?$/i, ""); }
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
  const pr = (t) => (t.prio === "high" ? 0 : t.prio === "low" ? 2 : 1);
  return tasks.filter((t) => t.status === "open" || t.status === "waiting")
    .sort((a, b) => pr(a) - pr(b) || rank(a) - rank(b) || (a.due || "9999").localeCompare(b.due || "9999"));
}

// карточка задачи: текст + кнопки под ним (callback_data до 64 байт: «д:<id>»)
function card(projects, t, from, menu) {
  const lines = [
    prioMark(t) + t.title,
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
    kb.push([{ text: "✅ Сделано", callback_data: "d:" + t.id }, { text: "⏸ Пауза", callback_data: "p:" + t.id }, { text: "📦 Архив", callback_data: "a:" + t.id }]);
    kb.push([
      ...(t.prio !== "high" ? [{ text: "🔥 Выше", callback_data: "u:" + t.id }] : []),
      ...(t.prio !== "low" ? [{ text: "↓ Ниже", callback_data: "w:" + t.id }] : []),
      ...(!menu && t.project !== "inbox" ? [{ text: "Проект", callback_data: "m:" + t.id }] : []),
      { text: "🗑", callback_data: "x:" + t.id },
    ]);
  } else {
    kb.push([{ text: "▶️ В работу", callback_data: "o:" + t.id }]);
  }
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: kb } };
}

const HELP = "Перешли мне сообщение коллеги — запишу задачей и сам подберу проект. Или напиши задачу сам: «Проверить таблицу hh 2д», «Ключ Wazzup в Doppler до пт».\nПод каждой задачей кнопки: ✅ сделано, ⏸ пауза, 📦 архив, 🔥 выше / ↓ ниже приоритет, сменить проект.\n«список» — открытые задачи, «готово 3» — закрыть третью из списка.\n\nЧтобы задачи приходили из чатов сами: добавь меня в группу (спрошу, что записывать) или подключи как чат-бота в Telegram Business и выбери личные чаты. «чаты» — что я слушаю и в каком режиме.";

// ── задачи из чатов без пересылки: группы, куда добавлен бот, и личные чаты через Telegram Business ──
const ACK = /^(ок|окей|ok|okay|да|нет|ага|угу|спасибо|спс|благодарю|принял|принято|понял|поняла|хорошо|супер|отлично|класс|готово|сделано|\+|[\p{Extended_Pictographic}\s.!?)]+)$/iu;
const senderName = (u) => u ? ([u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "кто-то") : "кто-то";
const chatTitle = (chat) => chat.title || senderName(chat) || String(chat.id);
const msgLink = (chat, msgId) => chat.username ? `https://t.me/${chat.username}/${msgId}`
  : /^-100\d+$/.test(String(chat.id)) ? `https://t.me/c/${String(chat.id).slice(4)}/${msgId}` : "";

// есть ли в сообщении обращение к владельцу: @username, упоминание без username или ответ на его сообщение
function mentionsOwner(msg, own) {
  if (msg.reply_to_message && msg.reply_to_message.from && Number(msg.reply_to_message.from.id) === own.id) return true;
  const text = String(msg.text || msg.caption || "");
  for (const e of [...(msg.entities || []), ...(msg.caption_entities || [])]) {
    if (e.type === "text_mention" && e.user && Number(e.user.id) === own.id) return true;
    if (e.type === "mention" && own.username && text.slice(e.offset, e.offset + e.length).toLowerCase() === "@" + own.username) return true;
  }
  return false;
}

// текст задачи из чужого сообщения: пусто или «ок/спасибо/👍» → null (не задача)
function chatText(msg, name) {
  let text = String(msg.text || msg.caption || "").trim();
  if (!text && mediaKind(msg)) text = `${mediaKind(msg)} от ${name}`.trim();
  if (!text || ACK.test(text) || text.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return null;
  return text;
}

// записать задачу из сообщения чата и прислать карточку владельцу в личку; src = {chat, message_id, name, text}
async function addChatTask(env, own, src, entry) {
  const { text, name } = src;
  const tasks = await readJson(env, K.tasks, []);
  const projects = await loadProjects(env);
  const parsed = parseDue(text.split("\n")[0]);
  const title = parsed.title.slice(0, 160) || "задача из чата";
  const project = projectOf(projects, text);
  const link = msgLink(src.chat, src.message_id);
  const from = `${name} из «${entry.title}»`;
  const task = {
    id: `${project}-tg${Date.now().toString(36)}`, project, title, created: today(), estimateDays: parsed.est, due: parsed.due, status: "open",
    source: "telegram-chat", why: `от ${from}, ${dm(today())}`, note: (text + (link ? "\n" + link : "")).slice(0, 1500),
  };
  tasks.push(task);
  await writeJson(env, K.tasks, tasks);
  await pushInbox(env, { action: "add", task });
  await tg(env, "sendMessage", { chat_id: own.id, disable_web_page_preview: true, ...card(projects, task, from) });
  return true;
}

// клавиатура выбора режима для чата (callback_data «c:<режим>:<id чата>»)
const modeKeyboard = (chatId, kind) => ({ inline_keyboard: [
  [{ text: "Все сообщения", callback_data: `c:all:${chatId}` }],
  ...(kind === "group" ? [[{ text: "Только с @упоминанием или ответом мне", callback_data: `c:mention:${chatId}` }]] : []),
  [{ text: "Не записывать", callback_data: `c:off:${chatId}` }],
] });

// сообщение в группе или бизнес-чате: пропустить, спросить про новый чат или записать задачей
async function handleChatMessage(env, msg, kind) {
  const own = await owner(env);
  if (!own || !msg.from || msg.from.is_bot || Number(msg.from.id) === own.id) return;
  const chat = msg.chat;
  // Telegram повторяет доставку, если вебхук не ответил вовремя — одно сообщение записываем один раз
  const seenKey = `dash:tg-seen:${chat.id}:${msg.message_id}`;
  if (await env.OKK_KV.get(seenKey)) return;
  await env.OKK_KV.put(seenKey, "1", { expirationTtl: 86400 });
  const watch = await readJson(env, K.watch, {});
  const name = senderName(msg.from);
  const src = { chat: { id: chat.id, username: chat.username }, message_id: msg.message_id, name, text: chatText(msg, name) };
  let entry = watch[chat.id];
  if (!entry) {
    // бизнес-чаты Никита уже выбрал в настройках Telegram — пишем сразу; про группу спрашиваем один раз,
    // первое сообщение придерживаем и записываем после ответа, если режим его допускает
    entry = { title: chatTitle(chat), kind, mode: kind === "business" ? "all" : "ask", since: today() };
    if (entry.mode === "ask") {
      if (src.text) entry.first = { ...src, mention: mentionsOwner(msg, own) };
      watch[chat.id] = entry;
      await writeJson(env, K.watch, watch);
      await tg(env, "sendMessage", { chat_id: own.id, text: `Меня добавили в чат «${entry.title}». Записывать сообщения оттуда задачами?` + (src.text ? `\n(первое уже есть: ${name} — «${src.text.slice(0, 80)}»)` : ""), reply_markup: modeKeyboard(chat.id, kind) });
      return;
    }
    watch[chat.id] = entry;
    await writeJson(env, K.watch, watch);
  } else if (entry.title !== chatTitle(chat)) { entry.title = chatTitle(chat); await writeJson(env, K.watch, watch); }
  if (entry.mode === "off" || entry.mode === "ask" || !src.text) return;
  if (entry.mode === "mention" && !mentionsOwner(msg, own)) return;
  await addChatTask(env, own, src, entry);
}

// «чаты» — что бот слушает, с кнопками режима под каждым
async function listChats(env, chatId) {
  const watch = await readJson(env, K.watch, {});
  const ids = Object.keys(watch);
  if (!ids.length) { await tgSend(env, chatId, "Пока ни одного чата. Добавь меня в группу или подключи в Telegram Business → Чат-боты и выбери личные чаты."); return; }
  await tgSend(env, chatId, `Чаты (${ids.length}). Под каждым — переключение режима:`);
  for (const id of ids.slice(0, 25)) {
    const e = watch[id];
    await tg(env, "sendMessage", { chat_id: chatId, text: `${e.kind === "business" ? "👤" : "👥"} «${e.title}» — ${MODES[e.mode] || e.mode}`, reply_markup: modeKeyboard(id, e.kind) });
  }
}

// кнопка режима чата: сохранить, перерисовать строку, записать придержанное первое сообщение
async function setChatMode(env, cq, mode, chatId) {
  const watch = await readJson(env, K.watch, {});
  const e = watch[chatId];
  if (!e || !MODES[mode] || mode === "ask") return "Чат уже не в списке";
  e.mode = mode;
  const first = e.first; delete e.first;
  await writeJson(env, K.watch, watch);
  if (cq.message) await tg(env, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `${e.kind === "business" ? "👤" : "👥"} «${e.title}» — ${MODES[mode]}`, reply_markup: modeKeyboard(chatId, e.kind) });
  if (first && first.text && (mode === "all" || (mode === "mention" && first.mention))) {
    const own = await owner(env);
    if (own) await addChatTask(env, own, first, e);
  }
  return `«${e.title}»: ${MODES[mode]}`;
}

// подключение/отключение бизнес-аккаунта: принимаем только от владельца дашборда
async function handleBusinessConnection(env, bc) {
  const own = await owner(env);
  if (!own || !bc.user || Number(bc.user.id) !== own.id) return;
  const biz = await readJson(env, K.biz, {});
  if (bc.is_enabled) biz[bc.id] = { user: own.id, chat: bc.user_chat_id, since: today() }; else delete biz[bc.id];
  await writeJson(env, K.biz, biz);
  await tgSend(env, own.id, bc.is_enabled
    ? "Telegram Business подключён: сообщения из выбранных там личных чатов буду записывать задачами и присылать сюда карточки. «чаты» — список и режимы."
    : "Telegram Business отключён — личные чаты больше не слушаю.");
}

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
  if (!from && /^(\/chats|чаты)$/.test(low)) { await listChats(env, chat); return; }

  if (!from && /^(\/list|список|задачи)$/.test(low)) {
    const list = openTasks(tasks);
    if (!list.length) { await tgSend(env, chat, "Открытых задач нет."); return; }
    const map = {};
    const shown = list.slice(0, 30);
    const lines = shown.map((t, i) => { map[i + 1] = t.id; return `${i + 1}. ${prioMark(t)}[${labelOf(projects, t.project)}] ${t.title}${t.status === "waiting" ? " · ждём" : t.due ? " · до " + dm(t.due) : ""}`; });
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

// ── утренний разбор хвоста: самые старые просроченные задачи одним сообщением, под каждой ✅ / ⏩ +2 дня / ⏸ / 🗑 ──
// Шлёт sync.mjs --digest (из brief.mjs) раз в день; какие задачи в каком сообщении — KV dash:tg-digest:<чат>:<сообщение>.
const daysLate = (due) => Math.round((new Date(today() + "T00:00:00Z") - new Date(due + "T00:00:00Z")) / 864e5);
const isLate = (t) => t.status === "open" && t.due && t.due < today();
const digestKey = (chat, msgId) => `dash:tg-digest:${chat}:${msgId}`;

function renderDigest(projects, tasks, ids, total) {
  const rows = [], lines = [];
  ids.forEach((id, i) => {
    const n = i + 1, t = tasks.find((x) => x.id === id);
    if (!t || t.status === "deleted") { lines.push(`${n}. 🗑 ${t ? t.title : "удалена"}`); return; }
    const tag = `[${labelOf(projects, t.project)}] `;
    if (t.status === "done") lines.push(`${n}. ✅ ${t.title}`);
    else if (t.status === "parked") lines.push(`${n}. ⏸ ${t.title}`);
    else if (t.status === "archived") lines.push(`${n}. 📦 ${t.title}`);
    else if (!isLate(t)) lines.push(`${n}. ⏩ ${t.title} · до ${dm(t.due)}`);
    else {
      lines.push(`${n}. ${tag}${t.title} · −${daysLate(t.due)} дн${t.moved ? ` · переносил ${t.moved}×` : ""}`);
      rows.push([["✅", "d"], ["⏩ +2д", "s"], ["⏸", "p"], ["🗑", "x"]].map(([txt, op]) => ({ text: `${txt} ${n}`, callback_data: `r:${op}:${t.id}` })));
    }
  });
  const head = `Разбор хвоста: просрочено ${total}. Самые старые — ✅ сделано, ⏩ перенести на 2 рабочих дня, ⏸ отложить, 🗑 удалить:`;
  return { text: head + "\n\n" + lines.join("\n") + (rows.length ? "" : "\n\nРазобрано 👍"), reply_markup: { inline_keyboard: rows } };
}

async function sendDigest(env, chat, limit, force) {
  const day = await env.OKK_KV.get("dash:tg-digest-day");
  if (!force && day === today()) return { sent: false, reason: "уже отправлен сегодня" };
  const tasks = await readJson(env, K.tasks, []);
  const late = tasks.filter(isLate).sort((a, b) => a.due.localeCompare(b.due));
  if (!late.length) return { sent: false, overdue: 0 };
  const projects = await loadProjects(env);
  const ids = late.slice(0, limit).map((t) => t.id);
  const r = await tg(env, "sendMessage", { chat_id: chat, disable_web_page_preview: true, ...renderDigest(projects, tasks, ids, late.length) });
  if (!r || !r.ok) return { sent: false, telegram: r };
  await env.OKK_KV.put(digestKey(chat, r.result.message_id), JSON.stringify({ ids, total: late.length }), { expirationTtl: 14 * 864e2 });
  await env.OKK_KV.put("dash:tg-digest-day", today());
  return { sent: true, overdue: late.length, shown: ids.length };
}

// нажатие кнопки под задачей
async function handleButton(env, cq) {
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: text || "" });
  const m = /^([dpxomjrauwc]):(?:([^:]+):)?(.+)$/.exec(String(cq.data || ""));
  if (!m) return answer();
  const [, op0, proj, id] = m;
  if (op0 === "c") return answer(await setChatMode(env, cq, proj, id));
  const tasks = await readJson(env, K.tasks, []);
  const projects = await loadProjects(env);
  const t = tasks.find((x) => x.id === id);
  if (!t) return answer("Задача не найдена — возможно, уже удалена в дашборде");
  if (op0 === "r") {
    // кнопка из утреннего разбора: делаем действие и перерисовываем весь разбор
    const op = proj;
    let note = "";
    if (op === "d") { await setStatus(env, tasks, t, "done"); note = "Закрыл"; }
    else if (op === "p") { await setStatus(env, tasks, t, "parked"); note = "Отложил"; }
    else if (op === "x") { await setStatus(env, tasks, t, "deleted"); note = "Удалил"; }
    else if (op === "s") {
      t.due = workdays(today(), 2); t.moved = (t.moved || 0) + 1;
      await writeJson(env, K.tasks, tasks);
      await pushInbox(env, { action: "due", taskId: t.id, due: t.due, moved: t.moved });
      note = "Перенёс на " + dm(t.due);
    }
    const msg = cq.message;
    const dg = msg && await readJson(env, digestKey(msg.chat.id, msg.message_id), null);
    if (dg) await tg(env, "editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, disable_web_page_preview: true, ...renderDigest(projects, tasks, dg.ids, dg.total) });
    return answer(note ? note + ": " + t.title.slice(0, 60) : "");
  }
  const op = op0;
  const fromLine = t.source === "telegram-forward" || t.source === "telegram-chat" ? (/от (.+?), \d{1,2}\.\d{2}$/.exec(t.why || "") || [])[1] : null;
  let menu = false, note = "";
  if (op === "d") { await setStatus(env, tasks, t, "done"); note = "Закрыл"; }
  else if (op === "p") { await setStatus(env, tasks, t, "parked"); note = "На паузе"; }
  else if (op === "a") { await setStatus(env, tasks, t, "archived"); note = "В архиве"; }
  else if (op === "u" || op === "w") {
    const next = (op === "u" ? PRIO_UP : PRIO_DOWN)[t.prio ?? "undefined"];
    if (next) t.prio = next; else delete t.prio;
    await writeJson(env, K.tasks, tasks);
    await pushInbox(env, { action: "prio", taskId: t.id, prio: t.prio || null });
    note = t.prio === "high" ? "🔥 Высокий приоритет" : t.prio === "low" ? "↓ Низкий приоритет" : "Обычный приоритет";
  }
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
      body: JSON.stringify({ url: hook, secret_token: secret, allowed_updates: ["message", "callback_query", "business_connection", "business_message"], drop_pending_updates: true }),
    });
    return json({ ok: r.ok, hook, telegram: await r.json().catch(() => null) });
  }

  // утренний разбор хвоста — зовёт sync.mjs --digest: {"chat_id": …, "limit": 10, "force": false}
  if (url.searchParams.get("digest")) {
    if (!hasIngestToken(request, env)) return bad("нет доступа", 401);
    const body = await request.json().catch(() => ({}));
    // без chat_id или с login — шлём администратору Штаба в личку бота по его tg_id из users
    // (логин не совпал, а администратор с Telegram один — ему); иначе отвечаем списком логинов, чтобы указать нужный
    if (!body.chat_id && env.DB) {
      const { results } = await env.DB.prepare("SELECT login, tg_id FROM users WHERE role = 'admin' AND active = 1 AND tg_id IS NOT NULL AND tg_id <> ''").all();
      const hit = (results || []).find((u) => u.login === body.login) || ((results || []).length === 1 ? results[0] : null);
      if (hit) body.chat_id = hit.tg_id;
      else return bad("укажи login администратора: " + (results || []).map((u) => u.login).join(", "));
    }
    if (!body.chat_id) return bad("нужен chat_id или login администратора с привязанным Telegram");
    return json({ ok: true, ...(await sendDigest(env, body.chat_id, Math.min(+body.limit || 10, 15), !!body.force)) });
  }

  // вебхук Telegram
  const secret = await env.OKK_KV.get(K.secret);
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return bad("нет доступа", 403);
  const update = await request.json().catch(() => null);
  const cq = update && update.callback_query;
  if (cq) {
    // кнопка «✅ Заведено в amo» из канала генератора ссылок (Маркетинг → Инфлюенс)
    if (String(cq.data || "").startsWith("ia:")) {
      try { await handleAmoButton(env, cq); } catch (e) { await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось: " + (e.message || e) }); }
      return json({ ok: true });
    }
    if (cq.from && await isAdminTg(env, cq.from.id)) {
      try { await handleButton(env, cq); } catch (e) { await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Не получилось: " + (e.message || e) }); }
    }
    return json({ ok: true });
  }
  // Telegram Business: подключение бота к аккаунту и сообщения из выбранных там личных чатов
  if (update && update.business_connection) {
    try { await handleBusinessConnection(env, update.business_connection); } catch { /* молча */ }
    return json({ ok: true });
  }
  const bm = update && update.business_message;
  if (bm) {
    try {
      const biz = await readJson(env, K.biz, {});
      if (biz[bm.business_connection_id]) await handleChatMessage(env, bm, "business");
    } catch { /* в бизнес-чат не отвечаем никогда */ }
    return json({ ok: true });
  }
  const msg = update && update.message;
  if (!msg || !msg.from) return json({ ok: true });
  // группа, куда добавили бота: задачи из чужих сообщений по режиму чата; в саму группу бот не пишет
  if (msg.chat?.type === "group" || msg.chat?.type === "supergroup") {
    try { await handleChatMessage(env, msg, "group"); } catch { /* молча */ }
    return json({ ok: true });
  }
  if (msg.chat?.type !== "private") return json({ ok: true });
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
        await tgSend(env, msg.chat.id, "Готово: вернитесь во вкладку Штаба, она откроется сама. Если Штаб открыт на другом устройстве или вкладка закрылась — войдите по ссылке (одноразовая, 10 минут): " + url.origin + "/__tglink?go=" + start[1]);
      } else {
        // tg — чтобы ждущая вкладка вошла сама, как только администратор подтвердит заявку; ждём до суток
        await env.OKK_KV.put(key, JSON.stringify({ status: "pending", tg: msg.from.id }), { expirationTtl: 86400 });
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
