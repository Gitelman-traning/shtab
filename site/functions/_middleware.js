/**
 * Один общий пароль на весь дашборд (страницы ОКК и Штаба); /api/* — своя проверка.
 *
 * Пароль ещё не задан — первый вошедший его придумывает, и дальше он общий для всех.
 * Хранится в KV (OKK_KV, ключ "password"), в репозитории и в коде его нет.
 * Логина нет: только поле пароля, дальше месяц живёт cookie — в ней подпись пароля,
 * а не он сам, восстановить оттуда пароль нельзя.
 *
 * Сбросить пароль (например, если утёк):
 *   npx wrangler kv key delete password --namespace-id 7d847d9c74434c35a28b148f488dd3b0
 * После сброса первый вошедший задаёт новый.
 */

import { currentUser, createSession, dropSession, verifyPassword, audit, tgVerify, tgSend, now } from "./api/_lib.js";

const COOKIE = "okk_auth";
const LOGIN = "admin";          // единый логин к общему паролю (решение 04.09.2026)
const MONTH = 60 * 60 * 24 * 30;
const KEY = "password";
const MIN_LEN = 6;

async function sign(password) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("okk-dashboard"));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Сравнение без ранней остановки: не даём подобрать значение по времени ответа. */
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function page({ setup, message, tgBot }) {
  const title = setup ? "Придумайте пароль" : "Вход";
  const hint = setup
    ? "Пароль ещё не задан. Тот, что вы введёте, станет общим для всех, кто открывает дашборд."
    : "Страница закрыта: внутри данные компании. Логин один на всех, пароль общий.";
  const action = setup ? "/__setup" : "/__login";
  const button = setup ? "Сохранить пароль" : "Войти";
  const autocomplete = setup ? "new-password" : "current-password";
  const note = message ? `<p class="err">${message}</p>` : `<p class="hint">${hint}</p>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Штаб · Вход</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=TikTok+Sans:opsz,wght@12..36,300..900&display=swap">
<style>
  :root{--ground:#f2f2f2;--surface:#fff;--line:#dedbd4;--text:#151616;--muted:#6b6760;
    --accent:#8a6f3d;--gold-a:#d8c9a8;--gold-b:#b59f76;--bad:#b8342a;--bad-bg:#f8ded9}
  @media (prefers-color-scheme:dark){:root{--ground:#151616;--surface:#1c1e1d;--line:#2c2f2e;
    --text:#f4f2ee;--muted:#948f86;--accent:#c9b487;--bad:#f95d51;--bad-bg:#301718}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--ground);
    color:var(--text);font-family:"TikTok Sans",Arial,Helvetica,sans-serif;padding:24px}
  form{background:var(--surface);border:1px solid var(--line);padding:28px;width:min(380px,100%);
    display:flex;flex-direction:column;gap:14px}
  .mark{width:36px;height:36px;display:grid;place-items:center;color:#151616;font-weight:800;
    background:linear-gradient(135deg,var(--gold-a),var(--gold-b));letter-spacing:-.04em}
  h1{margin:0;font-size:16px;font-weight:800;text-transform:uppercase;letter-spacing:-.01em}
  .hint,.err{margin:0;font-size:12.5px;color:var(--muted);line-height:1.45}
  .err{color:var(--bad);background:var(--bad-bg);padding:8px 10px}
  input{font-family:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--line);
    background:var(--ground);color:var(--text);width:100%}
  button{font-family:inherit;font-size:12px;font-weight:800;text-transform:uppercase;
    letter-spacing:.08em;padding:11px;border:0;cursor:pointer;color:#151616;
    background:linear-gradient(135deg,var(--gold-a),var(--gold-b))}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
  .tg{display:flex;justify-content:center;min-height:40px}
</style></head><body>
<form method="POST" action="${action}">
  <div class="mark">12</div>
  <h1>Штаб · ${title}</h1>
  ${note}
  <input type="text" name="login" placeholder="Логин" autofocus required autocomplete="username" aria-label="Логин">
  <input type="password" name="password" placeholder="Пароль" required
         autocomplete="${autocomplete}" aria-label="Пароль"${setup ? ` minlength="${MIN_LEN}"` : ""}>
  <button type="submit">${button}</button>
  ${tgBot && !setup ? `<div class="or"><span>или</span></div>
  <div class="tg"><script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${tgBot}" data-size="large" data-userpic="false" data-radius="6" data-auth-url="/__tg" data-request-access="write"></script></div>
  <p class="hint">Через Telegram: первый вход создаёт заявку, администратор подтверждает доступ.</p>` : ""}
</form></body></html>`;
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function letIn(token) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${MONTH}; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (!env.OKK_KV) return new Response("Хранилище пароля не подключено", { status: 500 });

  const url = new URL(request.url);
  // API витрины Штаба проверяет доступ сам: токен сборщика или персональная сессия
  if (url.pathname.startsWith("/api/")) return next();

  const stored = await env.OKK_KV.get(KEY);
  // тело читаем только у форм входа: иначе запрос уйдёт дальше уже «пустым»
  const isForm = request.method === "POST" &&
    (url.pathname === "/__login" || url.pathname === "/__setup");
  const posted = isForm;
  let value = "", login = "";
  if (isForm) {
    const form = await request.formData();
    value = String(form.get("password") || "");
    login = String(form.get("login") || "").trim().toLowerCase();
  }

  // выход: снимаем и общую cookie, и именную сессию
  if (url.pathname === "/__logout") {
    const gone = await dropSession(env, request);
    return new Response(null, { status: 303, headers: [["Location", "/"], ["Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`], ["Set-Cookie", gone], ["Cache-Control", "no-store"]] });
  }

  // вход через Telegram: виджет возвращает сюда подписанные данные аккаунта
  if (url.pathname === "/__tg") {
    if (!env.TG_BOT_TOKEN || !env.DB) return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Вход через Telegram не настроен." }), 503);
    const tg = await tgVerify(url.searchParams, env.TG_BOT_TOKEN);
    if (!tg) return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Подпись Telegram не сошлась или устарела. Попробуйте ещё раз." }), 403);
    const tgId = Number(tg.id);
    const fullName = [tg.first_name, tg.last_name].filter(Boolean).join(" ").slice(0, 80);
    let row = await env.DB.prepare("SELECT login, role, active FROM users WHERE tg_id = ?").bind(tgId).first();
    if (!row) {
      // заявка: пользователь создаётся без доступа, администратор подтверждает и назначает роль
      let login = String(tg.username || "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
      if (login.length < 3) login = "tg" + tgId;
      const taken = await env.DB.prepare("SELECT login FROM users WHERE login = ?").bind(login).first();
      if (taken) login = login + "-" + String(tgId).slice(-4);
      await env.DB.prepare(
        "INSERT INTO users (login, pass_hash, salt, name, role, sections, active, must_change, created_at, tg_id, tg_username, photo) VALUES (?,?,?,?,?,?,0,0,?,?,?,?)")
        .bind(login, "", "", fullName, "pending", "", now(), tgId, tg.username || "", tg.photo_url || "").run();
      await audit(env, login, "tg.request", login, fullName + (tg.username ? " @" + tg.username : ""));
      await tgSend(env, env.TG_ADMIN_CHAT, "Штаб: заявка на доступ — " + fullName + (tg.username ? " (@" + tg.username + ")" : "") + ". Подтвердить: https://okk-dashboard.pages.dev/users");
      await tgSend(env, tgId, "Заявка на доступ в Штаб отправлена. Когда администратор подтвердит, придёт сообщение.");
      return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Заявка отправлена. Администратор подтвердит доступ, и вы сможете войти этой же кнопкой." }), 202);
    }
    if (!row.active || row.role === "pending") {
      return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Заявка ещё не подтверждена. Мы напишем в Telegram, когда доступ откроют." }), 403);
    }
    await env.DB.prepare("UPDATE users SET tg_username = ?, photo = ? WHERE login = ?").bind(tg.username || "", tg.photo_url || "", row.login).run();
    const s = await createSession(env, row.login);
    await audit(env, row.login, "login.tg");
    return new Response(null, { status: 303, headers: { Location: "/shtab", "Set-Cookie": s.cookie, "Cache-Control": "no-store" } });
  }

  // именной пользователь: логин не «admin» — ищем в базе, сессия в cookie shtab_s
  if (posted && url.pathname === "/__login" && login && login !== LOGIN) {
    const row = env.DB ? await env.DB.prepare("SELECT login, pass_hash, salt, active FROM users WHERE login = ?").bind(login).first() : null;
    if (!row || !row.active || !(await verifyPassword(value, row.salt, row.pass_hash))) {
      await audit(env, login, "login.fail");
      return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Логин или пароль не подошли. Попробуйте ещё раз." }), 401);
    }
    const s = await createSession(env, row.login);
    await audit(env, row.login, "login");
    return new Response(null, { status: 303, headers: { Location: "/shtab", "Set-Cookie": s.cookie, "Cache-Control": "no-store" } });
  }
  if (env.DB && await currentUser(request, env)) {
    const response = await next();
    const out = new Response(response.body, response);
    out.headers.set("Cache-Control", "no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  }

  // пароля ещё нет — первый вошедший его задаёт
  if (!stored) {
    if (posted && url.pathname === "/__setup") {
      if (!same(login, LOGIN)) {
        return html(page({ tgBot: env.TG_BOT_NAME, setup: true, message: "Логин должен быть " + LOGIN + "." }), 400);
      }
      if (value.length < MIN_LEN) {
        return html(page({ tgBot: env.TG_BOT_NAME, setup: true, message: `Пароль короче ${MIN_LEN} символов — так не пойдёт.` }), 400);
      }
      // если кто-то успел раньше, его пароль остаётся в силе
      const again = await env.OKK_KV.get(KEY);
      if (again) return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Пароль уже задан. Введите его." }), 409);
      await env.OKK_KV.put(KEY, value);
      return letIn(await sign(value));
    }
    return html(page({ tgBot: env.TG_BOT_NAME, setup: true, message: "" }), 401);
  }

  // пароль задан — обычный вход
  if (posted && url.pathname === "/__login") {
    if (!same(login, LOGIN) || !same(value, stored)) {
      return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "Логин или пароль не подошли. Попробуйте ещё раз." }), 401);
    }
    return letIn(await sign(stored));
  }

  if (!same(cookieValue(request, COOKIE) || "", await sign(stored))) {
    return html(page({ tgBot: env.TG_BOT_NAME, setup: false, message: "" }), 401);
  }

  const response = await next();
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}
