#!/usr/bin/env python3
"""Трекер видимости Gitelman в ИИ-ответах.

Задаёт ключевые вопросы из core-queries.md (репо potok) нескольким ИИ и пишет,
упомянули ли нас, сослались ли на наши сайты и кого цитируют вместо нас.

Запуск:  python3 tracker.py --core /path/to/potok/core-queries.md [--top 21] [--limit 3]
Ключи берутся из окружения:
  PROXYAPI_KEY                 — ChatGPT через proxyapi.ru (OpenAI Responses + web_search)
  YANDEX_SEARCH_API_KEY        — Яндекс, генеративный ответ Search API (необязательно)
  YANDEX_FOLDER_ID             — каталог Yandex Cloud для Search API
  PRICE_IN_RUB_PER_1M / PRICE_OUT_RUB_PER_1M — тариф модели в ProxyAPI, ₽ за 1 млн токенов
  PRICE_SEARCH_RUB (по умолч. 1), BUDGET_RUB — потолок трат на прогон
Без ключа движок пропускается. Только стандартная библиотека Python.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

# старый адрес /openai/v1/responses помечен устаревшим (sunset 01.02.2027)
PROXYAPI_URL = os.environ.get("PROXYAPI_URL", "https://api.proxyapi.ru/v1/responses")
PROXYAPI_MODEL = os.environ.get("PROXYAPI_MODEL", "openai/gpt-5-mini")
# ProxyAPI не отдаёт цену в ответе — считаем сами по тарифу из кабинета (₽ с НДС)
# Умолчания для gpt-5-mini сверены с логом кабинета ProxyAPI 23.10.2026 (совпадение до копейки)
PRICE_IN = float(os.environ.get("PRICE_IN_RUB_PER_1M", "65"))       # ввод, ₽ за 1 млн токенов
PRICE_CACHED = float(os.environ.get("PRICE_CACHED_RUB_PER_1M", "6.5"))  # ввод из кеша
PRICE_OUT = float(os.environ.get("PRICE_OUT_RUB_PER_1M", "516"))    # вывод, ₽ за 1 млн токенов
PRICE_SEARCH = float(os.environ.get("PRICE_SEARCH_RUB", "1"))   # поиск web_search, ₽ за вызов
PRICE_YANDEX = float(os.environ.get("PRICE_YANDEX_RUB", "4"))   # генеративный ответ Яндекса, ₽ за запрос (оценка, сверить с биллингом)
BUDGET_RUB = float(os.environ.get("BUDGET_RUB", "0"))           # потолок на один прогон, 0 — без потолка
YANDEX_URL = os.environ.get("YANDEX_GEN_URL", "https://searchapi.api.cloud.yandex.net/v2/gen/search")

OUR_DOMAINS = ("gitelman.team",)  # покрывает journal., potok., chat.
BRAND_RE = re.compile(r"гительман|gitelman|тренинг[а-я]*\s+«?команда»?", re.I)
URL_RE = re.compile(r"https?://[^\s)\]>\"']+")


def load_queries(path, top):
    """Строки таблиц ядра: | Запрос | Ч | Д | С | **Σ** | Угол |. Берём top по Σ, порядок файла при равенстве."""
    rows = []
    for line in open(path, encoding="utf-8"):
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 6 or not re.fullmatch(r"\*\*\d+\*\*", cells[4]):
            continue
        rows.append((int(cells[4].strip("*")), len(rows), cells[0]))
    rows.sort(key=lambda r: (-r[0], r[1]))
    return [q for _, _, q in rows[:top]]


def post(url, headers, body, timeout=120):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def ask_chatgpt(q):
    key = os.environ.get("PROXYAPI_KEY_TRACKER") or os.environ.get("PROXYAPI_KEY")
    if not key:
        return None
    raw = json.loads(post(PROXYAPI_URL, {"Authorization": f"Bearer {key}"},
                          # без tool_choice модель отвечает по памяти и не ищет (проба 23.10)
                          {"model": PROXYAPI_MODEL, "input": q, "tool_choice": "required",
                           "tools": [{"type": "web_search",
                                      "user_location": {"type": "approximate", "country": "RU"}}]}))
    text, urls, searches = [], [], 0
    for item in raw.get("output", []):
        if item.get("type") == "web_search_call":
            searches += 1
        for part in item.get("content", []) or []:
            if part.get("type") == "output_text":
                text.append(part.get("text", ""))
                urls += [a.get("url") for a in part.get("annotations", []) if a.get("url")]
    u = raw.get("usage") or {}
    cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
    cost = (searches * PRICE_SEARCH + (u.get("input_tokens", 0) - cached) * PRICE_IN / 1e6
            + cached * PRICE_CACHED / 1e6 + u.get("output_tokens", 0) * PRICE_OUT / 1e6)
    return {"text": "\n".join(text), "urls": urls, "searches": searches, "usage": u, "cost_rub": round(cost, 2)}


def ask_yandex(q):
    # каталог default облака cloud-thunder-588 (ID не секрет)
    key, folder = os.environ.get("YANDEX_SEARCH_API_KEY"), os.environ.get("YANDEX_FOLDER_ID_TRACKER", "b1gc6qgbgi2pnmpnj17o")
    if not (key and folder):
        return None
    raw = post(YANDEX_URL, {"Authorization": f"Api-Key {key}"},
               {"messages": [{"content": q, "role": "ROLE_USER"}], "folderId": folder})
    # Ответ — JSON-массив; берём последний элемент (полный ответ)
    data = json.loads(raw)
    last = data[-1] if isinstance(data, list) else data
    sources = last.get("sources", [])
    return {"text": last.get("message", {}).get("content", ""),
            "urls": [s["url"] for s in sources if s.get("url") and s.get("used")],
            "all_sources": [s.get("url") for s in sources],
            "cost_rub": PRICE_YANDEX}


def analyse(ans):
    urls = list(dict.fromkeys(ans["urls"] + URL_RE.findall(ans["text"])))
    domains = [urlparse(u).netloc.lower().removeprefix("www.") for u in urls]
    ours = [d for d in domains if d.endswith(OUR_DOMAINS)]
    return {
        "mentioned": bool(BRAND_RE.search(ans["text"])),
        "our_links": ours,
        "our_position": next((i + 1 for i, d in enumerate(domains) if d.endswith(OUR_DOMAINS)), None),
        "domains": domains,
    }


ENGINES = {"chatgpt": ask_chatgpt, "yandex": ask_yandex}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--top", type=int, default=21)
    ap.add_argument("--limit", type=int, help="задать только первые N вопросов (проба)")
    ap.add_argument("--out", default=".")
    args = ap.parse_args()

    queries = load_queries(args.core, args.top)[: args.limit or None]
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H%MZ")
    results, spent = [], 0.0
    for q in queries:
        if BUDGET_RUB and spent >= BUDGET_RUB:
            print(f"Стоп: потрачено ~{spent:.0f} ₽ из потолка {BUDGET_RUB:.0f} ₽", file=sys.stderr)
            break
        for name, fn in ENGINES.items():
            try:
                ans = fn(q)
            except (urllib.error.URLError, ValueError, KeyError) as e:
                results.append({"engine": name, "query": q, "error": str(e)[:300]})
                print(f"[{name}] ошибка: {e}", file=sys.stderr)
                continue
            if ans is None:
                continue
            row = {"engine": name, "query": q, **analyse(ans), "searches": ans.get("searches"),
                   "usage": ans.get("usage"), "cost_rub": ans.get("cost_rub"), "answer": ans["text"]}
            spent += ans.get("cost_rub") or 0
            results.append(row)
            print(f"[{name}] {'ДА ' if row['mentioned'] or row['our_links'] else 'нет'} · {q[:70]}")

    path = os.path.join(args.out, f"ai-visibility-{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"at": stamp, "queries": len(queries), "cost_rub": round(spent, 2), "results": results}, f, ensure_ascii=False, indent=1)
    ok = [r for r in results if "error" not in r]
    for name in ENGINES:
        rs = [r for r in ok if r["engine"] == name]
        if rs:
            hit = sum(1 for r in rs if r["mentioned"] or r["our_links"])
            print(f"{name}: нас называют в {hit} из {len(rs)} ответов")
    print(f"Стоимость прогона: ~{spent:.2f} ₽ (поиски по {PRICE_SEARCH} ₽ + токены по тарифу)")
    print("Сохранено:", path)


if __name__ == "__main__":
    main()
