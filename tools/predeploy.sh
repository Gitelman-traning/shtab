#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --experimental-sqlite --test tests/*.test.mjs
"${PY:-python3}" -m unittest discover -s tests -p 'test_*.py' -v
"${PY:-python3}" -c 'import build; build.build_sources()'
git diff --exit-code -- site/public/marketing
