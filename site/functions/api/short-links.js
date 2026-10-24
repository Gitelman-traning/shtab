// Короткие ссылки с переадресацией (Маркетинг → YouTube → Генератор ссылок).
// Замена коротких страниц Тильды вида gitelman.team/page311628509.html, которые
// перекидывали на ссылку с utm или на TG-бота со start-меткой (с Тильды уходим).
//
// Реестр — KV (OKK_KV, ключ shortlinks), миграция не нужна. Переадресацию делает не
// Штаб, а сайт на нашем домене (репо journal, модуль short-links.js): он раз в минуту
// забирает GET ?export=1 и отвечает на /yt/<код> переадресацией 302.
//
//   GET  /api/short-links             — {items, base, can_edit, me}; читают все, кто видит YouTube
//   GET  /api/short-links?export=1    — {links:{код: ссылка}} без входа: это то же, что и так
//                                       видно любому, кто откроет короткую ссылку
//   POST /api/short-links {action:"channel", label}        — пара ссылок на канал: сайт с utm + бот
//   POST /api/short-links {action:"custom", url, code?, label?} — любая длинная ссылка
//   POST /api/short-links {action:"del", code}             — автор ссылки или правка раздела
import { json, bad, canRead, level, audit, now } from "./_lib.js";

const SECTION = "marketing.youtube";
const KEY = "shortlinks";
// Домен коротких ссылок — gitelman.team (с 24.10.2026 на своём хостинге в Нидерландах).
// Маршрут /yt/ не зависит от домена: работает и на journal.gitelman.team.
const BASE = "https://gitelman.team";
const PREFIX = "/yt/";
const BOT = "Pavel_Gitelman_Traning2_bot";
const BOT_PREFIX = "gitelman_youtube_";
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const LABEL_RE = /^[A-Za-z0-9_]{2,47}$/;   // start-метка Telegram: латиница, цифры, «_», до 64 знаков вместе с префиксом

export const siteUrl = (label) => "https://gitelman.team/?utm_source=organic&utm_medium=youtube&utm_campaign=" + label;
export const botUrl = (label) => "https://telegram.me/" + BOT + "?start=" + BOT_PREFIX + label;

async function load(env) {
  const raw = await env.OKK_KV.get(KEY);
  return raw ? JSON.parse(raw) : [];
}

function shortOf(code) { return BASE + PREFIX + code; }
function view(items) { return items.map((it) => ({ ...it, short: shortOf(it.code) })); }

function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  return u.toString();
}

function freeCode(items, want) {
  const taken = new Set(items.map((x) => x.code));
  if (want && !taken.has(want)) return want;
  for (let i = 2; i < 100; i++) if (!taken.has(want + "-" + i)) return want + "-" + i;
  return "";
}

function randomCode(items) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const taken = new Set(items.map((x) => x.code));
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(6));
    const c = [...b].map((x) => abc[x % abc.length]).join("");
    if (!taken.has(c)) return c;
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get("export") === "1") {
    const links = {};
    for (const it of await load(env)) links[it.code] = it.url;
    return json({ ok: true, prefix: PREFIX, links }, 200, { "cache-control": "public, max-age=30" });
  }
  const user = await canRead(request, env);
  if (!user || level(user, SECTION) < 1) return bad("нет доступа", 401);
  const items = await load(env);
  return json({ ok: true, items: view(items).reverse(), base: BASE + PREFIX, can_edit: level(user, SECTION) >= 2, me: user.login, can_create: user.login !== "shared" });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user || level(user, SECTION) < 1) return bad("нет доступа", 401);
  if (user.login === "shared") return bad("ссылку может выпустить только именной пользователь Штаба", 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const items = await load(env);
  const action = String(body.action || "");
  const stamp = { at: now(), by: user.login };
  let made = [];

  if (action === "channel") {
    const label = String(body.label || "").trim().replace(/\s+/g, "");
    if (!LABEL_RE.test(label)) return bad("метка — латиница, цифры и «_», от 2 до 47 знаков, например StanislavKim1");
    const base = label.toLowerCase().replace(/_/g, "-");
    const same = items.filter((x) => x.label === label);
    if (same.length) return bad("на метку " + label + " ссылки уже выпущены: " + same.map((x) => shortOf(x.code)).join(", "));
    const bot = freeCode(items, base);
    const site = freeCode(items.concat([{ code: bot }]), base + "-site");
    if (!bot || !site) return bad("не нашлось свободного кода, возьмите другую метку");
    made = [
      { code: bot, url: botUrl(label), kind: "bot", label, ...stamp },
      { code: site, url: siteUrl(label), kind: "site", label, ...stamp },
    ];
  } else if (action === "custom") {
    const target = cleanUrl(body.url);
    if (!target) return bad("вставьте длинную ссылку целиком, с https://");
    let code = String(body.code || "").trim().toLowerCase();
    if (code) {
      if (!CODE_RE.test(code)) return bad("код — латиница, цифры и дефис, от 2 до 60 знаков");
      if (items.some((x) => x.code === code)) return bad("код " + code + " уже занят");
    } else code = randomCode(items);
    made = [{ code, url: target, kind: "custom", label: String(body.label || "").trim().slice(0, 80), ...stamp }];
  } else if (action === "del") {
    const it = items.find((x) => x.code === String(body.code || ""));
    if (!it) return bad("ссылка не найдена", 404);
    if (it.by !== user.login && level(user, SECTION) < 2) return bad("удалить может автор ссылки или тот, у кого правка раздела", 403);
    items.splice(items.indexOf(it), 1);
    await env.OKK_KV.put(KEY, JSON.stringify(items));
    await audit(env, user.login, "short-links.del", it.code, it.url);
    return json({ ok: true, items: view(items).reverse() });
  } else return bad("action: channel, custom, del");

  items.push(...made);
  await env.OKK_KV.put(KEY, JSON.stringify(items));
  await audit(env, user.login, "short-links." + action, made.map((x) => x.code).join(", "), made.map((x) => x.url).join(" "));
  return json({ ok: true, made: view(made), items: view(items).reverse() });
}
