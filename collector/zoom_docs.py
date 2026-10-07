#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ссылки на расшифровки встреч диагноста из таблицы «маркетинг» (лист «дпд» — ID сделки → документ с расшифровкой,
лист «⬇️ОБЩАЯ ВЫГРУЗКА» — ID сделки → ответственный). Нужны для портрета стиля вопросов (prep.py).

  python collector/zoom_docs.py "Кротов" docs.json

В файл попадают только номер сделки и ссылка на документ — без имён клиентов и содержания.
Окружение: SHEET_ID (таблица «маркетинг»), GOOGLE_SERVICE_ACCOUNT_JSON.
"""
import json
import os
import re
import sys

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SHEET_ID = os.environ.get("SHEET_ID", "1gbj-FGKRnc5Cm4s5_qFfHpx-gHqL3Bn37FQbR8gTpuY")


def main():
    who = sys.argv[1] if len(sys.argv) > 1 else "Кротов"
    out = sys.argv[2] if len(sys.argv) > 2 else "docs.json"
    creds = Credentials.from_service_account_info(json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]),
                                                  scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    v = build("sheets", "v4", credentials=creds, cache_discovery=False).spreadsheets().values()
    # ответственный по ID сделки
    owners = {}
    for r in v.get(spreadsheetId=SHEET_ID, range="'⬇️ОБЩАЯ ВЫГРУЗКА'!A1:B20000").execute().get("values", []):
        if len(r) >= 2 and re.fullmatch(r"\d{6,}", r[0].strip()):
            owners[r[0].strip()] = r[1].strip()
    rows = v.get(spreadsheetId=SHEET_ID, range="'дпд'!1:100000").execute().get("values", [])
    found, total = [], 0
    for r in rows[1:]:
        deal = next((c.strip() for c in r if re.fullmatch(r"\d{8}", c.strip())), "")
        doc = next((c.strip() for c in r if "docs.google.com/document" in c), "")
        if not deal or not doc:
            continue
        total += 1
        row_owner = next((c for c in r if who.lower() in c.lower()), "")
        if who.lower() in owners.get(deal, "").lower() or row_owner:
            m = re.search(r"/d/([\w-]+)", doc)
            if m:
                found.append({"deal": int(deal), "doc": m.group(1)})
    print("в «дпд» строк с расшифровкой: %d, из них «%s»: %d" % (total, who, len(found)))
    with open(out, "w", encoding="utf-8") as f:
        json.dump(found, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
