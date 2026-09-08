// POST /api/sections/<id>/draft {prompt, base_version?} — модель пишет новую страницу раздела по просьбе словами.
// Результат сохраняется как новая версия (active = 0): редактор смотрит предпросмотр и публикует отдельно.
import { json, bad, canRead, canEdit, audit, now, llmChat } from "../../_lib.js";

const MAX_PROMPT = 1500;
const MAX_BASE = 60000;

const SYSTEM = `Ты делаешь ОДНУ самодостаточную HTML-страницу для раздела внутреннего дашборда компании.
Страница показывается внутри iframe на сайте Штаба, данные берёт сама через fetch.

Жёсткие правила:
1. Ответ — только HTML-документ целиком, начиная с <!doctype html>. Никаких пояснений до и после, никаких markdown-ограждений.
2. Никаких внешних скриптов, стилей, шрифтов, картинок, CDN. Весь CSS и JS внутри страницы. Графики — inline SVG, нарисованный своим JS.
3. Данные — только через fetch(DATA_URL, {credentials:"same-origin"}). Ответ JSON:
   {ok, section, name, from, to, metrics:[{id,name,unit,definition}], rows:[[metric, "YYYY-MM-DD", dim, value], ...]}
   dim "" — итог за день; непустой dim — срез (источник лида, менеджер). Не суммируй срезы с итогом.
   Если в ответе есть stock — это снимки состояния (участники по месяцам потока: pay.full полные оплаты, pay.prepaid предоплаты,
   pay.bloggers блогеры, pay.participants участники, pay.receipts прислали чек; period "shortlist" — шортлист). Их не складывают по дням.
   Недели и месяцы складывай сам из дней. Конверсия = отношение показателей.
4. Палитра через CSS-переменные, светлая и тёмная тема:
   :root{--page:#faf8f4;--card:#fff;--soft:#f3f1ec;--line:#f1eee8;--ink:#2b2721;--dim:#7b766f;--faint:#a29d95;--gold:#8a6f3d;--gold-soft:#efe7d6;--gold-b:#b59f76;--ok:#38765a;--ok-bg:#e8f2ec;--bad:#ad4636;--bad-bg:#fbe9e6;--blue:#4f6d8f}
   @media (prefers-color-scheme:dark){:root{--page:#161718;--card:#1e2021;--soft:#232526;--line:#282a2b;--ink:#eceae5;--dim:#9a958d;--faint:#75716a;--gold:#c9b487;--gold-soft:#2a2721;--gold-b:#b59f76;--ok:#7cc396;--ok-bg:#1b2b23;--bad:#e58975;--bad-bg:#2f1e1a;--blue:#8fa8c4}}
   Шрифт: Inter, Arial, sans-serif. Фон body — var(--page), карточки var(--card) с радиусом 16px. Без боковых меню и шапок сайта: только содержимое раздела.
5. Русский язык, аккуратные подписи, числа с разрядами. Если данных нет — честно написать «данных нет».
6. Размер страницы — до 40 000 символов. Без localStorage, без запросов куда-либо, кроме DATA_URL.
7. Если дана текущая версия страницы — измени её по просьбе, сохранив всё остальное, а не переписывай с нуля.`;

function stripFences(t) {
  t = t.trim();
  const m = t.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (m) t = m[1].trim();
  const i = t.search(/<!doctype html/i);
  return i > 0 ? t.slice(i) : t;
}

export async function onRequestPost({ request, env, params }) {
  const user = await canRead(request, env);
  if (!user || !canEdit(user, params.id)) return bad("менять этот раздел могут его владельцы и администратор", 403);
  const sec = await env.DB.prepare("SELECT id, name, config FROM sections WHERE id = ?").bind(params.id).first();
  if (!sec) return bad("раздела нет", 404);
  let b;
  try { b = await request.json(); } catch (e) { return bad("тело не JSON"); }
  const prompt = String(b.prompt || "").trim().slice(0, MAX_PROMPT);
  if (prompt.length < 5) return bad("опишите, что изменить");

  let base = null;
  if (b.base_version) {
    base = await env.DB.prepare("SELECT version, html FROM section_versions WHERE section = ? AND version = ?").bind(sec.id, parseInt(b.base_version, 10)).first();
  } else {
    base = await env.DB.prepare("SELECT version, html FROM section_versions WHERE section = ? AND active = 1").bind(sec.id).first();
  }
  let cfg = {};
  try { cfg = JSON.parse(sec.config || "{}"); } catch (e) {}
  const dataUrl = "/api/sections/" + sec.id + "/data?days=120";
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content:
      "Раздел: «" + sec.name + "» (id " + sec.id + ").\nDATA_URL = \"" + dataUrl + "\".\nПоказатели раздела: " + (cfg.metrics || []).join(", ") + ".\n" +
      (base ? "Текущая версия страницы (v" + base.version + "):\n<<<\n" + String(base.html).slice(0, MAX_BASE) + "\n>>>\n\n" : "Текущей версии нет — сделай страницу с нуля: ключевые цифры за вчера/неделю/месяц, таблица по неделям, один-два графика.\n\n") +
      "Просьба редактора: " + prompt + "\n\nВерни только HTML." },
  ];
  let out;
  try {
    out = await llmChat(env, messages, { max_tokens: 20000, temperature: 0.2 });
  } catch (e) {
    return bad("модель не справилась: " + e.message, 502);
  }
  const html = stripFences(out.text);
  if (!/<!doctype html/i.test(html) || html.length < 500) return bad("модель вернула не страницу, попробуйте переформулировать", 502);
  if (/<script[^>]+src=|<link[^>]+href=|@import/i.test(html)) return bad("модель подключила внешние файлы — это запрещено, попробуйте ещё раз", 502);
  const last = await env.DB.prepare("SELECT MAX(version) AS v FROM section_versions WHERE section = ?").bind(sec.id).first();
  const version = ((last && last.v) || 0) + 1;
  await env.DB.prepare(
    "INSERT INTO section_versions (section, version, html, prompt, author, created_at, active) VALUES (?,?,?,?,?,?,0)")
    .bind(sec.id, version, html.slice(0, 60000), prompt, user.login, now()).run();
  await audit(env, user.login, "section.draft", sec.id, "v" + version + " · " + out.model + " · " + prompt.slice(0, 120));
  return json({ ok: true, version, model: out.model, size: html.length });
}
