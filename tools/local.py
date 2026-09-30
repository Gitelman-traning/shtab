#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Локальная проверка страниц Штаба без деплоя и без ключей Cloudflare.

Отдаёт статику из site/public, а запросы /api/* проксирует на боевой сайт с твоей сессией — страница видит настоящие данные
в рамках твоих прав. Чистые адреса как на боевом: /tags → tags.html, /sales/l1/ → sales/l1/index.html.

Запуск:  python tools/local.py [порт]   (по умолчанию 8766), затем открой http://localhost:8766/
Сессия: войди на боевой сайт в браузере, скопируй значение cookie shtab_s и положи его в файл site/.session.local (одна строка).
Файл в .gitignore, никому его не пересылай — это твой вход.
Переменные: SHTAB_URL (боевой адрес, по умолчанию https://okk-dashboard.pages.dev), SHTAB_SESSION (вместо файла).
"""
import http.server
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "site", "public")
PROD = os.environ.get("SHTAB_URL", "https://okk-dashboard.pages.dev").rstrip("/")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766


def session():
    s = os.environ.get("SHTAB_SESSION", "").strip()
    if s:
        return s
    p = os.path.join(HERE, "..", "site", ".session.local")
    if os.path.exists(p):
        return open(p, encoding="utf-8").read().strip()
    print("нет сессии: положи значение cookie shtab_s в site/.session.local или в SHTAB_SESSION — API будет отвечать 401")
    return ""


TOKEN = session()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def translate_path(self, path):
        p = super().translate_path(path)
        clean = path.split("?")[0]
        if clean.endswith("/"):
            return os.path.join(p, "index.html") if os.path.isdir(p) else p
        if not os.path.exists(p) and os.path.exists(p + ".html"):
            return p + ".html"
        return p

    def proxy(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(PROD + self.path, data=body, method=self.command)
        if TOKEN:
            req.add_header("cookie", "shtab_s=" + TOKEN)
        req.add_header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) shtab-local")   # без него Cloudflare отвечает 1010
        req.add_header("accept", "application/json")
        if self.headers.get("content-type"):
            req.add_header("content-type", self.headers["content-type"])
        try:
            r = urllib.request.urlopen(req, timeout=120)
            code, data, ctype = r.status, r.read(), r.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as e:
            code, data, ctype = e.code, e.read(), e.headers.get("content-type", "application/json")
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.proxy()
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.proxy()
        self.send_error(405)


if __name__ == "__main__":
    print("Штаб локально: http://localhost:%d/  (API → %s)" % (PORT, PROD))
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
