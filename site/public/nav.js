/* Общее меню Штаба: аккордеон по отделам, активный пункт по адресу, виджет аккаунта в шапке.
   На странице: <aside class="side" id="side"></aside> внутри .layout и <script src="/nav.js"></script> в конце body. */
(function () {
  var I = {
    hub: '<svg viewBox="0 0 20 20"><path d="M3 3h6v6H3V3zM11 3h6v4h-6V3zM11 9h6v8h-6V9zM3 11h6v6H3v-6z" stroke-linejoin="round"/></svg>',
    sales: '<svg viewBox="0 0 20 20"><path d="M3 16l4-6 3 3 3-5 4 2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 4v12h14" stroke-linecap="round"/></svg>',
    mkt: '<svg viewBox="0 0 20 20"><path d="M3 8v4h3l6 4V4L6 8H3z" stroke-linejoin="round"/><path d="M15 7a4 4 0 010 6" stroke-linecap="round"/></svg>',
    help: '<svg viewBox="0 0 20 20"><path d="M4 4h5a2 2 0 012 2v10a2 2 0 00-2-2H4V4zM16 4h-5a2 2 0 00-2 2v10a2 2 0 012-2h5V4z" stroke-linejoin="round"/></svg>',
    db: '<svg viewBox="0 0 20 20"><ellipse cx="10" cy="5" rx="6" ry="2.4"/><path d="M4 5v10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4"/></svg>',
    gear: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" stroke-linecap="round"/></svg>',
    tag: '<svg viewBox="0 0 20 20"><path d="M3 4h6l8 8-6 6-8-8z" stroke-linejoin="round"/><circle cx="7" cy="8" r="1.2"/></svg>',
    users: '<svg viewBox="0 0 20 20"><circle cx="10" cy="7" r="3.2"/><path d="M4 17c.8-3.2 3.2-4.8 6-4.8s5.2 1.6 6 4.8" stroke-linecap="round"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 20 20"><path d="M7 8l3 3 3-3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  // дерево разделов; href — чистые адреса (Cloudflare Pages убирает .html)
  var TREE = [
    { name: "Общий экран", href: "/", icon: I.hub, sec: "hub" },
    { id: "sales", name: "Отдел продаж", icon: I.sales, href: "/sales/", sec: "sales", children: [
      { name: "Сводка отдела", href: "/sales/", sec: "sales" },
      { name: "Первая линия", href: "/sales/l1/", sec: "sales.l1", children: [
        { name: "Менеджеры", href: "/sales/l1/managers", sec: "sales.l1" }
      ] },
      { name: "Вторая линия", href: "/sales/l2/", sec: "sales.l2", children: [
        { name: "Встречи", href: "/sales/l2/meetings", sec: "sales.l2.okk" },
        { name: "Менеджеры", href: "/sales/l2/managers", sec: "sales.l2.okk" },
        { name: "Сверка", href: "/sales/l2/compare", sec: "sales.l2.okk" }
      ] }
    ] },
    { id: "mkt", name: "Маркетинг", icon: I.mkt, href: "/marketing/", sec: "marketing", children: [
      { name: "Сводка по источникам", href: "/marketing/", sec: "marketing" },
      { name: "Instagram SMM", href: "/marketing/instagram/", sec: "marketing.instagram" },
      { name: "Телеграм-канал", href: "/marketing/telegram/", sec: "marketing.telegram" },
      { name: "Инфлюенс", href: "/marketing/influence/", sec: "marketing.influence", children: [
        { name: "Менеджеры", href: "/marketing/influence/managers/", sec: "marketing.influence" }
      ] },
      { name: "YouTube", href: "/marketing/youtube/", sec: "marketing.youtube" },
      { name: "Реклама FB", href: "/marketing/fb/", sec: "marketing.fb" },
      { name: "Чат на сайте", href: "/marketing/sitechat/", sec: "marketing.sitechat" },
      { name: "Сайт", href: "/marketing/site/", sec: "marketing.site", children: [
        { name: "Сайт gitelman.team", href: "/marketing/site/main/", sec: "marketing.site" },
        { name: "Журнал", href: "/marketing/site/journal/", sec: "marketing.site" }
      ] }
    ] },
    { id: "help", name: "Справка", icon: I.help, children: [
      { name: "Гайд и вопросы", href: "/guide", icon: I.help, sec: "guide" },
      { name: "Витрина", href: "/status", icon: I.db, sec: "status" }
    ] },
    { id: "settings", name: "Настройки", icon: I.gear, admin: true, children: [
      { name: "Пользователи", href: "/users", icon: I.users, admin: true, sec: "users" },
      { name: "Теги", href: "/tags", icon: I.tag, admin: true, sec: "tags" }
    ] }
  ];

  var css = ".side{width:224px;flex:none;background:var(--card);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:2px;padding:16px 10px 14px;overflow:hidden auto;transition:width .16s ease;position:sticky;top:0;height:100vh}"
    + ":root[data-menu=mini] .side{width:64px}"
    + ".side .brand{display:flex;align-items:center;gap:11px;padding:4px 8px 14px;min-width:0;text-decoration:none;color:inherit}"
    + ".side .mark{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:9px;background:var(--gold-soft);color:var(--gold);font-weight:700;font-size:12px}"
    + ".side .brand b{display:block;font-size:13.5px;font-weight:600;white-space:nowrap}.side .brand span{display:block;font-size:11.5px;color:var(--faint);white-space:nowrap}"
    + ".side nav{display:flex;flex-direction:column;gap:2px}"
    + ".side .it{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;color:var(--dim);text-decoration:none;font-size:13.5px;white-space:nowrap;cursor:pointer;border:0;background:none;font-family:inherit;width:100%;text-align:left}"
    + ".side .it:hover{background:var(--soft);color:var(--ink)}.side .it.on{background:var(--gold-soft);color:var(--gold);font-weight:600}"
    + ".side .it svg{flex:none;width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6}"
    + ".side .it .chev{margin-left:auto;width:14px;height:14px;transition:transform .16s}.side .grp[aria-expanded=false] .chev{transform:rotate(-90deg)}"
    + ".side .grp{font-weight:600;color:var(--ink)}.side .grp.cur{color:var(--gold)}"
    + ".side .sub{display:flex;flex-direction:column;gap:1px}.side .sub[hidden]{display:none}"
    + ".side .l1{padding-left:26px;font-size:13px}.side .l2{padding-left:42px;font-size:12.5px}"
    + ".side .l1 i,.side .l2 i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.5;flex:none;margin:0 5px}"
    + ".side .grow{flex:1}"
    + ".side .collapse{display:flex;align-items:center;gap:11px;padding:10px;border-radius:9px;background:none;border:0;color:var(--faint);font-family:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;width:100%;text-align:left}"
    + ".side .collapse svg{flex:none;width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6;transition:transform .16s}:root[data-menu=mini] .side .collapse svg{transform:rotate(180deg)}"
    + ":root[data-menu=mini] .side .brand b,:root[data-menu=mini] .side .brand span,:root[data-menu=mini] .side .it span,:root[data-menu=mini] .side .chev,:root[data-menu=mini] .side .sub,:root[data-menu=mini] .side .collapse span{display:none}"
    + ":root[data-menu=mini] .side .it{justify-content:center;padding:11px 0}"
    + "@media (max-width:760px){.side{position:fixed;left:0;top:0;bottom:0;width:272px;height:100vh;z-index:60;transform:translateX(-100%);transition:transform .18s ease;box-shadow:none}"
    + ":root[data-nav=open] .side{transform:none;box-shadow:0 12px 40px rgba(0,0,0,.35)}.side .collapse{display:none}"
    + ".nav-burger{position:fixed;left:10px;top:10px;z-index:59;width:40px;height:40px;border-radius:11px;border:1px solid var(--line-2);background:var(--card);color:var(--ink);display:grid;place-items:center;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.08)}"
    + ".nav-burger svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.8}.nav-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:58;display:none}:root[data-nav=open] .nav-backdrop{display:block}"
    + "header{padding-left:62px}.pane header .crumbs{padding-left:0}"
    + ".side nav .grp,.side nav .it{display:flex!important;justify-content:flex-start!important;padding:9px 10px!important}.side nav .it span,.side .it span,.side .txt{display:inline!important}.side .brand .txt,.side .brand b,.side .brand span{display:block!important}.side .chev{display:inline-block!important}.side .sub{display:flex!important}.side .sub[hidden],.side [data-admin][hidden],.side a[hidden],.side button[hidden]{display:none!important}}"
    + "@media (min-width:761px){.nav-burger,.nav-backdrop{display:none}}"
    + ".acct{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dim);margin-left:8px;white-space:nowrap}.acct b{color:var(--ink);font-weight:600}.acct a{color:var(--gold);text-decoration:none;padding:4px 9px;border-radius:7px;background:var(--gold-soft);font-weight:600}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function norm(p) { p = p.replace(/\.html$/, "").replace(/\/index$/, "/"); if (p === "/index") p = "/"; return p; }
  var here = norm(location.pathname);
  function isHere(href) { return href && norm(href) === here; }
  function contains(node) { if (isHere(node.href)) return true; return (node.children || []).some(contains); }

  var KEY = "shtab-nav";
  function stored() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
  function store(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }

  function item(node, level) {
    var cls = "it" + (level === 1 ? " l1" : level === 2 ? " l2" : "") + (isHere(node.href) ? " on" : "");
    var ic = level ? "<i></i>" : (node.icon || "");
    var h = '<a class="' + cls + '" href="' + esc(node.href) + '"' + (node.admin ? ' data-admin hidden' : '') + (node.sec ? ' data-sec="' + node.sec + '"' : '') + '>' + ic + '<span>' + esc(node.name) + '</span></a>';
    if (node.children) h += '<div class="sub">' + node.children.map(function (c) { return item(c, level + 1); }).join("") + '</div>';
    return h;
  }
  function group(node) {
    // аккордеон: раскрыт текущий отдел или тот, что открыли руками
    var open = contains(node) || stored()[node.id] === true;
    var h = '<button type="button" class="it grp' + (contains(node) ? " cur" : "") + '" data-grp="' + node.id + '"' + (node.sec ? ' data-sec="' + node.sec + '"' : '') + ' aria-expanded="' + open + '">' + (node.icon || "") + '<span>' + esc(node.name) + '</span>' + I.chev + '</button>';
    h += '<div class="sub" data-sub="' + node.id + '"' + (open ? "" : " hidden") + '>' + node.children.map(function (c) { return item(c, 1); }).join("") + '</div>';
    return node.admin ? '<div data-admin hidden>' + h + '</div>' : h;
  }

  var side = document.getElementById("side");
  if (side) {
    side.innerHTML = '<a class="brand" href="/"><div class="mark">12</div><div><b>Штаб</b><span>центр компании</span></div></a><nav>'
      + TREE.map(function (n) { return n.children && n.id ? group(n) : item(n, 0); }).join("")
      + '</nav><div class="grow"></div><button type="button" class="collapse" id="menu-toggle"><svg viewBox="0 0 20 20"><path d="M12 5l-5 5 5 5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Свернуть меню</span></button>';
    side.addEventListener("click", function (e) {
      var g = e.target.closest("button[data-grp]");
      if (g) {
        var id = g.getAttribute("data-grp"), sub = side.querySelector('[data-sub="' + id + '"]');
        var open = g.getAttribute("aria-expanded") !== "true";
        g.setAttribute("aria-expanded", open); sub.hidden = !open;
        var s = stored(); s[id] = open; store(s);
        if (document.documentElement.getAttribute("data-menu") === "mini") { document.documentElement.setAttribute("data-menu", "full"); try { localStorage.setItem("okk-menu", "full"); } catch (x) {} }
      }
    });
  }
  // мобильный экран: кнопка-бургер и выезжающее меню; узкий режим (mini) на телефоне не используется
  var mobile = window.matchMedia("(max-width:760px)");
  if (side) {
    var burger = document.createElement("button"); burger.type = "button"; burger.className = "nav-burger"; burger.setAttribute("aria-label", "Меню");
    burger.innerHTML = '<svg viewBox="0 0 20 20"><path d="M3 5h14M3 10h14M3 15h14" stroke-linecap="round"/></svg>';
    var back = document.createElement("div"); back.className = "nav-backdrop";
    document.body.appendChild(burger); document.body.appendChild(back);
    var setOpen = function (o) { if (o) document.documentElement.setAttribute("data-nav", "open"); else document.documentElement.removeAttribute("data-nav"); };
    burger.addEventListener("click", function () { setOpen(document.documentElement.getAttribute("data-nav") !== "open"); });
    back.addEventListener("click", function () { setOpen(false); });
    side.addEventListener("click", function (e) { if (e.target.closest("a") && mobile.matches) setOpen(false); });
  }
  // свёрнутое меню — общий ключ с прежними страницами
  (function () { var m = null; try { m = localStorage.getItem("okk-menu"); } catch (e) {} document.documentElement.setAttribute("data-menu", mobile.matches ? "full" : (m || "full"));
    mobile.addEventListener && mobile.addEventListener("change", function (ev) { if (ev.matches) document.documentElement.setAttribute("data-menu", "full"); });
    var b = document.getElementById("menu-toggle"); if (b) b.addEventListener("click", function () { var n = document.documentElement.getAttribute("data-menu") === "mini" ? "full" : "mini"; try { localStorage.setItem("okk-menu", n); } catch (e) {} document.documentElement.setAttribute("data-menu", n); }); })();

  // кто вошёл: пункты для админа и виджет в шапке
  fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (m) {
    var u = m && m.ok && m.user;
    if (u && u.role === "admin") document.querySelectorAll("[data-admin]").forEach(function (a) { a.hidden = false; });
    // закрытые разделы убираем из меню (уровень 0); группа без единого открытого пункта тоже прячется
    var P = (u && u.perms) || {};
    document.querySelectorAll("[data-sec]").forEach(function (el) { var s = el.getAttribute("data-sec"); if (P[s] === 0) el.hidden = true; });
    document.querySelectorAll("button[data-grp]").forEach(function (g) { var sub = side.querySelector('[data-sub="' + g.getAttribute("data-grp") + '"]'); if (sub && ![].some.call(sub.querySelectorAll("a"), function (a) { return !a.hidden; })) { g.hidden = true; sub.hidden = true; } });
    var h = document.querySelector("header"); if (!h || document.querySelector(".acct")) return;
    var R = { admin: "администратор", head: "руководитель", member: "сотрудник", viewer: "смотрит" };
    var d = document.createElement("div"); d.className = "acct";
    d.innerHTML = (u && u.personal) ? "<span><b>" + esc(u.name || u.login) + "</b> · " + esc(R[u.role] || u.role) + "</span><a href=\"/__logout\">Выйти</a>"
      : "<span>общий вход</span><a href=\"/__logout\">Войти под своим именем</a>";
    h.appendChild(d);
  }).catch(function () {});
})();
