#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Разбор диагностики после встречи (раздел «Разбор встречи» Штаба, /sales/l2/debrief/) и пинги по нему.

  python collector/debrief.py auto [--dry]                         — цепочка (решение Никиты 15.10.2026): сделки, по которым была
        подготовка → копия на Второй линии → появилась запись Zoom → распознавание с разметкой говорящих → разбор на Opus → пинги
  python collector/debrief.py held --deal ID [--dry]                — кнопка «Встреча проведена» в Штабе: ждём запись и сразу разбираем
  python collector/debrief.py one --deal ID [--transcript diar.txt] [--dry] [--out debrief.md] [--client …] [--company …] [--meeting …]
        — одна встреча: с готовой расшифровкой или по записи Zoom из сделки

Вход: расшифровка «Менеджер: … / Клиент: …» с таймкодами + карточка сделки amo. Выход: лояльность X/10, ключ для следующей встречи,
PING_CONTEXT (формат — collector/debrief_prompt.md) → /api/ingest prep_debrief, затем collector/ping_suggest.py.
Окружение: как у prep.py + APIFY_TOKEN, DEEPGRAM_TOKEN (распознавание). Цена — в бюджет Штаба.
"""
import argparse
import datetime as dt
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402
import recording  # noqa: E402
import ping_suggest  # noqa: E402

PROMPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debrief_prompt.md")
# 14.10.2026: Opus 5.5 заметно точнее Sonnet 5 на разборе (говорящие, обещания обеих сторон, поправки клиента) при ~63 ₽ за встречу
MODEL = os.environ.get("DEBRIEF_MODEL") or "claude-opus-5-5"
DAILY = int(os.environ.get("DEBRIEF_DAILY", "8"))              # предохранитель: не больше N разборов за запуск
SINCE = os.environ.get("DEBRIEF_SINCE", "2026-10-15")           # цепочка запущена 15.10.2026: старые тестовые подготовки не разбираем
DEEPGRAM_RUB_MIN = 0.45                                        # nova-3 ≈ $0.0048/мин ≈ 0,45 ₽/мин — для бюджета, оценка


def field_by_name(lead, rx):
    for f in lead.get("custom_fields_values") or []:
        if re.search(rx, f.get("field_name") or "", re.I):
            v = (f.get("values") or [{}])[0].get("value")
            if v not in (None, ""):
                return v
    return None


def deal_card(lead):
    cf = prep.cf_map(lead)
    names = {f.get("field_id"): f.get("field_name") or "" for f in lead.get("custom_fields_values") or []}
    keep = re.compile(r"компани|сайт|ниша|оборот|сотрудник|должност|диагност|встреча|комитет", re.I)
    lines = ["Карточка сделки amo (заполнена менеджерами; чего нет — неизвестно):"]
    for fid, v in cf.items():
        n = names.get(fid, "")
        if keep.search(n) and not re.search(r"ссылка|код|zoom|форм", n, re.I):
            if re.fullmatch(r"\d{10}", str(v)):     # даты amo приходят числом секунд
                v = time.strftime("%d.%m.%Y %H:%M", time.gmtime(int(v) + 3 * 3600)) + " МСК"
            lines.append("- %s: %s" % (n, str(v)[:200]))
    return "\n".join(lines)


def zoom_of(lead):
    """(ссылка, код) записи Zoom из полей сделки или None."""
    url = field_by_name(lead, r"ссылка zoom|zoom запис")
    if not url or "zoom.us" not in str(url):
        return None
    m = re.search(r"https://\S+", str(url))
    code = field_by_name(lead, r"код.*зум|код.*zoom") or ""
    code_in = re.search(r"(?:код|passcode)[:\s]*(\S+)", str(url), re.I)
    return m.group(0), (str(code).strip() or (code_in.group(1) if code_in else ""))


def l2_copy(deal):
    """Копия сделки на Второй линии (там запись Zoom и отметки диагностики): сама сделка, если она уже на Второй линии."""
    lead = prep.amo("/leads/%d" % deal, {"with": "contacts"})
    if lead.get("pipeline_id") in prep.L2_PIPES:
        return lead
    cid = prep.main_contact_id(lead)
    if not cid:
        return None
    contact = prep.amo("/contacts/%d" % cid, {"with": "leads"})
    best = None
    for x in (contact.get("_embedded") or {}).get("leads") or []:
        if x["id"] == deal:
            continue
        l = prep.amo("/leads/%d" % x["id"])
        if l.get("pipeline_id") in prep.L2_PIPES and (not best or (l.get("created_at") or 0) > (best.get("created_at") or 0)):
            best = l
        time.sleep(0.15)
    return best


def run(deal, text, client="", company="", meeting="", dry=False, out_path=None, extra_cost=0.0, minutes=0):
    t0 = time.time()
    lead = prep.amo("/leads/%d" % deal, {"with": "contacts"})
    manager = prep.user_name(lead.get("responsible_user_id"))
    user = "%s\n- Менеджер (диагност): %s\n\n# РАСШИФРОВКА ВСТРЕЧИ (Менеджер / Клиент, [мм:сс])\n%s" % (deal_card(lead), manager, text)
    out, _, u = prep.claude(open(PROMPT, encoding="utf-8").read(), user, max_tokens=4000, model=MODEL)
    rub = prep.cost(u)
    out = re.sub(r"(?m)^#{1,3}\s*(\d)\.", r"## \1.", out)   # заголовки разделов всегда «## N.» — по ним раскладывает страница
    m = re.search(r"Лояльность:\s*(\d+)", out)
    loyalty = int(m.group(1)) if m else None
    if loyalty:
        out = out.replace("Лояльность: X/10", "Лояльность: %d/10" % loyalty)   # модель иногда копирует заголовок шаблона
    prep.log("разбор %d: %d символов, токенов %d/%d, %d сек, ≈ %.0f ₽ + распознавание ≈ %.0f ₽, лояльность %s" % (
        deal, len(out), u.get("in", 0), u.get("out", 0), time.time() - t0, rub, extra_cost, loyalty))
    body = "# Разбор встречи · сделка %d · %s · диагност %s%s\n\n%s" % (
        deal, " · ".join(x for x in (client, company) if x) or "клиент", manager, (" · %d мин" % minutes) if minutes else "", out)
    if out_path:
        open(out_path, "w", encoding="utf-8").write(body)
    if dry:
        return body
    spend = [prep.spend_row("разбор встречи", deal, dict(u, rub=rub))]
    if extra_cost:
        spend.append({"day": dt.datetime.now(prep.MSK).strftime("%Y-%m-%d"), "service": "Deepgram", "kind": "spend", "amount": round(extra_cost, 1),
                      "item": "распознавание встречи · сделка %d" % deal, "note": "%d мин (оценка)" % minutes,
                      "ref": "deepgram:%d:%s" % (deal, dt.datetime.now(prep.MSK).strftime("%Y%m%d%H%M"))})
    prep.shtab("POST", "/api/ingest", {"collector": "prep", "prep_debrief": [{
        "deal": deal, "text": body, "loyalty": loyalty, "client": client, "company": company, "manager": manager, "meeting_at": meeting,
        "model": MODEL, "label": "Opus 5.5 · авто" if not out_path else "", "cost": "модель ≈ %.0f ₽%s" % (rub, (" + распознавание ≈ %.0f ₽" % extra_cost) if extra_cost else "")}],
        "expenses": spend})
    prep.log("записано в Штаб")
    return body


def one(a):
    if a.transcript:
        text, minutes, extra = open(a.transcript, encoding="utf-8").read(), 0, 0.0
    else:
        z = zoom_of(prep.amo("/leads/%d" % a.deal))
        if not z:
            sys.exit("в сделке %d нет ссылки на запись Zoom" % a.deal)
        text, minutes, fresh = recording.zoom_to_text(*z, deal=a.deal)
        extra = minutes * DEEPGRAM_RUB_MIN if fresh else 0.0
    run(a.deal, text, a.client, a.company, a.meeting, a.dry, a.out, extra, minutes)
    if not a.dry:
        ping_suggest.suggest(a.deal)


def post_status(rows, dry):
    """Состояние цепочки по сделкам → Штаб (раздел «Разбор встречи», блок «В работе»): plan / wait / running / error / ready."""
    if rows and not dry:
        try:
            prep.shtab("POST", "/api/ingest", {"collector": "prep", "debrief_status": rows})
        except Exception as e:
            prep.log("статус не записан: %s" % str(e)[:120])


def process(base, l2id, z, dry, retry_note):
    """Запись есть → расшифровка (общая, /api/transcript) → разбор → пинги. → статус для Штаба.
    Не скачалась / не распозналась → status "retry" (Zoom ещё готовит запись или временный сбой)."""
    post_status([dict(base, status="running", note="беру расшифровку записи")], dry)
    prep.log("сделка %d (Вторая линия %d): есть запись — разбираю" % (base["deal"], l2id))
    try:
        text, minutes, fresh = recording.zoom_to_text(*z, deal=l2id)
    except Exception as e:
        prep.log("  запись не получилась: %s" % str(e)[:160])
        return dict(base, status="retry", note=retry_note)
    if minutes < 5:
        prep.log("  запись %d мин — слишком короткая, пропускаю" % minutes)
        return dict(base, status="error", note="запись %d мин — слишком короткая, разбор не делаю" % minutes)
    post_status([dict(base, status="running", note="разбираю встречу (%d мин записи)" % minutes)], dry)
    try:
        run(l2id, text, base["client"], base["company"], (base.get("meet_at") or "")[:10], dry, None,
            minutes * DEEPGRAM_RUB_MIN if fresh else 0.0, minutes)
        if not dry:
            ping_suggest.suggest(l2id)
        return dict(base, status="ready", note="")
    except Exception as e:
        prep.log("  разбор не получился: %s" % str(e)[:160])
        return dict(base, status="error", note="разбор не получился — повторю через 30 минут")


def recording_deal(deal):
    """(сделка с записью, (ссылка, код) | None, номер копии на Второй линии | None): запись ищем в копии на Второй линии, затем в самой сделке."""
    l2 = l2_copy(deal)
    if l2 and zoom_of(l2):
        return l2["id"], zoom_of(l2), l2["id"]
    own = prep.amo("/leads/%d" % deal)
    if zoom_of(own):
        return deal, zoom_of(own), (l2 or {}).get("id")
    return None, None, (l2 or {}).get("id")


def auto(dry):
    """Сделки с подготовкой → копия на Второй линии с записью Zoom → разбор → пинги. Уже разобранные пропускаем.
    По каждой сделке пишем в Штаб, на чём она сейчас (15.10.2026: «через сколько появится разбор» видно на странице)."""
    preps = prep.shtab("GET", "/api/prep", params={"days": 21, "back": 30}).get("rows") or []
    deb = prep.shtab("GET", "/api/prep", params={"mode": "debriefs"})
    done = {int(r["deal"]) for r in (deb.get("rows") or [])}
    # по кнопке «Встреча проведена» сделку ведёт отдельный прогон (held) — пока он идёт, не трогаем
    fresh_run = (dt.datetime.utcnow() - dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M")
    busy = {int(r["deal"]) for r in (deb.get("pending") or []) if r.get("status") == "running" and (r.get("updated_at") or "") > fresh_run}
    now = dt.datetime.now(prep.MSK).strftime("%Y-%m-%d %H:%M")
    n, st = 0, []
    for p in preps:
        if p.get("status") != "ready" or (p.get("meet_at") or p.get("updated_at") or "")[:10] < SINCE:
            continue
        deal, meet = int(p["deal"]), p.get("meet_at") or ""
        if deal in busy:
            continue
        base = {"deal": deal, "client": p.get("client") or "", "company": p.get("company") or "", "manager": p.get("manager") or "", "meet_at": meet}
        if deal in done:
            st.append(dict(base, status="ready", note=""))
            continue
        if meet and meet > now:
            st.append(dict(base, status="plan", note="встреча впереди — после неё нажмите «Встреча проведена»"))
            continue
        if n >= DAILY:
            st.append(dict(base, status="wait", note="в очереди — разберу в следующий запуск"))
            continue
        rec, z, l2id = recording_deal(deal)
        if l2id:
            base["l2"] = l2id
        if (l2id and l2id in done) or (rec and rec in done):
            st.append(dict(base, status="ready", note=""))
            continue
        if not z:
            st.append(dict(base, status="wait", note="ждём ссылку на запись Zoom в сделке" if l2id else "ждём копию сделки на Второй линии"))
            continue
        post_status(st, dry)
        st = []
        r = process(base, rec, z, dry, "запись не скачалась или не распозналась — повторю через 30 минут")
        if r["status"] == "retry":
            r["status"] = "error"
        st.append(r)
        n += 1
    post_status(st, dry)
    prep.log("разборов за запуск: %d" % n)


def held(deal, dry, wait_min=100, every=300):
    """Кнопка «Встреча проведена» (15.10.2026): ждём ссылку на запись и саму запись (раз в 5 минут, до ~100 минут) → разбор → пинги."""
    p = prep.shtab("GET", "/api/prep", params={"deal": deal}).get("row") or {}
    base = {"deal": deal, "client": p.get("client") or "", "company": p.get("company") or "", "manager": p.get("manager") or "", "meet_at": p.get("meet_at") or ""}
    until = time.time() + wait_min * 60
    while True:
        rec, z, l2id = recording_deal(deal)
        if l2id:
            base["l2"] = l2id
        if z:
            r = process(base, rec, z, dry, "запись в Zoom ещё готовится — проверяю раз в 5 минут")
            if r["status"] != "retry":
                post_status([r], dry)
                prep.log("сделка %d: %s %s" % (deal, r["status"], r["note"]))
                return
            note = r["note"]
        else:
            note = "ждём ссылку на запись Zoom в сделке — проверяю раз в 5 минут"
        if time.time() + every > until:
            post_status([dict(base, status="wait", note="за 2 часа запись не появилась — дальше проверка раз в 30 минут")], dry)
            prep.log("сделка %d: запись не дождались" % deal)
            return
        post_status([dict(base, status="running", note=note)], dry)
        time.sleep(every)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["auto", "one", "held"])
    ap.add_argument("--deal", type=int)
    ap.add_argument("--transcript")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--client", default="")
    ap.add_argument("--company", default="")
    ap.add_argument("--meeting", default="")
    a = ap.parse_args()
    if a.cmd == "auto":
        auto(a.dry)
    elif a.cmd == "held":
        if not a.deal:
            sys.exit("нужен --deal")
        held(a.deal, a.dry)
    else:
        if not a.deal:
            sys.exit("нужен --deal")
        one(a)


if __name__ == "__main__":
    main()
