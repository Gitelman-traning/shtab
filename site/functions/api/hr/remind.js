// HR · напоминания в Telegram: POST /api/hr/remind (токен сборщика, раз в день из GitHub Actions hr-remind.yml).
// Сотрудникам HR со связанным Telegram — праздники сегодня и через 3 дня. Если таких нет — администраторам.
// ?dry=1 — вернуть текст и число получателей, ничего не отправляя.
import { json, bad, hasIngestToken, loadPerms, tgSend } from "../_lib.js";
import { isHR, today, upcoming } from "./_hr.js";

const RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const dm = (iso) => +iso.slice(8, 10) + " " + RU[+iso.slice(5, 7) - 1];
function yrs(n) { const m = n % 10, h = n % 100; return n + " " + (m === 1 && h !== 11 ? "год" : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? "года" : "лет"); }
function line(e) {
  if (e.kind === "birthday") return "🎂 " + e.name + ": день рождения";
  if (e.kind === "anniversary") return "🎉 " + e.name + ": " + yrs(e.years) + " в компании";
  return "🧸 " + e.name + ": день рождения ребёнка, " + e.child + (e.age ? " (" + yrs(e.age) + ")" : "");
}

export async function onRequestPost({ request, env }) {
  if (!hasIngestToken(request, env)) return bad("нужен токен сборщика", 401);
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const people = (await env.DB.prepare("SELECT id, name, status, birth, hired FROM hr_people WHERE status = 'active'").all()).results || [];
  const children = (await env.DB.prepare("SELECT person, name, birth FROM hr_children").all()).results || [];
  const day = today();
  const ev = upcoming(people, children, day, 3, true).filter((e) => e.in === 0 || e.in === 3);
  if (!ev.length) return json({ ok: true, sent: 0, text: "" });
  const now0 = ev.filter((e) => e.in === 0), in3 = ev.filter((e) => e.in === 3);
  const text = ["Штаб · HR: поздравления",
    now0.length ? "Сегодня, " + dm(day) + ":\n" + now0.map(line).join("\n") : "",
    in3.length ? "Через 3 дня, " + dm(in3[0].date) + ":\n" + in3.map(line).join("\n") : ""].filter(Boolean).join("\n\n");
  // кому: активные именные пользователи с Telegram, у кого открыта закрытая часть HR; администраторы — запасной вариант
  const users = (await env.DB.prepare("SELECT login, role, sections, tg_id FROM users WHERE active = 1 AND tg_id IS NOT NULL AND role != 'pending'").all()).results || [];
  let to = [];
  for (const u of users) {
    if (u.role === "admin") continue;
    u.perms = await loadPerms(env, u.login, u.sections);
    if (isHR(u)) to.push(u.tg_id);
  }
  if (!to.length) to = users.filter((u) => u.role === "admin").map((u) => u.tg_id);
  if (dry) return json({ ok: true, dry: true, to: to.length, text });
  let sent = 0;
  for (const id of to) if (await tgSend(env, id, text)) sent++;
  return json({ ok: true, sent, text });
}
