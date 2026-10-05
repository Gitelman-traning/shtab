#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Расходы на модели из листов ОКК: «ОКК» и «Коуч» (колонка «стоимость, ₽») → витрина Штаба, раздел «Бюджет и расходы».
Каждая строка листа — одна трата с ключом ref (лист + сделка/клиент + модель + дата), повторный импорт не дублирует.

Окружение: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SA_FILE, SHTAB_URL, SHTAB_TOKEN.
Подписки (Cloudflare Workers Paid) добавляются на первое число месяца, если их ещё нет.
"""
import datetime as dt
import json
import os
import re
import sys

import requests
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SHEET = os.environ.get("SHEET_ID", "").strip()
URL = os.environ.get("SHTAB_URL", "").rstrip("/")
TOKEN = os.environ.get("SHTAB_TOKEN", "").strip()
FIXED = [("Cloudflare", "Workers Paid", 5.0, "USD", 95.0, "2026-09")]    # сервис, статья, сумма, валюта, курс, с какого месяца


def log(*a):
    print(*a, flush=True)


def values():
    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    f = os.environ.get("GOOGLE_SA_FILE", "").strip()
    creds = Credentials.from_service_account_file(f, scopes=scopes) if f else Credentials.from_service_account_info(json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]), scopes=scopes)
    return build("sheets", "v4", credentials=creds, cache_discovery=False).spreadsheets().values()


def read_tab(v, tab):
    try:
        data = v.get(spreadsheetId=SHEET, range="'%s'!1:100000" % tab).execute().get("values", [])
    except Exception as e:
        log("лист «%s» не прочитан: %s" % (tab, str(e)[:100]))
        return []
    if not data:
        return []
    hdr = data[0]
    return [dict(zip(hdr, r + [""] * (len(hdr) - len(r)))) for r in data[1:]]


def num(s):
    try:
        return float(str(s).replace(",", ".").replace("\xa0", "").replace(" ", ""))
    except ValueError:
        return None


def day_of(s):
    m = re.match(r"(\d{2})\.(\d{2})\.(\d{4})", str(s or ""))
    return "%s-%s-%s" % (m.group(3), m.group(2), m.group(1)) if m else None


def model_name(m):
    m = (m or "").split("/")[-1]
    return {"claude-sonnet-5": "Sonnet 5", "claude-opus-5": "Opus 5", "claude-opus-5-5": "Opus 5.5", "claude-fable-5-1": "Fable 5.1",
            "gpt-5": "GPT-5", "gpt-6-astra": "GPT-6 Astra", "gpt-6-sol": "GPT-6 Sol"}.get(m, m)


def main():
    if not (SHEET and URL and TOKEN):
        sys.exit("нужны SHEET_ID, SHTAB_URL, SHTAB_TOKEN")
    v = values()
    rows = []
    for tab, what in (("ОКК", "ОКК разбор"), ("ОКК модели", "ОКК сверка моделей"), ("Коуч", "коуч по диагностикам")):
        n = 0
        for r in read_tab(v, tab):
            cost = num(r.get("стоимость, ₽"))
            day = day_of(r.get("дата разбора"))
            if not cost or cost <= 0 or not day:
                continue
            model = model_name(r.get("модель"))
            key = (r.get("ID сделки") or r.get("клиент") or "").strip()
            rows.append({"day": day, "service": "ProxyAPI" if day >= "2026-09-07" else "OpenRouter", "item": "%s · %s" % (what, model),
                         "kind": "spend", "amount": round(cost, 2), "currency": "RUB", "qty": 1,
                         "note": (r.get("клиент") or "")[:60], "ref": "%s|%s|%s|%s" % (tab, key, model, day)})
            n += 1
        log("лист «%s»: %d строк с расходом" % (tab, n))
    today = dt.date.today()
    for service, item, amt, cur, rate, since in FIXED:
        y, m = int(since[:4]), int(since[5:7])
        while (y, m) <= (today.year, today.month):
            rows.append({"day": "%04d-%02d-01" % (y, m), "service": service, "item": item, "kind": "fixed", "amount": round(amt * rate, 2),
                         "currency": cur, "amount_orig": amt, "note": "подписка, курс %g ₽" % rate, "ref": "fixed|%s|%s|%04d-%02d" % (service, item, y, m)})
            m += 1
            if m > 12:
                y, m = y + 1, 1
    sent = 0
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        r = requests.post(URL + "/api/ingest", headers={"Authorization": "Bearer " + TOKEN, "User-Agent": "shtab-expenses"},
                          json={"collector": "expenses", "expenses": chunk}, timeout=120)
        if r.status_code >= 400:
            raise RuntimeError("ingest → %s %s" % (r.status_code, r.text[:200]))
        sent += len(chunk)
    log("отправлено строк расходов: %d" % sent)


if __name__ == "__main__":
    main()
