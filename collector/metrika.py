# -*- coding: utf-8 -*-
"""Яндекс Метрика → витрина Штаба: визиты, посетители и источники трафика по площадкам (сайт, журнал).

Переменные окружения: METRIKA_TOKEN (OAuth-токен Яндекса с правом metrika:read),
METRIKA_COUNTERS — JSON {"site": 12345678, "journal": 87654321} (ключ площадки → номер счётчика).
Точки: web.visits / web.users (dim = площадка), web.src (dim = «площадка|тип источника»),
web.eng (dim = «площадка|источник подробно», например «site|Google» или «journal|instagram.com»).
"""
import datetime as dt
import json
import os
import time

import requests

API = "https://api-metrika.yandex.net/stat/v1/data"
SRC_NAMES = {
    "organic": "поиск", "direct": "прямые заходы", "referral": "переходы с сайтов", "social": "соцсети", "ad": "реклама",
    "internal": "внутренние переходы", "recommend": "рекомендательные системы", "messenger": "мессенджеры",
    "saved": "сохранённые страницы", "email": "почтовые рассылки", "qr": "QR-коды", "undefined": "не определено",
}


def _get(token, params, tries=3):
    for i in range(tries):
        r = requests.get(API, params=params, headers={"Authorization": "OAuth " + token}, timeout=60)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(2 + i * 3)
            continue
        if r.status_code >= 400:
            raise RuntimeError("Метрика %s: %s" % (r.status_code, r.text[:200]))
        return r.json()
    raise RuntimeError("Метрика не ответила после %d попыток" % tries)


def _rows(token, counter, dims, metrics, d1, d2):
    out = []
    offset = 1
    while True:
        j = _get(token, {"ids": counter, "dimensions": dims, "metrics": metrics, "date1": d1.isoformat(), "date2": d2.isoformat(),
                         "limit": 10000, "offset": offset, "accuracy": "full"})
        data = j.get("data", [])
        out.extend(data)
        if len(data) < 10000:
            return out
        offset += 10000


def metrika_points(day_from, day_to, log=print):
    token = os.environ.get("METRIKA_TOKEN", "").strip()
    counters = os.environ.get("METRIKA_COUNTERS", "").strip()
    if not token or not counters:
        log("Метрика: METRIKA_TOKEN / METRIKA_COUNTERS не заданы — пропуск")
        return []
    counters = json.loads(counters)
    points = []
    for key, cid in counters.items():
        # визиты и посетители по дням
        for row in _rows(token, cid, "ym:s:date", "ym:s:visits,ym:s:users", day_from, day_to):
            d = row["dimensions"][0]["name"]
            v, u = row["metrics"]
            points.append({"metric": "web.visits", "ptype": "day", "period": d, "dim": key, "value": v})
            points.append({"metric": "web.users", "ptype": "day", "period": d, "dim": key, "value": u})
        # тип источника (последний значимый)
        for row in _rows(token, cid, "ym:s:date,ym:s:lastTrafficSource", "ym:s:visits", day_from, day_to):
            d = row["dimensions"][0]["name"]
            src = row["dimensions"][1].get("id") or row["dimensions"][1].get("name") or "undefined"
            points.append({"metric": "web.src", "ptype": "day", "period": d, "dim": key + "|" + SRC_NAMES.get(src, src), "value": row["metrics"][0]})
        # источник подробно: поисковик, соцсеть, сайт-реферер, рекламная система
        for row in _rows(token, cid, "ym:s:date,ym:s:lastSourceEngine", "ym:s:visits", day_from, day_to):
            d = row["dimensions"][0]["name"]
            eng = row["dimensions"][1].get("name") or "не определено"
            points.append({"metric": "web.eng", "ptype": "day", "period": d, "dim": key + "|" + eng, "value": row["metrics"][0]})
        # дни без визитов — нулём, чтобы графики не рвались
        have = {p["period"] for p in points if p["metric"] == "web.visits" and p["dim"] == key}
        d = day_from
        while d <= day_to:
            if d.isoformat() not in have:
                points.append({"metric": "web.visits", "ptype": "day", "period": d.isoformat(), "dim": key, "value": 0})
                points.append({"metric": "web.users", "ptype": "day", "period": d.isoformat(), "dim": key, "value": 0})
            d += dt.timedelta(days=1)
        log("Метрика %s (%s): точек %d" % (key, cid, sum(1 for p in points if p["dim"].startswith(key))))
    return points


if __name__ == "__main__":
    today = dt.date.today()
    pts = metrika_points(today - dt.timedelta(days=7), today - dt.timedelta(days=1))
    print(len(pts), "точек")
    for p in pts[:12]:
        print(p)
