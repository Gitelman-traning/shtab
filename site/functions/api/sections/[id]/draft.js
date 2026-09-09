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
4. Палитра через CSS-переменные. Тему задаёт сайт атрибутом data-theme на <html> ("light" или "dark"); без атрибута — системная. Ровно так:
   :root{--page:#faf8f4;--card:#fff;--soft:#f3f1ec;--line:#f1eee8;--ink:#2b2721;--dim:#7b766f;--faint:#a29d95;--gold:#8a6f3d;--gold-soft:#efe7d6;--gold-b:#b59f76;--ok:#38765a;--ok-bg:#e8f2ec;--bad:#ad4636;--bad-bg:#fbe9e6;--blue:#4f6d8f}
   @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--page:#161718;--card:#1e2021;--soft:#232526;--line:#282a2b;--ink:#eceae5;--dim:#9a958d;--faint:#75716a;--gold:#c9b487;--gold-soft:#2a2721;--gold-b:#b59f76;--ok:#7cc396;--ok-bg:#1b2b23;--bad:#e58975;--bad-bg:#2f1e1a;--blue:#8fa8c4}}
   :root[data-theme="dark"]{--page:#161718;--card:#1e2021;--soft:#232526;--line:#282a2b;--ink:#eceae5;--dim:#9a958d;--faint:#75716a;--gold:#c9b487;--gold-soft:#2a2721;--gold-b:#b59f76;--ok:#7cc396;--ok-bg:#1b2b23;--bad:#e58975;--bad-bg:#2f1e1a;--blue:#8fa8c4}
   Шрифт: Inter, Arial, sans-serif. Фон body — var(--page), карточки var(--card) с радиусом 16px. Без боковых меню и шапок сайта: только содержимое раздела.
5. Русский язык, аккуратные подписи, числа с разрядами. Если данных нет — честно написать «данных нет».
6. Размер страницы — до 30 000 символов, без длинных комментариев и повторов кода: чем компактнее, тем быстрее ответ. Без localStorage, без запросов куда-либо, кроме DATA_URL.
7. Если дана текущая версия страницы — измени её по просьбе, сохранив всё остальное, а не переписывай с нуля.
8. ДАТЫ. Никогда не используй new Date("YYYY-MM-DD"), toISOString(), getDay() для дат: часовой пояс сдвигает день и циклы зависают.
   Используй ровно эти функции (скопируй их в страницу как есть) и работай со строками "YYYY-MM-DD":
   function dParse(s){const p=s.split("-");return Date.UTC(+p[0],+p[1]-1,+p[2]);}
   function dStr(ms){const d=new Date(ms);return d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0")+"-"+String(d.getUTCDate()).padStart(2,"0");}
   function addDays(s,n){return dStr(dParse(s)+n*86400000);}
   function mondayOf(s){const d=new Date(dParse(s));const w=(d.getUTCDay()+6)%7;return dStr(dParse(s)-w*86400000);}
   function daysBetween(a,b){return Math.round((dParse(b)-dParse(a))/86400000);}
   Любой цикл по дням — for со счётчиком по daysBetween, не while по строкам. Сегодняшняя дата = поле to из данных (последний день), не new Date().

Мягкое правило (стиль воронок, принят в компании; отступай только по прямой просьбе):
воронка — «лестница» из горизонтальных полос, по одной на ступень, сверху вниз. Серая полоса (var(--soft)) — план на месяц, золотая (var(--gold-b)) — факт,
цифры прямо на полосе: над ней слева «факт N», справа «план N». Пунктирная риска с серым бейджем «план на сегодня N» над полосой, сплошная золотая
риска с золотым бейджем «прогноз N · % плана» под полосой (прогноз = факт / прошедших дней × дней в месяце). Один цвет полос, без зелёного/красного
в самих полосах. Между ступенями мелкая строка «↓ конверсия факт X% · план Y%», где X зелёный (var(--ok)), если не ниже плана, и красный (var(--bad)), если ниже.`;

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
  // вложения: до 4 штук, картинки как data:image/...;base64 (до 2 МБ каждая), текст и html до 60 тыс. символов
  const attachments = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 4).filter((a) => a && a.name && a.data);
  const images = [], texts = [];
  for (const a of attachments) {
    const name = String(a.name).slice(0, 80);
    if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(a.data) && a.data.length < 2800000) images.push({ name, url: a.data });
    else if (typeof a.data === "string" && !/^data:/.test(a.data)) texts.push({ name, text: a.data.slice(0, 60000) });
  }

  let base = null;
  if (b.base_version) {
    base = await env.DB.prepare("SELECT version, html FROM section_versions WHERE section = ? AND version = ?").bind(sec.id, parseInt(b.base_version, 10)).first();
  } else {
    base = await env.DB.prepare("SELECT version, html FROM section_versions WHERE section = ? AND active = 1").bind(sec.id).first();
  }
  let cfg = {};
  try { cfg = JSON.parse(sec.config || "{}"); } catch (e) {}
  const dataUrl = "/api/sections/" + sec.id + "/data?days=120";
  const userText =
      "Раздел: «" + sec.name + "» (id " + sec.id + ").\nDATA_URL = \"" + dataUrl + "\".\nПоказатели раздела: " + (cfg.metrics || []).join(", ") + ".\n" +
      (base ? "Текущая версия страницы (v" + base.version + "):\n<<<\n" + String(base.html).slice(0, MAX_BASE) + "\n>>>\n\n" : "Текущей версии нет — сделай страницу с нуля: ключевые цифры за вчера/неделю/месяц, таблица по неделям, один-два графика.\n\n") +
      (texts.length ? texts.map((x) => "Приложенный файл «" + x.name + "»:\n<<<\n" + x.text + "\n>>>\n").join("\n") + "\n" : "") +
      (images.length ? "Приложены примеры-картинки (" + images.map((x) => x.name).join(", ") + "): повтори их структуру и подачу, но с нашими данными и нашей палитрой.\n\n" : "") +
      "Просьба редактора: " + prompt + "\n\nВерни только HTML.";
  const content = images.length
    ? [{ type: "text", text: userText }].concat(images.map((x) => ({ type: "image_url", image_url: { url: x.url } })))
    : userText;
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content },
  ];
  let out, html = "";
  try {
    out = await llmChat(env, messages, { max_tokens: 14000, temperature: 0.2 });
    html = stripFences(out.text);
    // поток у провайдера иногда обрывается на середине: просим дописать с места обрыва, до трёх раз
    for (let i = 0; i < 3 && !/<\/html>\s*$/i.test(html); i++) {
      const more = await llmChat(env, messages.concat([
        { role: "assistant", content: html },
        { role: "user", content: "Ответ оборвался. Продолжи РОВНО с того места, где остановился — с первого недостающего символа, без повтора уже написанного, без пояснений и без ограждений. Доведи документ до </html>." },
      ]), { max_tokens: 14000, temperature: 0.2 });
      let add = more.text.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");
      // модель могла повторить хвост — срезаем пересечение
      for (let k = Math.min(400, add.length); k > 20; k--) { if (html.endsWith(add.slice(0, k))) { add = add.slice(k); break; } }
      html += add;
    }
  } catch (e) {
    await audit(env, user.login, "section.draft.fail", sec.id, e.message.slice(0, 120) + " · " + prompt.slice(0, 120));
    return bad("модель не успела: " + e.message + ". Нажмите «Сделать вариант» ещё раз или сократите просьбу.", 502);
  }
  if (!/<\/html>\s*$/i.test(html)) {
    await audit(env, user.login, "section.draft.fail", sec.id, "страница не дописана · " + prompt.slice(0, 120));
    return bad("модель не дописала страницу до конца, попробуйте ещё раз или сократите просьбу", 502);
  }
  if (!/<!doctype html/i.test(html) || html.length < 500) return bad("модель вернула не страницу, попробуйте переформулировать", 502);
  if (/<script[^>]+src=|<link[^>]+href=|@import/i.test(html)) return bad("модель подключила внешние файлы — это запрещено, попробуйте ещё раз", 502);
  const last = await env.DB.prepare("SELECT MAX(version) AS v FROM section_versions WHERE section = ?").bind(sec.id).first();
  const version = ((last && last.v) || 0) + 1;
  await env.DB.prepare(
    "INSERT INTO section_versions (section, version, html, prompt, author, created_at, active) VALUES (?,?,?,?,?,?,0)")
    .bind(sec.id, version, html.slice(0, 60000), prompt, user.login, now()).run();
  await audit(env, user.login, "section.draft", sec.id, "v" + version + " · " + out.model + (attachments.length ? " · вложений " + attachments.length : "") + " · " + prompt.slice(0, 120));
  return json({ ok: true, version, model: out.model, size: html.length });
}
