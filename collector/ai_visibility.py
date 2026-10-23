"""Трекер видимости в ИИ-ответах (23.10.2026, передан из треда «Видимость в ИИ»).

Раз в неделю (ai-visibility.yml) задаёт вопросы из ai_queries.txt ChatGPT (ProxyAPI + web_search) и Яндексу
(генеративный ответ Search API) через ai_tracker.py и пишет в витрину:
  web.ai.hit  (dim = движок)            — в скольких ответах нас назвали или дали ссылку на *.gitelman.team
  web.ai.n    (dim = движок)            — сколько ответов получено
  web.ai.q    (dim = «движок|вопрос»)   — 1/0 по каждому вопросу (для «появились / пропали»)
  web.ai.dom  (dim = «движок|домен»)    — сколько раз ИИ процитировал чужой домен (топ-20)
Период — день прогона (МСК), ptype=day. Траты — строками в «Бюджет и расходы». Появились / пропали — сообщением админу в Telegram.
Окружение: PROXYAPI_KEY_TRACKER, YANDEX_SEARCH_API_KEY, SHTAB_URL, SHTAB_TOKEN, BUDGET_RUB; --dry — без записи в витрину.
"""
import argparse
import collections
import datetime as dt
import json
import os
import sys
import urllib.error

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ai_tracker as T  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MSK = dt.timezone(dt.timedelta(hours=3))
NAMES = {"chatgpt": "ChatGPT", "yandex": "Яндекс"}


def queries():
    with open(os.path.join(HERE, "ai_queries.txt"), encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip() and not l.startswith("#")]


def shtab(method, path, **kw):
    r = requests.request(method, os.environ["SHTAB_URL"].rstrip("/") + path,
                         headers={"Authorization": "Bearer " + os.environ["SHTAB_TOKEN"]}, timeout=120, **kw)
    r.raise_for_status()
    return r.json()


def run(qs, log=print):
    rows, spent = [], 0.0
    for q in qs:
        if T.BUDGET_RUB and spent >= T.BUDGET_RUB:
            log("стоп: потрачено ~%.0f ₽ из потолка %.0f ₽" % (spent, T.BUDGET_RUB))
            break
        for name, fn in T.ENGINES.items():
            try:
                ans = fn(q)
            except (urllib.error.URLError, ValueError, KeyError) as e:
                log("[%s] ошибка: %s" % (name, str(e)[:200]))
                continue
            if ans is None:
                continue
            a = T.analyse(ans)
            spent += ans.get("cost_rub") or 0
            rows.append({"engine": name, "query": q, "hit": bool(a["mentioned"] or a["our_links"]), "domains": a["domains"],
                         "cost": ans.get("cost_rub") or 0, "answer": ans["text"]})
            log("[%s] %s · %s" % (name, "ДА " if rows[-1]["hit"] else "нет", q[:70]))
    return rows, spent


def points(rows, day):
    out, by = [], collections.defaultdict(list)
    for r in rows:
        by[r["engine"]].append(r)
    for eng, rs in by.items():
        out.append({"metric": "web.ai.n", "ptype": "day", "period": day, "dim": eng, "value": len(rs)})
        out.append({"metric": "web.ai.hit", "ptype": "day", "period": day, "dim": eng, "value": sum(r["hit"] for r in rs)})
        for r in rs:
            out.append({"metric": "web.ai.q", "ptype": "day", "period": day, "dim": eng + "|" + r["query"][:180], "value": 1 if r["hit"] else 0})
        doms = collections.Counter(d for r in rs for d in set(r["domains"]) if d and not d.endswith(T.OUR_DOMAINS))
        for d, n in doms.most_common(20):
            out.append({"metric": "web.ai.dom", "ptype": "day", "period": day, "dim": eng + "|" + d, "value": n})
    return out


def changes(rows, day):
    """Сравнение с прошлым прогоном: по каким вопросам нас стали называть и перестали."""
    since = (dt.date.fromisoformat(day) - dt.timedelta(days=45)).isoformat()
    prev = shtab("GET", "/api/points", params={"metric": "web.ai.q", "ptype": "day", "from": since, "to": day}).get("rows", [])
    prev = [p for p in prev if p["period"] < day]
    if not prev:
        return ""
    last = max(p["period"] for p in prev)
    was = {p["dim"]: p["value"] for p in prev if p["period"] == last}
    up, down = [], []
    for r in rows:
        k = r["engine"] + "|" + r["query"][:180]
        if k not in was:
            continue
        if r["hit"] and not was[k]:
            up.append("%s: %s" % (NAMES.get(r["engine"], r["engine"]), r["query"]))
        if not r["hit"] and was[k]:
            down.append("%s: %s" % (NAMES.get(r["engine"], r["engine"]), r["query"]))
    if not (up or down):
        return ""
    txt = "Видимость в ИИ-ответах, прогон %s (прошлый %s)." % (day, last)
    if up:
        txt += "\n\nСтали называть нас:\n" + "\n".join("• " + x for x in up)
    if down:
        txt += "\n\nПерестали называть:\n" + "\n".join("• " + x for x in down)
    return txt + "\n\nПодробно: " + os.environ["SHTAB_URL"].rstrip("/") + "/marketing/site/svodka/"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="только первые N вопросов (проба)")
    ap.add_argument("--dry", action="store_true", help="не писать в витрину")
    ap.add_argument("--out", default="", help="папка для полного JSON с ответами")
    ap.add_argument("--from", dest="src", default="", help="записать прошлый прогон из его JSON, не спрашивая ИИ заново")
    args = ap.parse_args()
    total = len(queries())
    if args.src:
        with open(args.src, encoding="utf-8") as f:
            saved = json.load(f)
        day, rows, spent = saved["day"], saved["results"], saved["cost_rub"]
    else:
        qs = queries()[: args.limit or None]
        day = dt.datetime.now(MSK).date().isoformat()
        rows, spent = run(qs)
    if not rows:
        sys.exit("нет ни одного ответа: проверьте ключи PROXYAPI_KEY_TRACKER и YANDEX_SEARCH_API_KEY")
    for eng in sorted({r["engine"] for r in rows}):
        rs = [r for r in rows if r["engine"] == eng]
        print("%s: нас называют в %d из %d" % (NAMES.get(eng, eng), sum(r["hit"] for r in rs), len(rs)))
    print("потрачено ~%.2f ₽" % spent)
    if args.out and not args.src:
        with open(os.path.join(args.out, "ai-visibility-%s.json" % day), "w", encoding="utf-8") as f:
            json.dump({"day": day, "cost_rub": round(spent, 2), "results": rows}, f, ensure_ascii=False, indent=1)
    pts = points(rows, day)
    exp = []
    for eng, svc in (("chatgpt", "ProxyAPI"), ("yandex", "Yandex Cloud")):
        amt = round(sum(r["cost"] for r in rows if r["engine"] == eng), 2)
        n = sum(1 for r in rows if r["engine"] == eng)
        if n:
            trial = "" if n >= total else "проба: %d вопр. из %d, " % (n, total)
            exp.append({"day": day, "service": svc, "kind": "spend", "amount": amt, "qty": n, "item": "трекер видимости в ИИ · " + NAMES[eng],
                        "note": trial + "ответов: %d, оценка по тарифу" % n, "ref": "ai-visibility:%s:%s" % (eng, day)})
    if args.dry:
        print(json.dumps({"points": len(pts), "expenses": exp}, ensure_ascii=False))
        return
    note = ""
    try:
        note = changes(rows, day)
    except Exception as e:  # noqa: BLE001 — сравнение не должно ронять запись
        print("сравнение с прошлым прогоном не удалось:", e)
    body = {"collector": "ai-visibility", "points": pts, "expenses": exp}
    if note:
        body["notify"] = note
    print(shtab("POST", "/api/ingest", json=body))


if __name__ == "__main__":
    main()
