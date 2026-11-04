// Локальная календарная дата (МСК), с необязательным неизвестным годом рождения.
export function calendarDate(value, allowNoYear=false) {
  const s=String(value ?? '').trim();
  if (!s) return '';
  const match=/^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(s);
  if(!match || (!match[1] && !allowNoYear)) return null;
  const year=match[1] ? Number(match[1]) : 2000, month=Number(match[2]), day=Number(match[3]);
  if(year<1 || month<1 || month>12) return null;
  const leap=year%4===0 && (year%100!==0 || year%400===0);
  return day>=1 && day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1] ? s : null;
}
