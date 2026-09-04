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

const COOKIE = "okk_auth";
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

function page({ setup, message }) {
  const title = setup ? "Придумайте пароль" : "Вход";
  const hint = setup
    ? "Пароль ещё не задан. Тот, что вы введёте, станет общим для всех, кто открывает дашборд."
    : "Страница закрыта: внутри разборы встреч с клиентами.";
  const action = setup ? "/__setup" : "/__login";
  const button = setup ? "Сохранить пароль" : "Войти";
  const autocomplete = setup ? "new-password" : "current-password";
  const note = message ? `<p class="err">${message}</p>` : `<p class="hint">${hint}</p>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ОКК · Разбор диагностик</title>
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
</style></head><body>
<form method="POST" action="${action}">
  <div class="mark">12</div>
  <h1>ОКК · ${title}</h1>
  ${note}
  <input type="password" name="password" placeholder="Пароль" autofocus required
         autocomplete="${autocomplete}" aria-label="Пароль"${setup ? ` minlength="${MIN_LEN}"` : ""}>
  <button type="submit">${button}</button>
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
  const value = isForm ? String((await request.formData()).get("password") || "") : "";

  // пароля ещё нет — первый вошедший его задаёт
  if (!stored) {
    if (posted && url.pathname === "/__setup") {
      if (value.length < MIN_LEN) {
        return html(page({ setup: true, message: `Пароль короче ${MIN_LEN} символов — так не пойдёт.` }), 400);
      }
      // если кто-то успел раньше, его пароль остаётся в силе
      const again = await env.OKK_KV.get(KEY);
      if (again) return html(page({ setup: false, message: "Пароль уже задан. Введите его." }), 409);
      await env.OKK_KV.put(KEY, value);
      return letIn(await sign(value));
    }
    return html(page({ setup: true, message: "" }), 401);
  }

  // пароль задан — обычный вход
  if (posted && url.pathname === "/__login") {
    if (!same(value, stored)) {
      return html(page({ setup: false, message: "Пароль не подошёл. Попробуйте ещё раз." }), 401);
    }
    return letIn(await sign(stored));
  }

  if (!same(cookieValue(request, COOKIE) || "", await sign(stored))) {
    return html(page({ setup: false, message: "" }), 401);
  }

  const response = await next();
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}
