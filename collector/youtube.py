#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YouTube-сделки из amo → Штаб (Маркетинг → YouTube → Сделки и выручка), таблицы yt_leads и yt_paid (schema38.sql).

YouTube-сделка — поле «Источник» (1439087) = YouTube или SHORTS Youtube, сделка создана с 26.07.2025.
Фильтра по полю у amo v4 нет, поэтому листаем сделки и отбираем сами (только GET):
  MODE=inc  (ночью)   — сделки, изменённые за последние DAYS дней (по умолчанию 3): новые, сменившие этап или источник;
                        сделки, у которых источник больше не YouTube, удаляются из витрины;
  MODE=full (вручную) — все сделки с 26.07.2025, витрина заливается заново (~70 тыс. сделок, ~25 минут).
Оплаты Второй линии (9701010 и архивная 8733518, статус 142) — каждый запуск целиком, любые источники:
страница считает «через контакт» — оплаты контактов, у которых есть хоть одна YouTube-сделка.

Переменные окружения:
  AMO_TOKEN_REPORTS (или AMO_TOKEN) — токен amo, только чтение
  SHTAB_URL, SHTAB_TOKEN            — адрес витрины и токен сборщика (без них — только файл youtube.local.json)
  MODE, DAYS                        — см. выше
"""

import datetime as dt
import json
import os
import sys
import time

import requests

MSK = dt.timezone(dt.timedelta(hours=3))
AMO = "https://pavelgitelman.amocrm.ru/api/v4"
# Токен интеграции Team_Training_Reports (отчёты, только чтение); AMO_TOKEN — общий запасной вариант, см. DOPPLER.md.
TOKEN = (os.environ.get("AMO_TOKEN_REPORTS") or os.environ.get("AMO_TOKEN", "")).strip().lstrip("﻿")
if TOKEN[:7].lower() == "bearer ":
    TOKEN = TOKEN[7:].strip()
URL = os.environ.get("SHTAB_URL", "").rstrip("/")
STOKEN = os.environ.get("SHTAB_TOKEN", "").strip()
MODE = (os.environ.get("MODE") or "inc").strip().lower()
DAYS = int(os.environ.get("DAYS") or 3)

SINCE = int(dt.datetime(2025, 7, 26, tzinfo=MSK).timestamp())   # начало окна YouTube-дашборда
F_SRC = 1439087
YT_ENUMS = {1218221: "YouTube", 1229449: "SHORTS Youtube"}
F_UTM = {453161: "utm_source", 453157: "utm_medium", 453159: "utm_campaign", 453155: "utm_content"}
L1, L2 = 8733326, (9701010, 8733518)   # Первая линия; Вторая линия (действующая и архивная)
WON = 142


def log(*a):
    print(*a, flush=True)


def get(path, params=None, tries=6):
    last = None
    for a in range(tries):
        try:
            r = requests.get(AMO + path, headers={"Authorization": "Bearer " + TOKEN}, params=params, timeout=90)
        except requests.RequestException as e:
            last = e
            time.sleep(3 + 3 * a)
            continue
        if r.status_code == 204:
            return {}
        if r.status_code == 200:
            return r.json()
        if r.status_code == 401:
            sys.exit("amo 401: токен не принят")
        last = "%s %s" % (r.status_code, r.text[:120])
        time.sleep(1.5 + 2 * a)
    raise RuntimeError("amo не ответил: %s %s (%s)" % (path, params, last))


def leads(params, label=""):
    """все страницы /leads с контактами; amo отдаёт по 250"""
    page, n = 1, 0
    while True:
        j = get("/leads", dict(params, limit=250, page=page, **{"with": "contacts"}))
        ls = (j.get("_embedded") or {}).get("leads") or []
        n += len(ls)
        yield from ls
        if page % 40 == 0:
            log("  %s: страниц %d, сделок %d" % (label, page, n))
        if len(ls) < 250 or not (j.get("_links") or {}).get("next"):
            break
        page += 1
        time.sleep(0.2)


def main_contact(l):
    cs = (l.get("_embedded") or {}).get("contacts") or []
    m = [c for c in cs if c.get("is_main")] or cs
    return m[0]["id"] if m else None


def yt_row(l):
    """сделка amo → строка yt_leads, или None, если источник не YouTube"""
    cf = {c["field_id"]: c.get("values") or [] for c in l.get("custom_fields_values") or []}
    src = next((YT_ENUMS[v.get("enum_id")] for v in cf.get(F_SRC, []) if v.get("enum_id") in YT_ENUMS), None)
    if not src:
        return None
    r = {"id": l["id"], "created_at": l["created_at"], "closed_at": l.get("closed_at"), "pipeline_id": l["pipeline_id"],
         "status_id": l["status_id"], "price": int(l.get("price") or 0), "contact_id": main_contact(l), "src": src}
    for fid, k in F_UTM.items():
        r[k] = "; ".join(str(v.get("value") or "").strip() for v in cf.get(fid, []) if str(v.get("value") or "").strip())[:120]
    tags = [t.get("name") or "" for t in (l.get("_embedded") or {}).get("tags") or []]
    # номер канала Wazzup — номер компании, не клиента; телефонов клиентов в витрине нет
    r["channel"] = next((t for t in tags if t.startswith("WZ")), "")[:120]
    r["meeting"] = int(l["pipeline_id"] == L1 and l["status_id"] == WON)
    r["paid"] = int(l["pipeline_id"] in L2 and l["status_id"] == WON)
    return r


def paid_rows():
    params = {"filter[created_at][from]": SINCE}
    for i, p in enumerate(L2):
        params["filter[statuses][%d][pipeline_id]" % i] = p
        params["filter[statuses][%d][status_id]" % i] = WON
    return [{"id": l["id"], "contact_id": main_contact(l), "pipeline_id": l["pipeline_id"], "price": int(l.get("price") or 0),
             "created_at": l["created_at"], "closed_at": l.get("closed_at")} for l in leads(params, "оплаты Второй линии")]


def send(body):
    if not (URL and STOKEN):
        return
    r = requests.post(URL + "/api/ingest", headers={"Authorization": "Bearer " + STOKEN}, json=body, timeout=180)
    if r.status_code != 200:
        raise RuntimeError("витрина ответила %s: %s" % (r.status_code, r.text[:200]))


def main():
    if not TOKEN:
        sys.exit("нет AMO_TOKEN_REPORTS")
    if MODE not in ("inc", "full"):
        sys.exit("MODE: inc | full")
    started = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = {"filter[created_at][from]": SINCE}
    if MODE == "inc":
        params["filter[updated_at][from]"] = int(time.time()) - DAYS * 86400
    log("режим %s%s" % (MODE, " (изменённые за %d дн.)" % DAYS if MODE == "inc" else ""))
    rows, drop, seen = [], [], 0
    for l in leads(params, "сделки"):
        seen += 1
        r = yt_row(l)
        if r:
            rows.append(r)
        elif MODE == "inc":
            drop.append(l["id"])
    paid = paid_rows()
    log("просмотрено сделок: %d, YouTube: %d (встреч %d, оплат %d), оплат Второй линии всего: %d"
        % (seen, len(rows), sum(r["meeting"] for r in rows), sum(r["paid"] for r in rows), len(paid)))
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "youtube.local.json"), "w", encoding="utf-8") as f:
        json.dump({"mode": MODE, "yt_leads": rows, "yt_paid": paid}, f, ensure_ascii=False)
    if not (URL and STOKEN):
        log("SHTAB_URL/SHTAB_TOKEN не заданы — записан только youtube.local.json")
        return
    # пачками: витрина пишет в D1 кусками, большой запрос не нужен
    for i in range(0, max(len(rows), 1), 500):
        send({"collector": "amo-youtube", "yt_leads": rows[i:i + 500], "yt_reset": MODE == "full" and i == 0})
    for i in range(0, len(drop), 2000):
        send({"collector": "amo-youtube", "yt_drop": drop[i:i + 2000]})
    send({"collector": "amo-youtube", "yt_paid": {"replace": True, "rows": paid}, "finalize": True, "started": started,
          "total_points": len(rows) + len(paid), "run_note": "%s: YouTube-сделок %d, оплат Второй линии %d" % (MODE, len(rows), len(paid))})
    log("отправлено в витрину")


if __name__ == "__main__":
    main()
