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

export function now() {
  return new Date().toISOString();
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 24) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------- токен сборщика ----------
export function hasIngestToken(request, env) {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return !!(env.INGEST_TOKEN && token && timingSafeEqual(token, env.INGEST_TOKEN));
}

export function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

// ---------- пароли и сессии именных пользователей ----------
export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}

export async function verifyPassword(password, salt, stored) {
  return timingSafeEqual(await hashPassword(password, salt), stored || "");
}

export const SESSION_COOKIE = "shtab_s";
const SESSION_DAYS = 30;

export async function createSession(env, login) {
  const id = randomId(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, login, expires) VALUES (?,?,?)").bind(id, login, expires).run();
  await env.DB.prepare("UPDATE users SET last_login = ? WHERE login = ?").bind(now(), login).run();
  return { id, cookie: `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` };
}

export async function dropSession(env, request) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function currentUser(request, env) {
  const sid = getCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(
    "SELECT u.login, u.name, u.role, u.sections, u.must_change FROM sessions s JOIN users u ON u.login = s.login " +
    "WHERE s.id = ? AND s.expires > ? AND u.active = 1"
  ).bind(sid, now()).first();
  if (!row) return null;
  row.perms = await loadPerms(env, row.login, row.sections);
  return row;
}

// ---------- права по разделам ----------
// дерево разделов: подраздел наследует уровень отдела, если своей строки нет
export const SECTIONS = ["hub", "sales", "sales.l1", "sales.l2", "sales.l2.okk", "marketing", "guide", "status", "users"];
const PARENT = { "sales.l1": "sales", "sales.l2": "sales", "sales.l2.okk": "sales.l2" };

export async function loadPerms(env, login, sectionsCsv) {
  const rows = await env.DB.prepare("SELECT section, level FROM perms WHERE login = ?").bind(login).all();
  const p = {};
  for (const r of (rows.results || [])) p[r.section] = Number(r.level);
  // старое поле sections (через запятую) = право редактирования, пока не задано явно
  if (!Object.keys(p).length && sectionsCsv) {
    for (const s of String(sectionsCsv).split(",").map((x) => x.trim()).filter(Boolean)) p[s] = 2;
  }
  return p;
}

// 0 закрыт · 1 просмотр · 2 редактирование
export function level(user, section) {
  if (!user) return 0;
  if (user.role === "admin" || user.login === "collector") return 2;
  if (user.role === "pending" || user.active === 0) return 0;
  if (user.login === "shared") return section === "users" ? 0 : 1;   // общий пароль: смотрит всё
  if (section === "users") return 0;
  const p = user.perms || {};
  let s = section;
  while (s) { if (p[s] != null) return p[s]; s = PARENT[s] || null; }
  if (p["*"] != null) return p["*"];
  return 1;   // по умолчанию именной пользователь видит всё, менять не может
}

export function effectivePerms(user) {
  const out = {};
  for (const s of SECTIONS) out[s] = level(user, s);
  return out;
}

// какой раздел отвечает за адрес страницы
export function sectionOf(pathname) {
  const p = pathname.replace(/\.html$/, "").replace(/\/index$/, "/");
  if (p === "/" || p === "") return "hub";
  if (/^\/sales\/l2\/(meetings|managers|compare)/.test(p)) return "sales.l2.okk";
  if (p.startsWith("/sales/l2")) return "sales.l2";
  if (p.startsWith("/sales/l1")) return "sales.l1";
  if (p.startsWith("/sales")) return "sales";
  if (p.startsWith("/marketing")) return "marketing";
  if (p === "/guide") return "guide";
  if (p === "/status") return "status";
  if (p === "/users") return "users";
  return null;
}

// ---------- общий пароль (cookie okk_auth = HMAC пароля из KV, как в _middleware) ----------
async function signShared(password) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("okk-dashboard")));
}

export async function hasSharedCookie(request, env) {
  if (!env.OKK_KV) return false;
  const c = getCookie(request, "okk_auth");
  if (!c) return false;
  const stored = await env.OKK_KV.get("password");
  return !!stored && timingSafeEqual(c, await signShared(stored));
}

// ---------- кто пришёл ----------
// Читать данные можно по токену сборщика, с именной сессией или с cookie общего пароля
export async function canRead(request, env) {
  if (hasIngestToken(request, env)) return { login: "collector", role: "admin", sections: "" };
  const user = await currentUser(request, env);
  if (user) return user;
  if (await hasSharedCookie(request, env)) return { login: "shared", role: "viewer", sections: "" };
  return null;
}

export function isAdmin(user) {
  return !!user && user.role === "admin";
}

// Менять раздел может тот, у кого уровень «редактирование»
export function canEdit(user, section) {
  return level(user, section) >= 2;
}
export function canView(user, section) {
  return level(user, section) >= 1;
}

export async function audit(env, login, action, target = "", note = "") {
  try {
    await env.DB.prepare("INSERT INTO audit (at, login, action, target, note) VALUES (?,?,?,?,?)")
      .bind(now(), login || "?", action, String(target || "").slice(0, 120), String(note || "").slice(0, 400)).run();
  } catch (e) { /* журнал не должен ломать действие */ }
}

// ---------- модель (тот же провайдер, что у «вопроса по встрече») ----------
const DEFAULT_BASE = "https://openrouter.ai/api/v1";
const FREE_MODELS = ["minimax/minimax-m3:free", "z-ai/glm-5.2:free"];

export async function llmChat(env, messages, opts = {}) {
  const base = (env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const key = env.LLM_API_KEY || env.OPENROUTER_API_KEY;
  if (!key) throw new Error("ключ модели не настроен");
  const paid = !!env.LLM_BASE_URL && !/openrouter\.ai/.test(base);
  const models = opts.model ? [opts.model]
    : paid ? [env.EDIT_MODEL || env.ASK_MODEL || "anthropic/claude-sonnet-5"]
    : [env.EDIT_MODEL || "anthropic/claude-sonnet-5", ...FREE_MODELS];
  // каждую модель пробуем дважды: провайдеры за Cloudflare отвечают 524/502 на долгие ответы
  const attempts = [];
  for (const m of models) { attempts.push(m); attempts.push(m); }
  let last = "";
  for (const model of attempts) {
    try {
      const r = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "text/event-stream",
                   "HTTP-Referer": "https://okk-dashboard.pages.dev", "X-Title": "Shtab edit" },
        body: JSON.stringify({ model, temperature: opts.temperature ?? 0.2, max_tokens: opts.max_tokens || 16000, messages, stream: true }),
      });
      if (!r.ok) { last = "ответ " + r.status; continue; }
      const ctype = r.headers.get("content-type") || "";
      let text = "", finish = "";
      if (/event-stream/.test(ctype)) {
        // SSE: строки "data: {...}" с choices[0].delta.content
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const c0 = j.choices && j.choices[0];
              const d = c0 && (c0.delta || c0.message);
              if (d && d.content) text += d.content;
              if (c0 && c0.finish_reason) finish = c0.finish_reason;
            } catch (e) { /* неполная строка — подождём следующий кусок */ }
          }
        }
        // хвост без перевода строки
        const tail = buf.trim();
        if (tail.startsWith("data:")) {
          try { const j = JSON.parse(tail.slice(5).trim()); const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message); if (d && d.content) text += d.content; } catch (e) {}
        }
      } else {
        const data = await r.json();
        const c0 = data.choices && data.choices[0];
        text = (c0 && c0.message && c0.message.content) || "";
        finish = (c0 && c0.finish_reason) || "";
      }
      text = text.trim();
      if (!text) { last = "пустой ответ"; continue; }
      return { text, model, finish };
    } catch (e) {
      last = String(e).slice(0, 120);
    }
  }
  throw new Error("модель не ответила (" + last + ")");
}

// ---------- Telegram Login Widget ----------
// Виджет присылает id, first_name, last_name, username, photo_url, auth_date, hash.
// Подпись: HMAC-SHA256(data_check_string, SHA256(bot_token)). Годна сутки.
export async function tgVerify(params, botToken) {
  const data = {};
  for (const [k, v] of params) if (k !== "hash") data[k] = v;
  const hash = params.get("hash") || "";
  if (!hash || !data.id || !data.auth_date) return null;
  if (Math.abs(Date.now() / 1000 - Number(data.auth_date)) > 86400) return null;
  const check = Object.keys(data).sort().map((k) => k + "=" + data[k]).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(check)));
  return timingSafeEqual(mac, hash) ? data : null;
}

export async function tgSend(env, chatId, text) {
  if (!env.TG_BOT_TOKEN || !chatId) return false;
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TG_BOT_TOKEN + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return r.ok;
  } catch (e) { return false; }
}
