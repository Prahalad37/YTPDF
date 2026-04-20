"""Regex heuristics for exam-style MCQ text (post-OCR)."""

from __future__ import annotations

import re
import unicodedata
from typing import TypedDict


class QuestionDraft(TypedDict, total=False):
    stem: str
    options: dict[str, str]
    source_frames: list[str]
    confidence: float


# Next question line (for breaking option scan)
STEM_START = re.compile(
    r"^\s*(?:(?:Q(?:uestion)?\s*)?\d+\s*[).:]|Q\s*\d+\s*[).:])",
    re.IGNORECASE,
)

# Line that is only a short question label (rest may continue on next lines)
STEM_LABEL = re.compile(
    r"^\s*(?:Q(?:uestion)?\s*)?(\d+)\s*[).:]\s*(.*)$",
    re.IGNORECASE,
)

# (A) text / (a): text  OR  A. text with uppercase letter only — avoids "m. Quorum" OCR glitches.
OPTION_LINE = re.compile(
    r"^\s*(?:"
    r"\(\s*([A-Ea-e])\s*\)\s*[).:]\s*(.+)"
    r"|"
    r"([A-E])\s*[).:]\s*(.+)"
    r")$",
)

# Inline options like "(A) foo (B) bar" on one line — split heuristically
INLINE_OPT = re.compile(r"\(\s*([A-Da-d])\s*\)")


# Lines that start a new MCQ block — never merge the next OCR line upward across these.
_HARD_BOUNDARY_CANDIDATES = (
    STEM_START,
    STEM_LABEL,
    OPTION_LINE,
)

# If the previous line ends with one of these tokens, do not glue the next line (e.g. "of a" + "quorum").
_MERGE_BLOCK_LAST_WORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "of",
        "in",
        "on",
        "at",
        "to",
        "for",
        "and",
        "or",
        "nor",
        "but",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "as",
        "if",
        "so",
        "no",
        "do",
        "we",
        "he",
        "she",
        "it",
        "us",
        "am",
        "by",
        "from",
        "with",
    }
)

# If the next line begins like a new clause/sentence, do not merge (e.g. "... world" + "and more").
# Do not treat these as OCR-split second halves (e.g. "Trip ura" → Tripura).
_INTRALINE_MERGE_EXCLUDE_SECONDS = frozenset(
    {
        "has",
        "have",
        "had",
        "is",
        "are",
        "was",
        "were",
        "been",
        "being",
        "be",
        "can",
        "may",
        "will",
        "would",
        "could",
        "should",
    }
)

_MERGE_BLOCK_NEXT_FIRST_WORDS = frozenset(
    {
        "and",
        "or",
        "but",
        "which",
        "who",
        "whom",
        "whose",
        "that",
        "this",
        "these",
        "those",
        "when",
        "where",
        "why",
        "how",
        "if",
        "then",
        "because",
        "although",
        "while",
        "the",
        "in",
        "on",
        "at",
        "of",
        "for",
        "from",
        "with",
        "by",
        "as",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "has",
        "have",
        "had",
        "not",
        "no",
        "can",
        "may",
        "will",
        "would",
        "could",
        "should",
    }
)


def _is_hard_boundary_line(stripped: str) -> bool:
    if not stripped:
        return False
    for rx in _HARD_BOUNDARY_CANDIDATES:
        if rx.match(stripped):
            return True
    return False


def _last_token(s: str) -> str:
    parts = re.findall(r"[\w]+", s, flags=re.UNICODE)
    return parts[-1] if parts else ""


def _first_word_lower(s: str) -> str:
    parts = re.findall(r"[\w]+", s, flags=re.UNICODE)
    return parts[0].lower() if parts else ""


def _should_merge_continuation(prev_line: str, next_stripped: str) -> bool:
    """True if next line is likely a mid-word / mid-phrase wrap from OCR (join without space)."""
    cs = prev_line.rstrip()
    ns = next_stripped.lstrip()
    if not cs or not ns:
        return False
    # Lines like "m. Quorum" are OCR junk, not options — never glue to previous line.
    if re.match(r"^[a-z]{1,2}\.\s+", ns):
        return False
    if cs.endswith("-"):
        return True
    last_ch, first_ch = cs[-1], ns[0]
    if not (last_ch.isalnum() and first_ch.islower()):
        return False
    last_w = _last_token(cs)
    if last_w.lower() in _MERGE_BLOCK_LAST_WORDS:
        return False
    fw = _first_word_lower(ns)
    if fw in _MERGE_BLOCK_NEXT_FIRST_WORDS:
        return False
    # Avoid "Hello world" + "and …" — already blocked "and". Avoid merging after long final words.
    if len(last_w) >= 6:
        return False
    return True


def normalize_ocr_text_for_mcq(text: str) -> str:
    """Undo common Paddle/line-box OCR wraps before line-based MCQ parsing."""
    t = unicodedata.normalize("NFC", text or "")
    t = t.replace("\ufeff", "").replace("\u00ad", "")
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    lines = t.split("\n")
    merged: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            merged.append(line)
            i += 1
            continue
        buf = line
        i += 1
        while i < n and lines[i].strip():
            nxt = lines[i]
            ns = nxt.strip()
            if _is_hard_boundary_line(ns):
                break
            cs = buf.rstrip()
            if cs.endswith("-"):
                buf = cs[:-1] + nxt.lstrip()
                i += 1
                continue
            if _should_merge_continuation(cs, nxt):
                buf = cs + nxt.lstrip()
                i += 1
                continue
            break
        merged.append(buf)
    joined = "\n".join(merged)
    joined = _collapse_cross_line_ocr_dupes(joined)
    return "\n".join(_collapse_intraline_ocr_glitches(ln) for ln in joined.split("\n"))


def _collapse_cross_line_ocr_dupes(text: str) -> str:
    """Fix a common exam-OCR pattern: 'quoru' newline 'm. Quorum is?' → 'quorum is?'."""
    t = re.sub(
        r"\bquoru\s*\n\s*m\.\s*Quorum\s+is\s*\?",
        "quorum is?",
        text,
        flags=re.IGNORECASE,
    )
    return t


def _collapse_intraline_ocr_glitches(line: str) -> str:
    """Join obvious within-line OCR splits: 'quoru m' → 'quorum', 'Trip ura' → 'Tripura'."""
    s = line
    s = re.sub(r"([\w]{4,}) (\w)(?=(?:\s|[?.!,;:]|$))", r"\1\2", s, flags=re.UNICODE)

    def _merge_cap_low(m: re.Match[str]) -> str:
        low = m.group(2) or ""
        if low.lower() in _INTRALINE_MERGE_EXCLUDE_SECONDS:
            return m.group(0)
        return (m.group(1) or "") + low

    s = re.sub(
        r"\b([A-Z][a-z]{2,})\s+([a-z]{3,4})\b(?=(?:\s|[?.!,;:]|$|\s*\())",
        _merge_cap_low,
        s,
    )
    # Glued auxiliary (run after cap/low merge so we don't undo 'Where has').
    s = re.sub(r"\b([A-Z][a-z]{3,})has\b", r"\1 has", s)
    return s


def normalize_stem(s: str) -> str:
    t = s.lower()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"[^\w\s?.:();%\-/]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def lines_from_ocr_text(text: str) -> list[str]:
    normalized = normalize_ocr_text_for_mcq(text)
    return [ln.rstrip() for ln in normalized.split("\n")]


def parse_mcq_blocks(lines: list[str], frame_name: str, frame_confidence: float) -> list[QuestionDraft]:
    """Best-effort: group lines into stem + A–D options."""
    out: list[QuestionDraft] = []
    i = 0
    n = len(lines)

    while i < n:
        raw = lines[i]
        if not raw.strip():
            i += 1
            continue

        # Inline pattern: multiple (A)(B)(C)(D) on few lines
        if INLINE_OPT.search(raw) and raw.count("(") >= 2:
            block = _parse_inline_options_block(lines, i, frame_name, frame_confidence)
            if block:
                out.append(block)
                # Advance past consumed lines — conservative: skip until next blank or stem
                i += 1
                while i < n and lines[i].strip():
                    i += 1
                continue

        m = STEM_LABEL.match(raw.strip())
        if m:
            stem_lines = [raw.strip()]
            i += 1
            opts: dict[str, str] = {}
            stem_extra: list[str] = []

            while i < n:
                line = lines[i]
                stripped = line.strip()
                if not stripped:
                    break
                om = OPTION_LINE.match(stripped)
                if om:
                    key = (om.group(1) or om.group(3) or "").upper()
                    raw_opt = (om.group(2) or om.group(4) or "").strip()
                    if key in ("A", "B", "C", "D", "E"):
                        opts[key] = raw_opt
                    i += 1
                    if len(opts) >= 4:
                        break
                    continue
                # Next question starts
                if STEM_START.match(stripped) or STEM_LABEL.match(stripped):
                    break
                stem_extra.append(stripped)
                i += 1

            stem_text = "\n".join(stem_lines + stem_extra).strip()
            if len(opts) >= 2 and len(stem_text) >= 4:
                out.append(
                    {
                        "stem": stem_text,
                        "options": opts,
                        "source_frames": [frame_name],
                        "confidence": frame_confidence,
                    }
                )
            continue

        i += 1

    # Fallback: whole-frame blob with many (A)-(D) mentions
    if not out:
        blob = "\n".join(lines)
        if _looks_like_mcq_blob(blob):
            out.append(
                {
                    "stem": blob[:2000],
                    "options": {},
                    "source_frames": [frame_name],
                    "confidence": frame_confidence * 0.7,
                }
            )

    return out


def _looks_like_mcq_blob(text: str) -> bool:
    u = text.upper()
    hits = sum(1 for x in ("(A)", "(B)", "(C)", "(D)") if x in u)
    return hits >= 3


def _parse_inline_options_block(
    lines: list[str],
    start: int,
    frame_name: str,
    frame_confidence: float,
) -> QuestionDraft | None:
    chunk = " ".join(lines[start : start + 4])
    opts: dict[str, str] = {}
    for m in INLINE_OPT.finditer(chunk):
        k = m.group(1).upper()
        if k not in ("A", "B", "C", "D"):
            continue
        start_pos = m.end()
        next_m = INLINE_OPT.search(chunk, start_pos)
        end_pos = next_m.start() if next_m else len(chunk)
        val = chunk[start_pos:end_pos].strip()
        if val:
            opts[k] = val
    if len(opts) < 2:
        return None
    return {
        "stem": "(inline options)",
        "options": opts,
        "source_frames": [frame_name],
        "confidence": frame_confidence,
    }
