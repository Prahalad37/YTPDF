# MCQ OCR worker (PaddleOCR)

## Python version (important)

**PaddlePaddle does not provide PyPI wheels for Python 3.14+** (yet). If `python3 -m venv .venv` created `lib/python3.14` and `pip install paddlepaddle` fails with *“No matching distribution”*, use **Python 3.12** (or 3.11 / 3.10) for the venv.

**macOS:** `brew install python@3.12` then either run the helper script below or `python3.12 -m venv .venv`.

**macOS (Homebrew Python):** do not use `pip3 install` on the system interpreter — you will get **PEP 668 externally-managed-environment**. Always use a **venv** (the Electron app uses `python/.venv` automatically when it exists).

## Setup (recommended)

```bash
cd python
chmod +x setup_venv.sh
./setup_venv.sh
```

Or manually with **3.12**:

```bash
cd python
brew install python@3.12   # once
rm -rf .venv
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

After this, **Generate MCQ PDF** uses `python/.venv` without `YTPDF_PYTHON`. Override with `YTPDF_PYTHON` if needed.

On **Apple Silicon**, use the official [PaddlePaddle install](https://www.paddlepaddle.org.cn/install/quick) for your OS if `pip install paddlepaddle` fails.

## Run (CLI)

From the `python/` directory (so `mcq_worker` is importable):

```bash
python -m mcq_worker --frames-dir /abs/path/to/frames --out-dir /abs/path/to/mcq_out
```

Progress events are **NDJSON lines** on stdout; the last line is `{"type":"done",...}` or `{"type":"error",...}`.

The first run downloads PaddleOCR detection/recognition models (can take a few minutes).

## Outputs

- `mcq_questions.json` — schema version + per-frame stats + deduped questions  
- `mcq_questions.txt` — plain text for debugging and LLM prompts
