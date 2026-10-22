#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Конверсии Второй линии «неделя до / неделя после» инструмента (подготовка → разбор → пинги), по диагностам.

  python collector/conv_report.py --before 2026-10-06 --after 2026-10-15 [--days 7] [--out report.json]

Когорта: сделки, которые за неделю ВОШЛИ в этап (событие смены статуса в amo); доля тех, что за --days дней после входа
продвинулись дальше по воронке (на любой более поздний этап, кроме «закрыто»). У обеих недель окно одинаковое.
Диагност = ответственный по сделке сейчас. Только чтение amo (токен Reports), ничего не пишет.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402

MSK = prep.MSK
LOST = 143


def ts(day):
    return int(dt.datetime.fromisoformat(day).replace(tzinfo=MSK).timestamp())


def stages():
    """{status_id: (pipeline_id, sort, name)} по воронкам Второй линии."""
    out = {}
    for pid in prep.L2_PIPES:
        p = prep.amo("/leads/pipelines/%d" % pid)
        for s in (p.get("_embedded") or {}).get("statuses") or []:
            out[(pid, s["id"])] = (s["sort"], s["name"])
    return out


def status_events(t0, t1):
    """События смены статуса сделок за [t0, t1) окнами по 2 дня (глубокая пагинация в amo падает)."""
    ev, a = [], t0
    while a < t1:
        b = min(a + 2 * 86400, t1)
        page = 1
        while True:
            j = prep.amo("/events", {"filter[type]": "lead_status_changed", "filter[created_at][from]": a,
                                     "filter[created_at][to]": b - 1, "limit": 100, "page": page})
            items = (j.get("_embedded") or {}).get("events") or []
            for e in items:
                try:
                    before = e["value_before"][0]["lead_status"]
                    after = e["value_after"][0]["lead_status"]
                except (KeyError, IndexError, TypeError):
                    continue
                ev.append({"lead": e["entity_id"], "at": e["created_at"], "from": (before.get("pipeline_id"), before.get("id")),
                           "to": (after.get("pipeline_id"), after.get("id"))})
            if len(items) < 100:
                break
            page += 1
            time.sleep(0.2)
        a = b
    return ev


def responsible(ids):
    out = {}
    ids = list(ids)
    for i in range(0, len(ids), 50):
        j = prep.amo("/leads", {"filter[id][]": ids[i:i + 50], "limit": 50})
        for l in (j.get("_embedded") or {}).get("leads") or []:
            out[l["id"]] = prep.user_name(l.get("responsible_user_id"))
        time.sleep(0.2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True, help="начало недели «до», YYYY-MM-DD")
    ap.add_argument("--after", required=True, help="начало недели «после», YYYY-MM-DD")
    ap.add_argument("--days", type=int, default=7, help="окно продвижения после входа в этап")
    ap.add_argument("--out")
    a = ap.parse_args()
    weeks = {"до": ts(a.before), "после": ts(a.after)}
    st = stages()
    t0 = min(weeks.values())
    t1 = min(max(weeks.values()) + 7 * 86400 + a.days * 86400, int(time.time()))
    ev = [e for e in status_events(t0, t1) if e["to"] in st or e["from"] in st]
    prep.log("событий смены этапа на Второй линии: %d" % len(ev))
    who = responsible({e["lead"] for e in ev})
    by_lead = defaultdict(list)
    for e in ev:
        by_lead[e["lead"]].append(e)
    # когорты: (неделя, диагност, этап) → сделки вошли / из них продвинулись за окно
    res = defaultdict(lambda: [set(), set()])
    for lead, es in by_lead.items():
        es.sort(key=lambda x: x["at"])
        for k, e in enumerate(es):
            if e["to"] not in st or e["to"][1] == LOST:
                continue
            for wk, w0 in weeks.items():
                if not (w0 <= e["at"] < w0 + 7 * 86400):
                    continue
                cell = res[(wk, who.get(lead, "?"), e["to"])]
                cell[0].add(lead)
                sort_in = st[e["to"]][0]
                for f in es[k + 1:]:
                    if f["at"] > e["at"] + a.days * 86400:
                        break
                    if f["to"] in st and f["to"][1] != LOST and st[f["to"]][0] > sort_in:
                        cell[1].add(lead)
                        break
    rows = []
    for (wk, mgr, stage), (entered, moved) in sorted(res.items(), key=lambda x: (x[0][1], st[x[0][2]][0], x[0][0])):
        rows.append({"week": wk, "manager": mgr, "pipeline": stage[0], "stage": st[stage][1], "sort": st[stage][0],
                     "entered": len(entered), "moved": len(moved), "pct": round(100 * len(moved) / len(entered)) if entered else None})
    json.dump({"before": a.before, "after": a.after, "days": a.days, "rows": rows}, open(a.out or "conv_report.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    prep.log("строк: %d → %s" % (len(rows), a.out or "conv_report.json"))


if __name__ == "__main__":
    main()
