// Карточка «Статья вышла» на странице Журнала → /api/journal-publish. Подключается в web.tpl.html только для журнала (build.py).
(function () {
  var box = document.getElementById("journal-publish"); if (!box) return;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function when(s) { var d = new Date(s); return isNaN(d) ? s : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  var st = document.createElement("style");
  st.textContent = "#journal-publish{margin-bottom:16px}#journal-publish .jp-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:10px}"
    + "#journal-publish label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim);flex:1 1 220px}"
    + "#journal-publish input{font:inherit;font-size:14px;padding:8px 10px;border-radius:9px;border:1px solid var(--line-2);background:var(--card);color:var(--ink)}"
    + "#journal-publish button{font:inherit;font-size:13px;font-weight:600;padding:9px 14px;border-radius:9px;border:0;background:var(--gold);color:#fff;cursor:pointer}#journal-publish button:disabled{opacity:.5;cursor:default}"
    + "#journal-publish .jp-out{margin-top:10px;font-size:13px}#journal-publish .jp-out.ok{color:var(--good,#2e7d32)}#journal-publish .jp-out.err{color:var(--bad,#c62828);font-weight:600}"
    + "#journal-publish .jp-log{margin-top:10px;font-size:12px;color:var(--dim)}#journal-publish .jp-log div{margin-top:3px}";
  document.head.appendChild(st);

  function load() {
    return fetch("/api/journal-publish", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { box.hidden = true; return; }
      var to = d.to.length ? "получат в Telegram: " + esc(d.to.join(", ")) : "пока никто не подписан, галочка «Вышла статья журнала» ставится на странице «Пользователи»";
      box.innerHTML = '<h2>Статья вышла <small>' + to + '</small></h2>'
        + (d.can ? '<div class="jp-row"><label>Название<input id="jp-title" placeholder="ИИ для бизнеса: четыре эпохи" maxlength="200"></label>'
          + '<label>Ссылка<input id="jp-url" placeholder="https://journal.gitelman.team/адрес-статьи/" inputmode="url"></label>'
          + '<button type="button" id="jp-send"' + (d.to.length ? '' : ' disabled') + '>Отправить</button></div>'
          : '<p class="sub" style="margin:8px 0 0">Отправлять может тот, у кого «правка» на разделе «Сайт».</p>')
        + '<div class="jp-out" id="jp-out"></div>'
        + (d.log.length ? '<div class="jp-log">Последние отправки:' + d.log.map(function (x) {
            return '<div>' + when(x.at) + ' · ' + esc(x.login) + ' · ' + (x.action === "journal.publish" ? "" : "<b>с ошибкой</b> · ") + esc(x.note) + '</div>'; }).join("") + '</div>' : '');
      var btn = document.getElementById("jp-send"); if (btn) btn.addEventListener("click", send);
    }).catch(function () { box.hidden = true; });
  }
  function send() {
    var btn = document.getElementById("jp-send"), out = document.getElementById("jp-out");
    var title = document.getElementById("jp-title").value, url = document.getElementById("jp-url").value;
    btn.disabled = true; out.className = "jp-out"; out.textContent = "отправляю…";
    fetch("/api/journal-publish", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: title, url: url }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "сервер ответил ошибкой " + r.status }; }); })
      .then(function (d) {
        if (d.ok) { load().then(function () { var o = document.getElementById("jp-out"); if (o) { o.className = "jp-out ok"; o.textContent = "Отправлено: " + d.sent.join(", "); } }); return; }
        btn.disabled = false; out.className = "jp-out err";
        out.textContent = "Не отправлено. " + (d.error || "неизвестная ошибка") + (d.sent && d.sent.length ? " (дошло: " + d.sent.join(", ") + ")" : "");
      })
      .catch(function () { btn.disabled = false; out.className = "jp-out err"; out.textContent = "Не отправлено: нет связи со Штабом, попробуйте ещё раз."; });
  }
  load();
})();
