#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборка сайта Штаба: страницы ОКК (из соседнего репозитория okk) раскладываются по новым адресам,
«Статистика» и «Дашборд ОКК» сшиваются в страницу Второй линии, всем страницам ставится общее меню (nav.js).

Запуск из папки shtab:  python build.py
Нужны переменные окружения для okk/build_dashboard.py: SHEET_ID, GOOGLE_SA_FILE (или GOOGLE_SERVICE_ACCOUNT_JSON).
Результат — в site/public (страницы с данными клиентов в git не попадают, см. .gitignore).
"""
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OKK = os.environ.get("OKK_DIR", os.path.join(HERE, "..", "okk"))
PUB = os.path.join(HERE, "site", "public")
NAV_ASIDE = '<aside class="side" id="side"></aside>'
NAV_SCRIPT = '<script src="/nav.js"></script>'


def rd(p):
    return io.open(p, encoding="utf-8").read()


def wr(p, t):
    d = os.path.dirname(p)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    io.open(p, "w", encoding="utf-8").write(t)


def strip_old(t):
    """Старое меню и старый виджет аккаунта убираем, ставим общий nav.js."""
    t = re.sub(r'<aside class="side">.*?</aside>', NAV_ASIDE, t, count=1, flags=re.S)
    t = re.sub(r'<script>\(function\(\)\{function esc.*?</script>\r?\n?', "", t, flags=re.S)
    t = re.sub(r'<script>fetch\("/api/me".*?</script>\r?\n?', "", t, flags=re.S)
    # старый тумблер меню в скриптах страниц ОКК: nav.js делает то же, но безвредно оставить
    if NAV_SCRIPT not in t:
        if "</body>" in t:
            t = t.replace("</body>", NAV_SCRIPT + "\n</body>", 1)
        else:
            t = t.rstrip("\r\n") + "\n" + NAV_SCRIPT + "\n"
    return t


def okk_links(t):
    """Ссылки внутри папки Второй линии: «Встречи» теперь meetings.html, а не index.html."""
    t = t.replace('href="./"', 'href="meetings.html"')
    t = t.replace("'index.html?deal='", "'meetings.html?deal='").replace("'index.html?client='", "'meetings.html?client='")
    t = t.replace('"index.html?deal="', '"meetings.html?deal="').replace('"index.html?client="', '"meetings.html?client="')
    return t


def compose_l2(stats_tpl, charts_tpl):
    """Страница Второй линии = «Статистика» + сверху цифры из витрины + снизу графики «Дашборда ОКК»."""
    t = stats_tpl
    # шапка
    t = t.replace("<h1>ОКК · Статистика</h1>", '<div class="crumbs">Отдел продаж · <b>Вторая линия</b></div><h1>Вторая линия · диагносты</h1>', 1)
    t = re.sub(r"<title>[^<]*</title>", "<title>Штаб · Вторая линия</title>", t, count=1)
    # стили графиков
    m = re.search(r"\.grid\{display:grid.*?\.gridline\{[^}]*\}", charts_tpl, re.S)
    charts_css = m.group(0) if m else ""
    extra_css = """
.vit{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.vit .kpi .v{font-size:26px}
.mergebox{overflow-x:auto}
.mergebox td.num,.mergebox th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mergebox .q{display:inline-block;min-width:34px;text-align:center;font-size:11.5px;font-weight:600;padding:2px 6px;border-radius:6px}
.q.ok{background:var(--ok-bg,#e8f2ec);color:var(--ok)}.q.warn{background:var(--warn-bg,#fbf1de);color:var(--warn)}.q.bad{background:var(--bad-bg,#fbe9e6);color:var(--bad)}
.bar8{height:6px;border-radius:3px;background:var(--soft);position:relative;min-width:60px}.bar8 i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--gold-b,#b59f76)}
.charts-title{margin:8px 0 0;font-size:15px;font-weight:600}
""" + charts_css + "\n"
    t = t.replace("</style>", extra_css + "</style>", 1)
    # блок витрины — первым в main, панель редактора — перед main
    vit = """<div id="section-editor" data-section="sales.l2"></div>
<main id="section-standard">
  <section>
    <h2>Вторая линия по витрине <span id="vit-period"></span></h2>
    <div class="kpis vit" id="vit-kpis"><div class="kpi"><span class="k">Загрузка…</span></div></div>
  </section>
  <section>
    <h2>Менеджеры: количество и качество <span>проведено и продажи из amoCRM · качество из разборов ОКК</span></h2>
    <div class="mergebox"><table id="merge"><thead><tr><th>Менеджер</th><th class="num">Провёл · мес.</th><th class="num">Продал · мес.</th><th class="num">CR · мес.</th><th class="num">Провёл · 8 нед.</th><th class="num">Продал · 8 нед.</th><th class="num">CR · 8 нед.</th><th></th><th class="num">Разборов ОКК</th><th class="num">Балл ОКК</th><th class="num">Цель</th></tr></thead><tbody><tr><td colspan="11" class="sub">загрузка…</td></tr></tbody></table></div>
  </section>
"""
    t = t.replace("<main>\n", vit, 1)
    # графики — перед заметкой в конце main
    mm = re.search(r'<main>\s*(<div class="grid">.*?</div>)\s*<footer id="foot">', charts_tpl, re.S)
    charts_main = mm.group(1) if mm else ""
    t = t.replace('  <div class="note" id="note">—</div>\n</main>', '  <h2 class="charts-title">Графики ОКК</h2>\n  ' + charts_main + '\n  <div class="note" id="foot">—</div>\n  <div class="note" id="note">—</div>\n</main>', 1)
    # скрипт графиков: от var PAYLOAD до </script>, без повторного PAYLOAD, в своей области видимости
    cm = re.search(r"var PAYLOAD = /\*__DATA__\*/;\n(.*?)</script>", charts_tpl, re.S)
    charts_js = cm.group(1) if cm else ""
    charts_js = charts_js.replace('document.getElementById("stamp").textContent', "void(")  # штамп уже поставила статистика
    charts_js = re.sub(r'void\(=([^;]*);', r"void(\1);", charts_js)
    vit_js = VIT_JS
    t = t.replace("</script>\n", "</script>\n<script>\n(function(){\n" + charts_js + "\n})();\n</script>\n<script>\n" + vit_js + "\n</script>\n<script src=\"/section-editor.js\"></script>\n", 1)
    return t


VIT_JS = r"""
/* цифры Второй линии из витрины + слияние с качеством ОКК по менеджерам */
(function(){
  function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
  function addDays(d,n){var x=new Date(d);x.setDate(x.getDate()+n);return x}
  function dmy(d){return String(d.getDate()).padStart(2,"0")+"."+String(d.getMonth()+1).padStart(2,"0")}
  function monday(d){var x=new Date(d);var wd=(x.getDay()+6)%7;x.setDate(x.getDate()-wd);return x}
  function pct(a,b){return b?Math.round(100*a/b):null}function fp(p){return p==null?"—":p+"%"}
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
  function api(q){return fetch("/api/points?"+q,{credentials:"same-origin"}).then(function(r){return r.json()})}
  var today=new Date();today.setHours(0,0,0,0);var y=addDays(today,-1);
  var wk=monday(y),ms=new Date(today.getFullYear(),today.getMonth(),1),h8=addDays(wk,-56);
  var from=ms<h8?ms:h8;
  function sum(t,m,a,b){var s=0,d=new Date(a);while(d<=b){s+=(t[m]&&t[m][iso(d)])||0;d=addDays(d,1)}return s}
  Promise.all([api("metric=l2.held,l2.sales&ptype=day&dim=&from="+iso(from)+"&to="+iso(y)),api("metric=l2.held,l2.sales&ptype=day&from="+iso(h8)+"&to="+iso(y))]).then(function(res){
    if(!res[0].ok){document.getElementById("vit-kpis").innerHTML='<div class="kpi"><span class="k">Витрина недоступна</span></div>';return}
    var day={};res[0].rows.forEach(function(r){(day[r.metric]=day[r.metric]||{})[r.period]=r.value});
    var mgr={};res[1].rows.forEach(function(r){if(!r.dim||r.dim.indexOf("src:")===0)return;((mgr[r.dim]=mgr[r.dim]||{})[r.metric]=mgr[r.dim][r.metric]||{})[r.period]=r.value});
    var H=sum(day,"l2.held",ms,y),S=sum(day,"l2.sales",ms,y),Hw=sum(day,"l2.held",wk,y),Sw=sum(day,"l2.sales",wk,y);
    var hist=[];for(var i=1;i<=8;i++){var s=addDays(wk,-7*i),e=addDays(s,6);var hh=sum(day,"l2.held",s,e),ss=sum(day,"l2.sales",s,e);if(hh)hist.push(100*ss/hh)}
    var norm=hist.length?Math.round(hist.reduce(function(a,b){return a+b},0)/hist.length):null;
    document.getElementById("vit-period").textContent="· месяц с "+dmy(ms)+" по "+dmy(y);
    var quality=(function(){var v=(PAYLOAD.items||[]).map(function(d){return d.s&&d.s.filter(function(x){return typeof x==="number"})}).filter(function(a){return a&&a.length}).map(function(a){return a.reduce(function(p,q){return p+q},0)/a.length});return v.length?Math.round(v.reduce(function(p,q){return p+q},0)/v.length):null})();
    var cards=[["Проведено диагностик",H,"месяц · неделя "+Hw,""],["Продажи",S,"месяц · неделя "+Sw,S?"":"bad"],["Конверсия диагностика → продажа",fp(pct(S,H)),norm!=null?"норма 8 недель "+norm+"%":"",pct(S,H)!=null&&norm!=null&&pct(S,H)<norm*0.85?"bad":""],["Качество встреч (ОКК)",quality==null?"—":quality,"средний балл этапов · "+(PAYLOAD.items||[]).length+" разборов",quality!=null&&quality<55?"bad":""]];
    document.getElementById("vit-kpis").innerHTML=cards.map(function(c){return '<div class="kpi"><span class="k">'+c[0]+'</span><span class="v '+c[3]+'">'+c[1]+'</span><span class="n">'+c[2]+'</span></div>'}).join("");
    // слияние по менеджеру: имя из amo = «Имя Фамилия», в ОКК так же
    var okk={};(PAYLOAD.items||[]).forEach(function(d){var k=(d.mgr||"").trim();if(!k)return;var o=okk[k]=okk[k]||{n:0,sc:[],goal:0};o.n++;var v=(d.s||[]).filter(function(x){return typeof x==="number"});if(v.length)o.sc.push(v.reduce(function(p,q){return p+q},0)/v.length);if(d.achieved==="Да")o.goal++});
    function nk(s){return String(s||"").toLowerCase().replace(/ё/g,"е").split(/\s+/).sort().join(" ")}
    var okkByKey={};Object.keys(okk).forEach(function(k){okkByKey[nk(k)]=okk[k]});
    var rows=Object.keys(mgr).map(function(name){var t=mgr[name];return {name:name,hm:sum(t,"l2.held",ms,y),sm:sum(t,"l2.sales",ms,y),h8:sum(t,"l2.held",h8,y),s8:sum(t,"l2.sales",h8,y),q:okkByKey[nk(name)]}}).filter(function(r){return r.h8||r.s8}).sort(function(a,b){return b.h8-a.h8});
    var maxCr=Math.max.apply(null,rows.map(function(r){return pct(r.s8,r.h8)||0}).concat([1]));
    document.querySelector("#merge tbody").innerHTML=rows.map(function(r){var cr=pct(r.s8,r.h8);var q=r.q;var qs=q&&q.sc.length?Math.round(q.sc.reduce(function(p,x){return p+x},0)/q.sc.length):null;
      return '<tr><td>'+esc(r.name)+'</td><td class="num">'+r.hm+'</td><td class="num">'+r.sm+'</td><td class="num">'+fp(pct(r.sm,r.hm))+'</td><td class="num">'+r.h8+'</td><td class="num">'+r.s8+'</td><td class="num"><b>'+fp(cr)+'</b></td><td><div class="bar8"><i style="width:'+Math.round(100*(cr||0)/maxCr)+'%"></i></div></td>'
        +'<td class="num">'+(q?q.n:"—")+'</td><td class="num">'+(qs==null?"—":'<span class="q '+(qs>=75?"ok":qs>=55?"warn":"bad")+'">'+qs+'</span>')+'</td><td class="num">'+(q?Math.round(100*q.goal/q.n)+"%":"—")+'</td></tr>'}).join("")||'<tr><td colspan="11" class="sub">данных нет</td></tr>';
  }).catch(function(e){document.getElementById("vit-kpis").innerHTML='<div class="kpi"><span class="k">Ошибка: '+esc(e.message)+'</span></div>'});
})();
"""


def build_okk():
    """Запуск сборки ОКК во временную папку с нашим шаблоном Второй линии."""
    tmp = tempfile.mkdtemp(prefix="shtab-okk-")
    l2_tpl = os.path.join(tmp, "l2.tpl.html")
    wr(l2_tpl, compose_l2(rd(os.path.join(OKK, "stats.tpl.html")), rd(os.path.join(OKK, "charts.tpl.html"))))
    env = dict(os.environ)
    env["OUT"] = os.path.join(tmp, "meetings.html")
    env["TPL_STATS"] = l2_tpl
    env.setdefault("PYTHONIOENCODING", "utf-8")
    r = subprocess.run([sys.executable, "build_dashboard.py"], cwd=OKK, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:])
        raise SystemExit("сборка ОКК упала")
    print("ОКК:", r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "ок")
    return tmp


SOURCES = [('instagram', 'Инстаграм smm', 'Instagram SMM'), ('telegram', 'Телеграм канал', 'Телеграм-канал'), ('influence', 'Интеграции', 'Инфлюенс'), ('youtube', 'YouTube', 'YouTube'), ('fb', 'Реклама FB', 'Реклама FB'), ('sitechat', 'GitelmanSiteChat', 'Чат на сайте'), ('site', 'Сайт', 'Сайт')]


def build_sources():
    """Страницы источников маркетинга из одного шаблона."""
    tpl = rd(os.path.join(HERE, "site", "src", "source.tpl.html"))
    for slug, src, title in SOURCES:
        page = tpl.replace("{{SRC}}", src).replace("{{TITLE}}", title).replace("{{SLUG}}", slug).replace("{{SECTION}}", "marketing." + slug).replace("{{SEG_TITLE}}", "Эффективность блогеров" if slug == "influence" else "Срезы источника")
        wr(os.path.join(PUB, "marketing", slug, "index.html"), page)
    print("источники маркетинга: %d страниц" % len(SOURCES))
    # площадки сайта: Метрика + лиды по тегу
    wtpl = rd(os.path.join(HERE, "site", "src", "web.tpl.html"))
    for slug, key, title, host, tag in [("main", "site", "Сайт", "gitelman.team", "tilda"), ("journal", "journal", "Журнал", "журнал", "журнал")]:
        page = wtpl.replace("{{TITLE}}", title).replace("{{HOST}}", host).replace("{{KEY}}", key).replace("{{TAG}}", tag)
        wr(os.path.join(PUB, "marketing", "site", slug, "index.html"), page)
    print("площадки сайта: 2 страницы")


def main():
    build_sources()
    tmp = build_okk()
    moves = {  # файл сборки ОКК → адрес на сайте
        "meetings.html": "sales/l2/meetings.html",
        "managers.html": "sales/l2/managers.html",
        "compare.html": "sales/l2/compare.html",
        "stats.html": "sales/l2/index.html",
        "guide.html": "guide.html",
    }
    for src, dst in moves.items():
        p = os.path.join(tmp, src)
        if not os.path.exists(p):
            print("нет файла сборки:", src)
            continue
        t = strip_old(rd(p))
        if dst.startswith("sales/l2/"):
            t = okk_links(t)
        wr(os.path.join(PUB, dst), t)
        print("→", dst, "%d КБ" % (len(t) // 1024))
    shutil.rmtree(tmp, ignore_errors=True)
    # страницы Штаба: меню общее (идемпотентно)
    for rel in ("index.html", "sales/index.html", "sales/l1/index.html", "marketing/index.html", "status.html", "users.html"):
        p = os.path.join(PUB, rel)
        if os.path.exists(p):
            t = rd(p); t2 = strip_old(t)
            if t2 != t:
                wr(p, t2); print("меню:", rel)
    print("готово")


if __name__ == "__main__":
    main()
