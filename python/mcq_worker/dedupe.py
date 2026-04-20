"""Fuzzy duplicate removal for question stems."""

from __future__ import annotations

import difflib

from mcq_worker.patterns import QuestionDraft, normalize_stem

DEFAULT_SIMILARITY = 88  # matches TS questionPatterns default ~0.88 on ratio scale


def _token_sort_similarity(a: str, b: str) -> float:
    """0–100 score, same idea as rapidfuzz token_sort_ratio (stdlib only)."""
    ta = " ".join(sorted(a.split()))
    tb = " ".join(sorted(b.split()))
    if not ta and not tb:
        return 100.0
    return difflib.SequenceMatcher(None, ta, tb).ratio() * 100.0


def dedupe_questions(questions: list[QuestionDraft], threshold: int = DEFAULT_SIMILARITY) -> list[QuestionDraft]:
    """Greedy: keep first; merge source_frames when similar to existing stem."""
    kept: list[QuestionDraft] = []
    reps: list[str] = []

    for q in questions:
        stem = q.get("stem", "")
        norm = normalize_stem(stem) if stem else ""
        if len(norm) < 6:
            kept.append(q)
            reps.append(norm or f"__short_{id(q)}")
            continue

        merged = False
        for j, rep in enumerate(reps):
            if len(rep) < 6 or rep.startswith("__"):
                continue
            score = _token_sort_similarity(norm, rep)
            if score >= threshold:
                prev = kept[j]
                sf_prev = list(prev.get("source_frames") or [])
                sf_new = list(q.get("source_frames") or [])
                merged_frames = sorted(set(sf_prev + sf_new))
                prev["source_frames"] = merged_frames
                oc = prev.get("confidence")
                nc = q.get("confidence")
                if isinstance(oc, (int, float)) and isinstance(nc, (int, float)):
                    prev["confidence"] = max(float(oc), float(nc))
                merged = True
                break

        if not merged:
            kept.append(q)
            reps.append(norm)

    return kept
