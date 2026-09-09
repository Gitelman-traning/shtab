#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборщик витрины Штаба из выгрузки amoCRM.

Читает лист с выгрузкой сделок и лист с участниками по потокам, считает по дням
те же цифры, что идут в ежедневный отчёт, и отправляет точки в витрину (/api/ingest).

Никаких названий таблиц и колонок в коде: раскладка приходит в LAYOUT_JSON
(см. документацию проекта). Переменные окружения:
  GOOGLE_SERVICE_ACCOUNT_JSON — ключ сервисного аккаунта
  LAYOUT_JSON                 — раскладка листов и колонок
  SHTAB_URL                   — адрес сайта (без завершающего /)
  SHTAB_TOKEN                 — токен сборщика
  FROM / TO                   — период по дням, YYYY-MM-DD (по умолчанию: 14 дней до вчера)
  SYNC_METRICS                — 1: заодно обновить реестр из metrics.json
"""

import datetime as dt
import io
import json
import os
import re
import sys
import time

import requests
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SA_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
SA_FILE = os.environ.get("GOOGLE_SA_FILE", "").strip()
LAYOUT = json.loads(os.environ.get("LAYOUT_JSON") or "{}")
URL = os.environ.get("SHTAB_URL", "").rstrip("/")
TOKEN = os.environ.get("SHTAB_TOKEN", "").strip()
SYNC_METRICS = os.environ.get("SYNC_METRICS", "").strip() in ("1", "true", "yes")

MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август",
          "сентябрь", "октябрь", "ноябрь", "декабрь"]


def log(*a):
    print(*a, flush=True)


def col_index(letter):
    n = 0
    for ch in letter.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def parse_date(s):
    """'13.04.25', '17.04.2025 10:58:15' → date; служебные 31.12.99 и пустые → None."""
    s = (s or "").strip()
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{2,4})", s)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    if y < 2020 or y > 2035:
        return None
    try:
        return dt.date(y, mo, d)
    except ValueError:
        return None


def sheets():
    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    creds = (Credentials.from_service_account_file(SA_FILE, scopes=scopes) if SA_FILE
             else Credentials.from_service_account_info(json.loads(SA_JSON), scopes=scopes))
    return build("sheets", "v4", credentials=creds, cache_discovery=False).spreadsheets().values()


def read(values, sheet_id, rng):
    for attempt in range(4):
        try:
            return values.get(spreadsheetId=sheet_id, range=rng).execute().get("values", [])
        except Exception as e:
            if attempt == 3:
                raise
            log("повтор чтения (%s)" % type(e).__name__)
            time.sleep(5)


def cell(row, idx):
    return row[idx].strip() if idx < len(row) else ""


# ---------- сделки → точки по дням ----------

def deal_points(values, day_from, day_to):
    L = LAYOUT
    c = {k: col_index(v) for k, v in L["cols"].items()}
    rows = read(values, L["sheet_id"], "'%s'!A%d:%s" % (L["export_tab"], L["first_row"], L.get("last_col", "AZ")))
    log("строк выгрузки: %d" % len(rows))
    lead_funnel = L["lead_funnel"]
    prefix = L["first_line_prefix"]

    def in_range(d):
        return d is not None and day_from <= d <= day_to

    counts = {}   # (metric, day, dim) → n

    def add(metric, d, dim=""):
        key = (metric, d.isoformat(), dim)
        counts[key] = counts.get(key, 0) + 1

    for r in rows:
        funnel = cell(r, c["funnel"])
        if not funnel:
            continue
        first_line = funnel.startswith(prefix)
        lead_d = parse_date(cell(r, c["lead_date"]))
        manager1 = cell(r, c["manager"]) or "без ответственного"
        if first_line and in_range(lead_d):
            add("l1.leads", lead_d)
            add("l1m.leads", lead_d, manager1)
            if funnel == lead_funnel:
                add("mkt.leads", lead_d)
                add("mkt.leads", lead_d, cell(r, c["source"]) or "без источника")
        if first_line:
            # по менеджеру Первой линии: назначено и проведено в той же сделке (колонка «встреча проведена»)
            b1 = parse_date(cell(r, c["booked_date"]))
            if in_range(b1):
                add("l1m.booked", b1, manager1)
            if "held1_date" in c:
                h1 = parse_date(cell(r, c["held1_date"]))
                if in_range(h1):
                    add("l1m.held", h1, manager1)
        source = cell(r, c["source"]) or "без источника"
        if funnel == lead_funnel:
            booked_d = parse_date(cell(r, c["booked_date"]))
            if in_range(booked_d):
                add("l1.booked", booked_d)
                add("l1.booked", booked_d, "src:" + source)
        if not first_line:
            manager = cell(r, c["manager"]) or "без ответственного"
            held_d = parse_date(cell(r, c["held_date"]))
            if in_range(held_d):
                add("l2.held", held_d)
                add("l2.held", held_d, manager)
                add("l2.held", held_d, "src:" + source)
            sale_d = parse_date(cell(r, c["sale_date"]))
            if in_range(sale_d):
                add("l2.sales", sale_d)
                add("l2.sales", sale_d, manager)
                add("l2.sales", sale_d, "src:" + source)

    # дни без событий тоже пишем нулём — иначе на графике дыра выглядит как «нет данных»
    points = []
    day = day_from
    while day <= day_to:
        for metric in ("mkt.leads", "l1.leads", "l1.booked", "l2.held", "l2.sales"):
            counts.setdefault((metric, day.isoformat(), ""), 0)
        day += dt.timedelta(days=1)
    for (metric, period, dim), n in counts.items():
        points.append({"metric": metric, "ptype": "day", "period": period, "dim": dim, "value": n})
    return points


# ---------- активность менеджеров: события amoCRM и звонки АТС ----------

def parse_any_date(s):
    """'08.09.2026 19:31' или '2026-04-10T07:15:23Z' (UTC → МСК) → date."""
    s = (s or "").strip()
    d = parse_date(s)
    if d:
        return d
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})", s)
    if m:
        try:
            utc = dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)))
            return (utc + dt.timedelta(hours=3)).date()
        except ValueError:
            return None
    return None


def activity_points(values, day_from, day_to):
    points = []
    ev = LAYOUT.get("events")
    if ev:
        c = {k: col_index(v) for k, v in ev["cols"].items()}
        rows = read(values, LAYOUT["sheet_id"], "'%s'!A%d:%s" % (ev["tab"], ev.get("first_row", 2), ev.get("last_col", "K")))
        counts = {}
        for r in rows:
            d = parse_any_date(cell(r, c["date"]))
            who = cell(r, c["author"])
            if not who or d is None or not (day_from <= d <= day_to):
                continue
            key = (d.isoformat(), who)
            counts[key] = counts.get(key, 0) + 1
        for (period, who), n in counts.items():
            points.append({"metric": "l1m.events", "ptype": "day", "period": period, "dim": who, "value": n})
        log("событий amo по менеджерам: %d точек" % len(counts))
    ca = LAYOUT.get("calls")
    if ca:
        # выгрузка АТС: у исходящих внутренний номер в «Кто», у входящих — в «Кому»; дата «[hh:mm:ss] YYYY-MM-DD», «Время разговора» в секундах
        c = {k: col_index(v) for k, v in ca["cols"].items()}
        ext_map = ca.get("ext_map") or {}
        rows = read(values, ca.get("sheet_id") or LAYOUT["sheet_id"], "'%s'!A%d:%s" % (ca["tab"], ca.get("first_row", 2), ca.get("last_col", "I")))
        calls, talk = {}, {}
        for r in rows:
            raw = cell(r, c["date"])
            m = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
            if not m:
                continue
            d = dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if not (day_from <= d <= day_to):
                continue
            who = cell(r, c["who"])
            to = cell(r, c["to"]) if "to" in c else ""
            name = ext_map.get(who) or ext_map.get(to)
            if not name:
                # ни один из номеров не менеджер: служебные очереди (11, 6100) и незнакомые номера пропускаем
                continue
            try:
                sec = float(cell(r, c["talk"]).replace(",", ".") or 0)
            except ValueError:
                sec = 0
            if sec <= 0:
                continue        # неотвеченные не считаем
            key = (d.isoformat(), name)
            calls[key] = calls.get(key, 0) + 1
            talk[key] = talk.get(key, 0) + sec / 60.0
        for (period, who), n in calls.items():
            points.append({"metric": "l1m.calls", "ptype": "day", "period": period, "dim": who, "value": n})
            points.append({"metric": "l1m.talk", "ptype": "day", "period": period, "dim": who, "value": round(talk[(period, who)], 1)})
        log("звонков по менеджерам: %d точек" % len(calls))
    tc = LAYOUT.get("touches")
    if tc:
        # «Работа с базой» → «активность 1 линия»: контакт, менеджер, дата последнего касания
        c = {k: col_index(v) for k, v in tc["cols"].items()}
        rows = read(values, tc.get("sheet_id") or LAYOUT["sheet_id"], "'%s'!A%d:%s" % (tc["tab"], tc.get("first_row", 2), tc.get("last_col", "E")))
        counts = {}
        for r in rows:
            d = parse_date(cell(r, c["date"]))
            who = cell(r, c["manager"])
            if not who or d is None or not (day_from <= d <= day_to):
                continue
            key = (d.isoformat(), who)
            counts[key] = counts.get(key, 0) + 1
        for (period, who), n in counts.items():
            points.append({"metric": "l1m.touches", "ptype": "day", "period": period, "dim": who, "value": n})
        log("касаний базы по менеджерам: %d точек" % len(counts))
    return points


# ---------- участники по потокам → снимок на сегодня ----------

def participants_points(values, today):
    L = LAYOUT.get("clients")
    if not L:
        return []
    c = {k: col_index(v) for k, v in L["cols"].items()}
    rows = read(values, LAYOUT["sheet_id"], "'%s'!A%d:%s%d" % (L["tab"], L["first_row"], L.get("last_col", "AL"), L["last_row"]))
    year = None
    points = []
    asof = today.isoformat()

    def num(s):
        try:
            return float(str(s).replace("\xa0", "").replace(" ", "").replace(",", "."))
        except ValueError:
            return 0.0

    for r in rows:
        label = cell(r, c["month"]).lower()
        if re.fullmatch(r"20\d\d", label):
            year = int(label)
            continue
        if label == "шортлист":
            period = "shortlist"
        elif label in MONTHS and year:
            period = "%d-%02d" % (year, MONTHS.index(label) + 1)
        else:
            continue
        full, pre = num(cell(r, c["full"])), num(cell(r, c["prepaid"]))
        vals = {"pay.full": full, "pay.prepaid": pre, "pay.bloggers": num(cell(r, c["bloggers"])),
                "pay.participants": full + pre, "pay.receipts": num(cell(r, c["receipt"]))}
        for metric, v in vals.items():
            points.append({"metric": metric, "ptype": "potok", "period": period, "dim": "", "asof": asof, "value": v})
    return points


# ---------- отправка ----------

def post(path, body):
    r = requests.post(URL + path, headers={"Authorization": "Bearer " + TOKEN}, json=body, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError("%s → %s %s" % (path, r.status_code, r.text[:200]))
    return r.json()


def send(points, note):
    started = dt.datetime.utcnow().isoformat() + "Z"
    total = len(points)
    for i in range(0, total, 500):
        chunk = points[i:i + 500]
        last = i + 500 >= total
        body = {"collector": "amo-sheet", "points": chunk}
        if last:
            body.update({"finalize": True, "started": started, "total_points": total, "run_note": note})
        res = post("/api/ingest", body)
        log("отправлено %d/%d (записано %s)" % (min(i + 500, total), total, res.get("written")))


def main():
    missing = [n for n, v in [("LAYOUT_JSON", LAYOUT), ("SHTAB_URL", URL), ("SHTAB_TOKEN", TOKEN)] if not v]
    if missing or not (SA_JSON or SA_FILE):
        log("ОШИБКА: не заданы " + ", ".join(missing + ([] if (SA_JSON or SA_FILE) else ["GOOGLE_SERVICE_ACCOUNT_JSON"])))
        sys.exit(1)
    today = dt.date.today()
    day_to = dt.date.fromisoformat(os.environ["TO"]) if os.environ.get("TO") else today - dt.timedelta(days=1)
    day_from = dt.date.fromisoformat(os.environ["FROM"]) if os.environ.get("FROM") else day_to - dt.timedelta(days=13)
    log("период: %s — %s" % (day_from, day_to))

    values = sheets()
    if SYNC_METRICS:
        here = os.path.dirname(os.path.abspath(__file__))
        reg = json.load(io.open(os.path.join(here, "..", "metrics.json"), encoding="utf-8"))
        log("реестр: %s" % post("/api/metrics", reg))

    pts = deal_points(values, day_from, day_to)
    log("точек по сделкам: %d" % len(pts))
    pp = participants_points(values, today)
    log("точек по участникам: %d" % len(pp))
    ap = activity_points(values, day_from, day_to)
    send(pts + pp + ap, "период %s—%s" % (day_from, day_to))
    log("ГОТОВО")


if __name__ == "__main__":
    main()
