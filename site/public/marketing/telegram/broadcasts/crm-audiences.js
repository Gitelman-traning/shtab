(function(){
  'use strict';
  var base='/api/tgbots-admin/crm-audiences',form=document.getElementById('crm-form');
  var audiences=[],campaigns=[],current=null,dirty=false,busy=false,poll=null;
  var el=function(id){return document.getElementById('crm-'+id);};
  var labels={draft:'черновик',tested:'тест отправлен',starting:'запускается',scheduled:'запущена',partial:'запущена частично',done:'завершена',stopped:'остановлена'};
  function api(path,body){return fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok||j.error)throw Error(j.error||'Не удалось загрузить данные');return j;});});}
  function notice(error){say('bad',error.message||String(error));}
  function selected(){return audiences.find(function(a){return a.id===form.audience.value;});}
  function status(){
    var a=selected(),editable=!current||['draft','tested'].includes(current.status);
    el('save').disabled=busy||!a||!editable;
    el('test').disabled=busy||!a||!editable||!form.text.value.trim()||!form.link.value.trim();
    el('test').textContent=!current||dirty?'Сохранить и отправить тест':'Тест себе';
    el('start').disabled=busy||!current||dirty||!['tested','partial'].includes(current.status);
    form.audience.disabled=busy||!!current;
    ['title','text','link','date_from','date_to','hours_from','hours_to','per_hour','per_day'].forEach(function(k){form[k].disabled=busy||!editable;});
    el('draft-state').textContent=current?(dirty?'Есть изменения. «Сохранить и отправить тест» сохранит их перед проверкой.':('Статус: '+(labels[current.status]||current.status)+'. Тест — по одному сообщению от каждого бота аудитории.')):'Добавьте текст и Telegram-ссылку для теста. Кнопка сохранит черновик и отправит проверку только вам; клиентам ничего не уйдёт.';
  }
  function stats(){
    var a=selected(),s=a&&a.stats;
    el('stats').textContent=s?('Готовы к отправке: '+n(s.ready)+' клиентов. В amoCRM: '+n(s.deals)+' сделок. Отписались: '+n(s.unsubscribed)+'. Без Telegram ID: '+n(s.missing_tg)+' сделок. Без доступного бота: '+n(s.no_bot)+'.'):'Выберите готовую аудиторию или соберите новую.';
    el('bots').textContent=s?s.bots.map(function(b){return '@'+b.bot+': '+n(b.total);}).join(' · ')+(s.duplicates?' · Повторы убраны: '+n(s.duplicates):''):'';
    el('preview-members').hidden=!s;el('members').hidden=true;status();
  }
  function preview(){el('message-preview').textContent=form.text.value||'Текст пока не добавлен.';}
  function day(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function edit(c){
    current=c||null;dirty=false;form.reset();
    var now=new Date();form.date_from.value=day(now);form.date_to.value=day(new Date(now.getTime()+7*86400000));
    if(c){form.audience.value=c.audience;form.title.value=c.title;form.text.value=c.text;form.link.value=c.link;Object.keys(c.settings||{}).forEach(function(k){if(form[k])form[k].value=c.settings[k];});}
    stats();preview();
  }
  function body(){var settings={pause_at:500,stop_pct:3};['date_from','date_to','hours_from','hours_to','per_hour','per_day'].forEach(function(k){settings[k]=form[k].value;});return {id:current?current.id:undefined,audience:form.audience.value,title:form.title.value,text:form.text.value,link:form.link.value,settings:settings};}
  function renderCampaigns(){
    el('campaigns').innerHTML=campaigns.length?'<table><thead><tr><th>Рассылка Первой линии</th><th>Статус</th><th>Доставлено</th><th></th></tr></thead><tbody>'+campaigns.map(function(c){return '<tr><td>'+esc(c.title)+'<div class="hint">'+dt(c.created_at)+'</div></td><td>'+esc(c.paused.length?'Пауза после первой волны':labels[c.status]||c.status)+(c.error?'<div class="hint">'+esc(c.error)+'</div>':'')+'</td><td>'+n(c.sent)+(c.total?' / '+n(c.total):'')+(c.failed?'<div class="hint">Не доставлено '+n(c.failed)+'</div>':'')+'</td><td><button class="btn ghost" type="button" data-crm-open="'+esc(c.id)+'">Открыть</button>'+(['scheduled','partial','starting'].includes(c.status)?' <button class="btn ghost" type="button" data-crm-stop="'+esc(c.id)+'">Стоп</button>':'')+(c.paused.length?' <button class="btn ghost" type="button" data-crm-resume="'+esc(c.id)+'">Продолжить</button>':'')+'</td></tr>';}).join('')+'</tbody></table>':'<p class="hint">Рассылок по этой аудитории пока нет. Сохраните первый черновик.</p>';
  }
  function refresh(open){
    return Promise.all([api(''),api('/campaigns')]).then(function(j){
      var selectedId=form.audience.value;audiences=j[0].rows||[];campaigns=j[1].rows||[];
      var active=audiences.find(function(a){return ['leads','contacts','resolve'].includes(a.state);});
      el('collect').disabled=busy||!!active;
      el('progress').textContent=active?({leads:'Собираем сделки…',contacts:'Находим Telegram ID…',resolve:'Сопоставляем клиентов с ботами…'}[active.state]):(audiences[0]&&audiences[0].state==='error'?'Сбор не завершён: '+(audiences[0].error||'повторите сбор'):audiences.length?'Аудитория сохранена; этапы перед отправкой повторно не проверяются.':'Сохранённых аудиторий пока нет.');
      var ready=audiences.filter(function(a){return a.state==='ready';});
      form.audience.innerHTML=ready.length?ready.map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.title)+' · '+dt(a.done_at)+' · '+n(a.stats.ready)+' клиентов</option>';}).join(''):'<option value="">Сначала соберите аудиторию</option>';
      form.audience.value=current?current.audience:ready.some(function(a){return a.id===selectedId;})?selectedId:ready[0]?ready[0].id:'';
      renderCampaigns();
      if(open)edit(campaigns.find(function(c){return c.id===open;}));else stats();
      clearTimeout(poll);if(active||campaigns.some(function(c){return ['starting','scheduled'].includes(c.status);}))poll=setTimeout(function(){refresh().catch(notice);},15000);
    });
  }
  function action(path,data,success){if(busy)return;busy=true;status();return api(path,data).then(function(j){say('ok',success(j));return refresh(j.id||current&&current.id);}).catch(notice).finally(function(){busy=false;status();el('collect').disabled=audiences.some(function(a){return ['leads','contacts','resolve'].includes(a.state);});});}
  form.addEventListener('input',function(){dirty=true;status();preview();});
  form.audience.onchange=stats;
  form.onsubmit=function(e){e.preventDefault();action('/campaigns',body(),function(){dirty=false;return 'Черновик сохранён. Когда будут текст и ссылка, отправьте тест себе.';});};
  el('collect').onclick=function(){action('',{},function(){return 'Сбор начался. Список появится здесь после обработки данных amoCRM.';});};
  el('new').onclick=function(){edit(null);};
  el('test').onclick=function(){
    if(busy||!selected()||!form.text.value.trim()||!form.link.value.trim())return;
    var data=!current||dirty?body():null;
    busy=true;status();
    var saved=data?api('/campaigns',data).then(function(j){return refresh(j.id);}):Promise.resolve();
    return saved.then(function(){return api('/test',{id:current.id});}).then(function(j){
      say('ok','Тест отправлен вам от '+j.bots+' бот(ов). Проверьте текст и переход по кнопке.');
      return refresh(current.id);
    }).catch(notice).finally(function(){busy=false;status();});
  };
  el('start').onclick=function(){
    if(!current||busy)return;
    api('/count',{id:current.id}).then(function(j){var answer=prompt('Рассылка «'+current.title+'». Получателей: '+j.total+'.\nВведите это число для запуска:');if(answer!==null)action('/start',{id:current.id,confirm:Number(answer)},function(r){return 'Запущено для '+n(r.total)+' клиентов. Каждому — одно сообщение от знакомого бота.';});}).catch(notice);
  };
  el('campaigns').onclick=function(e){var button=e.target.closest('button');if(!button)return;var id=button.dataset.crmOpen;if(id){edit(campaigns.find(function(c){return c.id===id;}));return;}id=button.dataset.crmStop;if(id&&confirm('Остановить эту рассылку во всех ботах?'))action('/stop',{id:id},function(){return 'Рассылка остановлена.';});id=button.dataset.crmResume;if(id&&confirm('Продолжить рассылку после первой волны?'))action('/resume',{id:id},function(){return 'Рассылка продолжена.';});};
  el('preview-members').onclick=function(){var area=el('members');if(!area.hidden){area.hidden=true;return;}api('/members?id='+encodeURIComponent(form.audience.value)).then(function(j){area.innerHTML='<p class="hint">Первые 50 клиентов сохранённой аудитории.</p><table><thead><tr><th>Клиент / Telegram ID</th><th>Бот</th><th>Этап при сборе</th><th>Сделки</th></tr></thead><tbody>'+(j.rows||[]).map(function(r){return '<tr><td>'+esc(r.name||'Без имени')+'<div class="hint">'+esc(r.tg_id)+' · '+esc({ready:'получатель',unsubscribed:'отписался',no_bot:'нет бота'}[r.state]||r.state)+'</div></td><td>'+esc(r.bot?'@'+r.bot:'—')+'</td><td>'+esc(r.stage_name||'—')+'</td><td>'+JSON.parse(r.lead_ids).map(function(id){return '<a href="https://pavelgitelman.amocrm.ru/leads/detail/'+Number(id)+'/" target="_blank" rel="noopener">'+Number(id)+'</a>';}).join(', ')+'</td></tr>';}).join('')+'</tbody></table>';area.hidden=false;}).catch(notice);};
  edit(null);refresh().catch(function(e){el('progress').textContent=e.message;});
})();
