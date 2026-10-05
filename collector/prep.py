#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Подготовка диагноста к встрече (раздел Второй линии Штаба, /sales/l2/prep/).

  python collector/prep.py cases [--out cases.json]          — база участников: купившие из amo → витрина (prep_cases)
  python collector/prep.py run [--deal ID] [--dry] [--out brief.md] [--cases cases.json]
        — сделки на этапе «Встреча подтверждена» (и поставленные в очередь на странице) → четыре шага → витрина (prep)

Четыре шага на каждую сделку (рекомендация GPT, принята 05.10.2026):
  1. company_research   — модель с веб-поиском: факты о компании с источниками + управленческие гипотезы;
  2. participants_search — модель выбирает 5 похожих участников из базы (бизнес-модель, ниша, масштаб, B2B/B2C, продукт, сложность);
  3. alumni_growth_research — по каждому из 5: год тренинга → тогда → сейчас → рост → источник (или «не подтверждено»);
  4. diagnostic_builder — сборка подготовки по промпту collector/prep_prompt.md (16 разделов).

Окружение: AMO_TOKEN (чтение), SHTAB_URL + SHTAB_TOKEN (витрина), LLM_API_KEY (ProxyAPI, Anthropic Messages с web_search).
Необязательно: PREP_MODEL (claude-sonnet-5), PREP_ANTHROPIC_BASE (https://api.proxyapi.ru/anthropic), PREP_MAX (сделок за прогон, 10).
В модель не уходят телефоны, почты, мессенджер-id; в журнал — только id сделок.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time

import requests

MSK = dt.timezone(dt.timedelta(hours=3))
AMO = "https://pavelgitelman.amocrm.ru/api/v4"
AMO_UI = "https://pavelgitelman.amocrm.ru/leads/detail/%d"
AMO_TOKEN = os.environ.get("AMO_TOKEN", "").strip()
URL = (os.environ.get("SHTAB_URL", "").strip() or "https://shtab-20v.pages.dev").rstrip("/")
STOKEN = os.environ.get("SHTAB_TOKEN", "").strip()
LLM_KEY = os.environ.get("LLM_API_KEY", "").strip()
LLM_BASE = os.environ.get("PREP_ANTHROPIC_BASE", "https://api.proxyapi.ru/anthropic").rstrip("/")
MODEL = os.environ.get("PREP_MODEL", "claude-sonnet-5")
MAX_PER_RUN = int(os.environ.get("PREP_MAX", "10"))

L1 = 8733326                      # Первая линия
ST_CONF = 70704326                # «Встреча подтверждена» — триггер подготовки
L2_PIPES = (9701010, 8733518)     # Вторая линия: здесь живёт копия сделки с диагностом и купившие
WIN, LOST = 142, 143

# поля сделки, которые идут в карточку клиента (id → подпись)
LEAD_F = {1442745: "Компания", 1447471: "Ниша", 1442673: "Ниша (список)", 1426295: "Сфера деятельности", 1442933: "Оборот, млн ₽ в год",
          1426297: "Сотрудников", 1444185: "Должность", 1444259: "Сайт / соцсети", 1446139: "Сайт", 1446141: "Instagram",
          1446161: "Город", 1439087: "Источник", 1444583: "Роль в компании", 1444587: "Годовой оборот (анкета)",
          1446151: "Оборот за 2024, $ (анкета)", 1446143: "Постоянных сотрудников (анкета)",
          1446157: "Кого нанять, чтобы вырасти (анкета)", 1446171: "Собственник?", 1446173: "Единственный собственник?"}
F_DIAG_DT = 1426301
CONTACT_F = {1447892: "Сайт", 1426321: "Instagram", 1444119: "Instagram", 1447335: "Регион", 1447337: "Страна", 1447886: "Ниша",
             1447888: "Оборот, млн ₽", 1447890: "Сотрудников", 1447896: "Должность", 453145: "Должность"}
F_QUIZ_RESULT = 1448125
# база участников: поля купившей сделки
CASE_F = {"company": 1442745, "niche": 1447471, "niche_sel": 1442673, "sphere": 1426295, "turn": 1442933, "staff": 1426297,
          "site": 1444259, "site2": 1446139, "role": 1444185, "city": 1446161}
CASE_CF = {"site": 1447892, "country": 1447337, "region": 1447335, "niche": 1447886}

RE_PHONE = re.compile(r"\+?\d[\d\s\-()]{8,}\d")
RE_MAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


def log(*a):
    print(*a, flush=True)


# ---------- amo ----------

def amo(path, params=None):
    last = None
    for a in range(6):
        try:
            r = requests.get(AMO + path, headers={"Authorization": "Bearer " + AMO_TOKEN}, params=params, timeout=90)
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
    raise RuntimeError("amo не ответил: %s (%s)" % (path, last))


def cf_map(entity):
    """custom_fields_values → {field_id: 'значение, значение'} без пустых и «-»"""
    out = {}
    for f in entity.get("custom_fields_values") or []:
        vals = [str(v.get("value")) for v in f.get("values") or [] if v.get("value") not in (None, "", "-", False, "False")]
        if vals:
            out[f["field_id"]] = ", ".join(vals)
    return out


def clean(text):
    t = RE_MAIL.sub("[почта]", text or "")
    return RE_PHONE.sub("[телефон]", t).strip()


def leads_pages(params, cap=60):
    out, page = [], 1
    while True:
        j = amo("/leads", dict(params, limit=250, page=page))
        ls = (j.get("_embedded") or {}).get("leads") or []
        out += ls
        if len(ls) < 250 or page >= cap:
            break
        page += 1
        time.sleep(0.15)
    return out


def contacts_by_ids(ids):
    out = {}
    ids = sorted(set(int(x) for x in ids))
    for i in range(0, len(ids), 50):
        p = {"limit": 250}
        for k, x in enumerate(ids[i:i + 50]):
            p["filter[id][%d]" % k] = x
        for c in (amo("/contacts", p).get("_embedded") or {}).get("contacts") or []:
            out[c["id"]] = c
        time.sleep(0.12)
    return out


_users = None


def user_name(uid):
    global _users
    if _users is None:
        _users = {}
        for u in (amo("/users", {"limit": 250}).get("_embedded") or {}).get("users") or []:
            _users[u["id"]] = u.get("name") or str(u["id"])
    return _users.get(uid, str(uid))


def main_contact_id(lead):
    for c in (lead.get("_embedded") or {}).get("contacts") or []:
        if c.get("is_main"):
            return c["id"]
    cs = (lead.get("_embedded") or {}).get("contacts") or []
    return cs[0]["id"] if cs else None


# ---------- витрина ----------

def shtab(method, path, body=None, params=None):
    r = requests.request(method, URL + path, headers={"Authorization": "Bearer " + STOKEN, "User-Agent": "shtab-prep"},
                         json=body, params=params, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError("Штаб %s %s → %s %s" % (method, path, r.status_code, r.text[:200]))
    return r.json()


# ---------- модель ----------

def claude(system, user, search_uses=0, max_tokens=4000):
    """Anthropic Messages через ProxyAPI. search_uses>0 включает серверный веб-поиск. → (text, sources, usage)"""
    body = {"model": MODEL, "max_tokens": max_tokens, "system": system,
            "messages": [{"role": "user", "content": user}]}
    if search_uses:
        body["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": search_uses}]
    last = ""
    for a in range(3):
        try:
            r = requests.post(LLM_BASE + "/v1/messages", json=body, timeout=420,
                              headers={"x-api-key": LLM_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        except requests.RequestException as e:
            last = str(e)[:120]
            time.sleep(5 + 10 * a)
            continue
        if r.status_code in (429, 500, 502, 503, 504, 529):
            last = "ответ %s" % r.status_code
            time.sleep(10 + 15 * a)
            continue
        if r.status_code != 200:
            raise RuntimeError("модель: %s %s" % (r.status_code, r.text[:300]))
        j = r.json()
        text, sources = [], []
        for b in j.get("content") or []:
            if b.get("type") == "text":
                text.append(b.get("text") or "")
                for c in b.get("citations") or []:
                    if c.get("url") and c["url"] not in [s["url"] for s in sources]:
                        sources.append({"url": c["url"], "title": (c.get("title") or "")[:120]})
        u = j.get("usage") or {}
        usage = {"in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
                 "search": ((u.get("server_tool_use") or {}).get("web_search_requests", 0))}
        return "".join(text).strip(), sources, usage
    raise RuntimeError("модель не ответила (%s)" % last)


def add_usage(total, u):
    for k in ("in", "out", "search"):
        total[k] = total.get(k, 0) + (u.get(k) or 0)


# ---------- контекст сделки ----------

def lead_context(deal):
    lead = amo("/leads/%d" % deal, {"with": "contacts"})
    if not lead.get("id"):
        raise RuntimeError("сделка %d не найдена" % deal)
    cf = cf_map(lead)
    card = {}
    for fid, label in LEAD_F.items():
        if fid in cf and label not in card:
            card[label] = cf[fid]
    cid = main_contact_id(lead)
    contact, related = {}, []
    if cid:
        contact = amo("/contacts/%d" % cid, {"with": "leads"})
        ccf = cf_map(contact)
        for fid, label in CONTACT_F.items():
            if fid in ccf and label not in card:
                card[label] = ccf[fid]
        related = [x["id"] for x in (contact.get("_embedded") or {}).get("leads") or [] if x["id"] != deal]
    first_name = (re.split(r"[\s,]+", contact.get("name") or lead.get("name") or "")[0] or "").strip()
    if first_name and not first_name.isdigit() and not first_name.lower().startswith("сделка"):
        card["Имя"] = first_name
    # копия сделки на Второй линии → диагност
    manager, copy_id = "", None
    for lid in related:
        x = amo("/leads/%d" % lid)
        if x.get("pipeline_id") in L2_PIPES and x.get("status_id") not in (WIN, LOST):
            manager, copy_id = user_name(x.get("responsible_user_id")), lid
            break
        time.sleep(0.1)
    if not manager:
        manager = user_name(lead.get("responsible_user_id"))
    # заметки: сделка Первой линии + копия Второй
    notes = []
    for lid in [deal] + ([copy_id] if copy_id else []):
        for n in ((amo("/leads/%d/notes" % lid, {"limit": 250}).get("_embedded") or {}).get("notes") or []):
            if n.get("note_type") == "common":
                t = clean((n.get("params") or {}).get("text"))
                if len(t) > 12:
                    notes.append((n.get("created_at") or 0, t[:600]))
    notes.sort()
    notes = [t for _, t in notes[-15:]]
    meet_ts = cf.get(F_DIAG_DT)
    meet_at = dt.datetime.fromtimestamp(int(meet_ts), MSK).strftime("%Y-%m-%d %H:%M") if meet_ts and str(meet_ts).isdigit() else ""
    quiz = cf_map(contact).get(F_QUIZ_RESULT, "") if contact else ""
    return {"deal": deal, "contact": cid, "card": card, "notes": notes, "meet_at": meet_at, "manager": manager,
            "quiz_url": quiz, "updated_at": lead.get("updated_at") or 0,
            "company": card.get("Компания", ""), "niche": card.get("Ниша") or card.get("Ниша (список)") or card.get("Сфера деятельности", ""),
            "turn": card.get("Оборот, млн ₽ в год", ""), "staff": card.get("Сотрудников", ""),
            "country": card.get("Страна", ""), "city": card.get("Город", "")}


def card_text(ctx):
    lines = ["Карточка клиента из CRM (заполнена менеджером со слов клиента; чего нет — неизвестно):"]
    for k, v in ctx["card"].items():
        lines.append("- %s: %s" % (k, v))
    if ctx["meet_at"]:
        lines.append("- Диагностика: %s МСК, диагност %s" % (ctx["meet_at"], ctx["manager"]))
    if ctx["notes"]:
        lines.append("\nЗаметки менеджеров по сделке (от старых к новым):")
        lines += ["- " + n.replace("\n", " ") for n in ctx["notes"]]
    return "\n".join(lines)


# ---------- шаг 1: исследование компании ----------

RESEARCH_SYS = """Ты аналитик, который готовит досье на компанию собственника перед бизнес-встречей.
Ищи в открытых источниках: сайт компании, соцсети, отзывы, карты, реестры юрлиц и выручки (Rusprofile, Checko, СБИС, список-орг и аналоги
в стране клиента), СМИ, вакансии (hh.ru — размер команды и какие роли нанимают), маркетплейсы.
Правила:
0. Обязательно ищи в интернете, даже если данных в карточке мало: по названию компании и сайту; по нику в Instagram/Telegram;
   по имени собственника вместе с нишей, городом или страной; по сайту — что на нём написано (продукты, цены, география, команда).
   Минимум 3 разных запроса, пока не найдёшь компанию или не убедишься, что её нет в открытых источниках.
1. Каждый факт — с источником (адрес страницы). Нет источника — это гипотеза, так и помечай.
2. Не выдумывай: если компанию найти не удалось, скажи это прямо и опиши, что именно искал.
3. Если найденное расходится с карточкой CRM — покажи оба значения.
4. Пиши по-русски, структурно, без вступлений."""

RESEARCH_USER = """%s

Собери досье по разделам:
## Факты о компании
Что за бизнес, продукт, кому продают (B2B/B2C), каналы продаж, география, год основания, юрлицо и выручка по открытым реестрам,
размер команды, открытые вакансии, цены/средний чек, отзывы и репутация, последние новости. У каждого пункта — источник.
## Структура бизнеса и продукты
## Рынок и конкуренты (коротко)
## Что необычного
## Управленческие гипотезы
3–5 гипотез о том, что может ограничивать рост (на чём основаны).
## Чего не удалось найти"""


def research_company(ctx):
    return claude(RESEARCH_SYS, RESEARCH_USER % card_text(ctx), search_uses=10, max_tokens=5000)


# ---------- шаг 2: подбор участников ----------

PICK_SYS = """Ты подбираешь из базы участников тренинга по управлению пять человек, чей бизнес больше всего похож на бизнес клиента.
Похожесть — не совпадение слова в нише. Сравнивай: бизнес-модель (производство / услуги / розница / опт / онлайн), B2B или B2C,
тип продукта, масштаб (оборот и штат), управленческую сложность (несколько точек, филиалы, сезонность, производство + продажи),
страну. Пример: для цветочной сети подходят не только цветочные компании, а рестораны, fashion-ритейл, сервисные сети с похожим
масштабом и той же проблемой управления.
Выбирай только из переданного списка, по id. Ответь строго JSON без пояснений:
{"cases":[{"deal":<id>,"why":"<1–2 предложения, чем похож>"}, ...5 штук]}
Если похожих мало — всё равно выбери 5 ближайших и честно напиши в why, что сходство частичное."""


def cases_lines(cases):
    out = []
    for c in cases:
        bits = [str(c["deal"]), c.get("company") or c.get("name") or "?"]
        n = c.get("niche") or c.get("sphere") or ""
        if n:
            bits.append(n)
        if c.get("turn"):
            bits.append("%s млн ₽" % c["turn"])
        if c.get("staff"):
            bits.append("%s чел" % c["staff"])
        geo = ", ".join(x for x in (c.get("city"), c.get("country")) if x)
        if geo:
            bits.append(geo)
        if c.get("site"):
            bits.append(c["site"][:60])
        if c.get("paid_at"):
            bits.append("тренинг " + c["paid_at"][:7])
        out.append(" | ".join(bits))
    return "\n".join(out)


def pick_cases(ctx, facts, cases):
    user = "%s\n\nДосье по открытым источникам:\n%s\n\nБаза участников (id | компания | ниша | оборот | штат | география | сайт | когда):\n%s" % (
        card_text(ctx), facts[:6000], cases_lines(cases))
    text, _, usage = claude(PICK_SYS, user, max_tokens=1500)
    m = re.search(r"\{.*\}", text.replace("```json", "").replace("```", ""), re.S)
    picked = []
    if m:
        try:
            by_id = {int(c["deal"]): c for c in cases}
            for it in json.loads(m.group(0)).get("cases") or []:
                c = by_id.get(int(str(it.get("deal") or "0").strip()))
                if c and c["deal"] not in [p["deal"] for p in picked]:
                    picked.append(dict(c, why=str(it.get("why") or "")[:400]))
        except (ValueError, TypeError, AttributeError) as e:
            log("  подбор участников: не разобрал ответ (%s): %s" % (e, text[:200].replace("\n", " ")))
    else:
        log("  подбор участников: модель ответила не JSON: %s" % text[:200].replace("\n", " "))
    return picked[:5], usage


# ---------- шаг 3: рост выпускников ----------

GROWTH_SYS = """Ты проверяешь по открытым источникам, как изменилась компания участника тренинга с момента тренинга до сегодня.
Ищи выручку и штат по реестрам (Rusprofile, Checko, СБИС и аналоги по стране), число точек/филиалов, вакансии, новости, соцсети.
Ответ — 3–6 строк строго по формату:
Тогда (<год тренинга>): <что известно: оборот/штат/точки> (источник: карточка CRM или адрес)
Сейчас (<текущий год>): <оборот/штат/точки> (источник: адрес)
Изменение: <рост ×N / +N% / без изменений / не подтверждено>
Что ещё заметно: <1–2 факта с источниками или «ничего»>
Если компанию найти не удалось или данных о динамике нет — пиши «Изменение: не подтверждено» и не придумывай."""


def alumni_growth(case):
    desc = cases_lines([case])
    user = "Участник тренинга: %s\nГод тренинга: %s\nЧто известно на момент тренинга — из карточки CRM выше. Найди текущее состояние компании." % (
        desc, (case.get("paid_at") or "")[:4] or "неизвестен")
    return claude(GROWTH_SYS, user, search_uses=4, max_tokens=900)


# ---------- шаг 4: сборка подготовки ----------

def build_brief(ctx, facts, picked, prompt):
    cases_txt = []
    for i, c in enumerate(picked, 1):
        cases_txt.append("### Участник %d: %s\n%s\nЧем похож: %s\nДинамика по открытым источникам:\n%s" % (
            i, cases_lines([c]), "", c.get("why", ""), c.get("growth") or "не проверялось"))
    user = "%s\n\n# ДОСЬЕ ПО ОТКРЫТЫМ ИСТОЧНИКАМ\n%s\n\n# УЧАСТНИКИ ИЗ БАЗЫ (подобраны по сходству)\n%s" % (
        card_text(ctx), facts, "\n\n".join(cases_txt) or "Подходящих участников в базе не нашлось.")
    return claude(prompt, user, max_tokens=7000)


# ---------- команды ----------

def cmd_cases(out):
    rows = []
    for pid in L2_PIPES:
        leads = leads_pages({"filter[statuses][0][pipeline_id]": pid, "filter[statuses][0][status_id]": WIN, "with": "contacts"})
        log("купивших в воронке %d: %d" % (pid, len(leads)))
        cids = [main_contact_id(l) for l in leads if main_contact_id(l)]
        contacts = contacts_by_ids(cids)
        for l in leads:
            cf = cf_map(l)
            c = contacts.get(main_contact_id(l) or 0, {})
            ccf = cf_map(c)
            paid = l.get("closed_at") or l.get("updated_at") or l.get("created_at")
            row = {"deal": l["id"], "pipeline": pid, "name": (l.get("name") or "")[:80],
                   "paid_at": dt.datetime.fromtimestamp(int(paid), MSK).strftime("%Y-%m-%d") if paid else ""}
            for k, fid in CASE_F.items():
                row[k] = cf.get(fid, "")
            row["company"] = row["company"] or ""
            row["niche"] = row["niche"] or row.pop("niche_sel", "") or ccf.get(CASE_CF["niche"], "")
            row.pop("niche_sel", None)
            row["site"] = row["site"] or row.pop("site2", "") or ccf.get(CASE_CF["site"], "")
            row.pop("site2", None)
            row["country"] = ccf.get(CASE_CF["country"], "")
            row["city"] = row["city"] or ccf.get(CASE_CF["region"], "")
            for k in ("turn", "staff"):
                row[k] = re.sub(r"[^\d.,]", "", str(row[k]))[:12]
            if len(re.sub(r"[^\w]", "", row["site"])) < 4:
                row["site"] = ""
            if len(re.sub(r"[^\w]", "", row["company"])) < 2:
                row["company"] = ""
            rows.append(row)
    log("всего участников: %d, с названием компании %d" % (len(rows), sum(1 for r in rows if r["company"])))
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=1)
        log("записано в %s" % out)
    if URL and STOKEN:
        for i in range(0, len(rows), 150):
            shtab("POST", "/api/ingest", {"collector": "prep", "prep_cases": rows[i:i + 150]})
        log("база участников обновлена в витрине")


def load_cases(path):
    if path:
        return json.load(open(path, encoding="utf-8"))
    j = shtab("GET", "/api/prep", params={"mode": "collector"})
    return j.get("cases") or []


def targets(deal, known, queued):
    if deal:
        return [deal]
    now = time.time()
    leads = leads_pages({"filter[statuses][0][pipeline_id]": L1, "filter[statuses][0][status_id]": ST_CONF})
    out = []
    for l in leads:
        meet = cf_map(l).get(F_DIAG_DT)
        fresh = (meet and str(meet).isdigit() and int(meet) >= now - 86400) or (l.get("updated_at") or 0) >= now - 7 * 86400
        if fresh and l["id"] not in known:
            out.append(l["id"])
    for q in queued:
        if q not in out:
            out.append(q)
    log("на этапе «Встреча подтверждена»: %d, новых к подготовке: %d, в очереди со страницы: %d" % (len(leads), len(out) - len([q for q in queued if q not in out]), len(queued)))
    return out[:MAX_PER_RUN]


def process(deal, cases, prompt, dry, out_path):
    t0 = time.time()
    usage = {}
    ctx = lead_context(deal)
    log("сделка %d: контекст собран (%d полей, %d заметок), диагност %s" % (deal, len(ctx["card"]), len(ctx["notes"]), ctx["manager"]))
    facts, sources, u = research_company(ctx)
    add_usage(usage, u)
    log("  исследование: %d символов, %d источников, поисков %d" % (len(facts), len(sources), u["search"]))
    picked, u = pick_cases(ctx, facts, cases)
    add_usage(usage, u)
    log("  участников подобрано: %d" % len(picked))
    for c in picked:
        try:
            g, gs, u = alumni_growth(c)
            add_usage(usage, u)
            c["growth"], c["sources"] = g, gs
        except Exception as e:
            c["growth"] = "не проверено (ошибка поиска)"
            log("  рост участника %d: %s" % (c["deal"], str(e)[:100]))
    brief, _, u = build_brief(ctx, facts, picked, prompt)
    add_usage(usage, u)
    log("  подготовка: %d символов, всего токенов %d/%d, поисков %d, %d сек" % (len(brief), usage["in"], usage["out"], usage["search"], time.time() - t0))
    row = {"deal": deal, "contact": ctx["contact"], "meet_at": ctx["meet_at"], "manager": ctx["manager"], "client": ctx["card"].get("Имя", ""),
           "company": ctx["company"], "niche": ctx["niche"], "turn": ctx["turn"], "staff": ctx["staff"],
           "geo": ", ".join(x for x in (ctx["city"], ctx["country"]) if x), "quiz_url": ctx["quiz_url"],
           "status": "ready", "facts": facts, "sources": sources, "cases": picked, "brief": brief,
           "model": MODEL, "tokens_in": usage["in"], "tokens_out": usage["out"], "searches": usage["search"],
           "amo_url": AMO_UI % deal, "error": ""}
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write("# Подготовка к встрече · сделка %d · %s · диагност %s\n\n%s\n\n---\n\n# Досье\n\n%s\n\n---\n\n# Участники\n\n%s\n" % (
                deal, ctx["meet_at"], ctx["manager"], brief, facts,
                "\n\n".join("## %s\n%s\n%s" % (cases_lines([c]), c.get("why", ""), c.get("growth", "")) for c in picked)))
        log("  записано в %s" % out_path)
    if not dry:
        shtab("POST", "/api/ingest", {"collector": "prep", "prep": [row]})
        log("  в витрине")
    return row


def cmd_run(deal, dry, out_path, cases_path):
    prompt = open(os.path.join(os.path.dirname(__file__), "prep_prompt.md"), encoding="utf-8").read()
    known, queued = set(), []
    if URL and STOKEN and not cases_path:
        j = shtab("GET", "/api/prep", params={"mode": "collector"})
        known = set(int(x) for x in j.get("known") or [])
        queued = [int(x) for x in j.get("queued") or []]
        cases = j.get("cases") or []
    else:
        cases = load_cases(cases_path)
    if not cases:
        log("ВНИМАНИЕ: база участников пуста — сперва python collector/prep.py cases")
    ids = targets(deal, known, queued)
    if not ids:
        log("готовить нечего")
        return
    done, failed = 0, 0
    for d in ids:
        try:
            process(d, cases, prompt, dry, out_path if deal else None)
            done += 1
        except Exception as e:
            failed += 1
            log("сделка %d: ОШИБКА %s" % (d, str(e)[:200]))
            if not dry and URL and STOKEN:
                try:
                    shtab("POST", "/api/ingest", {"collector": "prep", "prep": [{"deal": d, "status": "error", "error": str(e)[:300], "amo_url": AMO_UI % d}]})
                except Exception:
                    pass
    log("готово: %d, с ошибкой: %d" % (done, failed))
    if failed and not done:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["cases", "run"])
    ap.add_argument("--deal", type=int)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--cases")
    a = ap.parse_args()
    if not AMO_TOKEN:
        sys.exit("нет AMO_TOKEN")
    if a.cmd == "cases":
        cmd_cases(a.out)
    else:
        if not LLM_KEY:
            sys.exit("нет LLM_API_KEY")
        cmd_run(a.deal, a.dry, a.out, a.cases)


if __name__ == "__main__":
    main()
