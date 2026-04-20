"""CLI: OCR frames dir → MCQ JSON + TXT; or text bundle → same JSON (no Paddle on bundle path)."""

from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import tempfile
import traceback
from typing import Any, TextIO

from mcq_worker.dedupe import dedupe_questions
from mcq_worker.patterns import lines_from_ocr_text, parse_mcq_blocks


def emit(obj: dict[str, Any], stream: TextIO = sys.stdout) -> None:
    stream.write(json.dumps(obj, ensure_ascii=False) + "\n")
    stream.flush()


def _simplify_list_images(frames_dir: str) -> list[str]:
    exts = (".png", ".jpg", ".jpeg", ".webp")
    names = [n for n in os.listdir(frames_dir) if n.lower().endswith(exts)]
    names.sort(key=lambda x: x.lower())
    return [os.path.join(frames_dir, n) for n in names]


def build_txt(questions: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for i, q in enumerate(questions, start=1):
        stem = q.get("stem", "")
        opts = q.get("options") or {}
        parts.append(f"Question {i}\n{stem}\n")
        for k in sorted(opts.keys()):
            parts.append(f"  ({k}) {opts[k]}\n")
        parts.append("\n")
    return "".join(parts).strip() + "\n"


def _init_ocr_backend(total: int) -> tuple[str, Any]:
    """Lazy-import paddle/tesseract; return ('paddle', ocr) or ('tesseract', path)."""
    from mcq_worker.ocr_run import (  # noqa: PLC0415
        configure_paddle_env,
        create_paddle_ocr_with_retries,
        resolve_tesseract_executable,
    )

    configure_paddle_env()

    force_tess = os.environ.get("YTPDF_FORCE_TESSERACT_MCQ", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )
    if force_tess:
        tess = resolve_tesseract_executable()
        if tess:
            emit(
                {
                    "type": "progress",
                    "stage": "init",
                    "current": 0,
                    "total": total,
                    "message": "Using Tesseract only (YTPDF_FORCE_TESSERACT_MCQ).",
                    "ocrBackend": "tesseract",
                }
            )
            return ("tesseract", tess)
        emit(
            {
                "type": "error",
                "message": "YTPDF_FORCE_TESSERACT_MCQ is set but Tesseract was not found.",
            }
        )
        raise SystemExit(1)

    emit(
        {
            "type": "progress",
            "stage": "init",
            "current": 0,
            "total": total,
            "message": "Loading PaddleOCR…",
            "ocrBackend": "paddle",
        }
    )
    try:
        ocr = create_paddle_ocr_with_retries()
        emit(
            {
                "type": "progress",
                "stage": "init",
                "current": 0,
                "total": total,
                "message": "PaddleOCR ready.",
                "ocrBackend": "paddle",
            }
        )
        return ("paddle", ocr)
    except Exception as e:
        tess = resolve_tesseract_executable()
        if tess:
            emit(
                {
                    "type": "progress",
                    "stage": "init",
                    "current": 0,
                    "total": total,
                    "message": f"Using Tesseract (PaddleOCR unavailable: {e})",
                    "ocrBackend": "tesseract",
                }
            )
            return ("tesseract", tess)
        raise RuntimeError(
            f"PaddleOCR failed ({e!s}) and Tesseract was not found. "
            "Install Tesseract or set YTPDF_TESSERACT_PATH to the executable."
        ) from e


def _prepare_image_for_ocr(path: str, max_side: int) -> tuple[str, bool]:
    """Downscale very large frames before Paddle to lower native OOM / segfault risk.

    Returns (path_to_use, is_temp_file).
    """
    try:
        from PIL import Image
    except ImportError:
        return path, False
    try:
        with Image.open(path) as im:
            w, h = im.size
            if max(w, h) <= max_side:
                return path, False
            scale = max_side / max(w, h)
            nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
            resized = im.convert("RGB").resize((nw, nh), Image.Resampling.LANCZOS)
        fd, tmp = tempfile.mkstemp(suffix=".png", prefix="mcq_ocr_")
        os.close(fd)
        resized.save(tmp)
        resized.close()
        return tmp, True
    except Exception:
        return path, False


def _run_pipeline_frames_dir(frames_dir: str, out_dir: str) -> int:
    frames_dir = os.path.abspath(frames_dir)
    out_dir = os.path.abspath(out_dir)

    if not os.path.isdir(frames_dir):
        emit({"type": "error", "message": f"frames-dir is not a directory: {frames_dir}"})
        return 1

    images = _simplify_list_images(frames_dir)
    total = len(images)
    if total == 0:
        emit({"type": "error", "message": f"No images found in {frames_dir}"})
        return 1

    os.makedirs(out_dir, exist_ok=True)

    backend, engine = _init_ocr_backend(total)

    all_drafts: list[dict[str, Any]] = []
    frame_records: list[dict[str, Any]] = []

    from mcq_worker.ocr_run import run_ocr_batch, run_tesseract_batch  # noqa: PLC0415

    try:
        max_side = int(os.environ.get("MCQ_MAX_IMAGE_SIDE", "1920"))
    except ValueError:
        max_side = 1920
    max_side = max(640, min(max_side, 4096))

    for idx, path in enumerate(images):
        name = os.path.basename(path)
        emit(
            {
                "type": "progress",
                "stage": "ocr",
                "current": idx + 1,
                "total": total,
                "message": f"OCR {name}",
                "ocrBackend": backend,
            }
        )
        work_path, is_temp = (
            _prepare_image_for_ocr(path, max_side) if backend == "paddle" else (path, False)
        )
        try:
            if backend == "paddle":
                batch = run_ocr_batch([work_path], engine)
            else:
                batch = run_tesseract_batch([work_path], engine)
        finally:
            if is_temp and work_path != path:
                try:
                    os.remove(work_path)
                except OSError:
                    pass

        fo = batch[0]
        frame_records.append(
            {
                "name": fo.name,
                "meanConfidence": round(fo.mean_confidence, 4),
                "charCount": len(fo.text),
            }
        )
        lines = lines_from_ocr_text(fo.text)
        blocks = parse_mcq_blocks(lines, fo.name, max(0.0, min(1.0, fo.mean_confidence / 100.0)))
        for b in blocks:
            all_drafts.append(
                {
                    "stem": b.get("stem", ""),
                    "options": dict(b.get("options") or {}),
                    "source_frames": list(b.get("source_frames") or []),
                    "confidence": float(b.get("confidence") or 0.0),
                }
            )

        gc.collect()

    emit({"type": "progress", "stage": "dedupe", "current": total, "total": total, "message": "Deduplicating…"})
    merged = dedupe_questions(all_drafts)  # type: ignore[arg-type]

    questions_out: list[dict[str, Any]] = []
    for i, q in enumerate(merged, start=1):
        questions_out.append(
            {
                "id": f"q{i}",
                "stem": q.get("stem", ""),
                "options": q.get("options") or {},
                "sourceFrames": q.get("source_frames") or [],
                "confidence": round(float(q.get("confidence") or 0.0), 4),
            }
        )

    payload = {
        "version": 1,
        "framesDir": frames_dir,
        "frames": frame_records,
        "questions": questions_out,
    }

    json_path = os.path.join(out_dir, "mcq_questions.json")
    txt_path = os.path.join(out_dir, "mcq_questions.txt")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(build_txt(questions_out))

    emit(
        {
            "type": "done",
            "jsonPath": json_path,
            "txtPath": txt_path,
            "questionCount": len(questions_out),
        }
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MCQ extraction: PaddleOCR on frames, or from analyzed text bundle")
    parser.add_argument("--out-dir", required=True, help="Output directory for JSON and TXT")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--frames-dir", help="Directory containing frame images (PaddleOCR path)")
    src.add_argument(
        "--from-text-bundle",
        metavar="PATH",
        dest="text_bundle",
        help="JSON file: array of {name, text, meanConfidence?} from Tesseract/analyzed text",
    )

    args = parser.parse_args()

    if args.text_bundle:
        from mcq_worker.from_text import run_from_text_bundle  # noqa: PLC0415

        try:
            return run_from_text_bundle(args.text_bundle, args.out_dir, "")
        except Exception as e:
            detail = traceback.format_exc()
            emit(
                {
                    "type": "error",
                    "message": str(e) or type(e).__name__,
                    "detail": detail[:8000],
                }
            )
            return 1

    try:
        return _run_pipeline_frames_dir(args.frames_dir, args.out_dir)
    except Exception as e:
        detail = traceback.format_exc()
        emit(
            {
                "type": "error",
                "message": str(e) or type(e).__name__,
                "detail": detail[:8000],
            }
        )
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        try:
            emit({"type": "error", "message": f"Fatal: {e}", "detail": traceback.format_exc()[:8000]})
        except Exception:
            print(f"Fatal: {e}", file=sys.stderr)
        raise SystemExit(1)
