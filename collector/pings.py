#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пинги Второй линии, сторона координатора (полуручной режим: бот готовит текст, менеджер отправляет сам).

  python collector/pings.py prepare <manager> <candidates.json>   — из amo (только чтение): сделки в рабочих этапах, контекст, обезличенно
  python collector/pings.py deliver <plan.json> [--dry]            — модель пишет текст, черновик менеджеру в Telegram, журнал в витрину

Между ними — логика менеджера из репозитория pings-bot (bot.plan), она работает без сети и ключей.
Окружение: AMO_TOKEN, SHTAB_URL, SHTAB_TOKEN (prepare и deliver); LLM_BASE_URL, LLM_API_KEY, TG_BOT_TOKEN (deliver).
В модель уходит текст без телефонов, почт, ссылок и имён клиента: имя подставляется в готовый текст на нашей стороне.
"""
import datetime as dt
import json
import os
import re
import sys
import time

import requests

MSK = dt.timezone(dt.timedelta(hours=3))
AMO = "https://pavelgitelman.amocrm.ru/api/v4"
AMO_TOKEN = os.environ.get("AMO_TOKEN", "").strip()
URL = os.environ.get("SHTAB_URL", "").rstrip("/")
STOKEN = os.environ.get("SHTAB_TOKEN", "").strip()

MANAGERS = {
    "krotov": {"amo_user_id": 11482398, "name": "Евгений Кротов", "tg_match": "Кротов",
               # рабочие этапы Второй линии: после диагностики и до «Клиент прислал чек»
               "statuses": {9701010: [77332734, 85919918, 77332974, 77332978, 77350850, 77332742, 77332982],
                            8733518: [70705238, 77290714, 70705242, 71406938, 70705710, 70705714]}},
}
STAGE = {77332734: "диагностика проведена", 85919918: "повторка проведена", 77332974: "подали заявку на комитет",
         77332978: "комитет одобрил", 77350850: "клиент отреагировал", 77332742: "клиент подтвердил дату", 77332982: "счёт выставлен",
         70705238: "диагностика проведена", 77290714: "комитетский слот подтвердил", 70705242: "повторная диагностика проведена",
         71406938: "передали в прогрев", 70705710: "предложение согласовано", 70705714: "договор / счёт отправлен"}
F_DIAG, F_NICHE, F_TURN, F_STAFF = 1444167, 1447471, 1442933, 1426297
NAME_TOKEN = "{ИМЯ}"


def log(*a):
    print(*a, flush=True)


def amo(path, params=None):
    for a in range(6):
        r = requests.get(AMO + path, headers={"Authorization": "Bearer " + AMO_TOKEN}, params=params, timeout=90)
        if r.status_code == 204:
            return {}
        if r.status_code == 200:
            return r.json()
        if r.status_code == 401:
            sys.exit("amo 401")
        time.sleep(1.5 + 2 * a)
    raise RuntimeError("amo не ответил: %s" % path)


def shtab(method, path, body=None, params=None):
    r = requests.request(method, URL + path, headers={"Authorization": "Bearer " + STOKEN, "User-Agent": "shtab-pings"},
                         json=body, params=params, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError("Штаб %s %s → %s %s" % (method, path, r.status_code, r.text[:200]))
    return r.json()


def cf(lead, fid):
    for f in lead.get("custom_fields_values") or []:
        if f["field_id"] == fid and f.get("values"):
            return f["values"][0].get("value")
    return None


# ---------- обезличивание ----------

RE_PHONE = re.compile(r"\+?\d[\d\s\-()]{8,}\d")
RE_MAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
RE_URL = re.compile(r"https?://\S+|www\.\S+|t\.me/\S+")
RE_HANDLE = re.compile(r"@[A-Za-z0-9_]{4,}")


def anon(text, names):
    t = RE_URL.sub("[ссылка]", text or "")
    t = RE_MAIL.sub("[почта]", t)
    t = RE_PHONE.sub("[телефон]", t)
    t = RE_HANDLE.sub("[ник]", t)
    for n in names:
        if n and len(n) >= 3:
            t = re.sub(r"\b%s\w*" % re.escape(n), NAME_TOKEN, t, flags=re.I)
    return t.strip()


def name_parts(contact_name):
    parts = [p for p in re.split(r"[\s,.()]+", contact_name or "") if p and not p.isdigit() and not RE_PHONE.fullmatch(p)]
    return parts[:3]


# ---------- prepare ----------

def prepare(key, out):
    card = MANAGERS[key]
    now = time.time()
    leads = []
    for pid, sts in card["statuses"].items():
        params = {"filter[responsible_user_id]": card["amo_user_id"], "limit": 250, "with": "contacts"}
        for i, s in enumerate(sts):
            params["filter[statuses][%d][pipeline_id]" % i] = pid
            params["filter[statuses][%d][status_id]" % i] = s
        page = 1
        while True:
            j = amo("/leads", dict(params, page=page))
            ls = (j.get("_embedded") or {}).get("leads") or []
            leads += ls
            if len(ls) < 250:
                break
            page += 1
    log("сделок в рабочих этапах: %d" % len(leads))
    sent = {}
    try:
        for r in shtab("GET", "/api/pings", params={"manager": key}).get("rows", []):
            s = sent.setdefault(int(r["deal"]), {"n": 0, "last": 0})
            s["n"] += 1
            s["last"] = max(s["last"], dt.datetime.fromisoformat(r["day"]).replace(tzinfo=MSK).timestamp())
    except Exception as e:
        log("журнал пингов не прочитан (%s) — считаем, что пингов не было" % e)
    deals = []
    for l in leads:
        main = [c["id"] for c in (l.get("_embedded") or {}).get("contacts") or [] if c.get("is_main")]
        contact, related = {}, [l["id"]]
        if main:
            contact = amo("/contacts/%d" % main[0], {"with": "leads"})
            related = [x["id"] for x in (contact.get("_embedded") or {}).get("leads") or []] or related
        names = name_parts(contact.get("name"))
        notes = []
        for lid in related[:6]:
            for n in ((amo("/leads/%d/notes" % lid, {"limit": 250}).get("_embedded") or {}).get("notes") or []):
                if n["note_type"] in ("common", "call_in", "call_out"):
                    p = n.get("params") or {}
                    if n["note_type"] == "common":
                        text = anon(p.get("text"), names)
                    else:
                        d = int(p.get("duration") or 0)
                        text = ("входящий" if n["note_type"] == "call_in" else "исходящий") + " звонок, %s" % ("разговор %d сек" % d if d >= 40 else "не дозвонились")
                    if text:
                        notes.append({"at": n["created_at"], "who": "менеджер" if n.get("created_by") else "система", "text": text[:500]})
            time.sleep(0.1)
        notes.sort(key=lambda x: x["at"])
        last_touch = max([x["at"] for x in notes] + [sent.get(l["id"], {}).get("last", 0)])
        diag = cf(l, F_DIAG) or l["created_at"]
        turn = cf(l, F_TURN)
        deals.append({
            "id": l["id"], "client": NAME_TOKEN, "stage": STAGE.get(l["status_id"], str(l["status_id"])),
            "days_since_diag": int((now - int(diag)) / 86400),
            "days_since_touch": int((now - last_touch) / 86400) if last_touch else None,
            "pings_done": sent.get(l["id"], {}).get("n", 0),
            "niche": ", ".join(str(x) for x in [cf(l, F_NICHE), ("%s млн" % turn) if turn else None, ("%s чел" % cf(l, F_STAFF)) if cf(l, F_STAFF) else None] if x),
            "history": [{"at": dt.datetime.fromtimestamp(x["at"], MSK).strftime("%d.%m.%y"), "who": x["who"], "text": x["text"]} for x in notes[-25:]],
        })
        time.sleep(0.1)
    data = {"manager": key, "day": dt.datetime.now(MSK).date().isoformat(), "deals": deals, "style": []}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    nt = sum(1 for d in deals if d["days_since_touch"] is None)
    log("кандидатов %d (без единого касания %d), записано в %s" % (len(deals), nt, out))


# ---------- deliver ----------

def llm(messages):
    base = os.environ.get("LLM_BASE_URL", "https://api.proxyapi.ru/v1").rstrip("/")
    model = os.environ.get("PINGS_MODEL", "anthropic/claude-sonnet-5")
    body = {"model": model, "messages": messages, "temperature": 0.4, "max_tokens": 600}
    if "claude" in model and not any(x in model for x in ("5-5", "fable")):
        body["thinking"] = {"type": "disabled"}
    r = requests.post(base + "/chat/completions", headers={"Authorization": "Bearer " + os.environ["LLM_API_KEY"]}, json=body, timeout=180)
    r.raise_for_status()
    msg = (r.json().get("choices") or [{}])[0].get("message") or {}
    text = msg.get("content") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    u = r.json().get("usage") or {}
    return text.strip().replace("—", "-").replace("–", "-"), u


def tg(chat, text):
    r = requests.post("https://api.telegram.org/bot%s/sendMessage" % os.environ["TG_BOT_TOKEN"],
                      json={"chat_id": chat, "text": text, "disable_web_page_preview": True}, timeout=60)
    return r.status_code == 200


def manager_chat(card):
    forced = os.environ.get("PINGS_TG_CHAT", "").strip()
    if forced:
        return forced
    for u in shtab("GET", "/api/users").get("users", []):
        if card["tg_match"].lower() in (u.get("name") or "").lower() and u.get("tg_id") and u.get("active"):
            return u["tg_id"]
    return None


def deliver(plan_path, dry):
    plan = json.load(open(plan_path, encoding="utf-8"))
    key = plan["manager"]
    card = MANAGERS[key]
    items = plan.get("items") or []
    chat = None if dry else manager_chat(card)
    if not dry and not chat:
        log("ВНИМАНИЕ: у %s нет Telegram в Штабе (войти на сайт кнопкой «Войти через Telegram») — черновики не отправлены" % card["name"])
        dry = True
    # настоящие имена — только здесь, для подстановки в готовый текст
    leads = {}
    ids = [it["deal"] for it in items]
    for i in range(0, len(ids), 50):
        p = {"limit": 250, "with": "contacts"}
        for k, x in enumerate(ids[i:i + 50]):
            p["filter[id][%d]" % k] = x
        for l in (amo("/leads", p).get("_embedded") or {}).get("leads") or []:
            leads[l["id"]] = l
    names = {}
    for lid, l in leads.items():
        main = [c["id"] for c in (l.get("_embedded") or {}).get("contacts") or [] if c.get("is_main")]
        nm = amo("/contacts/%d" % main[0]).get("name", "") if main else ""
        names[lid] = (name_parts(nm) or [""])[0]
    done, rows, cost_in, cost_out = 0, [], 0, 0
    day = dt.datetime.now(MSK).date().isoformat()
    drafts = []
    for it in items:
        try:
            text, u = llm(it["messages"])
        except Exception as e:
            log("сделка %s: модель не ответила (%s)" % (it["deal"], str(e)[:120]))
            continue
        cost_in += u.get("prompt_tokens") or 0
        cost_out += u.get("completion_tokens") or 0
        if not text or text.strip().upper().startswith("SKIP"):
            log("сделка %s: модель советует не писать" % it["deal"])
            continue
        first = names.get(it["deal"]) or ""
        text = text.replace(NAME_TOKEN, first) if first else text.replace(NAME_TOKEN + ", ", "").replace(NAME_TOKEN, "")
        drafts.append({"deal": it["deal"], "reason": it.get("reason", ""), "text": text})
        if not dry:
            msg = "Пинг · %s · %s\nhttps://pavelgitelman.amocrm.ru/leads/detail/%s\n\n%s" % (
                first or "клиент", it.get("reason", ""), it["deal"], text)
            if tg(chat, msg):
                done += 1
                rows.append({"day": day, "manager": key, "deal": it["deal"], "text": text, "reason": it.get("reason", "")})
            time.sleep(1.2)
    rub = cost_in * 600 / 1e6 + cost_out * 3030 / 1e6
    with open(os.environ.get("PINGS_DRAFTS", "drafts.json"), "w", encoding="utf-8") as f:
        json.dump(drafts, f, ensure_ascii=False, indent=1)
    if dry:
        log("ПРОБНЫЙ ПРОГОН: черновиков %d (в Telegram не отправлено), расход ≈ %.0f ₽" % (len(drafts), rub))
        return
    if rows:
        shtab("POST", "/api/ingest", {"collector": "pings", "pings": rows, "finalize": True, "run_note": "пинги %s: %d" % (key, len(rows))})
    tg(chat, "Сегодня подготовлено пингов: %d. Отправь клиентам из amo (Wazzup) и, если не отправляешь, просто пропусти." % done)
    log("черновиков отправлено менеджеру: %d, расход ≈ %.0f ₽" % (done, rub))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "prepare":
        prepare(sys.argv[2], sys.argv[3])
    elif cmd == "deliver":
        deliver(sys.argv[2], "--dry" in sys.argv)
    else:
        sys.exit(__doc__)
