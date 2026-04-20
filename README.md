# YouTube Study — screenshots to PDF

Local web app: load a YouTube video, capture frames with accurate timestamps, add optional notes, and export everything as a PDF (two stacked captures per page: image, timestamp, note).

## Requirements

- **Node.js** 18+ (for `npm` / Vite)
- A **Chromium-based browser** is recommended for screen capture (`getDisplayMedia`). Safari/Firefox may differ slightly in the share picker.

## Setup

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Desktop app (Electron) — local video & MCQ PDF

Run **`npm run desktop`** (starts Vite + Electron). The desktop build extracts frames from local video files and can export a **study PDF** and, separately, an **MCQ exam PDF** built from OCR.

### Python worker (PaddleOCR)

The **Generate MCQ PDF** action runs `python/mcq_worker` (PaddleOCR). **PaddlePaddle does not install on Python 3.14+** from PyPI yet — use a venv built with **Python 3.10–3.12** (e.g. `brew install python@3.12`). On macOS Homebrew, avoid global `pip3` (**PEP 668**); use a venv. The app auto-picks `python/.venv` when present.

```bash
cd python
chmod +x setup_venv.sh
./setup_venv.sh
```

Or see [`python/README.md`](python/README.md). The first run may download model weights (one-time). Optional: **`YTPDF_PYTHON`** = absolute path to the interpreter with packages installed.

### DeepSeek API

MCQ layout polishing calls the **DeepSeek** chat API. Set a key in the environment before launching Electron:

```bash
export DEEPSEEK_API_KEY="your_key"
```

Then start the app from the same shell (or configure your IDE/launcher to inject the variable).

Artifacts for each finished job are written under the app’s user-data directory, in `jobs/<jobId>/mcq/`: `mcq_questions.json`, `mcq_questions.txt`, `mcq_polished.html`, and `mcq_exam.pdf`.

## How capture works

Embedded YouTube is cross-origin: the app **cannot** read video pixels from the iframe. After you click **Start capture session**, the browser asks you to share a surface. **This tab** is the usual choice so the embedded player is visible; you can also try **Window** or **Entire screen** if that fits your layout better (for example **YouTube fullscreen** or a maximized window often reduces how much the in-player title overlaps slides). The app records a display stream, crops to the player region, and saves a JPEG plus the current `getCurrentTime()` from the YouTube player API. **`getDisplayMedia` does not let the page pick the source** — you choose in the browser dialog.

- **Hide top title bar** (checkbox under the player controls): YouTube’s in-player title overlay cannot be turned off via the official embed API. When enabled, the app draws an **opaque strip** (~52px) over the top of the player so the title no longer covers readable content. The same strip appears in **tab captures** and PDFs. A thin band of the video is hidden as a tradeoff; preference is saved in **localStorage**.
- Use **Capture frame** (or press **`C`** when focus is not in an input/textarea) while sharing is active.
- **Speed** uses the YouTube IFrame API. The embed usually offers **up to about 2×** — not 5×.
- **Capture interval**: use **Every … s video** (next to **Automate**) to set how many seconds of the **video timeline** pass between captures. Allowed range **1–600** seconds; default **10**. The value is remembered in the browser (**localStorage**). While a **Scan timeline** is running, the field is locked so the step size does not change mid-scan.
- **Automate** (**`A`**) captures on that interval along the timeline (not raw wall-clock only). The wall-clock gap between shots is `interval / playbackSpeed` so spacing stays correct when you speed up playback.
- **Auto capture entire video** (primary control next to **Load**): one click starts tab sharing if needed (the browser still requires this user gesture — pasting a URL alone cannot grant capture), waits until the player reports a duration, then runs the same seek-and-capture pass as **Scan timeline** so you do not need to watch the full runtime. When prompted, choose **this tab**.
- **Scan timeline** seeks through the whole video at the same step as the capture interval, waits briefly after each seek, then captures — useful to avoid watching the entire runtime; turn off **Automate** first.
- Pasting a valid YouTube link in the URL field **auto-loads** the video after a short debounce (~800ms) so you can go straight to **Auto capture entire video**.
- **−10s / +10s** (or **`←` / `→`**, **`J` / `L`**) seek the video.
- Click **Stop sharing** when you are done capturing.

## Troubleshooting (black video or black captures)

1. **Confirm playback before sharing** — Press **Play** and make sure the YouTube picture is visible in the player. If it is already black *before* you start a capture session, fix embed/network/autoplay first (try a normal **non-live** upload to rule out live buffering).
2. **Pick the right source** — In the share dialog, choose **This tab** (or **Chrome tab**) for the tab running this app, not a random window. The app requests the current tab when the browser supports it; you can still override in the picker.
3. **DRM / Widevine** — While screen capture is active, Chromium may blank protected video (black in the player and in every capture). That is a browser/content-protection behavior, not something the page can read from the iframe. Workarounds people sometimes use: turn off **Use graphics acceleration when available** (Chrome **Settings → System**), try another Chromium profile or browser build, or test on another OS — results vary.
4. **Wrong crop** — If you share a different monitor or a window that does not show this page, crops will not match the player; use the tab that contains the embedded player.

## Production build

```bash
npm run build
npm run preview
```

Static files are emitted to `dist/`.

## Export

**Export PDF** writes one or more files to your downloads folder. Each PDF page is a **1×2 grid** (up to **two** captures per page, stacked vertically) with timestamp and a short note under each image. Loading a new video clears the current capture list and ends any active share session.

**Max pages per file** (optional): leave empty to download a **single** PDF. If you enter a number (1–500), the app **splits** the export into multiple PDFs so each file has at most that many pages (each page still holds up to two captures). When there is more than one part, you get **one ZIP** (`study-{videoId}-{timestamp}.zip`, DEFLATE-compressed) containing `part1ofN.pdf`, `part2ofN.pdf`, and so on—one browser download instead of many.

**Smart PDF** (checkbox next to export, on by default) runs quick image heuristics before generating the file: it drops near-uniform or very dark “blank” frames and consecutive slides that look the same (average-hash comparison). This is not OCR and can miss edge cases; turn **Smart PDF** off to export every capture unchanged. If everything would be filtered out, the app shows an error instead of an empty PDF.

## Accessibility

- Use **Tab** from the top of the page to reach a **Skip to main content** link, then the header, main player/controls, and screenshots sidebar.
- **Keyboard shortcuts** (when focus is not in a text field): **C** capture frame, **A** toggle automate, **←** / **J** seek back 10s, **→** / **L** seek forward 10s.
- **Errors** are announced assertively; routine status messages use a polite live region.
- Starting **capture** still requires the browser’s **share** dialog (mouse or keyboard activation on the button); the app cannot bypass that step.
