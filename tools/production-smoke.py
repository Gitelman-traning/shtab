"""Read-only release probes. Print statuses only, never tokens or response data."""
import datetime
import json
import os
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    base = os.environ.get("SHTAB_URL", "https://shtab-20v.pages.dev").rstrip("/")
    if base != "https://shtab-20v.pages.dev":
        raise SystemExit("SHTAB_URL must be the production Shtab origin; redirects are disabled")
    token = os.environ.get("SHTAB_TOKEN", "")
    if not token:
        raise SystemExit("SHTAB_TOKEN is required")
    opener = urllib.request.build_opener(NoRedirect())
    passed = 0

    def check(name, path, expected, *, service=False, method="GET", body=None, cookie=None, predicate=None):
        nonlocal passed
        headers = {"User-Agent": "shtab-release-check", "Accept": "application/json"}
        if service:
            headers["Authorization"] = "Bearer " + token
        if cookie:
            headers["Cookie"] = cookie
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        try:
            response = opener.open(request, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            if (response.headers.get("X-Content-Type-Options") != "nosniff" or
                    not response.headers.get("Content-Security-Policy") or not response.headers.get("Referrer-Policy")):
                raise SystemExit(f"FAIL {name}: protection headers missing")
            payload = response.read()
        if status != expected:
            raise SystemExit(f"FAIL {name}: HTTP {status}, expected {expected}")
        if predicate is not None and not predicate(json.loads(payload)):
            raise SystemExit(f"FAIL {name}: response contract mismatch")
        passed += 1
        print(f"PASS {name}: HTTP {status}", flush=True)

    # Confirm the new server before testing protected routes. No valid mutation is submitted.
    check("shared setup disabled", "/__setup", 410)
    for path in ["/", "/sales/l1/", "/sales/l2/", "/marketing/", "/hr/team/"]:
        check("anonymous page " + path, path, 401)
    check("legacy cookie refused", "/hr/team/", 401, cookie="okk_auth=synthetic-retired-cookie")
    check("anonymous points refused", "/api/points?metric=l2.sales", 401)
    check("anonymous meeting assistant refused", "/__ask", 401, method="POST", body={})
    check("collector registry", "/api/metrics", 200, service=True, predicate=lambda d: d.get("ok") and len(d.get("metrics", [])) > 0)
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    check("collector points", f"/api/points?metric=l1.booked&from={today}&to={today}", 200, service=True, predicate=lambda d: d.get("ok"))
    check("collector status", "/api/status", 200, service=True, predicate=lambda d: d.get("user", {}).get("role") == "service" and isinstance(d.get("sources"), list))
    check("points page", "/api/points?metric=l1.booked&page=1&page_size=1", 200, service=True,
          predicate=lambda d: d.get("ok") and len(d["rows"]) <= 1 and isinstance(d.get("has_more"), bool) and "next_page" in d)
    check("source health requires login", "/api/source-status", 401)
    check("anonymous Telegram marketing page", "/marketing/telegram/", 401)
    check("preparation collector reads", "/api/prep?mode=debriefs", 200, service=True, predicate=lambda d: d.get("ok"))
    check("pings collector reads", "/api/pings?manager=__release_probe__", 200, service=True, predicate=lambda d: d.get("ok"))
    check("recipient lookup", "/api/pings?mode=recipient&match=__release_probe__", 200, service=True, predicate=lambda d: d == {"ok": True, "tg_id": None})
    for method in ["GET", "POST", "PATCH"]:
        check("collector cannot " + method + " users", "/api/users", 403, service=True, method=method, body=None if method == "GET" else {})
    check("collector cannot use AI", "/api/chat", 401, service=True, method="POST", body={})
    check("invalid snapshot rejected before writes", "/api/ingest", 400, service=True, method="POST",
          body={"yt_leads_replace": {"rows": "invalid"}}, predicate=lambda d: "yt_leads" in d.get("error", ""))
    check("oversized nested preparation rejected", "/api/ingest", 400, service=True, method="POST",
          body={"prep": [{"deal": 1, "sources": ["probe"] * 61}]}, predicate=lambda d: "prep" in d.get("error", ""))
    print(f"Production release checks passed: {passed}")


if __name__ == "__main__":
    main()
