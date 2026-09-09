/* Общие помощники страниц Штаба: тема, даты, форматирование. Подключать до скрипта страницы. */
(function(){var KEY="okk-theme";function store(v){try{v?localStorage.setItem(KEY,v):localStorage.removeItem(KEY)}catch(e){}}
function read(){try{return localStorage.getItem(KEY)}catch(e){return null}}
function paint(mode){if(mode==="light"||mode==="dark"){document.documentElement.setAttribute("data-theme",mode)}else{document.documentElement.removeAttribute("data-theme")}
document.querySelectorAll(".themer button").forEach(function(b){b.setAttribute("aria-pressed",b.getAttribute("data-set")===(mode||"auto")?"true":"false")})}
paint(read()||"auto");var t=document.querySelector(".themer");if(t)t.addEventListener("click",function(e){var b=e.target.closest("button[data-set]");if(!b)return;var m=b.getAttribute("data-set");store(m==="auto"?null:m);paint(m)});})();

function iso(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); }
function addDays(d,n){ var x = new Date(d); x.setDate(x.getDate()+n); return x; }
function dmy(d){ return String(d.getDate()).padStart(2,"0") + "." + String(d.getMonth()+1).padStart(2,"0"); }
function monday(d){ var x = new Date(d); var wd = (x.getDay()+6)%7; x.setDate(x.getDate()-wd); return x; }
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]}); }
function pct(a,b){ return b ? Math.round(100*a/b) : null; }
function fmtPct(p){ return p==null ? "—" : p + "%"; }
function avg(a){ return a.length ? a.reduce(function(x,y){return x+y},0)/a.length : null; }
function delta(cur, prev){
  if (prev == null || cur == null) return "";
  if (!prev) return cur ? '<span class="d up">новое</span>' : '<span class="d flat">0</span>';
  var d = Math.round(100*(cur-prev)/prev); var cls = d > 3 ? "up" : d < -3 ? "down" : "flat";
  return '<span class="d ' + cls + '">' + (d>0?"+":"") + d + '%</span>';
}
