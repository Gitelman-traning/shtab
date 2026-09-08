/* Панель раздела: свой вид через Claude, версии и откат.
   Подключается на странице раздела: <div id="section-editor" data-section="marketing"></div> + этот скрипт.
   Кнопки правок видны только тем, кто может менять раздел (владельцы и администратор). */
(function () {
  var box = document.getElementById("section-editor");
  if (!box) return;
  var SEC = box.getAttribute("data-section");
  var std = document.getElementById("section-standard");   // стандартный вид (main)
  var css = ".se{background:var(--card);border-radius:16px;padding:14px 18px;margin:0 24px 6px;display:flex;flex-direction:column;gap:10px}"
    + ".se .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.se .sub{font-size:12.5px;color:var(--dim)}.se .err{color:var(--bad)}.se .ok{color:var(--ok)}"
    + ".se button{font:inherit;font-size:12.5px;padding:7px 12px;border:0;border-radius:8px;background:var(--gold);color:#fff;cursor:pointer}"
    + ".se button.ghost{background:var(--soft);color:var(--ink)}.se button.on{outline:2px solid var(--gold-b)}.se button:disabled{opacity:.5;cursor:default}"
    + ".se textarea{font:inherit;width:100%;min-height:70px;padding:10px 12px;border:1px solid var(--line-2);border-radius:10px;background:var(--page);color:var(--ink);resize:vertical}"
    + ".se table{border-collapse:collapse;width:100%;font-size:12.5px}.se td,.se th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}.se th{color:var(--faint);font-weight:500;font-size:11.5px}"
    + ".se .pill{font-size:11px;padding:2px 8px;border-radius:7px;background:var(--gold-soft);color:var(--gold)}"
    + "#section-custom{margin:0 24px 30px;border:0;width:calc(100% - 48px);min-height:70vh;border-radius:16px;background:var(--card)}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function api(path, opt) { opt = opt || {}; opt.credentials = "same-origin"; if (opt.body) { opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(opt.body); } return fetch(path, opt).then(function (r) { return r.json(); }); }
  function dt(s) { return s ? String(s).replace("T", " ").slice(0, 16) : ""; }

  var state = { canEdit: false, versions: [], active: null, mode: "standard", preview: null };
  var frame = null;

  function showCustom(version) {
    if (!frame) { frame = document.createElement("iframe"); frame.id = "section-custom"; frame.setAttribute("sandbox", "allow-scripts allow-same-origin"); box.parentNode.insertBefore(frame, box.nextSibling); }
    frame.src = "/api/sections/" + SEC + "/view" + (version ? "?v=" + version : "") + "&_=" + Date.now();
    frame.hidden = false; if (std) std.hidden = true;
  }
  function showStandard() { if (frame) frame.hidden = true; if (std) std.hidden = false; }

  function render() {
    var v = state.versions, act = state.active;
    var h = '<div class="row">'
      + '<button class="ghost' + (state.mode === "standard" ? " on" : "") + '" data-a="standard">Стандартный вид</button>'
      + (act ? '<button class="ghost' + (state.mode === "custom" ? " on" : "") + '" data-a="custom">Свой вид · v' + act.version + '</button>' : '<span class="sub">своего вида пока нет</span>')
      + (state.canEdit ? '<button data-a="edit">Изменить через Claude</button><button class="ghost" data-a="versions">Версии (' + v.length + ')</button>' : '')
      + '<span class="sub" id="se-msg"></span></div>';
    if (state.canEdit && state.mode === "edit") {
      h += '<div><textarea id="se-prompt" placeholder="Что изменить? Например: «покажи источники кругом вместо таблицы» или «добавь сравнение с прошлым месяцем в каждую карточку»"></textarea></div>'
        + '<div class="row"><button data-a="draft">Сделать вариант</button><span class="sub">Модель перепишет страницу раздела' + (act ? ' на основе v' + act.version : ' с нуля') + '. Это займёт от одной до трёх минут, не закрывайте страницу. Вариант сохранится как черновик — публикуете отдельно.</span></div>';
    }
    if (state.canEdit && state.mode === "versions") {
      h += v.length ? '<table><thead><tr><th>Версия</th><th>Автор</th><th>Когда</th><th>Просьба</th><th></th></tr></thead><tbody>'
        + v.map(function (x) { return '<tr><td>v' + x.version + (x.active ? ' <span class="pill">опубликована</span>' : '') + '</td><td>' + esc(x.author) + '</td><td>' + dt(x.created_at) + '</td><td class="sub">' + esc(x.prompt) + '</td><td>'
          + '<button class="ghost" data-a="preview" data-v="' + x.version + '">посмотреть</button> '
          + (x.active ? '' : '<button data-a="publish" data-v="' + x.version + '">' + (act && x.version < act.version ? 'откатить сюда' : 'опубликовать') + '</button>') + '</td></tr>'; }).join("")
        + '</tbody></table>' + (act ? '<div class="row"><button class="ghost" data-a="unpublish">Снять свой вид, показывать стандартный</button></div>' : '')
        : '<p class="sub">версий ещё нет</p>';
    }
    box.className = "se"; box.innerHTML = h;
  }

  function load() {
    return api("/api/sections/" + SEC + "/versions").then(function (r) {
      if (!r.ok) { box.className = "se"; box.innerHTML = '<span class="sub">' + esc(r.error) + '</span>'; return; }
      state.canEdit = !!r.can_edit; state.versions = r.versions || [];
      state.active = state.versions.filter(function (x) { return x.active; })[0] || null;
      if (state.active && state.mode === "standard" && !state.touched) { state.mode = "custom"; showCustom(); }
      render();
    });
  }

  box.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-a]"); if (!b) return;
    var a = b.getAttribute("data-a"), msg = function (t, cls) { var m = document.getElementById("se-msg"); if (m) { m.textContent = t; m.className = "sub " + (cls || ""); } };
    state.touched = true;
    if (a === "standard") { state.mode = "standard"; showStandard(); render(); }
    else if (a === "custom") { state.mode = "custom"; showCustom(); render(); }
    else if (a === "edit") { state.mode = "edit"; render(); }
    else if (a === "versions") { state.mode = "versions"; render(); }
    else if (a === "preview") { showCustom(b.getAttribute("data-v")); msg("предпросмотр v" + b.getAttribute("data-v")); }
    else if (a === "draft") {
      var p = document.getElementById("se-prompt").value.trim(); if (p.length < 5) { msg("опишите, что изменить", "err"); return; }
      b.disabled = true; msg("модель пишет страницу…");
      api("/api/sections/" + SEC + "/draft", { method: "POST", body: { prompt: p } }).then(function (r) {
        if (!r.ok) { msg(r.error, "err"); b.disabled = false; return; }
        state.mode = "versions"; load().then(function () { showCustom(r.version); msg("черновик v" + r.version + " готов (" + r.model + "), это предпросмотр — опубликуйте, если подходит", "ok"); });
      });
    }
    else if (a === "publish") {
      api("/api/sections/" + SEC + "/versions", { method: "POST", body: { action: "publish", version: b.getAttribute("data-v") } }).then(function (r) {
        if (!r.ok) { msg(r.error, "err"); return; }
        state.mode = "custom"; load().then(function () { showCustom(); msg("опубликована v" + r.active, "ok"); });
      });
    }
    else if (a === "unpublish") {
      api("/api/sections/" + SEC + "/versions", { method: "POST", body: { action: "unpublish" } }).then(function (r) {
        if (!r.ok) { msg(r.error, "err"); return; }
        state.mode = "standard"; showStandard(); load().then(function () { msg("свой вид снят", "ok"); });
      });
    }
  });
  load();
})();
