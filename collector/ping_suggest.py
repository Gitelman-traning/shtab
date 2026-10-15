#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пинги по договорённостям из разбора встречи (раздел «Пинги» Штаба, /sales/l2/pings/).

  python collector/ping_suggest.py --deal ID [--dry] [--silent]

Берёт разбор встречи (prep_debrief) из Штаба, проверяет в amo, что сделка ещё открыта, и просит модель предложить пинги:
повод, срок, сообщение и сценарий кружочка (промпт — collector/ping_prompt.md). Срок считает код. Клиенту ничего не отправляется:
предложения ложатся в Штаб, в день пинга менеджер получает их в Telegram (--silent — без Telegram, для теста).
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402

PROMPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ping_prompt.md")
MODEL = os.environ.get("PING_MODEL") or "claude-opus-5-5"      # 15.10.2026: текст уходит клиенту — качество важнее цены
CLOSED = (142, 143)


def work_days_after(day, n):
    d = day
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def due_day(when, meeting, today):
    t = (when or {}).get("type")
    if t == "date":
        try:
            return max(dt.date.fromisoformat(when.get("date")), today)
        except (TypeError, ValueError):
            return today
    if t == "work_days_after_meeting":
        return max(work_days_after(meeting, int(when.get("days") or 3)), today)
    d = today                                   # asap: сегодня, в выходные — понедельник
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deal", type=int, required=True)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--silent", action="store_true")
    a = ap.parse_args()
    res = prep.shtab("GET", "/api/prep", params={"deal": a.deal})
    deb = res.get("debrief") or {}
    if not deb.get("text"):
        sys.exit("по сделке %d нет разбора встречи" % a.deal)
    lead = prep.amo("/leads/%d" % a.deal)
    if lead.get("status_id") in CLOSED:
        prep.log("сделка %d закрыта (статус %s) — пингов не предлагаем" % (a.deal, lead.get("status_id")))
        return
    today = dt.datetime.now(prep.MSK).date()
    try:
        meeting = dt.date.fromisoformat((deb.get("meeting_at") or "")[:10])
    except ValueError:
        meeting = today
    user = "Сегодня %s. Встреча была %s. Менеджер: %s. Клиент: %s%s.\n\n# РАЗБОР ВСТРЕЧИ\n%s" % (
        today.isoformat(), meeting.isoformat(), deb.get("manager") or "", deb.get("client") or "клиент",
        (" · " + deb["company"]) if deb.get("company") else "", deb["text"])
    out, _, u = prep.claude(open(PROMPT, encoding="utf-8").read(), user, max_tokens=4000, model=MODEL)
    m = re.search(r"\{.*\}", out, re.S)
    pings = (json.loads(m.group(0)) if m else {}).get("pings") or []
    rows = []
    for p in pings[:3]:
        rows.append({"deal": a.deal, "manager": deb.get("manager") or "", "client": deb.get("client") or "", "company": deb.get("company") or "",
                     "due_day": due_day(p.get("when"), meeting, today).isoformat(), "reason": p.get("reason") or "",
                     "loyalty": deb.get("loyalty"), "text": (p.get("text") or "").replace("—", "-"), "script": (p.get("script") or "").replace("—", "-"),
                     "model": MODEL})
    prep.log("пинги %d: предложено %d, токенов %d/%d, ≈ %.0f ₽" % (a.deal, len(rows), u.get("in", 0), u.get("out", 0), prep.cost(u)))
    for r in rows:
        prep.log("  %s · %s" % (r["due_day"], r["reason"][:120]))
    if a.dry:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return
    if rows:
        print(prep.shtab("POST", "/api/pings", {"action": "suggest", "silent": a.silent, "rows": rows}))
    prep.shtab("POST", "/api/ingest", {"collector": "prep", "expenses": [prep.spend_row("пинги", a.deal, u)]})


if __name__ == "__main__":
    main()
