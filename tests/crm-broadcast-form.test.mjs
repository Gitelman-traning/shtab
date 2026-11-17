import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../site/public/marketing/telegram/broadcasts/crm-audiences.js',import.meta.url),'utf8');
async function fixture({existing=true,saveError=false,testError=false}={}){
 const nodes=new Map(),calls=[],notices=[];
 function node(id){if(!nodes.has(id))nodes.set(id,{id,value:'',disabled:false,hidden:false,textContent:'',innerHTML:'',listeners:{},addEventListener(k,fn){this.listeners[k]=fn;}});return nodes.get(id);}
 const form=node('crm-form'),fields=['audience','title','text','link','date_from','date_to','hours_from','hours_to','per_hour','per_day'];
 for(const key of fields)form[key]=node('crm-'+key);
 form.reset=()=>{for(const key of fields)form[key].value='';form.title.value='Диагностика';};
 let campaign=existing?{id:'draft',audience:'audience',title:'Диагностика',text:'Сохранённый текст',link:'https://t.me/manager_name',settings:{hours_from:10,hours_to:20,per_hour:300,per_day:2000},status:'draft',children:{},paused:[],created_at:1}:null;
 const context={document:{getElementById:node},Date,Promise,setTimeout:()=>0,clearTimeout:()=>{},say:(kind,text)=>notices.push({kind,text}),n:x=>String(x),dt:x=>String(x),esc:x=>String(x),confirm:()=>false,prompt:()=>null,
  fetch:async(url,options={})=>{
   const path=url.replace('/api/tgbots-admin/crm-audiences',''),body=options.body?JSON.parse(options.body):null;calls.push({path,body});
   let data,status=200;
   if(path==='' && !body)data={rows:[{id:'audience',state:'ready',title:'Сохранённая аудитория',stats:{ready:392,bots:[]}}]};
   else if(path==='/campaigns' && !body)data={rows:campaign?[campaign]:[]};
   else if(path==='/campaigns'){
    if(saveError){data={error:'Не сохранилось'};status=400;}
    else {campaign={...campaign,...body,id:'draft',status:'draft',paused:[]};data={ok:true,id:'draft'};}
   }else if(path==='/test'){
    if(testError){data={error:'Откройте бота и нажмите Старт'};status=400;}
    else{campaign.status='tested';data={ok:true,bots:6};}
   }else throw Error('Unexpected request: '+path);
   return {ok:status===200,json:async()=>data};
  }};
 vm.runInNewContext(source,context);
 await new Promise(resolve=>setImmediate(resolve));
 function open(){node('crm-campaigns').onclick({target:{closest:()=>({dataset:{crmOpen:'draft'}})}});}
 function change(text){form.text.value=text;form.listeners.input();}
 return {form,node,calls,notices,open,change};
}
test('editing an existing draft permits a self-test and saves the current text before testing',async()=>{
 const f=await fixture();f.open();f.change('Новая версия текста');assert.equal(f.node('crm-test').disabled,false);assert.equal(f.node('crm-start').disabled,true);
 await f.node('crm-test').onclick();
 const writes=f.calls.filter(c=>c.body);assert.deepEqual(writes.map(c=>c.path),['/campaigns','/test']);assert.equal(writes[0].body.text,'Новая версия текста');
 assert.equal(f.node('crm-start').disabled,false);assert.ok(!f.calls.some(c=>c.path==='/start'));
});
test('a new draft can be saved and tested with one click; text changes invalidate launch',async()=>{
 const f=await fixture({existing:false});f.form.link.value='https://t.me/manager_name';f.change('Текст');
 assert.equal(f.node('crm-test').disabled,false);await f.node('crm-test').onclick();assert.equal(f.node('crm-start').disabled,false);
 f.change('Изменено после теста');assert.equal(f.node('crm-start').disabled,true);assert.equal(f.node('crm-test').disabled,false);
});
test('save failures prevent testing, retain edited text and show the reason',async()=>{
 const f=await fixture({saveError:true});f.open();f.change('Не терять этот текст');await f.node('crm-test').onclick();
 assert.equal(f.form.text.value,'Не терять этот текст');assert.ok(!f.calls.some(c=>c.path==='/test'));assert.equal(f.node('crm-start').disabled,true);
 assert.equal(f.notices.at(-1).text,'Не сохранилось');
});
test('a failed Telegram test keeps launch disabled and displays the error',async()=>{
 const f=await fixture({testError:true});f.open();await f.node('crm-test').onclick();
 assert.equal(f.node('crm-start').disabled,true);assert.equal(f.notices.at(-1).text,'Откройте бота и нажмите Старт');
 assert.ok(!f.calls.some(c=>c.path==='/start'));
});
