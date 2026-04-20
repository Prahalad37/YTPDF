# YTPDF — initial release

## Verification (pre-push)

| Check            | Result |
| ---------------- | ------ |
| `npm run lint`   | Pass   |
| `npm run build`  | Pass   |
| Node.js          | v20.20.0 |
| Host OS (verify) | Darwin |

The optional Python MCQ worker (`python/mcq_worker`, PaddleOCR) was not exercised in this run; use Python 3.10–3.12 per [python/README.md](python/README.md).

## What’s included

- **Web app (Vite + React):** Load a YouTube video, capture frames with timestamps and notes, export a study PDF (stacked layout per README).
- **Desktop (Electron):** Local video extraction, OCR, MCQ exam PDF generation, optional DeepSeek polish for layout/text.
- **Docs:** Root [README.md](README.md) covers capture behavior, DRM/capture caveats, production build, and environment variables.

## Security / operations

- **`DEEPSEEK_API_KEY`:** Set only in the environment or your launcher; never commit keys or `.env` files with secrets.
- **`YTPDF_PYTHON`:** Optional absolute path to an interpreter that has the MCQ worker dependencies installed.

## Suggested GitHub repository settings

**Description (short):**

> Local YouTube study tool: capture frames with timestamps, notes, export PDF; Electron build adds local video + MCQ exam PDF via optional Python OCR.

**Topics:** `youtube`, `pdf`, `electron`, `vite`, `react`, `study-tools`, `ocr`, `paddleocr`, `typescript`
