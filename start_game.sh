#!/bin/sh
# One server serves the game page and its API. Ctrl+C stops it.
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Create the environment first: python3 -m venv .venv && .venv/bin/python -m pip install -e '.[dev,basilisk]'"
  exit 1
fi
printf 'Meet Me in Orbit: http://127.0.0.1:%s/play/\n' "${PORT:-8000}"
exec .venv/bin/python -m uvicorn orbital_game.api:app --host 127.0.0.1 --port "${PORT:-8000}"
