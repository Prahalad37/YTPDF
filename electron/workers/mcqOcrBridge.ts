import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PaddleNdjsonEvent } from '../python/runPaddleWorker.js'
import { runPaddleWorker, runTextBundleWorker } from '../python/runPaddleWorker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function workerEntryPath(): string {
  return path.join(__dirname, 'mcqOcrWorkerEntry.js')
}

type McqOcrResult =
  | { ok: true; jsonPath: string; txtPath: string; questionCount: number }
  | { ok: false; message: string }

function runInWorkerThread<T extends McqOcrResult>(params: {
  workerData: Record<string, unknown>
  signal: AbortSignal
  onEvent: (ev: PaddleNdjsonEvent) => void
}): Promise<T> {
  const { workerData, signal, onEvent } = params
  return new Promise<T>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(workerEntryPath(), { workerData })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }

    let settled = false

    const onAbort = (): void => {
      try {
        worker.postMessage({ type: 'abort' })
      } catch {
        /* ignore */
      }
      void worker.terminate().catch(() => undefined)
    }

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return
      const m = msg as { kind?: string; ev?: PaddleNdjsonEvent; result?: McqOcrResult }
      if (m.kind === 'event' && m.ev) {
        onEvent(m.ev)
        return
      }
      if (m.kind === 'done' && m.result !== undefined) {
        settle(() => {
          void worker.terminate().catch(() => undefined)
          resolve(m.result as T)
        })
      }
    })

    worker.on('error', (err) => {
      settle(() => {
        void worker.terminate().catch(() => undefined)
        reject(err)
      })
    })

    worker.on('exit', (code) => {
      settle(() => {
        if (code === 0) {
          reject(new Error('MCQ OCR worker finished without a result.'))
        } else {
          reject(new Error(`MCQ OCR worker thread exited (${code})`))
        }
      })
    })
  })
}

export async function runPaddleWorkerOffMainThread(opts: {
  framesDir: string
  outDir: string
  signal: AbortSignal
  onEvent: (ev: PaddleNdjsonEvent) => void
}): Promise<McqOcrResult> {
  try {
    return await runInWorkerThread({
      workerData: { mode: 'frames', framesDir: opts.framesDir, outDir: opts.outDir },
      signal: opts.signal,
      onEvent: opts.onEvent,
    })
  } catch {
    return runPaddleWorker(opts)
  }
}

export async function runTextBundleWorkerOffMainThread(opts: {
  bundlePath: string
  outDir: string
  signal: AbortSignal
  onEvent: (ev: PaddleNdjsonEvent) => void
}): Promise<McqOcrResult> {
  try {
    return await runInWorkerThread({
      workerData: { mode: 'textBundle', bundlePath: opts.bundlePath, outDir: opts.outDir },
      signal: opts.signal,
      onEvent: opts.onEvent,
    })
  } catch {
    return runTextBundleWorker(opts)
  }
}
