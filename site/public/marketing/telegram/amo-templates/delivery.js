(function(){
  'use strict';
  var rows=[],loaded=false,busy=false,$=function(id){return document.getElementById(id);};
  var states={pending:'В очереди',processing:'Отправляется',delivered:'Доставлено',failed:'Не доставлено',review:'Нужна проверка'};
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function time(v){return v?new Date(Number(v)).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';}
  function eventName(e){
    if(e.event==='received')return 'Сохранено';
    if(e.event==='delivered')return 'Telegram подтвердил отправку';
    if(e.event==='failed')return 'Отправка отклонена';
    if(e.event.indexOf('amo_status_')===0)return 'Статус обновлён в amo';
    if(e.event.indexOf('status_retry_')===0)return 'Повтор обновления статуса / записи истории';
    if(e.event.indexOf('review_')===0)return 'Результат неизвестен, требуется проверка';
    if(e.event.indexOf('retry_')===0)return 'Запланирована повторная попытка';
    if(e.event.indexOf('attempt_')===0)return 'Попытка '+e.event.slice(8);
    return e.event;
  }
  function render(){
    var q=$('delivery-search').value.trim().toLowerCase();
    var shown=rows.filter(function(r){return !q || [r.name,r.lead_id,r.text,r.bot].join(' ').toLowerCase().indexOf(q)>=0;});
    if(!shown.length){$('delivery-rows').innerHTML='<p class="hint">'+(rows.length?'Совпадений нет.':'Новых записей пока нет. Старые сообщения автоматически в журнал не добавляются.')+'</p>';return;}
    $('delivery-rows').innerHTML='<table><thead><tr><th>Время, МСК / клиент</th><th>Сообщение</th><th>Доставка</th><th>Статус в amo</th></tr></thead><tbody>'+shown.map(function(r){
      var log=(r.log || []).map(function(e){return '<li>'+esc(time(e.at))+' · '+esc(eventName(e))+(e.code?' <span class="hint">'+esc(e.code)+'</span>':'')+'</li>';}).join('');
      var link=Number.isSafeInteger(Number(r.lead_id)) && Number(r.lead_id)>0?'<a href="https://pavelgitelman.amocrm.ru/leads/detail/'+Number(r.lead_id)+'/" target="_blank" rel="noopener noreferrer">'+esc(r.name)+' ↗</a>':esc(r.name);
      var receipt=r.status_synced_at?'Обновлён '+time(r.status_synced_at):['delivered','failed','review'].indexOf(r.state)>=0?'Ожидает обновления':'После отправки';
      return '<tr><td>'+esc(time(r.amo_ts || r.received_at))+'<br>'+link+'<p class="hint">'+esc(r.bot || '')+(r.source==='reconcile'?'<br>Восстановлено сверкой':'')+'</p></td><td class="delivery-text">'+esc(String(r.text || '[вложение]').slice(0,300))+'</td><td><strong>'+esc(states[r.state] || r.state)+'</strong><p class="hint">Попыток: '+Number(r.attempts || 0)+(r.delivered_at?'<br>'+esc(time(r.delivered_at)):'')+'</p>'+(r.last_error?'<p class="hint">'+esc(r.last_error)+'</p>':'')+'<details><summary>История</summary><ol>'+log+'</ol></details></td><td>'+esc(receipt)+'</td></tr>';
    }).join('')+'</tbody></table>';
  }
  async function load(){
    if(busy)return;busy=true;$('delivery-refresh').disabled=true;$('delivery-note').textContent='Загружаем журнал…';
    try{
      var r=await fetch('/api/tgbots-admin/manager-delivery?limit=100',{credentials:'same-origin',cache:'no-store'}),data=await r.json();
      if(!r.ok || data.error)throw Error(data.error || 'Не удалось загрузить журнал');
      rows=data.rows || [];loaded=true;render();$('delivery-note').textContent=data.reserve_error?'Часть журнала временно недоступна. Повторите обновление.':'Загружено: '+rows.length+'. Обновлено '+time(Date.now())+' МСК.';
    }catch(e){$('delivery-note').textContent=e.message+'. Нажмите «Обновить журнал» для повторной загрузки.';}
    finally{busy=false;$('delivery-refresh').disabled=false;}
  }
  $('delivery-journal').addEventListener('toggle',function(){if(this.open && !loaded)load();});
  $('delivery-refresh').addEventListener('click',load);$('delivery-search').addEventListener('input',render);
})();
