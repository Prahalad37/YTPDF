import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { getPythonExecutable, getPythonPackageRoot } from './resolvePythonWorker.js'

export type PaddleNdjsonEvent =
  | {
      type: 'progress'
      stage: string
      current: number
      total: number
      message?: string
      ocrBackend?: string
    }
  | { type: 'done'; jsonPath: string; txtPath: string; questionCount: number }
  | { type: 'error'; message: string; detail?: string }

export type RunPaddleWorkerOptions = {
  framesDir: string
  outDir: string
  onEvent: (ev: PaddleNdjsonEvent) => void
  signal: AbortSignal
}

export type RunTextBundleWorkerOptions = {
  bundlePath: string
  outDir: string
  onEvent: (ev: PaddleNdjsonEvent) => void
  signal: AbortSignal
}

/** Merge env for offline-friendly PaddleOCR / Tesseract subprocess. */
function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
    PYTHONUNBUFFERED: '1',
    // Reduce native BLAS / OpenMP thread pile-ups that often trigger macOS crashes in Paddle.
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? '1',
    OPENBLAS_NUM_THREADS: process.env.OPENBLAS_NUM_THREADS ?? '1',
    MKL_NUM_THREADS: process.env.MKL_NUM_THREADS ?? '1',
    VECLIB_MAXIMUM_THREADS: process.env.VECLIB_MAXIMUM_THREADS ?? '1',
    NUMEXPR_NUM_THREADS: process.env.NUMEXPR_NUM_THREADS ?? '1',
  }
}

/** Strip noisy PaddleX lines and keep the most useful tail (traceback or last lines). */
function summarizeStderr(stderr: string, maxLen = 1200): string {
  let t = stderr.replace(/Checking connectivity to the model hosters[^\n]*/gi, '').trim()
  t = t.replace(/\n{3,}/g, '\n\n')
  const tbIdx = t.lastIndexOf('Traceback (most recent call last)')
  if (tbIdx >= 0) {
    const tail = t.slice(tbIdx)
    const lines = tail.split('\n')
    return lines.slice(-16).join('\n').slice(0, maxLen)
  }
  const lines = t
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
  return lines.slice(-10).join('\n').slice(0, maxLen)
}

function asEvent(raw: Record<string, unknown>): PaddleNdjsonEvent | null {
  const t = raw.type
  if (t === 'progress') {
    return {
      type: 'progress',
      stage: String(raw.stage ?? ''),
      current: Number(raw.current ?? 0),
      total: Number(raw.total ?? 0),
      message: raw.message !== undefined ? String(raw.message) : undefined,
      ocrBackend: raw.ocrBackend !== undefined ? String(raw.ocrBackend) : undefined,
    }
  }
  if (t === 'done') {
    return {
      type: 'done',
      jsonPath: String(raw.jsonPath ?? ''),
      txtPath: String(raw.txtPath ?? ''),
      questionCount: Number(raw.questionCount ?? 0),
    }
  }
  if (t === 'error') {
    const message = String(raw.message ?? 'Unknown error')
    const detail = raw.detail !== undefined ? String(raw.detail) : undefined
    return { type: 'error', message, detail }
  }
  return null
}

function formatWorkerError(summary: string, ev?: PaddleNdjsonEvent & { type: 'error' }): string {
  if (ev?.detail?.trim()) {
    return `${summary}\n---\n${ev.detail.trim().slice(0, 2500)}`
  }
  return summary
}

function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (!pid) {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    return
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    }
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, 2000)
}

export async function runPaddleWorker(opts: RunPaddleWorkerOptions): Promise<
  | { ok: true; jsonPath: string; txtPath: string; questionCount: number }
  | { ok: false; message: string }
> {
  const { framesDir, outDir, onEvent, signal } = opts
  const pythonRoot = getPythonPackageRoot()
  const py = getPythonExecutable()

  const proc = spawn(
    py,
    ['-m', 'mcq_worker', '--frames-dir', framesDir, '--out-dir', outDir],
    {
      cwd: pythonRoot,
      windowsHide: true,
      env: workerEnv(),
    },
  )

  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string | Buffer) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })

  const abortListener = (): void => {
    killProcessTree(proc)
  }
  signal.addEventListener('abort', abortListener)

  const result = await new Promise<{ ok: true; jsonPath: string; txtPath: string; questionCount: number } | { ok: false; message: string }>((resolve) => {
    let settled = false
    const finish = (r: typeof result): void => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (!line.trim() || settled) return
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const ev = asEvent(raw)
      if (!ev) return
      onEvent(ev)
      if (ev.type === 'error') {
        const summary = ev.message
        finish({ ok: false, message: formatWorkerError(summary, ev) })
      }
      if (ev.type === 'done') {
        finish({
          ok: true,
          jsonPath: ev.jsonPath,
          txtPath: ev.txtPath,
          questionCount: ev.questionCount,
        })
      }
    })

    proc.on('error', (err) => {
      finish({ ok: false, message: err.message })
    })

    proc.on('close', (code, killSignal) => {
      signal.removeEventListener('abort', abortListener)
      void rl.close()
      if (settled) return
      if (signal.aborted) {
        finish({ ok: false, message: 'MCQ OCR cancelled.' })
        return
      }
      if (killSignal) {
        finish({ ok: false, message: `OCR process exited (${String(killSignal)})` })
        return
      }
      if (code !== 0) {
        const stderrSummary = summarizeStderr(stderr)
        const hint = stderrSummary ? `\n${stderrSummary}` : ''
        finish({
          ok: false,
          message: `OCR worker exited with code ${code}${hint}`.slice(0, 4000),
        })
        return
      }
      finish({ ok: false, message: 'OCR worker finished without a result (missing done line).' })
    })
  })

  signal.removeEventListener('abort', abortListener)
  return result
}

/** MCQ JSON from pre-extracted text (no PaddleOCR). Same NDJSON protocol as runPaddleWorker. */
export async function runTextBundleWorker(opts: RunTextBundleWorkerOptions): Promise<
  | { ok: true; jsonPath: string; txtPath: string; questionCount: number }
  | { ok: false; message: string }
> {
  const { bundlePath, outDir, onEvent, signal } = opts
  const pythonRoot = getPythonPackageRoot()
  const py = getPythonExecutable()

  const proc = spawn(
    py,
    ['-m', 'mcq_worker', '--from-text-bundle', bundlePath, '--out-dir', outDir],
    {
      cwd: pythonRoot,
      windowsHide: true,
      env: workerEnv(),
    },
  )

  let stderr = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string | Buffer) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  })

  const abortListener = (): void => {
    killProcessTree(proc)
  }
  signal.addEventListener('abort', abortListener)

  const result = await new Promise<{ ok: true; jsonPath: string; txtPath: string; questionCount: number } | { ok: false; message: string }>((resolve) => {
    let settled = false
    const finish = (r: typeof result): void => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      if (!line.trim() || settled) return
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const ev = asEvent(raw)
      if (!ev) return
      onEvent(ev)
      if (ev.type === 'error') {
        const summary = ev.message
        finish({ ok: false, message: formatWorkerError(summary, ev) })
      }
      if (ev.type === 'done') {
        finish({
          ok: true,
          jsonPath: ev.jsonPath,
          txtPath: ev.txtPath,
          questionCount: ev.questionCount,
        })
      }
    })

    proc.on('error', (err) => {
      finish({ ok: false, message: err.message })
    })

    proc.on('close', (code, killSignal) => {
      signal.removeEventListener('abort', abortListener)
      void rl.close()
      if (settled) return
      if (signal.aborted) {
        finish({ ok: false, message: 'MCQ text bundle cancelled.' })
        return
      }
      if (killSignal) {
        finish({ ok: false, message: `MCQ text worker exited (${String(killSignal)})` })
        return
      }
      if (code !== 0) {
        const stderrSummary = summarizeStderr(stderr)
        const hint = stderrSummary ? `\n${stderrSummary}` : ''
        finish({
          ok: false,
          message: `MCQ text worker exited with code ${code}${hint}`.slice(0, 4000),
        })
        return
      }
      finish({ ok: false, message: 'MCQ text worker finished without a result (missing done line).' })
    })
  })

  signal.removeEventListener('abort', abortListener)
  return result
}
