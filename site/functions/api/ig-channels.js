// Реестр Instagram-каналов (Маркетинг → Instagram SMM → Каналы), миграция schema37.sql.
// У каждого канала своя ссылка на бота шапки: t.me/<BOT>?start=gitelman_instagram_<slug>.
// Движок (tg-bots-core, engine.parsePayload) кладёт это в utm_source=instagram и utm_campaign=<slug>,
// в amo: «Источник» = Instagram, тег сделки = <slug>. slug = ник в нижнем регистре, точки → дефис.
//
//   GET  /api/ig-channels[?from=&to=]  — каналы + статистика из ядра ботов по utm_campaign (зашли, номера, сделки, горячие)
//   POST /api/ig-channels {action:"add", nicks:"ник\nник…"}       — добавить (ник, @ник или ссылка на профиль)
//   POST /api/ig-channels {action:"note", slug, note} | {action:"archive", slug, archived:0|1}
// Смотреть — доступ к разделу marketing.instagram, менять — правка раздела (не общий вход).

import { json, bad, canRead, canView, canEdit, audit, now } from "./_lib.js";

const SECTION = "marketing.instagram";
const CORE = "https://tg-bots-core.gitelmanteam.workers.dev";
export const BOT = "Pavel_Gitelman_Traning_bot";   // бот шапки Instagram/YouTube, на движке
const PREFIX = "gitelman_instagram_";

// «@Pa.vel.pp⁠», «https://instagram.com/pa.vel.pp/» → pa.vel.pp; ник Instagram — латиница, цифры, точка, _ (до 30)
export function nickOf(s) {
  let v = String(s || "").replace(/[​-‍⁠﻿]/g, "").trim().toLowerCase();
  v = v.replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/[/?#].*$/, "").replace(/^@/, "").replace(/^\d+[.)]\s+/, "");
  return /^[a-z0-9._]{1,30}$/.test(v) ? v : "";
}
export const slugOf = (nick) => nick.replace(/\./g, "-");

function view(r) {
  return { ...r, profile: `https://instagram.com/${r.nick}`, start: PREFIX + r.slug, link: `https://t.me/${BOT}?start=${PREFIX}${r.slug}` };
}

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canView(user, SECTION)) return bad("нет доступа к разделу «Instagram SMM»", 403);
  const rows = (await env.DB.prepare("SELECT slug, nick, pos, note, archived, added_by, created_at FROM ig_channels ORDER BY archived, pos, created_at").all()).results || [];

  // Статистика бота: люди, зашедшие по ссылке канала (последний заход), сгруппированные по utm_campaign.
  let stats = {}, statsError = "";
  if (!env.TG_CORE_API_TOKEN) statsError = "ядро ботов не подключено: нет TG_CORE_API_TOKEN";
  else {
    const u = new URL(request.url), q = new URLSearchParams({ group: "campaign", source: "instagram" });
    for (const k of ["from", "to"]) if (/^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get(k) || "")) q.set(k, u.searchParams.get(k));
    try {
      const r = await fetch(`${env.TG_CORE_URL || CORE}/api/tags?${q}`, { headers: { Authorization: `Bearer ${env.TG_CORE_API_TOKEN}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `ядро ответило ${r.status}`);
      for (const x of d.rows || []) if (x.label) stats[String(x.label).toLowerCase()] = x;
    } catch (e) { statsError = e.message; }
  }
  return json({ ok: true, bot: BOT, prefix: PREFIX, canEdit: canEdit(user, SECTION) && user.login !== "shared",
    channels: rows.map((r) => ({ ...view(r), stats: stats[r.slug] || null })), statsError });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  if (!canEdit(user, SECTION) || user.login === "shared") return bad("менять может только тот, у кого правка раздела «Instagram SMM»", 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const action = String(body.action || "");

  if (action === "add") {
    const lines = String(body.nicks || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (!lines.length) return bad("впишите ник канала");
    const have = new Set(((await env.DB.prepare("SELECT slug FROM ig_channels").all()).results || []).map((r) => r.slug));
    let pos = ((await env.DB.prepare("SELECT MAX(pos) p FROM ig_channels").first()) || {}).p || 0;
    const added = [], skipped = [], invalid = [];
    for (const line of lines) {
      const nick = nickOf(line);
      if (!nick) { invalid.push(line); continue; }
      const slug = slugOf(nick);
      if (have.has(slug)) { skipped.push(nick); continue; }
      have.add(slug);
      await env.DB.prepare("INSERT INTO ig_channels (slug, nick, pos, added_by, created_at) VALUES (?,?,?,?,?)").bind(slug, nick, ++pos, user.login, now()).run();
      added.push(nick);
    }
    if (added.length) await audit(env, user.login, "ig-channels.add", added.join(", "));
    return json({ ok: true, added, skipped, invalid });
  }

  const slug = String(body.slug || "");
  const row = slug && await env.DB.prepare("SELECT slug FROM ig_channels WHERE slug = ?").bind(slug).first();
  if (!row) return bad("канал не найден", 404);
  if (action === "note") {
    await env.DB.prepare("UPDATE ig_channels SET note = ? WHERE slug = ?").bind(String(body.note || "").trim().slice(0, 200), slug).run();
    await audit(env, user.login, "ig-channels.note", slug);
    return json({ ok: true });
  }
  if (action === "archive") {
    const a = body.archived ? 1 : 0;
    await env.DB.prepare("UPDATE ig_channels SET archived = ? WHERE slug = ?").bind(a, slug).run();
    await audit(env, user.login, "ig-channels.archive", slug, a ? "в архив" : "из архива");
    return json({ ok: true });
  }
  return bad("action: add | note | archive");
}
