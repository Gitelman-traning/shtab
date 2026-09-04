// Общие помощники для API Штаба. Файлы с подчёркиванием маршрутами не становятся.

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export function bad(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Токен сборщика: Authorization: Bearer <INGEST_TOKEN>
export function hasIngestToken(request, env) {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return !!(env.INGEST_TOKEN && token && timingSafeEqual(token, env.INGEST_TOKEN));
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

// Сессия пользователя (персональные логины появятся на этапе 2; сейчас — только проверка)
export async function currentUser(request, env) {
  const sid = getCookie(request, "shtab_s");
  if (!sid) return null;
  const row = await env.DB.prepare(
    "SELECT u.login, u.name, u.role, u.sections FROM sessions s JOIN users u ON u.login = s.login " +
    "WHERE s.id = ? AND s.expires > ? AND u.active = 1"
  ).bind(sid, new Date().toISOString()).first();
  return row || null;
}

// Общий пароль страниц (тот же, что проверяет _middleware): cookie okk_auth = HMAC пароля из KV
async function signShared(password) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("okk-dashboard"));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hasSharedCookie(request, env) {
  if (!env.OKK_KV) return false;
  const c = getCookie(request, "okk_auth");
  if (!c) return false;
  const stored = await env.OKK_KV.get("password");
  return !!stored && timingSafeEqual(c, await signShared(stored));
}

// Читать данные можно по токену сборщика, с персональной сессией или с cookie общего пароля
export async function canRead(request, env) {
  if (hasIngestToken(request, env)) return { login: "collector", role: "admin", sections: "" };
  const user = await currentUser(request, env);
  if (user) return user;
  if (await hasSharedCookie(request, env)) return { login: "shared", role: "viewer", sections: "" };
  return null;
}

export function now() {
  return new Date().toISOString();
}
