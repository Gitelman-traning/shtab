# -*- coding: utf-8 -*-
"""Поисковая выдача → витрина Штаба: показы, клики и позиция сайтов в Google (Search Console) и Яндексе (Вебмастер).

Google: сервисный аккаунт из GOOGLE_SERVICE_ACCOUNT_JSON (тот же, что читает таблицы) — его почту надо добавить
пользователем в Search Console (право «Ограниченный» хватает). Яндекс: YANDEX_WEBMASTER_TOKEN — OAuth-токен с правом
webmaster:read. Без доступа источник пропускается, сбор не падает.
Точки (dim = «площадка|google» или «площадка|yandex»):
  web.serp.impr / web.serp.clicks / web.serp.pos — показы, клики, средняя позиция за день;
  web.serp.q / web.serp.q10 — сколько запросов с показами за последние 28 дней и сколько из них в топ-10 (снимок на день сбора);
  web.kw (dim = «google|запрос» / «yandex|запрос») — позиция по ключевым запросам из keywords.txt за 28 дней (снимок).
"""
import datetime as dt
import io
import json
import os

import requests

# potok.gitelman.team заморожен 23.10.2026 — его показы и запросы не считаем (вернуть: "potok.gitelman.team": "potok")
HOSTS = {"gitelman.team": "site", "journal.gitelman.team": "journal"}
WM = "https://api.webmaster.yandex.net/v4"


def _keywords():
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, "keywords.txt")
    if not os.path.exists(p):
        return []
    return [l.strip().lower() for l in io.open(p, encoding="utf-8") if l.strip() and not l.startswith("#")]


def _host(url):
    h = url.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0].lower()
    return HOSTS.get(h[4:] if h.startswith("www.") else h)


def _snapshot(points, engine, day, queries):
    """queries: {площадка: {запрос: (показы, позиция)}} за 28 дней → q, q10 и позиции ключевых запросов."""
    kw = set(_keywords())
    best = {}
    for key, qs in queries.items():
        points.append({"metric": "web.serp.q", "ptype": "day", "period": day, "dim": key + "|" + engine, "value": len(qs)})
        points.append({"metric": "web.serp.q10", "ptype": "day", "period": day, "dim": key + "|" + engine,
                       "value": sum(1 for _, pos in qs.values() if pos <= 10)})
        for q, (_, pos) in qs.items():
            if q in kw and (q not in best or pos < best[q]):
                best[q] = pos
    for q, pos in best.items():
        points.append({"metric": "web.kw", "ptype": "day", "period": day, "dim": engine + "|" + q, "value": round(pos, 1)})


def gsc_points(day_from, day_to, log=print):
    sa = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if not sa:
        log("Search Console: нет GOOGLE_SERVICE_ACCOUNT_JSON — пропуск")
        return []
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    creds = Credentials.from_service_account_info(json.loads(sa), scopes=["https://www.googleapis.com/auth/webmasters.readonly"])
    svc = build("searchconsole", "v1", credentials=creds, cache_discovery=False)
    sites = [s["siteUrl"] for s in svc.sites().list().execute().get("siteEntry", []) if s.get("permissionLevel") != "siteUnverifiedUser"]
    dom = [s for s in sites if s == "sc-domain:gitelman.team"]
    props = dom or [s for s in sites if _host(s)]
    if not props:
        log("Search Console: сервисному аккаунту не открыт ни один из сайтов — добавьте %s пользователем в Search Console"
            % json.loads(sa).get("client_email", "?"))
        return []

    def rows(prop, dims, d1, d2):
        out, start = [], 0
        while True:
            body = {"startDate": d1.isoformat(), "endDate": d2.isoformat(), "dimensions": dims, "rowLimit": 25000, "startRow": start}
            r = svc.searchanalytics().query(siteUrl=prop, body=body).execute().get("rows", [])
            out.extend(r)
            if len(r) < 25000:
                return out
            start += 25000

    day = {}       # (площадка, дата) → [показы, клики, позиция×показы]
    for prop in props:
        for r in rows(prop, ["date", "page"], day_from, day_to):
            key = _host(r["keys"][1])
            if not key:
                continue
            a = day.setdefault((key, r["keys"][0]), [0, 0, 0.0])
            a[0] += r["impressions"]; a[1] += r["clicks"]; a[2] += r["position"] * r["impressions"]
    points = []
    for (key, d), (im, cl, ps) in day.items():
        dim = key + "|google"
        points += [{"metric": "web.serp.impr", "ptype": "day", "period": d, "dim": dim, "value": im},
                   {"metric": "web.serp.clicks", "ptype": "day", "period": d, "dim": dim, "value": cl}]
        if im:
            points.append({"metric": "web.serp.pos", "ptype": "day", "period": d, "dim": dim, "value": round(ps / im, 1)})
    queries = {}
    for prop in props:
        for r in rows(prop, ["page", "query"], day_to - dt.timedelta(days=27), day_to):
            key = _host(r["keys"][0])
            if not key:
                continue
            q = r["keys"][1].lower()
            im, pos = queries.setdefault(key, {}).get(q, (0, 0.0))
            queries[key][q] = (im + r["impressions"], (pos * im + r["position"] * r["impressions"]) / (im + r["impressions"]) if im + r["impressions"] else 0)
    _snapshot(points, "google", day_to.isoformat(), queries)
    log("Search Console (%s): точек %d" % (", ".join(props), len(points)))
    return points


def webmaster_points(day_from, day_to, log=print):
    token = os.environ.get("YANDEX_WEBMASTER_TOKEN", "").strip()
    if not token:
        log("Вебмастер: нет YANDEX_WEBMASTER_TOKEN — пропуск")
        return []
    h = {"Authorization": "OAuth " + token}

    def get(path, **params):
        r = requests.get(WM + path, headers=h, params=params, timeout=60)
        r.raise_for_status()
        return r.json()

    uid = get("/user")["user_id"]
    points, queries = [], {}
    for host in get("/user/%s/hosts" % uid).get("hosts", []):
        key = _host(host.get("ascii_host_url") or host.get("unicode_host_url") or "")
        if not key or not host.get("verified"):
            continue
        base = "/user/%s/hosts/%s/search-queries" % (uid, host["host_id"])
        hist = get(base + "/all/history", query_indicator=["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION"],
                   date_from=day_from.isoformat(), date_to=day_to.isoformat()).get("indicators", {})
        for ind, metric in (("TOTAL_SHOWS", "web.serp.impr"), ("TOTAL_CLICKS", "web.serp.clicks"), ("AVG_SHOW_POSITION", "web.serp.pos")):
            for p in hist.get(ind, []):
                points.append({"metric": metric, "ptype": "day", "period": p["date"][:10], "dim": key + "|yandex",
                               "value": round(p["value"], 1) if metric == "web.serp.pos" else p["value"]})
        pop = get(base + "/popular", order_by="TOTAL_SHOWS", query_indicator=["TOTAL_SHOWS", "AVG_SHOW_POSITION"], limit=500,
                  date_from=(day_to - dt.timedelta(days=27)).isoformat(), date_to=day_to.isoformat())
        for q in pop.get("queries", []):
            ind = q.get("indicators", {})
            if ind.get("TOTAL_SHOWS"):
                queries.setdefault(key, {})[q["query_text"].lower()] = (ind["TOTAL_SHOWS"], ind.get("AVG_SHOW_POSITION") or 100)
    _snapshot(points, "yandex", day_to.isoformat(), queries)
    log("Вебмастер: точек %d" % len(points))
    return points
