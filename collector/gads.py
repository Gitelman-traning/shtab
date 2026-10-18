# -*- coding: utf-8 -*-
"""Google Ads → витрина Штаба: расход, клики, показы и конверсии по кампаниям за день (только чтение).

Переменные окружения (все из Doppler / GitHub Secrets, в код не попадают):
  GADS_DEVELOPER_TOKEN      — developer token из Центра API аккаунта-менеджера Google Ads
  GADS_CLIENT_ID, GADS_CLIENT_SECRET, GADS_REFRESH_TOKEN — OAuth-клиент и refresh token пользователя с доступом к кабинету
  GADS_CUSTOMER_ID          — ID рекламного аккаунта, цифры без дефисов
  GADS_LOGIN_CUSTOMER_ID    — ID аккаунта-менеджера (MCC), если доступ через него; иначе пусто
  GADS_API_VERSION          — версия API, по умолчанию v21 (Google выключает старые версии примерно через год)
Точки: ads.cost (в валюте аккаунта), ads.clicks, ads.impr, ads.conv; dim = «google|название кампании».
"""
import datetime as dt
import os

import requests

FIELDS = (("ads.cost", "costMicros", 1e-6), ("ads.clicks", "clicks", 1), ("ads.impr", "impressions", 1), ("ads.conv", "conversions", 1))


def _access_token():
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["GADS_CLIENT_ID"], "client_secret": os.environ["GADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GADS_REFRESH_TOKEN"], "grant_type": "refresh_token"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError("OAuth Google %s: %s" % (r.status_code, r.text[:200]))
    return r.json()["access_token"]


def gads_points(day_from, day_to, log=print):
    need = ["GADS_DEVELOPER_TOKEN", "GADS_CLIENT_ID", "GADS_CLIENT_SECRET", "GADS_REFRESH_TOKEN", "GADS_CUSTOMER_ID"]
    missing = [n for n in need if not os.environ.get(n, "").strip()]
    if missing:
        log("Google Ads: не заданы %s — пропуск" % ", ".join(missing))
        return []
    cid = os.environ["GADS_CUSTOMER_ID"].replace("-", "").strip()
    ver = os.environ.get("GADS_API_VERSION", "").strip() or "v21"
    headers = {"Authorization": "Bearer " + _access_token(), "developer-token": os.environ["GADS_DEVELOPER_TOKEN"].strip()}
    login = os.environ.get("GADS_LOGIN_CUSTOMER_ID", "").replace("-", "").strip()
    if login:
        headers["login-customer-id"] = login
    query = ("SELECT segments.date, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions "
             "FROM campaign WHERE segments.date BETWEEN '%s' AND '%s'" % (day_from.isoformat(), day_to.isoformat()))
    r = requests.post("https://googleads.googleapis.com/%s/customers/%s/googleAds:searchStream" % (ver, cid),
                      headers=headers, json={"query": query}, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError("Google Ads %s: %s" % (r.status_code, r.text[:300]))
    acc = {}   # (metric, date, dim) → value: у одной кампании за день может быть несколько строк
    for chunk in r.json():
        for row in chunk.get("results", []):
            d = row["segments"]["date"]
            dim = "google|" + row["campaign"]["name"]
            m = row.get("metrics", {})
            for metric, field, k in FIELDS:
                key = (metric, d, dim)
                acc[key] = acc.get(key, 0) + float(m.get(field, 0) or 0) * k
    points = [{"metric": m, "ptype": "day", "period": d, "dim": dim, "value": round(v, 2)} for (m, d, dim), v in acc.items()]
    log("Google Ads %s: точек %d" % (cid, len(points)))
    return points


if __name__ == "__main__":
    today = dt.date.today()
    for p in gads_points(today - dt.timedelta(days=7), today - dt.timedelta(days=1))[:12]:
        print(p)
