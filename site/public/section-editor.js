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
    + ".se .clip{background:var(--soft);color:var(--ink);display:inline-flex;align-items:center;gap:6px}.se .clip svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.7}"
    + ".se .chips{display:flex;gap:6px;flex-wrap:wrap}.se .chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border-radius:8px;background:var(--gold-soft);color:var(--gold)}"
    + ".se .chip img{width:22px;height:22px;object-fit:cover;border-radius:4px}.se .chip b{font-weight:600}.se .chip i{font-style:normal;cursor:pointer;opacity:.7}.se .chip i:hover{opacity:1}"
    + "#section-custom{margin:0 24px 30px;border:0;width:calc(100% - 48px);min-height:70vh;border-radius:16px;background:var(--card)}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  async function api(path,opt) {
    opt=opt||{};opt.credentials="same-origin";
    var ctrl=new AbortController(),timer=setTimeout(function(){ctrl.abort();},opt.method==="POST" && path.endsWith("/draft") ? 190000 : 15000);
    opt.signal=ctrl.signal;
    try {
      if(opt.body){opt.headers=Object.assign({},opt.headers,{"content-type":"application/json"});opt.body=JSON.stringify(opt.body);}
      var response=await fetch(path,opt), result;
      try{result=await response.json();}catch(e){return {ok:false,status:response.status,error:"Сервер вернул неожиданный ответ. Повторите запрос."};}
      if(!response.ok)return {ok:false,status:response.status,state:result.state,error:result.error||"Сервер временно недоступен. Повторите запрос."};
      return result;
    } catch(e){return {ok:false,status:0,error:e.name==="AbortError"?"Время ожидания истекло. Повторите запрос.":"Не удалось связаться со Штабом. Проверьте соединение и повторите запрос."};}
    finally{clearTimeout(timer);}
  }
  function dt(s) { return s ? String(s).replace("T", " ").slice(0, 16) : ""; }

  var state = { canEdit: false, versions: [], active: null, mode: "standard", preview: null, files: [] };
  var jobKey="shtab-draft:"+SEC, job="";
  try{job=sessionStorage.getItem(jobKey)||"";}catch(e){}
  function saveJob(id){job=id||"";try{job?sessionStorage.setItem(jobKey,job):sessionStorage.removeItem(jobKey);}catch(e){}}
  function jobMessage(text){var el=document.getElementById("se-msg");if(el)el.textContent=text;}
  async function checkJob(){
    if(!job)return;
    var id=job,r=await api("/api/sections/"+SEC+"/draft?job="+encodeURIComponent(id));
    if(id!==job)return;
    if(r.state==="running"){jobMessage("Модель готовит вариант…");setTimeout(checkJob,3000);return;}
    if(!r.ok){if(r.status===404||r.state==="failed"){saveJob("");render();}jobMessage(r.error);return;}
    saveJob("");state.mode="versions";await load();showCustom(r.version);jobMessage("Черновик v"+r.version+" готов.");
  }
  var MAX_FILES = 4, MAX_IMG = 1600, MAX_TEXT = 60000;

  // картинки ужимаем до 1600px по большей стороне, текст режем до 30 тыс. символов
  function readFile(f) {
    return new Promise(function (resolve, reject) {
      if (/^image\//.test(f.type)) {
        var img = new Image(); var url = URL.createObjectURL(f);
        img.onload = function () {
          var k = Math.min(1, MAX_IMG / Math.max(img.width, img.height));
          var c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve({ name: f.name, type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85) });
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("не удалось прочитать картинку " + f.name)); };
        img.src = url;
      } else if (/^text\/|\.(txt|csv|md|html|json|svg)$/i.test(f.type + " " + f.name)) {
        var r = new FileReader();
        r.onload = function () { resolve({ name: f.name, type: "text/plain", data: String(r.result).slice(0, MAX_TEXT) }); };
        r.onerror = function () { reject(new Error("не удалось прочитать " + f.name)); };
        r.readAsText(f);
      } else reject(new Error("подходят картинки и текстовые файлы (txt, csv, md, html): " + f.name));
    });
  }
  function chips() {
    return state.files.length ? '<div class="chips">' + state.files.map(function (f, i) {
      return '<span class="chip">' + (f.type.indexOf("image/") === 0 ? '<img src="' + f.data + '" alt="">' : '📄') + '<b>' + esc(f.name) + '</b><i data-rm="' + i + '" title="убрать">✕</i></span>';
    }).join("") + '</div>' : '';
  }
  var frame = null;

  function showCustom(version) {
    if (!frame) { frame = document.createElement("iframe"); frame.id = "section-custom"; frame.title = "Вид раздела"; frame.setAttribute("sandbox", "allow-scripts"); box.parentNode.insertBefore(frame, box.nextSibling); }
    var th = document.documentElement.getAttribute("data-theme") || "";
    frame.src = "/api/sections/" + SEC + "/view?v=" + (version || "") + "&theme=" + th + "&_=" + Date.now();
    frame.hidden = false; if (std) std.hidden = true;
  }
  function showStandard() { if (frame) frame.hidden = true; if (std) std.hidden = false; }

  function render() {
    var v = state.versions, act = state.active;
    var h = '<div class="row">'
      + '<button class="ghost' + (state.mode === "standard" ? " on" : "") + '" data-a="standard">Стандартный вид</button>'
      + (act ? '<button class="ghost' + (state.mode === "custom" ? " on" : "") + '" data-a="custom">Свой вид · v' + act.version + '</button>' : '<span class="sub">своего вида пока нет</span>')
      + (state.canEdit ? '<button data-a="edit">Изменить через Claude</button><button class="ghost" data-a="versions">Версии (' + v.length + ')</button>' : '')
       + (job ? '<button class="ghost" data-a="checkDraft">Проверить вариант</button>' : '') + '<span class="sub" id="se-msg" role="status"></span></div>';
    if (state.canEdit && state.mode === "edit") {
      h += '<div><textarea id="se-prompt" placeholder="Что изменить? Например: «покажи источники кругом вместо таблицы» или «добавь сравнение с прошлым месяцем в каждую карточку»">'+esc(state.prompt)+'</textarea></div>'
        + '<div class="row"><button data-a="draft">Сделать вариант</button>'
        + '<button class="clip" data-a="attach" title="Приложить пример: скриншот нужного вида, csv или текст"><svg viewBox="0 0 20 20"><path d="M13.5 6.5l-6 6a2 2 0 002.8 2.8l6.5-6.5a3.5 3.5 0 00-5-5L5.3 10.3a5 5 0 007 7l5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>Приложить пример</button>'
        + '<input type="file" id="se-attach" multiple accept="image/*,.txt,.csv,.md,.html,.json,.svg" hidden>'
        + '<span class="sub">Модель перепишет страницу раздела' + (act ? ' на основе v' + act.version : ' с нуля') + '. Это займёт от одной до трёх минут, не закрывайте страницу. Вариант сохранится как черновик — публикуете отдельно.</span></div>'
        + '<div id="se-chips">' + chips() + '</div>';
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
      if (!r.ok) { box.className = "se"; box.innerHTML = '<span class="sub">' + esc(r.error) + '</span> <button data-a="retry">Повторить загрузку</button>'; return; }
      state.canEdit = !!r.can_edit; state.versions = r.versions || [];
      state.active = state.versions.filter(function (x) { return x.active; })[0] || null;
      if (state.active && state.mode === "standard" && !state.touched) { state.mode = "custom"; showCustom(); }
      render();
    });
  }

  box.addEventListener("change", function (e) {
    if (e.target.id !== "se-attach") return;
    var list = [].slice.call(e.target.files); e.target.value = "";
    var msgEl = document.getElementById("se-msg");
    Promise.all(list.slice(0, MAX_FILES - state.files.length).map(readFile)).then(function (fs) {
      state.files = state.files.concat(fs).slice(0, MAX_FILES);
      document.getElementById("se-chips").innerHTML = chips();
      if (msgEl) { msgEl.textContent = "приложено: " + state.files.length; msgEl.className = "sub"; }
    }).catch(function (err) { if (msgEl) { msgEl.textContent = err.message; msgEl.className = "sub err"; } });
  });
  box.addEventListener("click", function (e) {
    var rm = e.target.closest("i[data-rm]");
    if (rm) { state.files.splice(+rm.getAttribute("data-rm"), 1); document.getElementById("se-chips").innerHTML = chips(); return; }
    var b = e.target.closest("button[data-a]"); if (!b) return;
    var a = b.getAttribute("data-a"), msg = function (t, cls) { var m = document.getElementById("se-msg"); if (m) { m.textContent = t; m.className = "sub " + (cls || ""); } };
    state.touched = true;
    if (a === "retry") { load(); return; }
    if (a === "checkDraft") { checkJob(); return; }
    if (a === "standard") { state.mode = "standard"; showStandard(); render(); }
    else if (a === "custom") { state.mode = "custom"; showCustom(); render(); }
    else if (a === "edit") { state.mode = "edit"; render(); }
    else if (a === "attach") { document.getElementById("se-attach").click(); }
    else if (a === "versions") { state.mode = "versions"; render(); }
    else if (a === "preview") { showCustom(b.getAttribute("data-v")); msg("предпросмотр v" + b.getAttribute("data-v")); }
    else if (a === "draft") {
      var p = document.getElementById("se-prompt").value.trim(); if (p.length < 5) { msg("опишите, что изменить", "err"); return; }
      state.prompt=p;
      var id=job||crypto.randomUUID();saveJob(id);b.disabled=true;msg("Модель пишет страницу…");
      api("/api/sections/"+SEC+"/draft",{method:"POST",headers:{"x-draft-job":id},body:{prompt:p,attachments:state.files}})
        .then(async function(r){
          if(!r.ok){if(r.status===0 || r.status>=500){render();jobMessage(r.error+" Можно проверить состояние варианта.");return;}saveJob("");msg(r.error,"err");return;}
          if(r.state==="running"){checkJob();return;}
          saveJob("");state.prompt="";state.files=[];state.mode="versions";await load();showCustom(r.version);jobMessage("Черновик v"+r.version+" готов.");
        }).catch(function(){msg("Не удалось показать результат. Повторите проверку.","err");})
        .finally(function(){b.disabled=false;});
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
  load().then(function(){if(job)checkJob();});
})();
