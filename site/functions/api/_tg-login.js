import { randomId, sessionTicket, getCookie, now } from './_lib.js';

const BROWSER = '__Host-shtab_tg';
const expiresIn = seconds => new Date(Date.now() + seconds * 1000).toISOString();
async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function beginLogin(env, request, returnTo = '/') {
  const saved = getCookie(request, BROWSER);
  const browser = /^[a-f0-9]{64}$/.test(saved) ? saved : randomId(32);
  const code = randomId(16);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tg_login_codes WHERE expires <= ?').bind(now()),
    env.DB.prepare('INSERT INTO tg_login_codes (code,browser,expires,return_to) VALUES (?,?,?,?)')
      .bind(await digest(code), await digest(browser), expiresIn(600), returnTo),
  ]);
  return {code, cookie:`${BROWSER}=${browser}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`};
}

export async function reserveCode(env, code, tgId) {
  const result = await env.DB.prepare("UPDATE tg_login_codes SET tg_id=? WHERE code=? AND expires>? AND state='wait' AND (tg_id IS NULL OR tg_id=?)")
    .bind(tgId, await digest(code), now(), tgId).run();
  return result.meta.changes === 1;
}

export async function confirmCode(env, code, tgId, active) {
  const goKey = randomId(16), state = active ? 'ok' : 'pending';
  const result = await env.DB.prepare("UPDATE tg_login_codes SET state=?, go_key=?, expires=? WHERE code=? AND tg_id=? AND state='wait' AND expires>?")
    .bind(state, await digest(goKey), expiresIn(active ? 600 : 86400), await digest(code), tgId, now()).run();
  return result.meta.changes === 1 ? goKey : null;
}

export async function redeemCode(env, request, code, direct) {
  if (!/^[a-f0-9]{32}$/.test(code)) return {status:'expired'};
  // Вкладке нужен браузерный секрет. Для другого устройства бот выдаёт отдельную закрытую ссылку.
  const match = direct ? 'g.go_key=?' : 'g.code=? AND g.browser=?';
  const args = [await digest(code)];
  if (!direct) args.push(await digest(getCookie(request, BROWSER)));
  const grant = await env.DB.prepare(`SELECT g.code,g.state,g.return_to FROM tg_login_codes g WHERE ${match} AND g.expires>?`).bind(...args,now()).first();
  if (!grant) return {status:'expired'};
  if (grant.state === 'wait') return {status:'wait'};
  const ticket = sessionTicket();
  // Сессия и погашение в одной транзакции. После COMMIT второй запрос не найдёт исходную строку.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (id,login,expires) SELECT ?,u.login,? FROM tg_login_codes g JOIN users u ON u.tg_id=g.tg_id WHERE ${match} AND g.expires>? AND g.state IN ('ok','pending') AND u.active=1 AND u.role!='pending' AND (u.must_change=0 OR u.temp_expires>?) LIMIT 1`)
      .bind(ticket.id,ticket.expires,...args,now(),now()),
    env.DB.prepare('DELETE FROM tg_login_codes WHERE code=? AND EXISTS (SELECT 1 FROM sessions WHERE id=?)').bind(grant.code,ticket.id),
    env.DB.prepare('UPDATE users SET last_login=? WHERE login=(SELECT login FROM sessions WHERE id=?)').bind(now(),ticket.id),
  ]);
  if (result[0].meta.changes !== 1) {
    const remaining = await env.DB.prepare('SELECT state FROM tg_login_codes WHERE code=? AND expires>?').bind(grant.code,now()).first();
    return {status:remaining?.state === 'pending' ? 'pending' : 'expired'};
  }
  return {status:'ok', cookie:ticket.cookie, returnTo:grant.return_to};
}
