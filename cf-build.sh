#!/usr/bin/env bash
# Сборка Штаба в Cloudflare Pages (проект привязан к GitHub, root directory = site, build command = bash ../cf-build.sh, output = public).
# Клонирует публичный репозиторий okk (страницы ОКК) и по желанию приватный okk-docs (оценки человека для «Сверки», нужен DOCS_TOKEN),
# затем собирает страницы источников и ОКК в site/public. Переменные окружения проекта Pages: SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON,
# PYTHON_VERSION=3.12, по желанию DOCS_TOKEN.
set -euo pipefail
cd "$(dirname "$0")"
# Ошибка тестов, миграций или шаблонов останавливает сборку до публикации Pages.
bash tools/predeploy.sh
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
rm -rf .okk .okk-docs .shtab-docs
checkout_locked() {
  local repo="$1" dest="$2" private="${3:-}" ref auth
  ref="$(python3 -c 'import json,re,sys; v=json.load(open("build-refs.json"))[sys.argv[1]]; assert re.fullmatch("[0-9a-f]{40}",v); print(v)' "$repo")"
  git init --quiet "$dest"
  git -C "$dest" remote add origin "https://github.com/Gitelman-traning/$repo.git"
  if [ "$private" = private ]; then
    auth="$(printf 'x-access-token:%s' "$DOCS_TOKEN" | base64 | tr -d '\r\n')"
    git -C "$dest" -c "http.extraHeader=Authorization: Basic $auth" fetch --quiet --depth 1 origin "$ref" || return 1
  else
    git -C "$dest" fetch --quiet --depth 1 origin "$ref" || return 1
  fi
  git -C "$dest" checkout --quiet --detach FETCH_HEAD || return 1
  test "$(git -C "$dest" rev-parse HEAD)" = "$ref"
}
checkout_locked okk .okk
if [ -n "${DOCS_TOKEN:-}" ]; then
  checkout_locked okk-docs .okk-docs private
else
  echo "okk-docs: без токена, страница «Сверка» без оценок человека"
fi
PY="${PY:-$(command -v python3 || command -v python)}"   # локально на Windows: PY=python bash cf-build.sh
"$PY" -m pip install --quiet --require-hashes -r build-requirements.lock
export PYTHONIOENCODING=utf-8
export OKK_DIR="$ROOT/.okk"
export MANUAL_SCORES="$ROOT/.okk-docs/manual-scores.json"
"$PY" build.py
# сводка по сайтам (Маркетинг → Сайт): данные с заявками и оплатами живут в приватном shtab-docs/site-svodka
if [ -n "${DOCS_TOKEN:-}" ]; then
  checkout_locked shtab-docs .shtab-docs private
  mkdir -p site/public/marketing/site/svodka/data && cp .shtab-docs/site-svodka/*.json site/public/marketing/site/svodka/data/ && echo "сводка по сайтам: $(ls .shtab-docs/site-svodka/*.json | wc -l) файлов"
else
  echo "сводка по сайтам: нет доступа к shtab-docs, страница покажет «Сводок пока нет»"
fi
rm -rf .okk .okk-docs .shtab-docs
echo "сборка готова: site/public"
