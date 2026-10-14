#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Разбор диагностики после встречи (раздел «Разбор встречи» Штаба, /sales/l2/debrief/).

  python collector/debrief.py --deal ID --transcript diar.txt [--dry] [--out debrief.md]

Вход: расшифровка с разметкой «Менеджер: … / Клиент: …» и таймкодами (Deepgram diarize, как okk/diarize.py) + карточка сделки amo.
Выход: лояльность X/10, ключ для следующей встречи, PING_CONTEXT (формат — collector/debrief_prompt.md) → /api/ingest prep_debrief.
Модель и ключ — как у подготовки (prep.py: ProxyAPI, PREP_MODEL). Шаг распознавания по записи Zoom добавим, когда формат утвердят.
"""
import argparse
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prep  # noqa: E402

PROMPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debrief_prompt.md")


def deal_card(deal):
    lead = prep.amo("/leads/%d" % deal, {"with": "contacts"})
    cf = prep.cf_map(lead)
    names = {}
    for f in lead.get("custom_fields_values") or []:
        names[f.get("field_id")] = f.get("field_name") or ""
    keep = re.compile(r"компани|сайт|ниша|оборот|сотрудник|должност|диагност|встреча|комитет", re.I)
    lines = ["Карточка сделки amo (заполнена менеджерами; чего нет — неизвестно):"]
    for fid, v in cf.items():
        n = names.get(fid, "")
        if keep.search(n) and not re.search(r"ссылка|код|zoom|форм", n, re.I):
            lines.append("- %s: %s" % (n, str(v)[:200]))
    return lead, "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deal", type=int, required=True)
    ap.add_argument("--transcript", required=True, help="расшифровка с разметкой говорящих")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--client", default="")
    ap.add_argument("--company", default="")
    ap.add_argument("--meeting", default="")
    a = ap.parse_args()
    t0 = time.time()
    text = open(a.transcript, encoding="utf-8").read()
    lead, card = deal_card(a.deal)
    manager = prep.user_name(lead.get("responsible_user_id"))
    user = "%s\n- Менеджер (диагност): %s\n\n# РАСШИФРОВКА ВСТРЕЧИ (Менеджер / Клиент, [мм:сс])\n%s" % (card, manager, text)
    out, _, u = prep.claude(open(PROMPT, encoding="utf-8").read(), user, max_tokens=4000)
    rub = prep.cost(u)
    m = re.search(r"Лояльность:\s*(\d+)", out)
    loyalty = int(m.group(1)) if m else None
    prep.log("разбор %d: %d символов, токенов %d/%d, %d сек, ≈ %.0f ₽, лояльность %s" % (
        a.deal, len(out), u.get("in", 0), u.get("out", 0), time.time() - t0, rub, loyalty))
    body = "# Разбор встречи · сделка %d · %s · диагност %s\n\n%s" % (a.deal, " · ".join(x for x in (a.client, a.company) if x) or "клиент", manager, out)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(body)
    if not a.dry:
        prep.shtab("POST", "/api/ingest", {"collector": "prep", "prep_debrief": [{
            "deal": a.deal, "text": body, "loyalty": loyalty, "client": a.client, "company": a.company, "manager": manager,
            "meeting_at": a.meeting, "model": prep.MODEL, "cost": "модель ≈ %.0f ₽" % rub}],
            "expenses": [prep.spend_row("разбор встречи", a.deal, dict(u, rub=rub))]})
        prep.log("записано в Штаб")


if __name__ == "__main__":
    main()
