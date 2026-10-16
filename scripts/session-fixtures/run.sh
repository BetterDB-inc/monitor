#!/usr/bin/env zsh
# Usage: zsh scripts/session-fixtures/run.sh [--seed-only]
# Seeds the compose valkey (6380) and valkey-bundle (6384) with session data
# written by real client libraries under the sxfix: prefix, then captures
# fixtures into apps/api/test/fixtures/session-explorer. Never flushes.
set -euo pipefail

HERE="${0:A:h}"

cd "$HERE"

for port in $(grep -hoE '^(const )?PORT = [0-9]+' seed_*.py seed-*.mjs | grep -oE '[0-9]+$'); do
  if [[ "$port" != "6380" && "$port" != "6384" ]]; then
    echo "refusing port $port: only 6380 and 6384 are allowed" >&2
    exit 1
  fi
done

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for candidate in python3.12 python3.13 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && \
       "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
      PYTHON="$candidate"
      break
    fi
  done
fi
[[ -n "$PYTHON" ]] || { echo "python >= 3.10 required" >&2; exit 1; }

[[ -d .venv ]] || "$PYTHON" -m venv .venv
.venv/bin/pip install -q -r requirements.txt
npm install --no-audit --no-fund --silent

rm -f seed-expectations.json
.venv/bin/python seed_langchain_community.py
.venv/bin/python seed_llamaindex.py
node seed-langchain-js.mjs
node seed-agent-cache.mjs

if [[ "${1:-}" != "--seed-only" ]]; then
  node capture.mjs
fi
