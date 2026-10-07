#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Окна менеджеров Первой линии: цифры дня с пруф-списками сделок.

Считает на срез 00:00 дня окна (по правилам Людмилы, выжимка 01, раздел 1) и шлёт в витрину:
  проведено за месяц (в зачёт по дате «проведена»), сорвавшиеся встречи месяца, назначенные впереди,
  лид / первый ответ (как отчёт amo: «Дата вступил в чат» / «Дата взят в работу ответил»),
  ЦА / назначено (поле «Квалификация» = ЦА, не-ЦА в знаменатель не идут), смены из графика.
Каждая цифра — список сделок (id + короткая подпись), чтобы менеджер мог открыть каждую в amo.

Переменные окружения:
  AMO_TOKEN                   — долгоживущий токен amoCRM (только чтение)
  SHTAB_URL, SHTAB_TOKEN      — адрес витрины и токен сборщика (без них — только локальный файл)
  GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SA_FILE — сервис-аккаунт для графика смен
  OKNA_DAY                    — день окна, YYYY-MM-DD (по умолчанию сегодня по Москве)
  OKNA_OUT                    — куда положить JSON с результатом (по желанию)
  OKNA_SHIFTS_SHEET           — id таблицы «график 1 линии» (по умолчанию из раскладки ниже)
Только GET к amo. Даты месяца считаются от дня окна — ничего не зашито.
"""

import datetime as dt
import json
import math
import os
import re
import sys
import time

import requests

MSK = dt.timezone(dt.timedelta(hours=3))
AMO = "https://pavelgitelman.amocrm.ru/api/v4"
# Токен интеграции Team_Training_Reports (отчёты, только чтение);
# AMO_TOKEN — общий запасной вариант, см. DOPPLER.md.
TOKEN = (os.environ.get("AMO_TOKEN_REPORTS") or os.environ.get("AMO_TOKEN", "")).strip().lstrip("﻿")
if TOKEN[:7].lower() == "bearer ":
    TOKEN = TOKEN[7:].strip()
URL = os.environ.get("SHTAB_URL", "").rstrip("/")
STOKEN = os.environ.get("SHTAB_TOKEN", "").strip()
SHIFTS_SHEET = os.environ.get("OKNA_SHIFTS_SHEET", "").strip() or "18dDX0Q3utC-gaqtVg4v4GlOnVLOa9jqGM-979GJqsig"

# менеджеры Первой линии: amo user id → имя в окне; имя в графике смен
MGR = {10118550: "Маргарита", 11799278: "Алина", 12974558: "Юлия", 11827650: "Полина"}
SHIFT_NAME = {"Маргарита": "Марго", "Алина": "Алина", "Юлия": "Юля", "Полина": "Полина"}
MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]

L1 = 8733326                                    # Первая линия Продажи тренинга
COND_PIPES = (8733326, 8733518, 9701010, 10242466)   # где ищем проведённые встречи менеджера
ST_BOOK, ST_MOVED, ST_CONF, ST_HELD, ST_LOST = 70705178, 70969558, 70704326, 142, 143
TAIL_ST = (ST_BOOK, ST_CONF, ST_MOVED)
ST_QUAL_NB, ST_QUAL_WARM, ST_DIALOG = 70703850, 70704318, 71054662
F = {"zoom": 1426301, "line1": 1443165, "qual": 1444195, "ans_d": 1444365, "chat_d": 1443071,
     "d_book": 1444151, "d_conf": 1444155, "d_cond": 1444159, "d_qualnb": 1444143, "d_qual_old": 1443001,
     "src": 1439087, "role": 1444185, "turn": 1442933, "staff": 1426297, "niche": 1447471, "company": 1442745}
FID = {v: k for k, v in F.items()}


def log(*a):
    print(*a, flush=True)


# ---------- amo ----------

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


def slim(l):
    """сделка amo → плоская запись с нужными полями (даты — unix ts как отдаёт amo)"""
    rec = {"id": l["id"], "pipe": l["pipeline_id"], "st": l["status_id"], "cr": l["created_at"],
           "upd": l.get("updated_at"), "cl": l.get("closed_at"), "resp": l["responsible_user_id"], "name": l.get("name") or ""}
    for f in l.get("custom_fields_values") or []:
        k = FID.get(f["field_id"])
        if k and f.get("values"):
            rec[k] = f["values"][0].get("value")
    return rec


def leads_pages(params, cap=80, label=""):
    out, page = [], 1
    while True:
        j = get("/leads", dict(params, limit=250, page=page))
        ls = (j.get("_embedded") or {}).get("leads") or []
        out += [slim(l) for l in ls]
        if len(ls) < 250:
            break
        if page >= cap:
            log("ВНИМАНИЕ: упор в лимит %d страниц (%s) — часть сделок не прочитана" % (cap, label))
            break
        page += 1
        time.sleep(0.15)
    return out


def leads_by_ids(ids):
    out = []
    ids = sorted(set(int(x) for x in ids))
    for i in range(0, len(ids), 50):
        params = {"limit": 250}
        for k, x in enumerate(ids[i:i + 50]):
            params["filter[id][%d]" % k] = x
        j = get("/leads", params)
        out += [slim(l) for l in (j.get("_embedded") or {}).get("leads") or []]
        time.sleep(0.12)
    return out


def events_status(params, since, until=None, cap=200):
    """события смены этапа: [(lead, at, pipe_before, st_before, pipe_after, st_after)]"""
    out, page = [], 1
    base = {"filter[type]": "lead_status_changed", "filter[created_at][from]": int(since), "limit": 100}
    if until:
        base["filter[created_at][to]"] = int(until) - 1
    base.update(params or {})
    while True:
        j = get("/events", dict(base, page=page))
        es = (j.get("_embedded") or {}).get("events") or []
        for e in es:
            if e.get("entity_type") not in (None, "lead"):
                continue
            vb = ((e.get("value_before") or [{}])[0].get("lead_status") or {})
            va = ((e.get("value_after") or [{}])[0].get("lead_status") or {})
            out.append((int(e["entity_id"]), int(e["created_at"]), vb.get("pipeline_id"), vb.get("id"), va.get("pipeline_id"), va.get("id")))
        if len(es) < 100 or not ((j.get("_links") or {}).get("next")):
            break
        if page >= cap:
            log("ВНИМАНИЕ: упор в лимит %d страниц событий" % cap)
            break
        page += 1
        time.sleep(0.15)
    return out


# ---------- подписи ----------

def mdate(ts):
    return dt.datetime.fromtimestamp(int(ts), MSK) if ts else None


def turn_txt(o):
    try:
        o = float(o or 0)
    except (TypeError, ValueError):
        return ""
    if not o:
        return ""
    return ("%g млрд" % (o / 1000)).replace(".", ",") if o >= 1000 else "%g млн" % o


def label(d, when=None):
    """«12.09 - ниша, 55 млн, 36 чел, Instagram»"""
    parts = []
    n = str(d.get("niche") or "").strip()
    if n and n != "-":
        parts.append(n[:30])
    t = turn_txt(d.get("turn"))
    if t:
        parts.append(t)
    if d.get("staff") not in (None, "", "0", 0):
        parts.append("%s чел" % d["staff"])
    if d.get("src"):
        parts.append(str(d["src"]))
    head = when.strftime("%d.%m") if when else mdate(d["cr"]).strftime("%d.%m")
    return head + " - " + (", ".join(parts) or "данных в карточке нет")


def clean_name(s):
    """имя сделки без телефона и служебных хвостов («+79991234567 по форме Ниша: Прочее» → «по форме Ниша: Прочее»)"""
    s = re.sub(r"\+?\d[\d\s\-()]{8,}\d", "", str(s or ""))
    return re.sub(r"\s+", " ", s).strip(" -,")[:60]


def item(d, when=None, extra=""):
    return [d["id"], label(d, when) + (" - " + extra if extra else ""), clean_name(d.get("name"))]


def l1_of(d):
    try:
        u = int(d.get("line1") or 0)
    except (TypeError, ValueError):
        u = 0
    return u or d["resp"]


# ---------- график смен ----------

def shifts_for(month_key):
    """{'Маргарита': [1,4,5,...], ...} из вкладки «график <месяц>»"""
    sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    sa_file = os.environ.get("GOOGLE_SA_FILE", "").strip()
    if not (sa_json or sa_file):
        log("график смен: нет сервис-аккаунта, смены пропущены")
        return {}
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    creds = Credentials.from_service_account_file(sa_file, scopes=scopes) if sa_file else Credentials.from_service_account_info(json.loads(sa_json), scopes=scopes)
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False).spreadsheets()
    meta = svc.get(spreadsheetId=SHIFTS_SHEET, fields="sheets.properties.title").execute()
    mon = MONTHS[int(month_key[5:7]) - 1]
    tab = None
    for s in meta.get("sheets", []):
        t = s["properties"]["title"]
        if re.search(r"график\s+" + mon, t.lower()):
            tab = t
            break
    if not tab:
        log("график смен: вкладки за %s нет" % mon)
        return {}
    rows = svc.values().get(spreadsheetId=SHIFTS_SHEET, range="'%s'!A1:AG20" % tab).execute().get("values", [])
    if not rows:
        return {}
    daycol = {}
    for j, c in enumerate(rows[0]):
        if re.fullmatch(r"\d{1,2}", str(c).strip()) and 1 <= int(c) <= 31:
            daycol[j] = int(c)
    back = {v: k for k, v in SHIFT_NAME.items()}
    out = {}
    for r in rows[1:]:
        name = back.get(str(r[0] if r else "").strip())
        if not name:
            continue
        out[name] = sorted(d for j, d in daycol.items() if j < len(r) and str(r[j]).strip() == "1")
    log("график смен %s (%s): %s" % (month_key, tab.strip(), {k: len(v) for k, v in out.items()}))
    return out


# ---------- расчёт окна ----------

def build(day):
    cut_dt = dt.datetime(day.year, day.month, day.day, tzinfo=MSK)
    cut = int(cut_dt.timestamp())
    m_from_dt = dt.datetime(day.year, day.month, 1, tzinfo=MSK)
    m_from = int(m_from_dt.timestamp())
    now = int(time.time())
    log("окно на %s (срез %s, месяц с %s)" % (day, cut_dt.strftime("%d.%m.%Y %H:%M"), m_from_dt.strftime("%d.%m")))

    # 1. сделки четырёх воронок, обновлённые с начала месяца (проведённые, лиды/ответы, квалы месяца)
    leads = {}
    for pid in COND_PIPES:
        ls = leads_pages({"filter[pipeline_id]": pid, "filter[updated_at][from]": m_from}, label="воронка %d" % pid)
        for d in ls:
            leads[d["id"]] = d
        log("воронка %d: %d сделок с обновлением за месяц" % (pid, len(ls)))
    # 2. активные «назначена / подтверждена / перенесена» Первой линии — независимо от даты обновления
    params = {}
    for k, st in enumerate(TAIL_ST):
        params["filter[statuses][%d][pipeline_id]" % k] = L1
        params["filter[statuses][%d][status_id]" % k] = st
    tails_now = leads_pages(params, label="этапы встреч")
    for d in tails_now:
        leads[d["id"]] = d
    log("на этапах встреч сейчас: %d" % len(tails_now))

    # 3. срез: что было в 00:00. Смены этапов после среза откатываем, сделки моложе среза выкидываем
    at_cut = {}
    if now > cut:
        for lead, at, pb, sb, pa, sa in sorted(events_status({}, cut), key=lambda e: e[1]):
            if lead not in at_cut:
                at_cut[lead] = (pb, sb)
        need = [lid for lid, (pb, sb) in at_cut.items() if lid not in leads and pb in COND_PIPES]
        for d in leads_by_ids(need):
            leads[d["id"]] = d
        log("смен этапа после среза: %d сделок, догружено %d" % (len(at_cut), len(need)))
    dropped = 0
    for lid in list(leads):
        d = leads[lid]
        if d["cr"] >= cut:
            leads.pop(lid); dropped += 1
            continue
        if lid in at_cut:
            pb, sb = at_cut[lid]
            if sb is None:
                leads.pop(lid); dropped += 1
                continue
            d["st"], d["pipe"] = sb, pb
            if d.get("cl") and d["cl"] >= cut:
                d["cl"] = None
            # зум поставили после среза (дата назначения в день окна или позже), а в полночь сделка ещё не стояла на этапе встречи — зума тогда не было
            if d.get("d_book") and int(d["d_book"]) >= cut and sb not in TAIL_ST + (ST_HELD,):
                d["zoom"] = None
    log("выкинуто моложе среза / ушедших: %d, в расчёте %d сделок" % (dropped, len(leads)))

    # 4. переводы в «подтверждена» за месяц до среза (этап «подтверждена» мог быть пройден и сброшен)
    conf_at = set()
    for lead, at, pb, sb, pa, sa in events_status({"filter[value_after][leads_statuses][0][pipeline_id]": L1,
                                                   "filter[value_after][leads_statuses][0][status_id]": ST_CONF}, m_from, cut):
        conf_at.add(lead)

    def in_month(ts):
        return bool(ts) and m_from <= int(ts) < cut

    def dts(ts):
        return mdate(ts).date() if ts else None

    def before(ts):
        """дата этапа считается, только если она раньше дня окна: проставленное в день окна в полночь ещё не существовало"""
        z = dts(ts)
        return bool(z) and z < day

    def reach(d):
        # до какого этапа сделка дошла: по этапу на срезе и по датам этапов в карточке (как в окне Людмилы)
        cond = d["st"] == ST_HELD or before(d.get("d_cond"))
        conf = cond or d["st"] == ST_CONF or before(d.get("d_conf")) or d["id"] in conf_at
        book = conf or d["st"] in (ST_BOOK, ST_MOVED) or before(d.get("d_book")) or bool(d.get("zoom"))
        qual = book or d["st"] in (ST_QUAL_NB, ST_QUAL_WARM)
        return {"cond": cond, "conf": conf, "book": book, "qual": qual}

    out = {}
    for uid, name in MGR.items():
        R = {}
        # проведённые за месяц: поле «дата проведена» в месяце и до дня окна, менеджер по полю «1-линия ответственный», четыре воронки
        cond = [d for d in leads.values() if d["pipe"] in COND_PIPES and l1_of(d) == uid and d.get("line1")
                and dts(d.get("d_cond")) and m_from_dt.date() <= dts(d["d_cond"]) < day]
        cond.sort(key=lambda d: d["d_cond"])
        R["cond"] = [item(d, mdate(d["d_cond"])) for d in cond]
        # встречи на этапах «назначена / подтверждена / перенесена» у ответственного менеджера
        mine = [d for d in leads.values() if d["pipe"] == L1 and d["st"] in TAIL_ST and d["resp"] == uid]
        tails, ahead = [], []
        for d in mine:
            z = dts(d.get("zoom"))
            age = (cut - d["cr"]) / 86400.0
            if z and z >= day:
                ahead.append((d, mdate(d["zoom"])))
            elif age <= 90:
                tails.append((d, mdate(d["zoom"]) if z else None))
        ahead.sort(key=lambda x: x[1])
        tails.sort(key=lambda x: -(x[1].timestamp() if x[1] else 0))
        mtails = [(d, z) for d, z in tails if z and (z.year, z.month) == (day.year, day.month)]
        R["lost"] = [item(d, z) for d, z in mtails]
        R["tails"] = [item(d, z) for d, z in tails]
        R["ahead"] = [[d["id"], z.strftime("%d.%m %H:%M") + " - " + label(d, z)[8:], clean_name(d.get("name"))] for d, z in ahead]
        # лид / первый ответ — как отчёт amo
        pool = [d for d in leads.values() if d["pipe"] == L1 and l1_of(d) == uid]
        base = [d for d in pool if in_month(d.get("chat_d"))]
        ans = [d for d in pool if in_month(d.get("ans_d"))]
        base_ids = {d["id"] for d in base}
        R["leads"] = [item(d, mdate(d["chat_d"]), "в чат " + mdate(d["chat_d"]).strftime("%d.%m")) for d in sorted(base, key=lambda x: -int(x["chat_d"]))]
        R["answered"] = [item(d, mdate(d["ans_d"]), "ответил " + mdate(d["ans_d"]).strftime("%d.%m") + ("" if d["id"] in base_ids else " - в лидах месяца нет"))
                         for d in sorted(ans, key=lambda x: -int(x["ans_d"]))]
        # ЦА / назначено: сделки месяца (по дате создания) менеджера, дошедшие до квала; ЦА по полю «Квалификация»
        msep = [d for d in pool if m_from <= d["cr"] < cut]
        qual = [d for d in msep if reach(d)["qual"]]
        ca = [d for d in qual if d.get("qual") == "ЦА"]
        nca = [d for d in qual if d.get("qual") and d.get("qual") != "ЦА"]
        cab = [d for d in ca if reach(d)["book"]]
        cnb = [d for d in ca if not reach(d)["book"]]
        cai = lambda ds: [item(d, None, d.get("qual") or "квалификация не проставлена") for d in sorted(ds, key=lambda x: -x["cr"])]
        R["ca"], R["ca_booked"], R["ca_nobook"], R["ca_notca"] = cai(ca), cai(cab), cai(cnb), cai(nca)
        R["month_leads"] = [item(d) for d in sorted(msep, key=lambda x: -x["cr"])]
        out[name] = R
        log("%s: проведено %d, сорвалось %d (всего хвостов %d), впереди %d, лидов %d / ответили %d, ЦА %d / назначено %d"
            % (name, len(cond), len(mtails), len(tails), len(ahead), len(base), len(ans), len(ca), len(cab)))
    return out


def main():
    if not TOKEN:
        sys.exit("нет AMO_TOKEN")
    day = dt.date.fromisoformat(os.environ["OKNA_DAY"]) if os.environ.get("OKNA_DAY") else dt.datetime.now(MSK).date()
    started = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    res = build(day)
    month_key = day.strftime("%Y-%m")
    try:
        shifts = shifts_for(month_key)
    except Exception as e:      # график не должен ронять окно
        log("график смен: ошибка %s" % e)
        shifts = {}
    rows = []
    for mgr, R in res.items():
        for key, items in R.items():
            rows.append({"day": day.isoformat(), "mgr": mgr, "key": key, "n": len(items), "items": items})
        if mgr in shifts:
            rows.append({"day": day.isoformat(), "mgr": mgr, "key": "shifts", "n": len(shifts[mgr]), "items": shifts[mgr]})
    if os.environ.get("OKNA_OUT"):
        with open(os.environ["OKNA_OUT"], "w", encoding="utf-8") as f:
            json.dump({"day": day.isoformat(), "rows": rows}, f, ensure_ascii=False, indent=1)
        log("результат: %s" % os.environ["OKNA_OUT"])
    if URL and STOKEN:
        for i in range(0, len(rows), 40):
            chunk = rows[i:i + 40]
            body = {"collector": "okna", "okna": chunk}
            if i + 40 >= len(rows):
                body.update({"finalize": True, "started": started, "total_points": len(rows), "run_note": "окна на %s" % day})
            r = requests.post(URL + "/api/ingest", headers={"Authorization": "Bearer " + STOKEN}, json=body, timeout=120)
            if r.status_code >= 400:
                raise RuntimeError("ingest → %s %s" % (r.status_code, r.text[:200]))
            log("отправлено %d/%d" % (min(i + 40, len(rows)), len(rows)))
    log("ГОТОВО")


if __name__ == "__main__":
    main()
