import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../site/public/marketing/telegram/broadcasts/broadcasts.js',import.meta.url),'utf8');
const audience='06cfe72b-1482-4495-9411-e19f0da4de5f';
async function fixture({rawFailure=false}={}){
 const nodes=new Map(),calls=[];
 function element(id){
  if(nodes.has(id))return nodes.get(id);
  let html='';const x={id,value:'',disabled:false,hidden:false,checked:false,children:[],listeners:{},textContent:'',name:id,addEventListener(k,fn){this.listeners[k]=fn;},appendChild(c){this.children.push(c);c.parent=this;},remove(){this.parent.children=this.parent.children.filter(x=>x!==this);},focus(){},setSelectionRange(){}};
  Object.defineProperty(x,'innerHTML',{configurable:true,get:()=>html,set:v=>{html=v;if(id==='btns')x.children=[];}});nodes.set(id,x);return x;
 }
 const form=element('f'),fields=['audience','bot','list','phone','source','medium','tag','q','from','to','seg','exclude_list','rules','title','text','material','date_from','date_to','hours_from','hours_to','per_hour','per_day','pause_at','stop_pct'];
 for(const k of fields)form[k]=element(k);
 form.reset=()=>{for(const k of fields)form[k].value='';Object.assign(form.hours_from,{value:'10'});form.hours_to.value='20';form.per_hour.value='300';form.per_day.value='2000';form.pause_at.value='500';form.stop_pct.value='3';form.rules.checked=true;};
 const campaign={id:6,title:'Рассылка Анны',bot:'__client_bot__',segment:JSON.stringify({audience,bot:'__client_bot__'}),content:JSON.stringify({text:'Текст Анны',buttons:[[{text:'Записаться',url:'https://t.me/Tam_Ilona5'}]]}),status:'draft',created_at:1,window_from:Date.now(),window_to:Date.now()+86400000,hours_from:10,hours_to:20,per_hour:300,per_day:2000,pause_at:500,stop_pct:3};
 function createElement(){
  const x=element('created-'+nodes.size),inputs=[{value:''},{value:''}],select={value:'url'},button={};
  let html='';Object.defineProperty(x,'innerHTML',{configurable:true,get:()=>html,set:v=>{html=v;const values=[...v.matchAll(/value="([^"]*)"/g)];inputs[0].value=values[0]?.[1]||'';inputs[1].value=values.at(-1)?.[1]||'';}});
  x.querySelector=s=>s==='select'?select:button;x.querySelectorAll=()=>inputs;return x;
 }
 const context={document:{getElementById:element,createElement,querySelectorAll:s=>s==='#btns .brow'?element('btns').children:[]},window:{scrollTo(){}},Date,Promise,URL,setTimeout:()=>0,clearTimeout(){},prompt:()=>null,confirm:()=>false,
  esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),iso:d=>d.toISOString().slice(0,10),dmy:()=>'',
  fetch:async(url,options={})=>{
   const path=url.replace('/api/tgbots-admin/',''),body=options.body?JSON.parse(options.body):null;calls.push({path,body});let data;
   if(path==='bots')data={rows:[{key:'one',connected:true}]};else if(path==='lists'||path==='materials')data={rows:[]};
   else if(path==='crm-audiences')data={rows:[{id:audience,title:'Первая линия',state:'ready',stats:{ready:392}}]};
   else if(path==='broadcasts'&&!body)data={allowed:['one'],rows:[campaign]};
   else if(path==='broadcasts'){Object.assign(campaign,{title:body.title,segment:JSON.stringify(body.segment),content:JSON.stringify(body.content),status:'draft'});data={ok:true,id:6};}
   else if(path==='broadcasts/test'){
    if(rawFailure)return {ok:false,status:500,text:async()=> 'error code: 1042\n'};
    campaign.status='tested';data={ok:true,bots:6};
   }else throw Error('Unexpected request '+path);
   return {ok:true,status:200,text:async()=>JSON.stringify(data)};
  }};
 vm.createContext(context);vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
 return {context,form,element,calls,campaign,open(){context.edit(campaign);},change(text){form.text.value=text;form.listeners.input({target:{name:'text'}});}};
}
test('only the existing broadcast form remains; saved audience is a segment of it',()=>{
 const html=readFileSync(new URL('../site/public/marketing/telegram/broadcasts/index.html',import.meta.url),'utf8');
 assert.equal((html.match(/<form\b/g)||[]).length,1);assert.ok(html.includes('name="audience"'));assert.ok(!html.includes('crm-workspace'));assert.ok(!html.includes('crm-audiences.js'));
});
test('normal filters remain; selecting saved audience uses its immutable recipient set and each client bot',async()=>{
 const f=await fixture();f.form.bot.value='one';f.form.phone.value='no';assert.equal(f.context.segment().rules,'anna');assert.equal(f.context.segment().phone,'no');
 f.form.audience.value=audience;f.form.audience.onchange();assert.equal(f.form.bot.disabled,true);assert.equal(f.element('audience-filters').hidden,true);
 assert.deepEqual(JSON.parse(JSON.stringify(f.context.segment())),{audience,bot:'__client_bot__'});
 f.form.audience.value='';f.form.audience.onchange();assert.equal(f.form.bot.disabled,false);assert.equal(f.form.bot.value,'one');assert.equal(f.context.segment().rules,'anna');
});
test('migrated draft preserves text, button and schedule in the existing form; test saves edits first',async()=>{
 const f=await fixture();f.open();assert.equal(f.form.text.value,'Текст Анны');assert.equal(f.context.buttons()[0][0].url,'https://t.me/Tam_Ilona5');assert.equal(f.form.per_hour.value,300);
 f.change('Актуальная версия');assert.equal(f.element('test').disabled,false);assert.equal(f.element('start').disabled,true);
 await f.element('test').onclick();const writes=f.calls.filter(x=>x.body);assert.deepEqual(writes.map(x=>x.path),['broadcasts','broadcasts/test']);assert.equal(writes[0].body.content.text,'Актуальная версия');
 assert.equal(f.element('start').disabled,false);assert.ok(!f.calls.some(x=>x.path==='broadcasts/start'));
 f.change('Следующая правка');assert.equal(f.element('start').disabled,true);
});
test('plain-text transport failures are visible as connection errors and never unlock launch',async()=>{
 const f=await fixture({rawFailure:true});f.open();await f.element('test').onclick();assert.ok(f.element('msgs').innerHTML.includes('1042'));assert.ok(!f.element('msgs').innerHTML.includes('Unexpected token'));assert.equal(f.element('start').disabled,true);
});
test('opening a normal broadcast after a saved audience restores its original bot and filters',async()=>{
 const f=await fixture();f.open();assert.equal(f.form.bot.disabled,true);
 const normal={...f.campaign,bot:'one',segment:JSON.stringify({bot:'one',phone:'no',rules:'anna'})};
 f.context.edit(normal);assert.equal(f.form.audience.value,'');assert.equal(f.form.bot.disabled,false);assert.equal(f.form.bot.value,'one');
 assert.equal(f.form.phone.value,'no');assert.equal(f.form.rules.checked,true);assert.equal(f.element('audience-filters').hidden,false);
});
