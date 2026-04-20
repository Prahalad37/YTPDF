"""Build mcq_questions.json from pre-extracted frame text (e.g. Tesseract). No Paddle/OCR imports."""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, TextIO

from mcq_worker.dedupe import dedupe_questions
from mcq_worker.patterns import lines_from_ocr_text, parse_mcq_blocks


def emit(obj: dict[str, Any], stream: TextIO = sys.stdout) -> None:
    stream.write(json.dumps(obj, ensure_ascii=False) + "\n")
    stream.flush()


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


def run_from_text_bundle(bundle_path: str, out_dir: str, frames_dir_label: str) -> int:
    """Parse JSON bundle, run MCQ heuristics + dedupe, write same outputs as OCR pipeline."""
    bundle_path = os.path.abspath(bundle_path)
    out_dir = os.path.abspath(out_dir)

    if not os.path.isfile(bundle_path):
        emit({"type": "error", "message": f"Bundle file not found: {bundle_path}"})
        return 1

    try:
        raw = json.loads(open(bundle_path, encoding="utf-8").read())
    except json.JSONDecodeError as e:
        emit({"type": "error", "message": f"Invalid JSON bundle: {e}"})
        return 1

    if not isinstance(raw, list):
        emit({"type": "error", "message": "Bundle must be a JSON array of frame objects."})
        return 1

    frames_in: list[dict[str, Any]] = [x for x in raw if isinstance(x, dict)]
    total = len(frames_in)
    if total == 0:
        emit({"type": "error", "message": "Bundle has no frame entries."})
        return 1

    os.makedirs(out_dir, exist_ok=True)

    emit(
        {
            "type": "progress",
            "stage": "init",
            "current": 0,
            "total": total,
            "message": "Parsing analyzed text…",
            "ocrBackend": "tesseract_bundle",
        }
    )

    all_drafts: list[dict[str, Any]] = []
    frame_records: list[dict[str, Any]] = []

    for idx, entry in enumerate(frames_in):
        name = str(entry.get("name", f"frame_{idx}"))
        text = str(entry.get("text", "") or "")
        mean_conf = entry.get("meanConfidence")
        if mean_conf is None:
            mean_conf = entry.get("mean_confidence")
        try:
            mean_f = float(mean_conf) if mean_conf is not None else 70.0
        except (TypeError, ValueError):
            mean_f = 70.0

        emit(
            {
                "type": "progress",
                "stage": "ocr",
                "current": idx + 1,
                "total": total,
                "message": f"Extract MCQ {name}",
                "ocrBackend": "tesseract_bundle",
            }
        )

        frame_records.append(
            {
                "name": name,
                "meanConfidence": round(mean_f, 4),
                "charCount": len(text),
            }
        )
        lines = lines_from_ocr_text(text)
        blocks = parse_mcq_blocks(lines, name, max(0.0, min(1.0, mean_f / 100.0)))
        for b in blocks:
            all_drafts.append(
                {
                    "stem": b.get("stem", ""),
                    "options": dict(b.get("options") or {}),
                    "source_frames": list(b.get("source_frames") or []),
                    "confidence": float(b.get("confidence") or 0.0),
                }
            )

    emit(
        {
            "type": "progress",
            "stage": "dedupe",
            "current": total,
            "total": total,
            "message": "Deduplicating…",
        }
    )
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
        "framesDir": frames_dir_label,
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


def main_from_argv() -> int:
    """CLI: python -m mcq_worker.from_text <bundle> <out_dir> [frames_dir_label] — or use __main__ dispatcher."""
    import argparse

    p = argparse.ArgumentParser(description="MCQ JSON from pre-extracted frame text")
    p.add_argument("bundle", help="Path to JSON bundle")
    p.add_argument("out_dir", help="Output directory")
    p.add_argument("frames_dir_label", nargs="?", default="", help="Label stored in JSON framesDir field")
    args = p.parse_args()
    try:
        return run_from_text_bundle(args.bundle, args.out_dir, args.frames_dir_label or "")
    except Exception as e:
        emit(
            {
                "type": "error",
                "message": str(e) or type(e).__name__,
                "detail": traceback.format_exc()[:8000],
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main_from_argv())
