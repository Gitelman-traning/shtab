(function () {
  'use strict';
  var rows = [], selected = null, dirty = false, busy = false, waiting = null, poll = null;
  var $ = function (id) { return document.getElementById(id); };
  function escapeText(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function message(text, bad) { $('message').hidden = !text; $('message').textContent = text || ''; $('message').className = 'message' + (bad ? ' bad' : ''); }
  async function api(action, body) {
    var response = await fetch('/api/tgbots-admin/manager-media' + (action ? '/' + action : ''), { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? {'content-type':'application/json'} : {}, body: body ? JSON.stringify(body) : undefined });
    var data = await response.json();
    if (!response.ok || data.error || data.ok === false) { var error = new Error(data.error || 'Не удалось выполнить действие'); error.status = response.status; throw error; }
    return data;
  }
  function current() { return rows.find(function (r) { return r.id === selected; }); }
  function command() { return '/' + ($('kind').value === 'voice' ? 'голос' : 'кружок') + ' ' + ($('key').value.trim().toLowerCase() || '…'); }
  function buttons() {
    var row = current(), ready = row && row.active && row.file_key;
    ['save','new','refresh'].forEach(function (id) { $(id).disabled = busy; });
    $('upload').disabled = busy || dirty || !row || !row.active;
    $('test').disabled = busy || dirty || !ready;
    $('publish').disabled = busy || dirty || !ready;
    $('copy').disabled = busy || !$('key').value.trim();
    $('command').textContent = command();
    $('saved-state').textContent = dirty && selected ? 'Есть несохранённые изменения' : '';
  }
  function drawList() {
    $('count').textContent = rows.length ? String(rows.length) : '';
    $('list').innerHTML = rows.length ? rows.map(function (r) {
      var status = !r.active ? 'Выключен' : !r.file_key ? 'Ждёт запись' : r.amo_template_id ? 'Есть в amo' : 'Запись готова';
      if (r.tracking_tag) status += ' · ' + escapeText(r.tracking_tag);
      return '<button type="button" class="template' + (r.id === selected ? ' selected' : '') + '" data-id="' + escapeText(r.id) + '"><strong>' + escapeText(r.title) + '</strong><small>' + (r.kind === 'voice' ? 'Голосовое' : 'Кружок') + ' · ' + escapeText(r.command) + '</small><span class="badge">' + status + '</span><span class="template-stats"><span><b>' + Number((r.stats || {}).sent || 0).toLocaleString('ru-RU') + '</b><span>Отправлено</span></span><span><b>' + Number((r.stats || {}).replied || 0).toLocaleString('ru-RU') + '</b><span>С ответом</span></span><span title="Первый ответ за 24 часа после последнего шаблона. Проверки на себе исключены."><b>' + ((r.stats || {}).sent ? (100 * (r.stats.replied || 0) / r.stats.sent).toFixed(1) + '%' : '—') + '</b><span>Конверсия</span></span></span></button>';
    }).join('') : '<p class="empty">Пока нет шаблонов. Создайте первый и пришлите запись в Telegram.</p>';
  }
  function details() {
    var row = current(); $('recording').hidden = !row;
    if (!row) return;
    $('publish').textContent = row.amo_template_id ? 'Обновить шаблон в amo' : 'Создать шаблон в amo';
    $('file-state').textContent = row.file_key ? 'Запись сохранена' + (row.duration ? ' · ' + row.duration + ' сек' : '') + (row.file_size ? ' · ' + (row.file_size / 1048576).toFixed(1) + ' МБ' : '') : 'Запись ещё не загружена.';
    $('amo-state').textContent = row.amo_error ? 'Ошибка amo: ' + row.amo_error : row.amo_template_id ? 'В amo: «' + (row.kind === 'voice' ? 'Голосовое' : 'Кружок') + ' — ' + row.title + '». После изменения названия нажмите «Обновить шаблон в amo».' : 'Когда запись будет готова, создайте шаблон в amo одним нажатием.';
    $('upload-help').textContent = waiting && waiting.id === row.id ? 'Ожидаем запись в Telegram. Пришлите её в бота — страница обновится сама. Запрос действует 30 минут.' : 'Нажмите «Загрузить в Telegram», затем запишите или перешлите запись в бота. Она сохранится в выбранный шаблон.';
    $('preview').innerHTML = row.file_key ? '<button type="button" class="btn ghost" id="listen">' + (row.kind === 'voice' ? 'Прослушать запись' : 'Посмотреть кружок') + '</button>' : '';
  }
  function choose(id) {
    if (dirty && !window.confirm('Перейти к другому шаблону без сохранения изменений?')) return;
    selected = id || null; dirty = false;
    var row = current();
    $('editor-title').textContent = row ? 'Настройка шаблона' : 'Новый шаблон';
    $('save').textContent = row ? 'Сохранить изменения' : 'Создать шаблон';
    $('title').value = row ? row.title : '';
    $('kind').value = row ? row.kind : 'voice';
    $('key').value = row ? row.key : '';
    $('active').checked = row ? !!row.active : true;
    $('kind').disabled = !!row; $('key').disabled = !!row;
    drawList(); details(); buttons();
  }
  async function load() {
    var data = await api(''); rows = data.rows || [];
    var botValue = $('bot').value;
    $('bot').innerHTML = (data.bots || []).map(function (b) { return '<option value="' + escapeText(b.key) + '">' + escapeText(b.title) + ' · @' + escapeText(b.key) + '</option>'; }).join('');
    if ((data.bots || []).some(function (b) { return b.key === botValue; })) $('bot').value = botValue;
    drawList(); details(); buttons(); return data;
  }
  async function run(action) {
    if (busy) return; busy = true; buttons();
    try { await action(); } catch (e) { message(e.message, true); } finally { busy = false; buttons(); }
  }
  $('editor').addEventListener('input', function () { dirty = true; buttons(); });
  $('editor').addEventListener('change', function () { dirty = true; buttons(); });
  $('editor').onsubmit = function (event) { event.preventDefault(); run(async function () {
    var result = await api('', {id:selected,kind:$('kind').value,title:$('title').value,key:$('key').value,active:$('active').checked});
    dirty = false; await load(); choose(result.id); message('Шаблон сохранён. Теперь можно загрузить запись.');
  }); };
  $('new').onclick = function () { choose(null); };
  $('list').onclick = function (event) { var button = event.target.closest('[data-id]'); if (button && !busy) choose(button.dataset.id); };
  $('copy').onclick = function () { run(async function () { await navigator.clipboard.writeText(command()); message('Команда скопирована.'); }); };
  $('refresh').onclick = function () { run(async function () { await load(); message('Данные обновлены.'); }); };
  $('upload').onclick = function () { run(async function () {
    await api('upload-request', {id:selected});
    waiting = {id:selected,file_key:current().file_key,until:Date.now()+30*60*1000}; details();
    message('Бот прислал запрос в ваш Telegram. Пришлите ему запись, затем вернитесь сюда.');
    if (poll) clearInterval(poll);
    poll = setInterval(async function () {
      if (!waiting || waiting.until < Date.now()) { clearInterval(poll); waiting = null; details(); return; }
      if (busy) return;
      try {
        var previous = waiting; var data = await api(''); rows = data.rows || []; drawList();
        var updated = rows.find(function (r) { return r.id === previous.id; });
        if (updated && updated.file_key && updated.file_key !== previous.file_key) { waiting = null; clearInterval(poll); details(); buttons(); message('Запись сохранена. Проверьте её на себе и добавьте шаблон в amo.'); }
      } catch (e) { clearInterval(poll); message('Не удалось обновить статус: ' + e.message, true); }
    }, 5000);
  }); };
  $('test').onclick = function () { run(async function () { await api('test', {id:selected,bot:$('bot').value}); message('Отправлено в ваш Telegram от выбранного бота.'); }); };
  $('publish').onclick = function () { run(async function () {
    await api('publish', {id:selected}); await load(); message('Шаблон сохранён в amo. Менеджер может выбрать его в чате нашего бота.');
  }); };
  $('preview').onclick = function (event) {
    if (event.target.id !== 'listen') return;
    var row = current(), media = document.createElement(row.kind === 'voice' ? 'audio' : 'video');
    media.controls = true; media.preload = 'metadata'; media.playsInline = true;
    media.src = '/api/tgbots-admin/manager-media/file?id=' + encodeURIComponent(row.id);
    media.onerror = function () { message('Не удалось открыть запись. Обновите страницу и попробуйте ещё раз.', true); };
    $('preview').replaceChildren(media);
  };
  load().then(function () { choose(rows.length ? rows[0].id : null); }).catch(function (e) { $('workspace').hidden = true; message(e.message, true); });
})();
