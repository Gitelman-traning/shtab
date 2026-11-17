var A = "/api/tgbots-admin/", f = document.getElementById("f"), cur = null, allowed = [], broadcastHistory = [], audienceRows = [], formDirty = false, formBusy = false, regularBot = "";
var ST = { draft: "черновик", tested: "тест отправлен", scheduled: "запланирована", sending: "идёт", paused: "пауза после волны", done: "завершена", stopped: "остановлена" };
function readResponse(r){ return r.text().then(function(text){var j;try{j=JSON.parse(text);}catch(e){throw Error(/error code:\s*1042/i.test(text)?"Ошибка связи с движком рассылок (1042).":"Сервис рассылок вернул некорректный ответ (HTTP "+r.status+").");}if(!j||typeof j!=="object"||!r.ok||j.error||j.ok===false)throw Error(j&&j.error||"Не удалось выполнить действие");return j;}); }
function get(p){ return fetch(A + p, { credentials: "same-origin" }).then(readResponse); }
function post(p,b){ return fetch(A+p,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(readResponse); }
function report(e){say("bad",e.message || String(e));}
function botCaption(key){return key==='__client_bot__'?'Бот каждого клиента':'@'+key;}
function audienceMode(){
  var saved=!!f.audience.value;
  if(saved){if(!f.bot.disabled && f.bot.value!=='__client_bot__')regularBot=f.bot.value;f.bot.value='__client_bot__';}
  else if(f.bot.disabled)f.bot.value=regularBot;
  f.bot.disabled=saved;document.getElementById('audience-filters').hidden=saved;
  var a=audienceRows.find(function(a){return a.id===f.audience.value;}),note=document.getElementById('audience-note');
  note.hidden=!saved;note.textContent=a?'Сохранённый состав из amoCRM. Каждый клиент получит сообщение от своего бота. Исключаем отписавшихся; дополнительные фильтры и правила Анны к этому сегменту не применяются.':'';
}
f.audience.onchange=function(){audienceMode();formDirty=true;setState(cur);recount();};
function say(kind, t){ document.getElementById("msgs").innerHTML = '<div class="msg ' + kind + '">' + esc(t) + '</div>'; window.scrollTo(0, 0); }
function n(x){ return (x || 0).toLocaleString("ru-RU"); }
function dt(ms){ if (!ms) return ""; var d = new Date(ms); return dmy(d) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function isoDay(ms){ return ms ? iso(new Date(ms)) : ""; }

function btnRow(b){
  var div = document.createElement("div"); div.className = "brow";
  var type = b && b.material ? "material" : "url";
  div.innerHTML = '<input placeholder="Текст кнопки" value="' + esc(b ? b.text : "") + '"><select><option value="url">ссылка</option><option value="material">материал</option></select><input placeholder="https://… или ключ материала" value="' + esc(b ? (b.url || b.material || "") : "") + '"><button type="button" class="btn ghost">×</button>';
  div.querySelector("select").value = type; div.querySelector("button").onclick = function(){ div.remove();formDirty=true;setState(cur);preview(); };
  document.getElementById("btns").appendChild(div);
}
document.getElementById("addbtn").onclick = function(){ btnRow(null);formDirty=true;setState(cur); };
function buttons(){ var rows = []; document.querySelectorAll("#btns .brow").forEach(function(r){ var i = r.querySelectorAll("input"), t = i[0].value.trim(), v = i[1].value.trim(), k = r.querySelector("select").value; if (t && v) { var o = { text: t }; o[k] = v; rows.push([o]); } }); return rows; }
function segment(){ if(f.audience.value)return {audience:f.audience.value,bot:"__client_bot__"}; var s = {}; ["bot", "list", "phone", "source", "medium", "tag", "q", "from", "to", "seg", "exclude_list"].forEach(function(k){ var v = f[k].value.trim(); if (v) s[k] = v; }); if (f.rules.checked) s.rules = "anna"; return s; }
function body(){
  return { id: cur ? cur.id : undefined, title: f.title.value.trim(), segment: segment(),
    content: f.material.value ? { material: f.material.value } : { text: f.text.value, buttons: buttons(), photo_r2: photoR2 || undefined },
    date_from: f.date_from.value, date_to: f.date_to.value, hours_from: Number(f.hours_from.value), hours_to: Number(f.hours_to.value),
    per_hour: Number(f.per_hour.value), per_day: Number(f.per_day.value), pause_at: Number(f.pause_at.value) || 0, stop_pct: Number(f.stop_pct.value) || 3 };
}
var countTimer = null, lastCount = null;
function recount(){
  clearTimeout(countTimer);
  countTimer = setTimeout(function(){
    if (!f.bot.value && !f.audience.value) { document.getElementById("cnt").textContent = "выберите бота"; return; }
    post("broadcasts/count", { segment: segment() }).then(function(j){
      if (j.total == null) { document.getElementById("cnt").textContent = j.error || "не посчиталось"; return; }
      lastCount = j.total;
      document.getElementById("cnt").innerHTML = 'Получателей: <b>' + n(j.total) + '</b> <span class="hint">(без отписавшихся)</span>' + (j.sample && j.sample.length ? '<div class="hint">например: ' + j.sample.map(function(p){ return esc(p.name || p.username || "—"); }).join(", ") + '</div>' : '');
      var missing=(j.bots || []).filter(function(b){return allowed.indexOf(b.bot)<0;});
      if(f.audience.value && missing.length)document.getElementById('cnt').innerHTML+='<div class="hint">Клиентские рассылки ещё выключены для: '+missing.map(function(b){return esc('@'+b.bot);}).join(', ')+'. Тест себе доступен.</div>';
      eta();
    }).catch(report);
  }, 400);
}
function lastBroadcastHint(){
  var el = document.getElementById("last-broadcast-hint"), bot = f.bot.value;
  var b = broadcastHistory.filter(function(b){ return b.bot === bot && b.status === "done" && b.sent > 0; })
    .sort(function(a, b){ return (b.done_at || b.created_at || 0) - (a.done_at || a.created_at || 0); })[0];
  el.hidden = !b;
  if (!b) { el.textContent = ""; return; }
  var stamp = Number(b.done_at || b.created_at), day = stamp ? new Date(stamp + 3 * 3600e3).toISOString().slice(0, 10).split("-").reverse().join(".") : "";
  var pct = Math.round((b.unsub || 0) * 10000 / b.sent) / 100;
  var duration = "";
  if (b.started_at && b.done_at && b.done_at >= b.started_at) {
    var minutes = Math.round((b.done_at - b.started_at) / 60000);
    duration = " От запуска до завершения — " + Math.floor(minutes / 60) + " ч " + (minutes % 60) + " мин, включая перерывы в отправке.";
  }
  el.textContent = "Последняя завершённая рассылка этого бота: «" + b.title + "»" + (day ? " · завершена " + day : "") + ". Доставлено " + n(b.sent) + ", отписались после доставки " + n(b.unsub || 0) + " (" + n(pct) + "%). Не доставлено " + n(b.failed || 0) + ", из них прежние блокировки или удалённые аккаунты — " + n(b.blocked || 0) + "." + duration + " Тогда были заданы пределы " + n(b.per_hour) + " в час и " + n(b.per_day) + " в сутки; это настройки, а не фактическая скорость.";
}
function eta(){
  lastBroadcastHint();
  var ph = Math.min(7200, Math.max(1, Number(f.per_hour.value) || 1)), pd = Math.min(50000, Math.max(1, Number(f.per_day.value) || 1)), hrs = Number(f.hours_to.value) - Number(f.hours_from.value);
  if (!(hrs > 0)) { document.getElementById("eta").textContent = "Время «до» должно быть позже времени «с»."; return; }
  var perDay = Math.min(pd, ph * hrs), days = Math.ceil(lastCount / perDay);
  var why = ph * hrs <= pd ? n(ph) + " в час × " + hrs + " ч окна" : "предел " + n(pd) + " в сутки";
  var text = "По расписанию — до <b>" + n(perDay) + "</b> попыток доставки за день (" + why + ").";
  if (lastCount != null) text = "Получателей " + n(lastCount) + ". " + text + " На всю базу — не менее <b>" + days + " " + plural(days, "день", "дня", "дней") + "</b> при полном ежедневном окне.";
  if (ph * hrs < pd) text += " Чтобы использовать суточный предел " + n(pd) + " за " + hrs + " " + plural(hrs, "час", "часа", "часов") + ", нужна скорость не менее <b>" + n(Math.ceil(pd / hrs)) + " в час</b>.";
  if (Number(f.pause_at.value) > 0) text += " После первой волны будет ручная пауза — её длительность в расчёт не входит.";
  text += " Доставка и сбои могут увеличить срок; укажите даты с запасом.";
  document.getElementById("eta").innerHTML = text;
}
function plural(x, a, b, c){ var m = x % 10, h = x % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; }

/* текст: кнопки Ж / К / ссылка, превью как в Telegram, картинка */
var photoR2 = "", photoUrl = "";
document.querySelectorAll(".tb button").forEach(function(b){ b.onclick = function(){
  var ta = f.text, s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e), w = b.dataset.w;
  if (!sel) return say("bad", "Сначала выделите в тексте слова, которые нужно оформить");
  var open = "<" + w + ">", close = "</" + w + ">";
  if (w === "a") { var u = prompt("Ссылка для «" + sel + "»:", "https://"); if (!u || !/^https?:\/\//.test(u)) return; open = '<a href="' + u.replace(/"/g, "%22") + '">'; }
  ta.value = ta.value.slice(0, s) + open + sel + close + ta.value.slice(e);
  ta.focus(); ta.setSelectionRange(s, s + open.length + sel.length + close.length);formDirty=true;setState(cur);preview();
}; });
// Безопасный показ: экранируем всё, потом возвращаем только <b>, <i>, <a href>.
function tgHtml(t){
  return esc(t || "").replace(/&lt;(\/?)(b|i|u|s)&gt;/g, "<$1$2>")
    .replace(/&lt;a href=&quot;(https?:\/\/[^"<>]*?)&quot;&gt;/g, '<a href="$1" target="_blank" rel="noopener">').replace(/&lt;\/a&gt;/g, "</a>");
}
function preview(){
  var pv = document.getElementById("pv"), t = f.text.value, plain = t.replace(/<[^>]+>/g, "");
  var kb = buttons().map(function(r){ return '<div class="kb">' + esc(r[0].text) + '</div>'; }).join("");
  var long = photoR2 && plain.length > 1024;
  pv.innerHTML = (photoR2 ? '<div class="bub">' + (photoUrl ? '<img src="' + photoUrl + '" alt="">' : '🖼 картинка прикреплена') + (long ? "" : tgHtml(t)) + '</div>' + (long ? "" : kb) : "") +
    (!photoR2 || long ? (t ? '<div class="bub" style="margin-top:6px">' + tgHtml(t) + '</div>' + kb : '<div class="hint">текста пока нет</div>') : "");
  document.getElementById("len").textContent = plain.length + " знаков" + (photoR2 ? (plain.length > 1024 ? " — длиннее 1024: картинка уйдёт отдельно, текст следом" : " · под картинкой можно до 1024") : " · до 4000");
}
f.text.addEventListener("input", preview);
document.getElementById("btns").addEventListener("input", preview);
document.getElementById("photo").onchange = function(){
  var file = this.files[0]; if (!file) return;
  document.getElementById("photo-st").textContent = "загружаю…";
  fetch(A + "broadcast-photo", { method: "POST", credentials: "same-origin", headers: { "content-type": file.type }, body: file })
    .then(readResponse).then(function(j){
      if (!j.ok) { document.getElementById("photo-st").textContent = ""; return say("bad", j.error || "картинка не загрузилась"); }
      photoR2 = j.photo_r2; photoUrl = URL.createObjectURL(file); formDirty=true;setState(cur);showPhoto(); say("ok", "Картинка загружена. Не забудьте сохранить черновик.");
    }).catch(report);
};
document.getElementById("photo-x").onclick = function(){ photoR2 = ""; photoUrl = ""; document.getElementById("photo").value = ""; formDirty=true;setState(cur);showPhoto(); };
function showPhoto(){
  document.getElementById("photo-st").textContent = photoR2 ? "✓ картинка прикреплена" : "";
  document.getElementById("photo-x").hidden = !photoR2; preview();
}
f.addEventListener("input", function(e){ formDirty=true;setState(cur); if (["title", "text", "date_from", "date_to"].indexOf(e.target.name) < 0) recount(); eta(); });
f.material.onchange = function(){ document.getElementById("textbox").hidden = !!f.material.value; };
function setState(b){
  var editable=!b || ["draft","tested"].indexOf(b.status)>=0;
  var ready=f.title.value.trim() && (f.audience.value || f.bot.value) && (f.material.value || f.text.value.trim() || photoR2);
  document.getElementById("test").disabled=formBusy || !editable || !ready;
  document.getElementById("test").textContent=!b||formDirty?"Сохранить и отправить тест":"Тест себе в Telegram";
  document.getElementById("start").disabled=formBusy || !b || formDirty || b.status!=="tested";
}
function edit(b){
  cur = b || null; formDirty=false; f.reset();f.bot.disabled=false; document.getElementById("btns").innerHTML = ""; lastCount = null; photoR2 = ""; photoUrl = "";
  document.getElementById("ftitle").textContent = b ? "Рассылка «" + b.title + "» · " + (ST[b.status] || b.status) : "Новая рассылка";
  if (b) {
    var s = JSON.parse(b.segment || "{}"), c = JSON.parse(b.content || "{}");
    f.title.value = b.title; Object.keys(s).forEach(function(k){ if (f[k] && k !== "rules") f[k].value = s[k]; }); f.rules.checked = s.rules === "anna";
    f.material.value = c.material || ""; f.text.value = c.text || ""; photoR2 = c.photo_r2 || "";
    (c.buttons || []).forEach(function(row){ (Array.isArray(row) ? row : [row]).forEach(btnRow); });
    f.date_from.value = isoDay(b.window_from); f.date_to.value = isoDay(b.window_to);
    f.hours_from.value = b.hours_from; f.hours_to.value = b.hours_to; f.per_hour.value = b.per_hour; f.per_day.value = b.per_day;
    f.pause_at.value = b.pause_at || 0; f.stop_pct.value = b.stop_pct || 3;
  }
  audienceMode();f.material.onchange(); setState(b); recount(); showPhoto();
}
document.getElementById("new").onclick = function(){ edit(null); };
f.onsubmit = function(e){e.preventDefault();if(formBusy)return;formBusy=true;setState(cur);return post("broadcasts",body()).then(function(j){say("ok","Черновик сохранён. Дальше — тест себе.");return load(j.id);}).catch(report).finally(function(){formBusy=false;setState(cur);});};
document.getElementById("test").onclick=function(){
  if(formBusy)return;var data=!cur||formDirty?body():null;formBusy=true;setState(cur);
  var saved=data?post("broadcasts",data).then(function(j){return load(j.id);}):Promise.resolve();
  return saved.then(function(){return post("broadcasts/test",{id:cur.id});}).then(function(j){say("ok","Тест отправлен вам"+(j.bots>1?' от '+j.bots+' ботов':' в Telegram')+". Проверьте текст и кнопки.");return load(cur.id);}).catch(report).finally(function(){formBusy=false;setState(cur);});
};
document.getElementById("start").onclick=function(){
  if(formBusy || !cur || formDirty || cur.status!=="tested")return;
  var v=prompt("Запуск рассылки «"+cur.title+"».\nВведите число получателей, чтобы подтвердить:");if(v==null)return;
  formBusy=true;setState(cur);return post("broadcasts/start",{id:cur.id,confirm:Number(v)}).then(function(j){say("ok","Запущено: "+n(j.total)+" получателей, уходит порциями в рамках расписания.");return load(cur.id);}).catch(report).finally(function(){formBusy=false;setState(cur);});
};
function load(open){
  return get("broadcasts").then(function(j){
    allowed = j.allowed || [];
    document.getElementById("guard").textContent = "Запуск сейчас разрешён только от: " + (allowed.join(", ") || "—") + ".";
    var rows = j.rows || []; broadcastHistory = rows;
    document.getElementById("list-b").innerHTML = rows.length ? '<table><thead><tr><th>Рассылка</th><th>Статус</th><th class="num">Отправлено</th><th></th></tr></thead><tbody>' + rows.map(function(b){
      var pct = b.total ? Math.round(100 * b.sent / b.total) : 0;
      return '<tr><td><b>' + esc(b.title) + '</b><div class="hint">' + esc(botCaption(b.bot)) + ' · ' + dt(b.created_at) + (b.created_by ? ' · ' + esc(b.created_by) : '') + '</div></td><td><span class="st ' + esc(b.status) + '">' + esc(ST[b.status] || b.status) + '</span></td><td class="num">' + n(b.sent) + (b.total ? ' / ' + n(b.total) : '') + (b.failed ? '<div class="hint">не доставлено ' + n(b.failed) + '</div>' : '') + (b.sent ? '<div class="hint"' + (b.unsub * 100 / b.sent >= (b.stop_pct || 3) * 0.7 ? ' style="color:var(--bad)"' : '') + '>отписались ' + n(b.unsub || 0) + ' · ' + (Math.round((b.unsub || 0) * 1000 / b.sent) / 10) + '%</div>' : '') + '<div class="bar"><i style="width:' + pct + '%"></i></div></td><td><button class="btn ghost" data-open="' + b.id + '">открыть</button>' + (b.status === "paused" ? ' <button class="btn" data-resume="' + b.id + '">продолжить</button>' : '') + (["scheduled", "sending", "paused"].indexOf(b.status) >= 0 ? ' <button class="btn warn" data-stop="' + b.id + '">стоп</button>' : '') + '</td></tr>'; }).join("") + '</tbody></table>' : '<p class="empty">рассылок пока нет</p>';
    document.querySelectorAll("[data-open]").forEach(function(x){ x.onclick = function(){ edit(rows.find(function(b){ return b.id === Number(x.dataset.open); })); }; });
    document.querySelectorAll("[data-resume]").forEach(function(x){ x.onclick = function(){ var b = rows.find(function(r){ return r.id === Number(x.dataset.resume); }); if (confirm("Продолжить рассылку на остальных?\nОтписались " + n(b.unsub || 0) + " из " + n(b.sent) + " (" + (Math.round((b.unsub || 0) * 1000 / (b.sent || 1)) / 10) + "%).")) post("broadcasts/resume", { id: b.id }).then(function(j){ if (!j.ok) say("bad", j.error || "не продолжилось"); load(); }); }; });
    document.querySelectorAll("[data-stop]").forEach(function(x){ x.onclick = function(){ if (confirm("Остановить рассылку? Неотправленные не уйдут.")) post("broadcasts/stop", { id: Number(x.dataset.stop) }).then(function(){ load(); }); }; });
    if (open) edit(rows.find(function(b){ return b.id === open; }));
    eta();
  });
}
Promise.all([get("bots"), get("lists"), get("materials"),get("crm-audiences")]).then(function(r){
  var bots = (r[0].rows || []).filter(function(b){ return b.connected; });
  f.bot.innerHTML = '<option value="">— выберите —</option><option value="__client_bot__" hidden>Бот каждого клиента</option>' + bots.map(function(b){ return '<option value="' + esc(b.key) + '">' + esc(b.title || b.key) + ' (@' + esc(b.key) + ')</option>'; }).join("");
  audienceRows=(r[3].rows || []).filter(function(a){return a.state==='ready';});
  f.audience.innerHTML='<option value="">По фильтрам ниже</option>'+audienceRows.map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.title)+' · '+n(a.stats.ready)+' клиентов</option>';}).join('');
  var listOpts = (r[1].rows || []).map(function(l){ return '<option value="' + esc(l.key) + '">' + esc(l.title || l.key) + ' · ' + n(l.people) + '</option>'; }).join("");
  f.list.innerHTML = '<option value="">любой</option>' + listOpts;
  f.exclude_list.innerHTML = '<option value="">—</option>' + listOpts;
  f.material.innerHTML = '<option value="">— свой текст —</option>' + (r[2].rows || []).filter(function(m){ return m.active; }).map(function(m){ return '<option value="' + esc(m.key) + '">' + esc(m.title) + '</option>'; }).join("");
  document.getElementById("stamp").textContent = bots.length + " бот(ов) с токеном";
  edit(null);return load();
}).catch(report);
