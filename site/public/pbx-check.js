// Проверка связи с АТС (onlinePBX): общий код для /pbx-check (без входа) и /sales/l1/svyaz/ (Первая линия).
// Ждёт на странице разметку с id: name, go, verdict, steps, tools, beep, copy, copied — внутри обёртки .pbx. 23.10.2026
(function () {
"use strict";
const PBX = "pbx20965.onpbx.ru";
const WSS = ["wss://" + PBX + ":8082/", "wss://" + PBX + ":8082/ws"];
const STUN = [
  { name: "Google", url: "stun:stun.l.google.com:19302" },
  { name: "Cloudflare", url: "stun:stun.cloudflare.com:3478" },
];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const jitter = (a) => a.length < 2 ? 0 : a.slice(1).reduce((t, v, i) => t + Math.abs(v - a[i]), 0) / (a.length - 1);
const ICON = { ok: "✓", warn: "!", bad: "✕", run: "…", wait: "·" };

try { $("name").value = localStorage.getItem("pbxcheck.name") || ""; } catch (e) {}
// в Штабе со входом (Первая линия) подставляем имя из профиля
if (!$("name").value && window.PBX_ME) fetch("/api/me").then((r) => r.ok ? r.json() : null).then((d) => { if (d && d.user && d.user.name && !$("name").value) $("name").value = d.user.name; }).catch(() => {});

// Адрес API: в Штабе — /api/pbx-check; на журнале (российский вход, если Cloudflare недоступен) — /pbx/api.
const API = window.PBX_API || "/api/pbx-check";
const SHTAB = "https://shtab-20v.pages.dev";

// ---------- шаги проверки ----------
const STEPS = [
  ["browser", "Браузер"],
  ["net", "Интернет"],
  ["pbx", "Сервер АТС"],
  ["wss", "Голосовое подключение к АТС (WebRTC)"],
  ["ice", "Прохождение голоса (UDP / STUN)"],
  ["mic", "Микрофон"],
];
// с журнала проверяем ещё, открывается ли у сотрудника Штаб (Cloudflare)
if (window.PBX_SHTAB_PROBE) STEPS.splice(2, 0, ["cf", "Доступ к Штабу (Cloudflare)"]);
let R = {};
function drawSteps() {
  $("steps").innerHTML = STEPS.map(([id, title]) =>
    `<li id="s-${id}"><span class="ic">${ICON.wait}</span><span class="t">${title}</span><span class="d">Ждёт проверки</span></li>`).join("");
}
function setStep(id, state, detail, hint) {
  const li = $("s-" + id);
  const meter = id === "mic" && li.querySelector(".meter");
  li.querySelector(".ic").className = "ic " + state;
  li.querySelector(".ic").textContent = ICON[state];
  li.querySelector(".d").innerHTML = detail;
  li.querySelectorAll(".hint").forEach((x) => x.remove());
  if (hint) li.insertAdjacentHTML("beforeend", `<span class="hint">${hint}</span>`);
  if (meter) li.appendChild(meter);
}
drawSteps();

// ---------- 1. браузер ----------
function browserInfo() {
  const ua = navigator.userAgent;
  let name = "Неизвестный", ver = 0, m;
  if ((m = ua.match(/YaBrowser\/(\d+)/))) { name = "Яндекс Браузер"; ver = +m[1]; }
  else if ((m = ua.match(/Edg\/(\d+)/))) { name = "Edge"; ver = +m[1]; }
  else if ((m = ua.match(/OPR\/(\d+)/))) { name = "Opera"; ver = +m[1]; }
  else if ((m = ua.match(/Firefox\/(\d+)/))) { name = "Firefox"; ver = +m[1]; }
  else if ((m = ua.match(/Chrome\/(\d+)/))) { name = "Chrome"; ver = +m[1]; }
  else if ((m = ua.match(/Version\/(\d+).*Safari/))) { name = "Safari"; ver = +m[1]; }
  const os = /Windows NT 10/.test(ua) ? "Windows 10/11" : /Windows/.test(ua) ? "Windows (старая)" : /Mac OS X/.test(ua) ? "macOS" :
    /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "—";
  return { name, ver, os, ua };
}
async function checkBrowser() {
  const b = browserInfo();
  const feats = { webrtc: !!window.RTCPeerConnection, media: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), ws: !!window.WebSocket, audio: !!(window.AudioContext || window.webkitAudioContext) };
  R.browser = { ...b, ...feats, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, cores: navigator.hardwareConcurrency || 0, memory: navigator.deviceMemory || 0 };
  const missing = Object.entries({ "WebRTC": feats.webrtc, "доступ к микрофону": feats.media, "WebSocket": feats.ws }).filter(([, v]) => !v).map(([k]) => k);
  const txt = `<b>${esc(b.name)} ${b.ver || ""}</b>, ${esc(b.os)} · часовой пояс ${esc(R.browser.tz)}`;
  const old = (b.name === "Chrome" || b.name === "Edge" || b.name === "Яндекс Браузер") ? b.ver && b.ver < 110 : b.name === "Firefox" ? b.ver < 110 : b.name === "Safari" ? b.ver < 16 : false;
  if (missing.length) return setStep("browser", "bad", txt + ` · нет: ${missing.join(", ")}`, "Браузер не умеет звонить. Откройте эту страницу в Google Chrome последней версии."), "bad";
  if (b.name === "Safari" || b.name === "Firefox" || b.name === "Неизвестный")
    return setStep("browser", "warn", txt, "Телефония лучше всего работает в Google Chrome. Если звонки сбоят, попробуйте его."), "warn";
  if (old) return setStep("browser", "warn", txt + " · версия устарела", "Обновите браузер: меню → Справка → О браузере."), "warn";
  setStep("browser", "ok", txt); return "ok";
}

// ---------- 2. интернет ----------
async function checkNet() {
  if (!navigator.onLine) { R.net = { online: false }; setStep("net", "bad", "Браузер считает, что интернета нет"); return "bad"; }
  const pings = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    try { await fetch(API + "?mode=ping&r=" + Math.random(), { cache: "no-store" }); pings.push(Math.round(performance.now() - t)); } catch (e) {}
  }
  let down = 0, up = 0;
  try {
    const t = performance.now(); const r = await fetch(API + "?mode=bytes&n=2000000&r=" + Math.random(), { cache: "no-store" });
    const b = await r.arrayBuffer(); down = +(b.byteLength * 8 / ((performance.now() - t) / 1000) / 1e6).toFixed(1);
  } catch (e) {}
  try {
    const body = new Uint8Array(1000000); const t = performance.now();
    await fetch(API + "?mode=sink", { method: "POST", body }); up = +(8 / ((performance.now() - t) / 1000)).toFixed(1);
  } catch (e) {}
  let who = {};
  try { who = await (await fetch(API + "?mode=whoami", { cache: "no-store" })).json(); } catch (e) {}
  const c = navigator.connection || {};
  const p = pings.slice(1);  // первый запрос — с установкой соединения
  R.net = { online: true, ping: median(p), jitter: Math.round(jitter(p)), lost: 10 - pings.length, down, up, type: c.effectiveType || "", saveData: !!c.saveData, ip: who.ip || "", place: who.place || "", colo: who.colo || "", cloudPbx: who.pbx || null };
  const txt = `Задержка до сервера проверки <b>${R.net.ping} мс</b> (разброс ±${R.net.jitter}) · загрузка <b>${down} Мбит/с</b> · отдача <b>${up} Мбит/с</b>` +
    (R.net.place ? ` · ${esc(R.net.place)}` : "");
  if (!pings.length) return setStep("net", "bad", "Сервер проверки не отвечает", "Похоже, интернет не работает или его режет VPN/антивирус."), "bad";
  const problems = [];
  if (R.net.ping > 150) problems.push("большая задержка");
  if (R.net.jitter > 30) problems.push("нестабильная задержка");
  if (R.net.lost) problems.push(`потеряно ${R.net.lost} из 10 запросов`);
  if (up && up < 1) problems.push("очень медленная отдача");
  if (down && down < 2) problems.push("медленная загрузка");
  if (problems.length) return setStep("net", "warn", txt + ` · ${problems.join(", ")}`, "Интернет нестабильный: голос может прерываться или пропадать. Подключите компьютер к роутеру кабелем или сядьте ближе к Wi‑Fi, выключите загрузки и видео на время звонков."), "warn";
  setStep("net", "ok", txt); return "ok";
}

// ---------- Штаб на Cloudflare (только на журнале) ----------
async function checkShtab() {
  const t = performance.now();
  let ok = false;
  try {
    await Promise.race([fetch(SHTAB + "/favicon-32.png?r=" + Math.random(), { mode: "no-cors", cache: "no-store" }), sleep(7000).then(() => { throw new Error("timeout"); })]);
    ok = true;
  } catch (e) {}
  R.cf = { ok, ms: Math.round(performance.now() - t) };
  if (!ok) return setStep("cf", "warn", "Штаб (shtab-20v.pages.dev) у вас не открывается",
    "Ваш провайдер ограничивает Cloudflare, на котором работает Штаб. На саму АТС это напрямую не влияет, но часть сервисов тоже может не открываться. Помогает другой интернет (например, раздача с телефона) или обращение к провайдеру."), "warn";
  setStep("cf", "ok", `Штаб открывается, ${R.cf.ms} мс`); return "ok";
}

// ---------- 3. сервер АТС по HTTPS ----------
async function checkPbx() {
  const times = []; let fails = 0;
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    try {
      await Promise.race([fetch("https://" + PBX + "/?r=" + Math.random(), { mode: "no-cors", cache: "no-store" }), sleep(6000).then(() => { throw new Error("timeout"); })]);
      times.push(Math.round(performance.now() - t));
    } catch (e) { fails++; }
  }
  const cloud = R.net && R.net.cloudPbx;
  R.pbx = { times, fails, cloud };
  const cloudTxt = cloud && cloud.web ? ` · с нашего сервера АТС ${cloud.web.ok ? "отвечает" : "не отвечает"}` : "";
  if (!times.length) return setStep("pbx", "bad", `${PBX} недоступен из вашего браузера${cloudTxt}`,
    "Компьютер не может достучаться до АТС. Частые причины: VPN, антивирус или «защита сети» у провайдера. Выключите VPN и проверьте ещё раз; если не поможет, перезагрузите роутер."), "bad";
  const p = median(times.slice(1).length ? times.slice(1) : times);
  const txt = `${PBX} отвечает, задержка <b>${p} мс</b>` + (fails ? ` · ${fails} из 4 запросов без ответа` : "") + cloudTxt;
  R.pbx.ping = p;
  if (fails || p > 300) return setStep("pbx", "warn", txt, "Связь с АТС есть, но медленная или с потерями. Голос может опаздывать и обрываться."), "warn";
  setStep("pbx", "ok", txt); return "ok";
}

// ---------- 4. WSS + SIP OPTIONS ----------
function rnd(n = 10) { return Math.random().toString(36).slice(2, 2 + n); }
function sipOptions(cseq, callId, tag) {
  return [`OPTIONS sip:${PBX} SIP/2.0`, `Via: SIP/2.0/WSS ${rnd(8)}.invalid;branch=z9hG4bK${rnd(12)}`, "Max-Forwards: 70",
    `To: <sip:${PBX}>`, `From: <sip:check@${PBX}>;tag=${tag}`, `Call-ID: ${callId}`, `CSeq: ${cseq} OPTIONS`,
    "User-Agent: Shtab-PBX-Check", "Content-Length: 0", "", ""].join("\r\n");
}
function tryWss(url) {
  return new Promise((resolve) => {
    const t0 = performance.now(); let ws, done = false, opened = 0;
    const out = { url, open: false, openMs: 0, sip: [], sipStatus: "", closeCode: 0 };
    const finish = () => { if (done) return; done = true; try { ws.close(); } catch (e) {} resolve(out); };
    try { ws = new WebSocket(url, "sip"); } catch (e) { out.error = String(e.message || e); return resolve(out); }
    const timer = setTimeout(finish, 9000);
    ws.onopen = async () => {
      out.open = true; out.openMs = Math.round(performance.now() - t0); opened = performance.now();
      const callId = rnd(16), tag = rnd(8);
      for (let i = 1; i <= 3 && !done; i++) {
        const sent = performance.now(); let got = false;
        const wait = new Promise((r) => {
          ws.onmessage = (ev) => {
            const first = String(ev.data).split("\r\n")[0];
            if (/^SIP\/2\.0 \d+/.test(first)) { out.sipStatus = first.slice(8); out.sip.push(Math.round(performance.now() - sent)); got = true; r(); }
          };
          setTimeout(r, 3000);
        });
        try { ws.send(sipOptions(i, callId, tag)); } catch (e) { break; }
        await wait; if (!got) break;
      }
      clearTimeout(timer); finish();
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => { out.closeCode = ev.code; if (!out.open) out.openMs = Math.round(performance.now() - t0); clearTimeout(timer); finish(); };
  });
}
async function checkWss() {
  let res;
  const tried = [];
  for (const url of WSS) { res = await tryWss(url); tried.push(res); if (res.open) break; }
  R.wss = { tried };
  if (!res.open) return setStep("wss", "bad", `Не удалось открыть защищённое соединение с ${PBX}:8082`,
    "Именно через это соединение браузерный телефон регистрируется на АТС. Его часто блокируют VPN, антивирус (Касперский, ESET, Avast — «проверка защищённых соединений») или роутер. Выключите VPN и проверку HTTPS в антивирусе, затем проверьте ещё раз."), "bad";
  const sipMs = median(R.wss.tried.at(-1).sip);
  const txt = `Соединение открыто за <b>${res.openMs} мс</b>` + (res.sip.length ? ` · АТС отвечает на SIP (${esc(res.sipStatus)}), <b>${sipMs} мс</b>` : " · АТС не ответила на SIP‑запрос");
  if (!res.sip.length) return setStep("wss", "warn", txt, "Соединение есть, но АТС молчит. Если у коллег здесь же стоит зелёная галочка, причина на вашей стороне: VPN, антивирус или сеть."), "warn";
  setStep("wss", "ok", txt); return "ok";
}

// ---------- 5. STUN / ICE ----------
function gather(server) {
  return new Promise((resolve) => {
    const out = { server: server.name, srflx: [], host: 0, error: "" };
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [{ urls: server.url }] }); } catch (e) { out.error = String(e.message || e); return resolve(out); }
    const t0 = performance.now();
    const end = () => { try { pc.close(); } catch (e) {} resolve(out); };
    const timer = setTimeout(end, 5000);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) { clearTimeout(timer); return end(); }
      const c = ev.candidate.candidate.split(" ");
      const type = c[c.indexOf("typ") + 1], ip = c[4], port = +c[5], proto = c[2];
      if (type === "host") out.host++;
      if (type === "srflx") { out.srflx.push({ ip, port, proto }); out.ms = out.ms || Math.round(performance.now() - t0); }
    };
    pc.createDataChannel("x");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { out.error = String(e.message || e); clearTimeout(timer); end(); });
  });
}
async function checkIce() {
  if (!window.RTCPeerConnection) { R.ice = { error: "нет WebRTC" }; setStep("ice", "bad", "Браузер не поддерживает WebRTC"); return "bad"; }
  const res = await Promise.all(STUN.map(gather));
  const ok = res.filter((r) => r.srflx.length);
  const ips = [...new Set(ok.flatMap((r) => r.srflx.map((s) => s.ip)))];
  const ports = ok.map((r) => r.srflx[0].port);
  const symmetric = ok.length > 1 && new Set(ports).size > 1;
  const vpn = R.net && R.net.ip && ips.length && !ips.includes(R.net.ip);
  R.ice = { res, ips, symmetric, vpn: !!vpn };
  if (!ok.length) return setStep("ice", "bad", "UDP наружу не проходит: STUN‑серверы не ответили",
    "Голос по UDP не пройдёт: звонок соединится, но будет тишина или звонок сорвётся. Обычно это файрвол антивируса, VPN или настройки роутера. Выключите VPN и файрвол антивируса и проверьте ещё раз."), "bad";
  const txt = `Внешний адрес для голоса <b>${esc(ips.join(", "))}</b>, ответ STUN за ${median(ok.map((r) => r.ms))} мс` + (symmetric ? " · NAT строгого типа" : "") + (vpn ? ` · отличается от адреса сайта (${esc(R.net.ip)})` : "");
  const hints = [];
  if (symmetric) hints.push("Роутер меняет порты для каждого соединения (симметричный NAT). Из‑за этого бывает односторонняя слышимость. Помогает перезагрузка роутера или включение UPnP в его настройках.");
  if (vpn) hints.push("Голос и сайты идут разными путями: похоже, включён VPN или прокси. Выключите его на время работы.");
  if (hints.length) return setStep("ice", "warn", txt, hints.join(" ")), "warn";
  setStep("ice", "ok", txt); return "ok";
}

// ---------- 6. микрофон ----------
async function checkMic() {
  const li = $("s-mic");
  let perm = "";
  try { perm = (await navigator.permissions.query({ name: "microphone" })).state; } catch (e) {}
  R.mic = { perm };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStep("mic", "bad", "Браузер не даёт доступ к микрофону"); return "bad"; }
  setStep("mic", "run", "Разрешите доступ к микрофону, если браузер спросит, и скажите что‑нибудь вслух…");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) {
    R.mic.error = e.name;
    const map = {
      NotAllowedError: ["Доступ к микрофону запрещён", "Нажмите на значок замка слева от адреса сайта → Микрофон → Разрешить. Проверьте то же самое на сайте телефонии (amoCRM или панели АТС). В Windows: Параметры → Конфиденциальность → Микрофон → разрешить приложениям и браузеру."],
      NotFoundError: ["Микрофон не найден", "Подключите гарнитуру или микрофон. Если он подключён, проверьте, что Windows его видит: Параметры → Система → Звук → Ввод."],
      NotReadableError: ["Микрофон занят другой программой или не отвечает", "Закройте программы, которые могут держать микрофон (Zoom, Teams, Skype, другой софтфон, вторая вкладка с телефоном), и переподключите гарнитуру."],
    }[e.name] || ["Ошибка микрофона: " + esc(e.name || e.message), "Переподключите гарнитуру и перезапустите браузер."];
    setStep("mic", "bad", map[0], map[1]); return "bad";
  }
  const track = stream.getAudioTracks()[0];
  const set = track.getSettings ? track.getSettings() : {};
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  R.mic.label = track.label; R.mic.inputs = devices.filter((d) => d.kind === "audioinput").length; R.mic.outputs = devices.filter((d) => d.kind === "audiooutput").length;
  R.mic.sampleRate = set.sampleRate || 0;
  // уровень звука 4 секунды
  let peak = 0;
  if (!li.querySelector(".meter")) li.insertAdjacentHTML("beforeend", '<span class="meter"><i></i></span>');
  const meter = li.querySelector(".meter"); meter.style.display = "block";
  setStep("mic", "run", `<b>${esc(track.label || "Микрофон")}</b> · скажите что‑нибудь вслух…`);
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx();
    const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize); const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      an.getFloatTimeDomainData(buf);
      let s = 0; for (const v of buf) s += v * v; const rms = Math.sqrt(s / buf.length);
      peak = Math.max(peak, rms);
      meter.firstChild.style.width = Math.min(100, rms * 400) + "%";
      await sleep(50);
    }
    ctx.close();
  } catch (e) { R.mic.meterError = String(e.message || e); }
  stream.getTracks().forEach((t) => t.stop());
  meter.style.display = "none";
  const db = peak > 0 ? Math.round(20 * Math.log10(peak)) : -100;
  R.mic.peakDb = db; R.mic.muted = track.muted;
  const txt = `<b>${esc(track.label || "Микрофон")}</b> · громкость до ${db} дБ · микрофонов в системе: ${R.mic.inputs}, динамиков: ${R.mic.outputs}`;
  if (db < -55) return setStep("mic", "warn", txt + " · звука почти нет", "Микрофон подключён, но молчит. Проверьте кнопку выключения на гарнитуре и громкость микрофона в Windows (Параметры → Система → Звук → Ввод). Если микрофонов несколько, выберите нужный в настройках сайта (значок замка → Настройки сайта) или в Windows."), "warn";
  setStep("mic", "ok", txt); return "ok";
}

// ---------- запуск ----------
const RANK = { ok: 0, warn: 1, bad: 2 };
function summaryLine(st) {
  const n = R.net || {}, mark = (k) => ({ ok: "✓", warn: "!", bad: "✕" }[st[k]] || "·");
  return [
    st.cf ? `Штаб ${mark("cf")}` : "",
    `АТС ${mark("pbx")}${R.pbx && R.pbx.ping ? " " + R.pbx.ping + " мс" : ""}`,
    `WebRTC ${mark("wss")}`, `UDP ${mark("ice")}`, `микрофон ${mark("mic")}`,
    n.ping != null ? `интернет ${mark("net")} ${n.ping}±${n.jitter} мс, ${n.down}/${n.up} Мбит/с` : `интернет ${mark("net")}`,
    R.browser ? `${R.browser.name} ${R.browser.ver || ""}` : "",
  ].filter(Boolean).join(" · ");
}
const low = (t) => /^[А-ЯA-Z]{2}/.test(t) ? t : t[0].toLowerCase() + t.slice(1);
function verdictText(v, st) {
  const bad = STEPS.filter(([id]) => st[id] === "bad").map(([, t]) => low(t));
  const warn = STEPS.filter(([id]) => st[id] === "warn").map(([, t]) => low(t));
  if (v === "ok") return ["Всё в порядке: с этого компьютера телефония должна работать.", "Если звонки всё равно сбоят, нажмите «Скопировать отчёт» и пришлите его руководителю."];
  if (v === "bad") return ["Есть проблема: " + bad.join(", ") + ".", "Подсказки, что сделать, — у пунктов с красным крестиком. После исправления проверьте ещё раз."];
  return ["Работать будет, но возможны сбои: " + warn.join(", ") + ".", "Подсказки — у пунктов с жёлтым значком."];
}
let lastReport = "";
$("go").onclick = async () => {
  const name = $("name").value.trim();
  if (!name) { $("name").focus(); $("name").placeholder = "Сначала напишите имя"; return; }
  try { localStorage.setItem("pbxcheck.name", name); } catch (e) {}
  $("go").disabled = true; $("go").textContent = "Проверяю…";
  $("verdict").style.display = "none"; $("tools").style.display = "none";
  R = { started: new Date().toISOString() }; drawSteps();
  const st = {};
  const run = async (id, fn) => { setStep(id, "run", "Проверяю…"); try { st[id] = await fn(); } catch (e) { st[id] = "warn"; setStep(id, "warn", "Проверка не удалась: " + esc(e.message || e)); } };
  await run("browser", checkBrowser);
  await run("net", checkNet);
  if (window.PBX_SHTAB_PROBE) await run("cf", checkShtab);
  await run("pbx", checkPbx);
  await run("wss", checkWss);
  await run("ice", checkIce);
  await run("mic", checkMic);
  const v = Object.values(st).reduce((a, b) => RANK[b] > RANK[a] ? b : a, "ok");
  const [head, sub] = verdictText(v, st);
  $("verdict").className = "verdict " + v; $("verdict").style.display = "block";
  $("verdict").innerHTML = esc(head) + `<p>${esc(sub)}</p>`;
  const summary = summaryLine(st);
  R.steps = st;
  lastReport = `Проверка связи с АТС — ${name}, ${new Date().toLocaleString("ru-RU")}\nИтог: ${head}\n` +
    STEPS.map(([id, t]) => `${{ ok: "✓", warn: "!", bad: "✕" }[st[id]] || "·"} ${t}: ${$("s-" + id).querySelector(".d").textContent}`).join("\n");
  $("tools").style.display = "flex";
  $("go").disabled = false; $("go").textContent = "Проверить ещё раз";
  let saved = false;
  try {
    const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, verdict: v, summary, details: R }) });
    saved = r.ok;
  } catch (e) {}
  $("copied").textContent = saved ? "Результат сохранён" : "Сохранить результат не удалось — нажмите «Скопировать отчёт» и пришлите его руководителю";
};

$("beep").onclick = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 660; g.gain.value = 0.15;
    o.connect(g).connect(ctx.destination); o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 1200);
    $("copied").textContent = "Должен прозвучать сигнал. Не слышно — проверьте громкость и выбранные динамики.";
  } catch (e) { $("copied").textContent = "Не удалось воспроизвести звук"; }
};
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(lastReport); $("copied").textContent = "Отчёт скопирован"; }
  catch (e) { prompt("Скопируйте отчёт:", lastReport); }
};
})();
