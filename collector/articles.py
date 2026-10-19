# -*- coding: utf-8 -*-
"""Сколько статей на сайтах → витрина Штаба: снимок числа страниц в sitemap.xml журнала и потока.

Точка: web.articles (dim = площадка, ptype=day, period = последний день сбора). Главная страница не считается.
Прирост за период — разница снимков, её считает страница «Сводка по сайтам». Без секретов: sitemap публичный.
"""
import re

import requests

SITEMAPS = {
    "journal": "https://journal.gitelman.team/sitemap.xml",
    "potok": "https://potok.gitelman.team/sitemap.xml",
}


def articles_points(day, log=print):
    points = []
    for key, url in SITEMAPS.items():
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
        except Exception as e:      # один сайт недоступен — остальные всё равно считаем
            log("статьи %s: ошибка %s" % (key, e))
            continue
        locs = [u.strip() for u in re.findall(r"<loc>([^<]+)</loc>", r.text)]
        n = len([u for u in locs if u.rstrip("/").count("/") > 2])   # без главной
        log("статьи %s: %d" % (key, n))
        points.append({"metric": "web.articles", "ptype": "day", "period": day.isoformat(), "dim": key, "value": n})
    return points
