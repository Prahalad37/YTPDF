/**
 * Worker-thread entry: runs Paddle/text-bundle subprocess off the Electron main thread.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runPaddleWorker, runTextBundleWorker } from '../python/runPaddleWorker.js'

type Mode = 'frames' | 'textBundle'

type WorkerData = {
  mode: Mode
  framesDir?: string
  bundlePath?: string
  outDir: string
}

const data = workerData as WorkerData
const ac = new AbortController()

parentPort?.on('message', (msg: unknown) => {
  if (typeof msg === 'object' && msg !== null && 'type' in msg && (msg as { type: string }).type === 'abort') {
    ac.abort()
  }
})

void (async () => {
  try {
    if (data.mode === 'textBundle') {
      const bundlePath = data.bundlePath?.trim() ?? ''
      if (!bundlePath) {
        parentPort?.postMessage({ kind: 'done', result: { ok: false as const, message: 'Missing bundle path.' } })
        return
      }
      const result = await runTextBundleWorker({
        bundlePath,
        outDir: data.outDir,
        signal: ac.signal,
        onEvent: (ev) => parentPort?.postMessage({ kind: 'event', ev }),
      })
      parentPort?.postMessage({ kind: 'done', result })
      return
    }

    const framesDir = data.framesDir?.trim() ?? ''
    if (!framesDir) {
      parentPort?.postMessage({ kind: 'done', result: { ok: false as const, message: 'Missing frames directory.' } })
      return
    }
    const result = await runPaddleWorker({
      framesDir,
      outDir: data.outDir,
      signal: ac.signal,
      onEvent: (ev) => parentPort?.postMessage({ kind: 'event', ev }),
    })
    parentPort?.postMessage({ kind: 'done', result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    parentPort?.postMessage({ kind: 'done', result: { ok: false as const, message } })
  }
})()
