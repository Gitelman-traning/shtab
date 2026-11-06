(()=>{
  const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={pending:'Ожидает проверки',ok:'Разметка присутствует',missing:'Разметка отсутствует / отличается',no_rule:'Нет точного совпадения',condition_mismatch:'Отличаются условия',unresolved:'Не найдена сделка',error:'Ошибка чтения',mixed:'Разные результаты'};
  const fmt=n=>n?new Date(n*1000).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
  const badge=s=>`<span class="badge ${Object.hasOwn(labels,s)?s:''}">${esc(labels[s]||s)}</span>`;
  let RULES=[],ROWS=[],next=null,busy=false;
  async function api(query='',options){const r=await fetch('/api/amo-watch'+query,{cache:'no-store',...options});let d;try{d=await r.json();}catch{throw Error('Сервер временно недоступен');}if(!r.ok)throw Error(d.error||'Не удалось загрузить журнал');return d;}
  function draw(){
    $('rows').innerHTML=ROWS.length?ROWS.map(r=>`<tr><td class="when">${fmt(r.created_at)}<br><small class="hint">${esc(r.origin||r.message_type||'чат')}</small></td><td>${r.lead_id?`<a href="https://pavelgitelman.amocrm.ru/leads/detail/${Number(r.lead_id)}/" target="_blank" rel="noopener">${Number(r.lead_id)}</a>`:'—'}<br><button class="link-button" type="button" data-event="${r.id}">Подробности</button></td><td class="msg">${esc(r.message_text||'Сообщение без текста')}</td><td>${badge(r.result)}<br><small class="hint">${r.next_check_at?'Следующее чтение: '+fmt(r.next_check_at):'Наблюдение завершено'}</small></td><td>${(r.latest?.results||[]).map(x=>esc(x.name)).join('<br>')||'—'}</td></tr>`).join(''):'<tr><td colspan="5" class="hint">Записей нет. Журнал собирает новые входящие после подключения; сообщения до подключения не загружаются. Другие кампании нужно добавить в правила наблюдения.</td></tr>';
    $('more').hidden=!next;
  }
  async function load(append=false){
    if(busy)return;busy=true;$('count').textContent='Загружаем…';
    try{
      const p=new URLSearchParams({from:String(Math.floor(Date.now()/1000)-Number($('days').value)*86400)});
      for(const key of ['lead','result','rule'])if($(key).value)p.set(key,$(key).value);
      if(append&&next)p.set('before',next);
      const d=await api('?'+p);ROWS=append?ROWS.concat(d.rows):d.rows;next=d.next;RULES=d.rules;
      const selected=$('rule').value;$('rule').innerHTML='<option value="">Все</option>'+RULES.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');$('rule').value=selected;
      const counts=Object.fromEntries(d.summary.map(s=>[s.result,s.n]));const total=d.summary.reduce((n,s)=>n+s.n,0);
      $('totals').innerHTML=[[total,'Входящих'],[counts.ok||0,'Разметка присутствует'],[counts.missing||0,'Разметка отсутствует / отличается'],[counts.no_rule||0,'Нет точного совпадения']].map(([n,t])=>`<div class="total"><strong>${n}</strong><span>${t}</span></div>`).join('');
      $('count').textContent=`Показано ${ROWS.length} из ${total} по выбранным фильтрам`;
      const tick=d.health.find(h=>h.id==='cron'),hook=d.health.find(h=>h.id==='subscription');
      $('health').textContent=(hook?.value==='active'?'Приём событий подключён. ':'Подключение приёма событий ещё не подтверждено. ')+(tick?'Проверки: '+fmt(tick.updated_at)+'. ':'')+'Последнее входящее: '+fmt(d.last_event_at);
      $('rules').innerHTML=RULES.map(r=>`<div class="rule-row"><div><b>${esc(r.name)}</b><small>${r.enabled?'Наблюдаем':'Выключено'} · ${esc(r.id)} · ${esc(r.expected_tags.join(', '))}${r.source_value?' · '+esc(r.source_value):''}</small></div><button type="button" data-rule="${esc(r.id)}">Изменить</button></div>`).join('');$('rule-count').textContent='('+RULES.filter(r=>r.enabled).length+')';draw();
    }catch(e){$('count').textContent=e.message;$('count').classList.add('error-text');}finally{busy=false;}
  }
  async function detail(id){
    $('detail').hidden=false;$('detail-body').textContent='Загружаем…';
    try{
      const d=await api('?id='+id),r=d.row;
      $('detail-body').innerHTML=`<p class="hint">Получено ${fmt(r.received_at)} · сообщение ${esc(r.message_id)} · контакт ${r.contact_id||'—'} · беседа ${r.talk_id||'—'}</p><pre class="exact">${esc(r.message_text||'Без текста')}</pre>${r.text_truncated?'<p class="error-text">Текст длиннее 32 000 знаков. Точное сравнение пропущено.</p>':''}<p class="hint">Первое чтение: ${fmt(r.initial?.observed_at)}. Снимок правил сохранён при поступлении сообщения.</p>`+d.checks.map(c=>`<div class="check-entry"><b>${['Первое чтение','Контроль через 1 минуту','Контроль через 5 минут'][c.phase]} · ${fmt(c.checked_at)}</b> ${badge(c.result)}<p class="hint">${esc(c.detail)}</p>${c.snapshot?`<p class="hint">Сделка ${c.snapshot.lead_id} · воронка ${c.snapshot.pipeline_id} · статус ${c.snapshot.status_id}<br>Теги: ${esc(c.snapshot.tags.join(', ')||'нет')}</p>`:''}${c.results.map(v=>`<p><b>${esc(v.name)}</b> ${badge(v.result)}<br><span class="hint">Ожидаемые теги: ${esc(v.expected_tags.join(', ')||'не заданы')}. Отсутствуют: ${esc(v.missing_tags.join(', ')||'нет')}.<br>Источник: ${esc(v.actual_source||'пусто')} · ожидается: ${esc(v.expected_source||'по ID значения / не задан')}${v.reasons.length?'<br>'+v.reasons.map(esc).join('<br>'):''}</span></p>`).join('')}</div>`).join('')+`<details><summary>Копии правил на момент сообщения</summary>${r.rules.map(v=>`<p><b>${esc(v.name)}</b></p><pre class="exact">${esc(v.match_text)}</pre><p class="hint">Воронка: ${v.pipeline_id||'любая'} · статус: ${v.status_id||'любой'} · теги: ${esc(v.expected_tags.join(', '))} · источник: ${esc(v.source_value)}</p>`).join('')}</details>`;
    }catch(e){$('detail-body').textContent=e.message;}
    $('detail').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function edit(rule={}){
    const f=$('rule-form');f.reset();f.hidden=false;
    for(const key of ['id','name','match_text','pipeline_id','status_id','source_value','source_enum_id'])f.elements.namedItem(key).value=rule[key]??'';
    f.elements.namedItem('source_field_id').value=rule.source_field_id||1439087;f.elements.namedItem('expected_tags').value=(rule.expected_tags||[]).join('\n');f.elements.namedItem('enabled').checked=rule.enabled!==0;f.elements.namedItem('id').readOnly=!!rule.id;
    $('save-status').textContent='';f.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  $('filters').onsubmit=e=>{e.preventDefault();load();};$('more').onclick=()=>load(true);
  $('rows').onclick=e=>{const b=e.target.closest('[data-event]');if(b)detail(b.dataset.event);};$('close-detail').onclick=()=>{$('detail').hidden=true;};
  $('rules').onclick=e=>{const b=e.target.closest('[data-rule]');if(b)edit(RULES.find(r=>r.id===b.dataset.rule));};$('new-rule').onclick=()=>edit();$('cancel-rule').onclick=()=>{$('rule-form').hidden=true;};
  $('rule-form').onsubmit=async e=>{
    e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type=submit]');b.disabled=true;
    const data=Object.fromEntries(new FormData(f));data.enabled=f.elements.namedItem('enabled').checked;data.expected_tags=data.expected_tags.split('\n').map(t=>t.trim()).filter(Boolean);
    try{await api('',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});f.hidden=true;await load();}catch(error){$('save-status').textContent=error.message;}finally{b.disabled=false;}
  };
  load();setInterval(()=>{if(!document.hidden&&!$('rule-form').matches(':focus-within'))load();},60000);
})();
