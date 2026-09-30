#!/usr/bin/env bash
# Сборка Штаба в Cloudflare Pages (проект привязан к GitHub, root directory = site, build command = bash ../cf-build.sh, output = public).
# Клонирует публичный репозиторий okk (страницы ОКК) и по желанию приватный okk-docs (оценки человека для «Сверки», нужен DOCS_TOKEN),
# затем собирает страницы источников и ОКК в site/public. Переменные окружения проекта Pages: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
# PYTHON_VERSION=3.12, по желанию DOCS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")"
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
