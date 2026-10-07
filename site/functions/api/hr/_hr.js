// Общее для HR: даты, ближайшие праздники, остаток отпуска.
import { level } from "../_lib.js";

// сотрудник HR: тот, кому открыта закрытая часть (правка на «HR» или явный доступ к «Для HR»)
export const isHR = (user) => level(user, "hr.team") >= 1;

// сегодня по Москве, ГГГГ-ММ-ДД
export function today() {
  return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {   // b − a в днях
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
}
// дата: ГГГГ-ММ-ДД или --ММ-ДД (год неизвестен); пусто — ок
export function cleanDate(v, allowNoYear) {
  const s = String(v || "").trim();
  if (!s) return "";
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(s);
  if (!m || (!m[1] && !allowNoYear)) return null;
  const mm = +m[2], dd = +m[3];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return s;
}
// ближайшая дата с тем же днём и месяцем, не раньше from; 29.02 в невисокосный год — 28.02
function nextOccur(mmdd, from) {
  for (const y of [+from.slice(0, 4), +from.slice(0, 4) + 1]) {
    let [mm, dd] = mmdd.split("-").map(Number);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (mm === 2 && dd === 29 && !leap) dd = 28;
    const iso = y + "-" + String(mm).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
    if (iso >= from) return iso;
  }
  return null;
}

// праздники на days дней вперёд: дни рождения, годовщины в компании и (только для HR) дети
export function upcoming(people, children, from, days, withChildren) {
  const to = addDays(from, days), out = [];
  const byId = {}; for (const p of people) byId[p.id] = p;
  const push = (date, kind, person, extra) => { if (date && date <= to) out.push(Object.assign({ date, in: daysBetween(from, date), kind, person: person.id, name: person.name }, extra)); };
  for (const p of people) {
    if (p.status !== "active") continue;
    if (p.birth) push(nextOccur(p.birth.slice(-5), from), "birthday", p, {});
    if (/^\d{4}/.test(p.hired)) {
      const d = nextOccur(p.hired.slice(-5), from);
      const years = d ? +d.slice(0, 4) - +p.hired.slice(0, 4) : 0;
      if (years >= 1) push(d, "anniversary", p, { years });
    }
  }
  if (withChildren) for (const c of children) {
    const p = byId[c.person];
    if (!p || p.status !== "active" || !c.birth) continue;
    const d = nextOccur(c.birth.slice(-5), from);
    push(d, "child", p, { child: c.name, age: /^\d{4}/.test(c.birth) && d ? +d.slice(0, 4) - +c.birth.slice(0, 4) : null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "ru"));
}

// отпуск: начисляется leave_year дней в год за полные месяцы с даты выхода; списываются отпуска (кроме больничных)
export function balance(p, leaves, day) {
  const mine = leaves.filter((l) => l.person === p.id);
  const vac = mine.filter((l) => l.kind === "vacation");
  const taken = vac.filter((l) => l.date_from <= day).reduce((s, l) => s + Number(l.days), 0);
  const planned = vac.filter((l) => l.date_from > day).reduce((s, l) => s + Number(l.days), 0);
  const year = day.slice(0, 4);
  const sick = mine.filter((l) => l.kind === "sick" && l.date_from.slice(0, 4) === year).reduce((s, l) => s + Number(l.days), 0);
  let accrued = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.hired) && p.hired <= day) {
    const [hy, hm, hd] = p.hired.split("-").map(Number), [ty, tm, td] = day.split("-").map(Number);
    const months = (ty - hy) * 12 + (tm - hm) - (td < hd ? 1 : 0);
    accrued = Math.round(Math.max(0, months) * Number(p.leave_year || 28) / 12 * 10) / 10;
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return { accrued, taken: r1(taken), planned: r1(planned), adj: Number(p.leave_adj || 0), sick_year: r1(sick),
    left: accrued == null ? null : r1(accrued + Number(p.leave_adj || 0) - taken - planned) };
}
