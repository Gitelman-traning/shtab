# -*- coding: utf-8 -*-
"""Статьи на сайтах → витрина Штаба: сколько их и сколько проходят проверку качества.

Список статей — sitemap.xml журнала (поток заморожен 23.10.2026) (главная не считается). Каждую статью сборщик открывает и проверяет
по чек-листу CHECKS — то, что видно в коде страницы и важно для поиска и заявок. Без секретов: страницы публичные.
Точки (ptype=day, period = последний день сбора):
  web.articles (dim = площадка) — статей в sitemap; прирост за период считает страница «Сводка по сайтам»;
  web.quality (dim = площадка) — статей, прошедших все проверки;
  web.quality.fail (dim = «площадка|проверка») — статей, не прошедших эту проверку.
"""
import re

import requests

SITEMAPS = {
    "journal": "https://journal.gitelman.team/sitemap.xml",
    # "potok": "https://potok.gitelman.team/sitemap.xml",   # поток заморожен 23.10.2026
}
MIN_WORDS = 800


def _text(html):
    html = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", html)
    return re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", " ", html))


# название проверки → функция(html) → True, если пройдена
CHECKS = {
    "title до 70 знаков": lambda h: bool(re.search(r"(?is)<title>\s*([^<]{10,70}?)\s*</title>", h)),
    "meta description": lambda h: bool(re.search(r"""(?i)<meta\s+name=["']description["']\s+content=["'][^"']{50,}""", h)),
    "один H1": lambda h: len(re.findall(r"(?i)<h1[\s>]", h)) == 1,
    "canonical": lambda h: bool(re.search(r"""(?i)<link\s+rel=["']canonical["']""", h)),
    "разметка schema.org": lambda h: "application/ld+json" in h.lower(),
    "картинки с alt": lambda h: all(re.search(r"(?i)\balt=", t) for t in re.findall(r"(?i)<img\b[^>]*>", re.sub(r"(?is)<noscript\b.*?</noscript>", "", h))),
    "кнопка диагностики": lambda h: bool(re.search(r"(?i)cta-button|utm_medium=cta_button|диагностик", h)),
    "от %d слов" % MIN_WORDS: lambda h: len(_text(h).split()) >= MIN_WORDS,
}


def articles_points(day, log=print):
    points, d = [], day.isoformat()
    for key, url in SITEMAPS.items():
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
        except Exception as e:      # один сайт недоступен — остальные всё равно считаем
            log("статьи %s: ошибка %s" % (key, e))
            continue
        locs = [u.strip() for u in re.findall(r"<loc>([^<]+)</loc>", r.text)]
        pages = [u for u in locs if u.rstrip("/").count("/") > 2]   # без главной
        points.append({"metric": "web.articles", "ptype": "day", "period": d, "dim": key, "value": len(pages)})
        ok, fails, checked = 0, {c: 0 for c in CHECKS}, 0
        for u in pages:
            try:
                h = requests.get(u, timeout=30).text
            except Exception as e:
                log("статьи %s: %s не открылась (%s)" % (key, u, e))
                continue
            checked += 1
            bad = [c for c, f in CHECKS.items() if not f(h)]
            for c in bad:
                fails[c] += 1
            ok += not bad
        if checked:
            points.append({"metric": "web.quality", "ptype": "day", "period": d, "dim": key, "value": ok})
            points += [{"metric": "web.quality.fail", "ptype": "day", "period": d, "dim": key + "|" + c, "value": n} for c, n in fails.items()]
        log("статьи %s: %d, проверку прошли %d из %d" % (key, len(pages), ok, checked))
    return points
