#!/usr/bin/env bash
# Create python/.venv with a Python version PaddlePaddle supports (3.10–3.12).
# Python 3.14+ will NOT install paddlepaddle from PyPI (no wheels yet).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

pick_python() {
  local c
  for c in \
    "${PYTHON_FOR_YTPDF:-}" \
    "$(command -v python3.12 2>/dev/null || true)" \
    "/opt/homebrew/opt/python@3.12/bin/python3.12" \
    "/usr/local/opt/python@3.12/bin/python3.12" \
    "$(command -v python3.11 2>/dev/null || true)" \
    "/opt/homebrew/opt/python@3.11/bin/python3.11" \
    "$(command -v python3.10 2>/dev/null || true)" \
    "/opt/homebrew/opt/python@3.10/bin/python3.10"
  do
    if [[ -n "${c:-}" && -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

if ! PY="$(pick_python)"; then
  echo "No Python 3.10–3.12 found. PaddlePaddle does not ship wheels for Python 3.14+ yet."
  echo "Install one of:"
  echo "  brew install python@3.12"
  echo "Then re-run: $0"
  echo "Or set PYTHON_FOR_YTPDF=/path/to/python3.12 and re-run."
  exit 1
fi

echo "Using interpreter: $PY"
"$PY" --version
rm -rf .venv
"$PY" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo ""
echo "Done. The desktop app uses python/.venv automatically (see electron/python/resolvePythonWorker.ts)."
