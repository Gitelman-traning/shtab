// Генератор ссылок для блогеров (раздел Маркетинг → Инфлюенс → Генератор ссылок).
// Переехал сюда 05.10.2026 с chat.gitelman.team/go/ (проект amo-chat).
//
// Заказчик (Мари, Настя, Маша) заполняет одну заявку на блогера:
//   WhatsApp    — wa.me/<номер>?text=«Я от …, тренинг Команда». Стикер в сторис
//                 Instagram принимает не длиннее 245 знаков (кириллица ×6). Выдаётся сразу.
//   TG-бот      — t.me/gitelmanteam_bot?start=git_influence_<имя латиницей><ДДММ>
//                 (метка для Salebot только латиницей). Выдаётся сразу. Обязательный выбор
//                 «кружок Паши в боте»: нужен → заявка ждёт, пока администратор добавит его в Salebot.
//   TG-входящее — ссылка Telegram Business с готовой фразой. Создать её может только
//                 администратор руками + блок в триггерах amo, поэтому это заявка:
//                 фраза проверяется по реестру (не совпадает и не вложена в другую),
//                 статус «ждёт: ссылку TG», администратор вставляет ссылку на странице.
// Заказчик определяется по входу в Штаб. Заявки с ожиданием уходят в Telegram
// (tgSend, чат GO_TG_CHAT_ID или TG_ADMIN_CHAT); когда ссылку выдали — сообщение
// уходит и самому заказчику, если его аккаунт Штаба привязан к Telegram.
//
// Реестр — Google Таблица «Ссылки для блогеров (WhatsApp)», лист «Заявки» (создаётся сам).
// Пишет сервис-аккаунт из GOOGLE_SERVICE_ACCOUNT_JSON (тот же, что у сборки Штаба;
// JSON или base64). Дополнительно читает «Реестр фраз входящих сообщений» из таблицы
// «Ссылки на все чаты Вотсап», если сервис-аккаунту дали доступ.
//
//   GET  /api/influence-links                      — настройки формы, заявки, кто я
//   POST /api/influence-links {action:"save", …}   — новая заявка (любой, кто видит раздел, кроме общего входа)
//   POST /api/influence-links {action:"check", phrase} — свободна ли фраза
//   POST /api/influence-links {action:"issue", row, link} | {action:"circle", row} — только администратор

import { json, bad, canRead, isAdmin, canView, audit, tgSend } from "./_lib.js";

const SECTION = "marketing.influence";
const SHEET_ID = "1VqMEdiV7NroUIKNCRY3mnGuuTASzY7hbvgdOO86hghw";
const PHRASES_SHEET_ID = "1WmDh6tu0tSKipmylQlgamgjzNkYqAsKf5xewvf0gicw";
const PHRASES_TAB = "Реестер фраз входящих сообщений"; // так называется лист (с опечаткой)
const TAB = "Заявки";
const LIMIT = 245;
const BOT = "gitelmanteam_bot";
const BOT_PREFIX = "git_influence_";
const PHONES = [{ value: "77010439135", label: "+7 701 043-91-35 — основной WhatsApp" }];
const PLATFORMS = ["сторис Instagram", "пост Instagram", "Telegram-канал", "YouTube", "TikTok", "кружок / нативка", "другое"];
const WA_TEMPLATES = ["Я от {имя}, тренинг Команда", "Я от {имя}, детали тренинга Команда", "Привет! Я от {имя}, тренинг Команда"];
const TGIN_TEMPLATES = [
  "Здравствуйте 👋🏻 Я от {имя}, меня заинтересовал тренинг «Команда», поделитесь деталями",
  "Здравствуйте 👋🏻 Я от {имя}, хочу узнать детали тренинга «Команда» в Стамбуле",
  "Привет! Я от {имя}, расскажите про тренинг Команда",
];

// Порядок колонок менять нельзя — строки читаются по индексам. Новые — только в конец.
const HEADER = ["Дата", "Тег", "Заказчик", "Блогер и площадка", "Типы", "WA текст", "WA ссылка", "WA длина",
  "TG-бот ссылка", "TG-входящее фраза", "TG-входящее ссылка", "Статус", "Выдал", "Примечание", "Кружок", "Логин заказчика"];
const C = Object.fromEntries(HEADER.map((h, i) => [h, i]));
const LAST = String.fromCharCode(64 + HEADER.length);

// ---------- правила ----------
const TAG_RE = /^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])_[^\s]{2,60}$/u;
// «1.10_Анатолий_Пистол», «Ильнара_1.10», «16.09 Мухаммад» → «01.10_Анатолий_Пистол»
export function normalizeTag(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, " ").replace(/\s*_\s*/g, "_").replace(/\s/g, "_").replace(/_+/g, "_");
  let m = s.match(/^(\d{1,2})[.,](\d{1,2})(?:[.,]\d{2,4})?_(.+)$/u);
  if (!m) { const m2 = s.match(/^(.+?)_(\d{1,2})[.,](\d{1,2})(?:[.,]\d{2,4})?$/u); if (m2) m = [null, m2[2], m2[3], m2[1]]; }
  if (!m) return "";
  const tag = `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}_${m[3].replace(/^_+|_+$/g, "")}`;
  return TAG_RE.test(tag) ? tag : "";
}
const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
export function botSlug(tag) {
  const m = tag.match(/^(\d{2})\.(\d{2})_(.+)$/u);
  if (!m) return "";
  const first = m[3].split("_")[0].toLowerCase();
  const lat = [...first].map((ch) => TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch).join("").replace(/[^a-z0-9]/g, "");
  return lat ? `${lat}${m[1]}${m[2]}` : "";
}
const botLink = (slug) => `https://t.me/${BOT}?start=${BOT_PREFIX}${slug}`;
const waLink = (phone, text) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
const normPhrase = (s) => String(s || "").toLowerCase().replace(/[«»"'“”]/g, "").replace(/\s+/g, " ").trim();
const fmtMsk = (d) => new Date(d).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// ---------- сервис-аккаунт Google (JWT RS256 на WebCrypto) ----------
function serviceAccount(env) {
  let raw = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return { sa: null, error: "нет GOOGLE_SERVICE_ACCOUNT_JSON" };
  try {
    if (!raw.startsWith("{")) raw = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) throw new Error("нет client_email/private_key");
    return { sa, error: "" };
  } catch (e) { return { sa: null, error: "GOOGLE_SERVICE_ACCOUNT_JSON не разобрать: " + e.message }; }
}
const te = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function pemToDer(pem) {
  const bin = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
let tokenCache = { value: "", exp: 0, email: "" };
async function accessToken(sa) {
  if (tokenCache.value && tokenCache.email === sa.client_email && Date.now() < tokenCache.exp - 60000) return tokenCache.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(te.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + b64url(te.encode(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, te.encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error("Google не выдал токен: " + (t.error_description || t.error || r.status));
  tokenCache = { value: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000, email: sa.client_email };
  return tokenCache.value;
}
async function sheets(sa, id, method, pathAndQuery, body) {
  const token = await accessToken(sa);
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${pathAndQuery}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Sheets ${r.status}: ${(d.error && d.error.message) || "ошибка"}`);
  return d;
}
const q = (s) => encodeURIComponent(`'${s.replace(/'/g, "''")}'`);

let tabReady = false;
async function ensureTab(sa) {
  if (tabReady) return;
  const meta = await sheets(sa, SHEET_ID, "GET", "?fields=sheets.properties(sheetId,title)");
  const has = (meta.sheets || []).find((s) => s.properties.title === TAB);
  if (!has) {
    const r = await sheets(sa, SHEET_ID, "POST", ":batchUpdate", { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }] });
    const sid = r.replies[0].addSheet.properties.sheetId;
    await sheets(sa, SHEET_ID, "PUT", `/values/${q(TAB)}!A1:${LAST}1?valueInputOption=RAW`, { values: [HEADER] });
    await sheets(sa, SHEET_ID, "POST", ":batchUpdate", { requests: [{ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } }] });
  } else {
    const d = await sheets(sa, SHEET_ID, "GET", `/values/${q(TAB)}!A1:${LAST}1`);
    const cur = (d.values && d.values[0]) || [];
    if (HEADER.some((h, i) => cur[i] !== h)) await sheets(sa, SHEET_ID, "PUT", `/values/${q(TAB)}!A1:${LAST}1?valueInputOption=RAW`, { values: [HEADER] });
  }
  tabReady = true;
}
async function readRows(sa) {
  await ensureTab(sa);
  const d = await sheets(sa, SHEET_ID, "GET", `/values/${q(TAB)}!A2:${LAST}?majorDimension=ROWS`);
  return (d.values || []).map((r, i) => ({ row: i + 2, v: Object.assign(Array(HEADER.length).fill(""), r) })).filter((x) => x.v.some((c) => String(c).trim()));
}
function view(x) {
  const g = (h) => x.v[C[h]] || "";
  return { row: x.row, date: g("Дата"), tag: g("Тег"), by: g("Заказчик"), who: g("Блогер и площадка"), types: g("Типы"), waText: g("WA текст"), wa: g("WA ссылка"),
    waLen: g("WA длина"), bot: g("TG-бот ссылка"), phrase: g("TG-входящее фраза"), tgin: g("TG-входящее ссылка"), status: g("Статус"), issued: g("Выдал"),
    circle: g("Кружок"), login: g("Логин заказчика") };
}
async function updateCells(sa, row, patch) {
  const data = Object.entries(patch).map(([h, val]) => ({ range: `${TAB}!${String.fromCharCode(65 + C[h])}${row}`, values: [[val]] }));
  await sheets(sa, SHEET_ID, "POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
}
let phrasesCache = { at: 0, list: [], error: "" };
async function externalPhrases(sa) {
  if (Date.now() - phrasesCache.at < 120000) return phrasesCache;
  try {
    const d = await sheets(sa, PHRASES_SHEET_ID, "GET", `/values/${q(PHRASES_TAB)}!A2:D?majorDimension=ROWS`);
    phrasesCache = { at: Date.now(), list: (d.values || []).filter((r) => r[1]).map((r) => ({ phrase: r[1], source: r[2] || "", tag: r[3] || "" })), error: "" };
  } catch (e) { phrasesCache = { at: Date.now(), list: phrasesCache.list, error: String(e.message || e) }; }
  return phrasesCache;
}
async function phraseConflict(sa, phrase, rows) {
  const p = normPhrase(phrase);
  if (!p) return "";
  const own = rows.map(view).filter((r) => r.phrase).map((r) => ({ phrase: r.phrase, tag: r.tag, source: "заявки" }));
  for (const e of [...own, ...(await externalPhrases(sa)).list]) {
    const n = normPhrase(e.phrase);
    if (!n) continue;
    if (n === p) return `такая фраза уже есть (${e.tag || e.source})`;
    if (n.includes(p) || p.includes(n)) return `пересекается с фразой «${e.phrase}» (${e.tag || e.source}) — триггер «содержит» их не различит`;
  }
  return "";
}

// ---------- уведомления ----------
const adminChat = (env) => env.GO_TG_CHAT_ID || env.TG_ADMIN_CHAT || "";
async function tgOfLogin(env, login) {
  if (!login) return null;
  const r = await env.DB.prepare("SELECT tg_id FROM users WHERE login = ?").bind(login).first();
  return r && r.tg_id ? r.tg_id : null;
}

// ---------- маршруты ----------
async function gate(request, env) {
  const user = await canRead(request, env);
  if (!user || !canView(user, SECTION)) return { error: bad("нет доступа", 401) };
  return { user };
}

export async function onRequestGet({ request, env }) {
  const { user, error } = await gate(request, env);
  if (error) return error;
  const { sa, error: saError } = serviceAccount(env);
  let rows = [], sheetError = saError, extError = "";
  if (sa) {
    try { rows = (await readRows(sa)).map(view); } catch (e) { sheetError = String(e.message || e); }
    extError = (await externalPhrases(sa)).error;
  }
  return json({
    ok: true,
    me: { name: user.name || user.login, login: user.login, admin: isAdmin(user), canCreate: user.login !== "shared" && !!sa },
    config: { limit: LIMIT, bot: BOT, prefix: BOT_PREFIX, phones: PHONES, platforms: PLATFORMS, waTemplates: WA_TEMPLATES, tgTemplates: TGIN_TEMPLATES, telegram: !!(env.TG_BOT_TOKEN && adminChat(env)) },
    sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, tab: TAB,
    sheetError, extError, serviceAccount: sa ? sa.client_email : "",
    rows: rows.slice(-60).reverse(),
  });
}

export async function onRequestPost({ request, env }) {
  const { user, error } = await gate(request, env);
  if (error) return error;
  const { sa, error: saError } = serviceAccount(env);
  if (!sa) return bad("реестр не подключён: " + saError, 503);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const action = String(b.action || "");

  if (action === "check") {
    return json({ ok: true, conflict: await phraseConflict(sa, String(b.phrase || ""), await readRows(sa)) });
  }

  if (action === "save") {
    if (user.login === "shared") return bad("заявку может оставить только именной пользователь Штаба", 403);
    const types = [].concat(b.types || []).filter((t) => ["wa", "bot", "tgin"].includes(t));
    const tag = normalizeTag(b.tag);
    if (!tag) return bad("Тег должен быть вида ДД.ММ_Имя, например 16.09_Мухаммад");
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) return bad("Укажите блогера");
    const platform = String(b.platform || "").trim().slice(0, 40);
    const who = [name, platform].filter(Boolean).join(", ");
    if (!types.length) return bad("Выберите хотя бы один тип ссылки");

    let waText = "", wa = "", waLen = "", bot = "", phrase = "", circle = "";
    if (types.includes("wa")) {
      const phone = String(b.phone || "").replace(/\D/g, "");
      if (!PHONES.some((p) => p.value === phone)) return bad("Выберите номер WhatsApp из списка");
      waText = String(b.text || "").trim().replace(/\s+/g, " ").slice(0, 200);
      if (!waText) return bad("Нужен текст сообщения для WhatsApp");
      if (!/я от/i.test(waText)) return bad("В тексте WhatsApp должно быть «Я от …» с именем блогера");
      wa = waLink(phone, waText); waLen = wa.length;
      if (wa.length > LIMIT && !b.long) return bad(`WA-ссылка ${wa.length} знаков, предел ${LIMIT} для сторис — сократите текст или подтвердите`);
    }
    if (types.includes("bot")) {
      const s = botSlug(tag);
      if (!s) return bad("Не удалось собрать метку для бота из тега");
      bot = botLink(s);
      if (b.circle === "yes") {
        const note = String(b.circleNote || "").trim().slice(0, 200);
        if (!note) return bad("Укажите, где взять кружок для бота");
        circle = "нужен: " + note;
      } else if (b.circle === "no") circle = "нет";
      else return bad("Укажите, нужен ли кружок Паши в боте");
    }
    if (types.includes("tgin")) {
      phrase = String(b.phrase || "").trim().replace(/\s+/g, " ").slice(0, 300);
      if (!phrase) return bad("Нужна фраза для TG-входящего");
    }

    const rows = await readRows(sa);
    const views = rows.map(view);
    const dupTag = views.find((r) => r.tag.toLowerCase() === tag.toLowerCase());
    if (dupTag) return bad(`Тег ${tag} уже выдан ${dupTag.date} (${dupTag.by}) — возьмите другой день или имя`);
    if (phrase) { const c = await phraseConflict(sa, phrase, rows); if (c) return bad("Фраза не подходит: " + c); }
    if (bot) { const d = views.find((r) => r.bot === bot); if (d) return bad(`Ссылка на бота ${bot} уже выдана (${d.tag})`); }

    const by = user.name || user.login;
    const waiting = [types.includes("tgin") ? "ссылку TG" : "", circle.startsWith("нужен") ? "кружок" : ""].filter(Boolean);
    const status = waiting.length ? "ждёт: " + waiting.join(", ") : "выдано";
    await ensureTab(sa);
    await sheets(sa, SHEET_ID, "POST", `/values/${q(TAB)}!A1:${LAST}1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: [[fmtMsk(Date.now()), tag, by, who, types.join(","), waText, wa, waLen, bot, phrase, "", status, waiting.length ? "" : by, "", circle, user.login]] });
    await audit(env, user.login, "influence.links.save", tag, types.join(","));

    if (waiting.length) {
      const lines = [`Инфлюенс: заявка на ссылки ${tag}`, `Блогер: ${who}`, `Запросил: ${by}`,
        wa ? `WA (${waLen}): ${wa}` : "", bot ? `TG-бот: ${bot}` : "",
        phrase ? `TG-входящее — нужна ссылка Telegram Business и блок в триггерах amo.\nФраза: «${phrase}»\nИсточник: интеграции · Тег: ${tag}` : "",
        circle.startsWith("нужен") ? `Кружок Паши в ветку бота — ${circle.slice(7)}` : "",
        `Выдать: ${new URL(request.url).origin}/marketing/influence/links/`].filter(Boolean);
      await tgSend(env, adminChat(env), lines.join("\n"));
    }
    return json({ ok: true, tag, wa, waLen, bot, waiting });
  }

  if (action === "issue" || action === "circle") {
    if (!isAdmin(user)) return bad("только для администратора", 403);
    const row = parseInt(String(b.row || ""), 10);
    const x = (await readRows(sa)).find((r) => r.row === row);
    if (!x) return bad("заявка не найдена", 404);
    const r = view(x);
    let patch, msg;
    if (action === "issue") {
      const link = String(b.link || "").trim();
      if (!/^https?:\/\/(t\.me|telegram\.me)\/\S+$/i.test(link)) return bad("Ссылка должна вести на t.me");
      const still = r.circle.startsWith("нужен") ? "ждёт: кружок" : "выдано";
      patch = { "TG-входящее ссылка": link, "Статус": still, "Выдал": still === "выдано" ? (user.name || user.login) : "" };
      msg = `Готова ссылка на TG-входящее для ${r.tag}:\n${link}`;
    } else {
      const still = r.types.includes("tgin") && !r.tgin ? "ждёт: ссылку TG" : "выдано";
      patch = { "Кружок": "добавлен", "Статус": still, "Выдал": still === "выдано" ? (user.name || user.login) : "" };
      msg = `Кружок Паши добавлен в бота для ${r.tag}:\n${r.bot}`;
    }
    await updateCells(sa, row, patch);
    await audit(env, user.login, "influence.links." + action, r.tag);
    const tgId = await tgOfLogin(env, r.login);
    if (tgId) await tgSend(env, tgId, msg);
    return json({ ok: true, notified: !!tgId });
  }

  return bad("неизвестное действие");
}
