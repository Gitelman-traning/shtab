#!/usr/bin/env bash
# Сборка Штаба в Cloudflare Pages (проект привязан к GitHub, root directory = site, build command = bash ../cf-build.sh, output = public).
# Клонирует публичный репозиторий okk (страницы ОКК) и по желанию приватный okk-docs (оценки человека для «Сверки», нужен DOCS_TOKEN),
# затем собирает страницы источников и ОКК в site/public. Переменные окружения проекта Pages: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
# PYTHON_VERSION=3.12, по желанию DOCS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")"
echo "переменные окружения сборки (только имена): $(env | cut -d= -f1 | grep -E '^(SHEET_ID|GOOGLE_|PYTHON_VERSION|INGEST_TOKEN|LLM_|ASK_MODEL|EDIT_MODEL|CF_PAGES)' | sort | tr '
' ' ')"
# секреты сборки из Doppler: если задан DOPPLER_TOKEN, тянем конфиг и экспортируем всё, чего нет в окружении
if [ -n "${DOPPLER_TOKEN:-}" ]; then
  curl -sf -H "Authorization: Bearer $DOPPLER_TOKEN" "https://api.doppler.com/v3/configs/config/secrets/download?format=json" > .doppler.json     && echo "Doppler: секреты получены ($(python3 -c 'import json;print(len(json.load(open(".doppler.json"))))' 2>/dev/null || echo '?') имён)"     || echo "Doppler: не удалось получить секреты, используем переменные панели"
  if [ -s .doppler.json ]; then
    eval "$(python3 - <<'PY'
import json, shlex, os
d = json.load(open(".doppler.json"))
for k, v in d.items():
    if k.startswith("DOPPLER_") or not isinstance(v, str): continue
    print("export %s=%s" % (k, shlex.quote(v)))
PY
)"
  fi
  rm -f .doppler.json
fi
for v in SHEET_ID GOOGLE_SERVICE_ACCOUNT_JSON; do
  if [ -z "${!v:-}" ]; then
    echo "ОШИБКА: не задана переменная $v — добавь её в проекте Pages: Settings → Variables and Secrets → Production, затем Retry deployment"; exit 1
  fi
done
ROOT="$(pwd)"
rm -rf .okk .okk-docs
git clone --depth 1 https://github.com/Gitelman-traning/okk.git .okk
if [ -n "${DOCS_TOKEN:-}" ]; then
  git clone --depth 1 "https://x-access-token:${DOCS_TOKEN}@github.com/Gitelman-traning/okk-docs.git" .okk-docs && echo "okk-docs: есть"
else
  echo "okk-docs: без токена, страница «Сверка» без оценок человека"
fi
PY="${PY:-$(command -v python3 || command -v python)}"   # локально на Windows: PY=python bash cf-build.sh
"$PY" -m pip install --quiet -r .okk/requirements.txt
export PYTHONIOENCODING=utf-8
export OKK_DIR="$ROOT/.okk"
export MANUAL_SCORES="$ROOT/.okk-docs/manual-scores.json"
"$PY" build.py
rm -rf .okk .okk-docs
echo "сборка готова: site/public"
