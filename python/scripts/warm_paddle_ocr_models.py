#!/usr/bin/env python3
"""One-shot: set PaddleX env and construct PaddleOCR once to populate local model cache.

Run online once (CI or dev machine): ``python scripts/warm_paddle_ocr_models.py``
Optional: ``PADDLE_PDX_CACHE_HOME=/path/to/cache`` to control download location.
"""

from __future__ import annotations

import os
import sys

# Ensure repo root on path when run as script
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PYTHON_ROOT = os.path.normpath(os.path.join(_SCRIPT_DIR, ".."))
if _PYTHON_ROOT not in sys.path:
    sys.path.insert(0, _PYTHON_ROOT)

from mcq_worker.ocr_run import configure_paddle_env, create_paddle_ocr  # noqa: E402


def main() -> int:
    configure_paddle_env()
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    try:
        create_paddle_ocr()
    except Exception as e:
        print(f"[warm_paddle_ocr_models] failed: {e}", file=sys.stderr)
        return 1
    print("[warm_paddle_ocr_models] PaddleOCR models ready in cache.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
