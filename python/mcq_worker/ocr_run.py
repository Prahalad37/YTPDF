"""Run PaddleOCR or Tesseract over image files; return text + mean confidence per frame."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("[mcq_worker] %(levelname)s: %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)

PADDLE_ENV_DISABLE_MODEL_CHECK = "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"
ENV_DET_DIR = "PADDLE_OCR_DET_DIR"
ENV_REC_DIR = "PADDLE_OCR_REC_DIR"
TESSERACT_ENV_KEYS = ("YTPDF_TESSERACT_PATH", "TESSERACT_CMD")

PADDLE_INIT_RETRIES = 3
PADDLE_INIT_BACKOFF_S = 0.45
TESSERACT_TIMEOUT_S = 180


@dataclass
class FrameOcr:
    name: str
    path: str
    text: str
    mean_confidence: float


def configure_paddle_env() -> None:
    """Disable PaddleX model-host connectivity probe (offline-friendly). Call before importing paddleocr."""
    os.environ[PADDLE_ENV_DISABLE_MODEL_CHECK] = "True"


def _mean(nums: list[float]) -> float:
    if not nums:
        return 0.0
    return sum(nums) / len(nums)


def _scores_to_display_scale(scores: list[float]) -> list[float]:
    """PaddleX uses 0–1; downstream expects 0–100 for meanConfidence."""
    if not scores:
        return []
    m = max(scores)
    if m <= 1.5:
        return [s * 100.0 for s in scores]
    return scores


def _extract_text_and_scores_from_paddlex(raw: Any) -> tuple[str, list[float]]:
    """Parse PaddleOCR 3.x / PaddleX OCRResult list or legacy 2.x nested lists."""
    lines: list[str] = []
    confs: list[float] = []

    if not raw:
        return "", []

    sample = raw[0]
    rec_probe: Any = None
    if hasattr(sample, "get"):
        rec_probe = sample.get("rec_texts")
    elif isinstance(sample, dict):
        rec_probe = sample.get("rec_texts")

    if rec_probe is not None:
        # PaddleX pipeline: list[OCRResult]
        for page in raw:
            if page is None:
                continue
            rec_texts: Any = None
            rec_scores: Any = None
            if hasattr(page, "get"):
                rec_texts = page.get("rec_texts")
                rec_scores = page.get("rec_scores")
            elif isinstance(page, dict):
                rec_texts = page.get("rec_texts")
                rec_scores = page.get("rec_scores")
            if rec_texts is None:
                continue
            texts = list(rec_texts) if not hasattr(rec_texts, "tolist") else rec_texts.tolist()
            scores = (
                list(rec_scores)
                if rec_scores is not None and not hasattr(rec_scores, "tolist")
                else (rec_scores.tolist() if rec_scores is not None else [])
            )
            for i, t in enumerate(texts):
                if isinstance(t, str) and t.strip():
                    lines.append(t.strip())
                    if i < len(scores):
                        try:
                            confs.append(float(scores[i]))
                        except (TypeError, ValueError):
                            confs.append(0.0)
                    else:
                        confs.append(0.0)

        text = "\n".join(lines)
        return text, _scores_to_display_scale(confs)

    # Legacy 2.x: [ page [ line [ box, (text, conf) ] ] ]
    for page in raw:
        if not page:
            continue
        for item in page:
            if not item or len(item) < 2:
                continue
            meta = item[1]
            if isinstance(meta, (list, tuple)) and len(meta) >= 2:
                text, conf = meta[0], meta[1]
                if isinstance(text, str) and text.strip():
                    lines.append(text.strip())
                    try:
                        confs.append(float(conf))
                    except (TypeError, ValueError):
                        confs.append(0.0)

    text = "\n".join(lines)
    return text, _scores_to_display_scale(confs)


def run_ocr_batch(image_paths: list[str], ocr: Any) -> list[FrameOcr]:
    """Run PaddleOCR.predict over images (PaddleOCR 3.x)."""
    results: list[FrameOcr] = []
    for p in image_paths:
        name = os.path.basename(p)
        try:
            raw = ocr.predict(p)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"OCR failed for {name}: {e}") from e

        text, confs = _extract_text_and_scores_from_paddlex(raw)
        results.append(
            FrameOcr(
                name=name,
                path=p,
                text=text,
                mean_confidence=_mean(confs),
            )
        )
    return results


def _parse_tesseract_tsv(tsv: str) -> tuple[str, list[float]]:
    """Parse tesseract TSV output; mean conf from word-level rows (level 5)."""
    lines = tsv.strip().splitlines()
    if len(lines) < 2:
        return "", []
    texts: list[str] = []
    confs: list[float] = []
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        try:
            level = int(parts[0])
        except ValueError:
            continue
        if level != 5:
            continue
        try:
            conf = float(parts[10])
        except (IndexError, ValueError):
            continue
        if conf < 0:
            continue
        word = parts[11] if len(parts) > 11 else ""
        texts.append(word)
        confs.append(conf)
    # Tesseract conf is 0–100
    return " ".join(texts), confs


def run_tesseract_batch(image_paths: list[str], tesseract_cmd: str) -> list[FrameOcr]:
    """OCR via local tesseract binary; prefers TSV for confidence."""
    results: list[FrameOcr] = []
    for p in image_paths:
        name = os.path.basename(p)
        try:
            r = subprocess.run(
                [tesseract_cmd, p, "-", "-l", "eng", "tsv"],
                capture_output=True,
                text=True,
                timeout=TESSERACT_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"Tesseract timed out for {name}") from e
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"Tesseract failed for {name}: {e}") from e

        text = ""
        confs: list[float] = []
        if r.returncode == 0 and r.stdout:
            text, confs = _parse_tesseract_tsv(r.stdout)
        if not text.strip() and r.stderr:
            logger.warning("tesseract stderr for %s: %s", name, r.stderr[:500])

        if not text.strip():
            # Plain text fallback (stdout)
            for out in ("-", "stdout"):
                r2 = subprocess.run(
                    [tesseract_cmd, p, out, "-l", "eng"],
                    capture_output=True,
                    text=True,
                    timeout=TESSERACT_TIMEOUT_S,
                    check=False,
                )
                if r2.returncode == 0 and (r2.stdout or "").strip():
                    text = (r2.stdout or "").strip()
                    confs = [70.0] if text else []
                    break
            else:
                raise RuntimeError(
                    f"Tesseract failed for {name} (code {r.returncode}): {(r.stderr or '')[:400]}"
                )

        mean_c = _mean(confs) if confs else (70.0 if text else 0.0)
        results.append(FrameOcr(name=name, path=p, text=text, mean_confidence=mean_c))
    return results


def create_paddle_ocr() -> Any:
    """Import and construct PaddleOCR (downloads models on first run when online)."""
    configure_paddle_env()
    try:
        from paddleocr import PaddleOCR  # type: ignore[import-untyped]
    except ImportError as e:
        raise RuntimeError(
            "paddleocr is not installed. Create a venv and: pip install -r python/requirements.txt"
        ) from e

    det_dir = os.environ.get(ENV_DET_DIR, "").strip()
    rec_dir = os.environ.get(ENV_REC_DIR, "").strip()
    kwargs: dict[str, Any] = {
        "use_textline_orientation": True,
        "lang": "en",
    }
    if det_dir:
        kwargs["text_detection_model_dir"] = det_dir
    if rec_dir:
        kwargs["text_recognition_model_dir"] = rec_dir

    return PaddleOCR(**kwargs)


def create_paddle_ocr_with_retries() -> Any:
    last: Exception | None = None
    for attempt in range(PADDLE_INIT_RETRIES):
        try:
            ocr = create_paddle_ocr()
            if attempt > 0:
                logger.info("PaddleOCR initialized on attempt %s", attempt + 1)
            return ocr
        except Exception as e:
            last = e
            logger.warning("PaddleOCR init attempt %s failed: %s", attempt + 1, e)
            if attempt < PADDLE_INIT_RETRIES - 1:
                time.sleep(PADDLE_INIT_BACKOFF_S * (attempt + 1))
    assert last is not None
    raise RuntimeError(f"PaddleOCR failed after {PADDLE_INIT_RETRIES} attempts: {last}") from last


def resolve_tesseract_executable() -> str | None:
    for key in TESSERACT_ENV_KEYS:
        p = os.environ.get(key, "").strip()
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    found = shutil.which("tesseract")
    return found if found else None
