// Теги сделок: справочник (маркетинговый / служебный) и правила-шаблоны для служебных.
//   GET  /api/tags                       — {rules:[{id,pattern,note}], kinds:{tag:{kind,note}}}; читают все, кто видит витрину
//   POST /api/tags {action:"kind", tag, kind:"m"|"s"|"", note}   — только администратор
//   POST /api/tags {action:"rule_add", pattern, note} | {action:"rule_del", id}
//   POST /api/tags {action:"owner", tag, owner}   — руководитель интеграции (Инфлюенс), пусто = снять
import { json, bad, canRead, isAdmin, audit, now } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  const user = await canRead(request, env);
  if (!user) return bad("нет доступа", 401);
  const rules = await env.DB.prepare("SELECT id, pattern, note FROM tag_rules ORDER BY id").all();
  const kinds = await env.DB.prepare("SELECT tag, kind, note, set_by, updated_at, owner FROM tags").all();
  const map = {};
  for (const r of (kinds.results || [])) map[r.tag] = { kind: r.kind || "", note: r.note || "", set_by: r.set_by, updated_at: r.updated_at, owner: r.owner || "" };
  return json({ ok: true, rules: rules.results || [], kinds: map });
}

export async function onRequestPost({ request, env }) {
  const user = await canRead(request, env);
  if (!user || !isAdmin(user)) return bad("только для администратора", 403);
  let body;
  try { body = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const action = String(body.action || "");
  if (action === "kind") {
    const tag = String(body.tag || "").trim().slice(0, 200);
    const kind = String(body.kind || "");
    if (!tag) return bad("укажите тег");
    if (!["m", "s", ""].includes(kind)) return bad("kind: m, s или пусто");
    await env.DB.prepare("INSERT INTO tags (tag, kind, note, set_by, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(tag) DO UPDATE SET kind = excluded.kind, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at")
      .bind(tag, kind, String(body.note || "").slice(0, 200), user.login, now()).run();
    await env.DB.prepare("DELETE FROM tags WHERE tag = ? AND kind = '' AND (owner IS NULL OR owner = '')").bind(tag).run();
    await audit(env, user.login, "tags.kind", tag + " → " + (kind || "сброс"));
    return json({ ok: true });
  }
  if (action === "owner") {
    const tag = String(body.tag || "").trim().slice(0, 200);
    const owner = String(body.owner || "").trim().slice(0, 100);
    if (!tag) return bad("укажите тег");
    await env.DB.prepare("INSERT INTO tags (tag, kind, note, set_by, updated_at, owner) VALUES (?,'','',?,?,?) ON CONFLICT(tag) DO UPDATE SET owner = excluded.owner, set_by = excluded.set_by, updated_at = excluded.updated_at")
      .bind(tag, user.login, now(), owner).run();
    await env.DB.prepare("DELETE FROM tags WHERE tag = ? AND kind = '' AND (owner IS NULL OR owner = '')").bind(tag).run();
    await audit(env, user.login, "tags.owner", tag + " → " + (owner || "снят"));
    return json({ ok: true });
  }
  if (action === "rule_add") {
    const pattern = String(body.pattern || "").trim().slice(0, 200);
    if (!pattern) return bad("укажите шаблон");
    try { new RegExp(pattern, "i"); } catch (e) { return bad("шаблон не разбирается: " + e.message); }
    await env.DB.prepare("INSERT INTO tag_rules (pattern, note, created_by, created_at) VALUES (?,?,?,?)").bind(pattern, String(body.note || "").slice(0, 200), user.login, now()).run();
    await audit(env, user.login, "tags.rule_add", pattern);
    return json({ ok: true });
  }
  if (action === "rule_del") {
    const id = parseInt(body.id, 10);
    if (!id) return bad("укажите id");
    await env.DB.prepare("DELETE FROM tag_rules WHERE id = ?").bind(id).run();
    await audit(env, user.login, "tags.rule_del", String(id));
    return json({ ok: true });
  }
  return bad("неизвестное действие");
}
