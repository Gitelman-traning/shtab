# -*- coding: utf-8 -*-
"""
Запись встречи Zoom → текст с разметкой «Менеджер: … / Клиент: …» и таймкодами [мм:сс].
Тот же путь, что в ОКК (okk/diarize.py): Apify достаёт файл по share-ссылке и коду, Deepgram nova-3 с diarize=true делит речь,
менеджер — тот, в чьей речи чаще звучат слова продавца (тренинг, комитет, поток, цена).
Окружение: APIFY_TOKEN, DEEPGRAM_TOKEN.
"""
import os
import re
import tempfile
import time

import requests

APIFY_TOKEN = os.environ.get("APIFY_TOKEN", "").strip()
DEEPGRAM_TOKEN = os.environ.get("DEEPGRAM_TOKEN", "").strip()
APIFY_TASK = os.environ.get("APIFY_TASK", "gyglem~my-actor-1-task")
DEEPGRAM_URL = "https://api.deepgram.com/v1/listen?model=nova-3&language=ru&smart_format=true&diarize=true&utterances=true"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
SELLER_WORDS = re.compile(r"комитет|тренинг|поток|программ\w*|павел|паш[аиеу]|стамбул|820|720|бронь|предоплат\w*|рассрочк\w*|заявк\w*", re.I)


def apify_audio(share_url, passcode, polls=40, every=30):
    r = requests.post("https://api.apify.com/v2/actor-tasks/%s/runs" % APIFY_TASK, params={"token": APIFY_TOKEN},
                      json={"shareUrl": share_url, "passcode": passcode}, timeout=60)
    r.raise_for_status()
    run_id = r.json()["data"]["id"]
    for _ in range(polls):
        time.sleep(every)
        s = requests.get("https://api.apify.com/v2/actor-runs/%s" % run_id, params={"token": APIFY_TOKEN}, timeout=60)
        s.raise_for_status()
        status = s.json()["data"]["status"]
        if status in ("READY", "RUNNING", "TIMING-OUT"):
            continue
        if status != "SUCCEEDED":
            raise RuntimeError("Apify: статус %s" % status)
        break
    else:
        raise RuntimeError("Apify: не дождались записи")
    items = requests.get("https://api.apify.com/v2/actor-runs/%s/dataset/items" % run_id,
                         params={"token": APIFY_TOKEN, "clean": "true"}, timeout=120).json()
    if not items or not items[0].get("audio_url"):
        raise RuntimeError("Apify не вернул ссылку на запись (запись ещё обрабатывается в Zoom или неверный код)")
    return items[0]


def download(item):
    r = requests.get(item["audio_url"], headers={"Referer": item.get("finalUrl", ""), "Cookie": item.get("cookieHeader", ""),
                                                 "Origin": "https://us06web.zoom.us", "User-Agent": UA}, stream=True, timeout=900)
    r.raise_for_status()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    for chunk in r.iter_content(1 << 20):
        tmp.write(chunk)
    tmp.close()
    return tmp.name


def transcribe(path):
    with open(path, "rb") as f:
        r = requests.post(DEEPGRAM_URL, headers={"Content-Type": "video/mp4", "Authorization": "Token " + DEEPGRAM_TOKEN}, data=f, timeout=2400)
    r.raise_for_status()
    return r.json()


def labeled_text(dg):
    """Deepgram → «Менеджер: [мм:сс] …» / «Клиент: …», минуты записи."""
    utts = (dg.get("results") or {}).get("utterances") or []
    if not utts:
        raise RuntimeError("Deepgram вернул ответ без разбивки по говорящим")
    hits, talk = {}, {}
    for u in utts:
        sp = u.get("speaker", 0)
        hits[sp] = hits.get(sp, 0) + len(SELLER_WORDS.findall(u.get("transcript") or ""))
        talk[sp] = talk.get(sp, 0) + float(u.get("end", 0)) - float(u.get("start", 0))
    manager = max(hits, key=hits.get) if any(hits.values()) else max(talk, key=talk.get)
    lines, prev, buf = [], None, []
    for u in utts:
        sp = u.get("speaker", 0)
        who = "Менеджер" if sp == manager else ("Клиент" if len(talk) <= 2 else "Клиент %d" % sp)
        if who != prev and buf:
            lines.append("%s: %s" % (prev, " ".join(buf)))
            buf = []
        prev = who
        mm, ss = divmod(int(float(u.get("start", 0))), 60)
        buf.append(("[%d:%02d] " % (mm, ss) if not buf else "") + (u.get("transcript") or ""))
    if buf:
        lines.append("%s: %s" % (prev, " ".join(buf)))
    minutes = float((dg.get("metadata") or {}).get("duration") or 0) / 60
    return "\n\n".join(lines), minutes


def zoom_to_text(share_url, passcode):
    """→ (размеченный текст, минут записи)."""
    if not (APIFY_TOKEN and DEEPGRAM_TOKEN):
        raise RuntimeError("нет APIFY_TOKEN / DEEPGRAM_TOKEN")
    path = download(apify_audio(share_url, passcode))
    try:
        return labeled_text(transcribe(path))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
