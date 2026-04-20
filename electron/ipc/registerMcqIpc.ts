import { BrowserWindow, ipcMain } from 'electron'
import type { JobStore } from '../jobs/store.js'
import { runMcqPipeline, runMcqPipelineFromAnalyzedText } from '../services/mcqOrchestrator.js'
import type { McqAiMode, McqGenerateResult, McqProgressPayload } from '../services/mcqTypes.js'
import {
  generateAnswerKeyPdf,
  generateRevisionSheetPdf,
  generateShuffledPracticePdf,
  generateWeakTopicMcqPdf,
  tagMcqTopicsToFile,
} from '../services/mcqSecondaryExports.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isTransientMcqMessage(msg: string | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  return (
    m.includes('econnreset') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('aborted') ||
    m.includes('429') ||
    m.includes('503') ||
    m.includes('502') ||
    m.includes('mcq ocr worker finished without') ||
    m.includes('worker thread exited')
  )
}

const MCQ_PROGRESS_IPC_MS = 380

function createThrottledMcqProgressSender(
  getTargetWindow: () => BrowserWindow | null,
): {
  send: (p: McqProgressPayload) => void
  flush: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: McqProgressPayload | null = null
  let lastFlush = 0

  const fire = (p: McqProgressPayload): void => {
    const win = getTargetWindow()
    win?.webContents.send('mcq:progress', p)
    lastFlush = Date.now()
    pending = null
  }

  return {
    send: (p: McqProgressPayload) => {
      pending = p
      const now = Date.now()
      if (now - lastFlush >= MCQ_PROGRESS_IPC_MS) {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        fire(p)
        return
      }
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        if (pending) fire(pending)
      }, MCQ_PROGRESS_IPC_MS - (now - lastFlush))
    },
    flush: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (pending) fire(pending)
    },
  }
}

let mcqController: AbortController | null = null
let secondaryController: AbortController | null = null

export function registerMcqIpc(deps: {
  store: JobStore
  getTargetWindow: () => BrowserWindow | null
}): void {
  const { store, getTargetWindow } = deps

  const runWithController = async (
    fn: (opts: {
      jobId: string
      store: JobStore
      signal: AbortSignal
      onProgress: (p: McqProgressPayload) => void
    }) => Promise<McqGenerateResult>,
    jobId: string,
  ): Promise<McqGenerateResult> => {
    if (mcqController) {
      return { ok: false, message: 'Another MCQ export is already running.' }
    }
    mcqController = new AbortController()
    const signal = mcqController.signal
    const progressSender = createThrottledMcqProgressSender(getTargetWindow)
    try {
      const runOnce = () =>
        fn({
          jobId,
          store,
          signal,
          onProgress: (p) => progressSender.send(p),
        })
      let result = await runOnce()
      progressSender.flush()
      if (!result.ok && isTransientMcqMessage(result.message) && !signal.aborted) {
        await sleep(1800)
        if (!signal.aborted) {
          result = await runOnce()
          progressSender.flush()
        }
      }
      if (result.ok) {
        const meta: {
          lastMcqCount?: number
          lastMcqAt?: string
          mcqJsonPath?: string | null
          mcqTxtPath?: string | null
          mcqPdfPath?: string | null
          answerKeyPdfPath?: string | null
        } = {
          lastMcqCount: result.questionCount,
          lastMcqAt: new Date().toISOString(),
          mcqJsonPath: result.mcqJsonPath ?? null,
          mcqTxtPath: result.txtPath ?? null,
          mcqPdfPath: result.mcqPdfPath ?? null,
        }
        if (result.answerKeyPdfPath != null) {
          meta.answerKeyPdfPath = result.answerKeyPdfPath
        }
        await store.patchJobExportMeta(jobId, meta)
      }
      return result
    } finally {
      mcqController = null
    }
  }

  ipcMain.handle(
    'mcq:generate',
    async (_event, jobId: string, mode?: McqAiMode): Promise<McqGenerateResult> => {
      return runWithController(
        (opts) => runMcqPipeline({ ...opts, mode: mode ?? 'fast' }),
        jobId,
      )
    },
  )

  ipcMain.handle(
    'mcq:generateFromAnalyzedText',
    async (_event, jobId: string, mode?: McqAiMode): Promise<McqGenerateResult> => {
      return runWithController(
        (opts) => runMcqPipelineFromAnalyzedText({ ...opts, mode: mode ?? 'fast' }),
        jobId,
      )
    },
  )

  ipcMain.handle('mcq:cancel', async (): Promise<{ ok: boolean }> => {
    if (mcqController) {
      mcqController.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  const withSecondary = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (secondaryController) {
      throw new Error('Another export is running.')
    }
    secondaryController = new AbortController()
    try {
      return await fn(secondaryController.signal)
    } finally {
      secondaryController = null
    }
  }

  ipcMain.handle('mcq:cancelSecondary', async (): Promise<{ ok: boolean }> => {
    if (secondaryController) {
      secondaryController.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  ipcMain.handle(
    'mcq:answerKey',
    async (_event, jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }> => {
      const key = process.env.DEEPSEEK_API_KEY?.trim()
      if (!key) {
        return { ok: false, message: 'Set DEEPSEEK_API_KEY for answer-key generation.' }
      }
      try {
        return await withSecondary((signal) =>
          generateAnswerKeyPdf({ jobId, store, signal, apiKey: key }),
        )
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Answer key failed.' }
      }
    },
  )

  ipcMain.handle(
    'mcq:revisionSheet',
    async (_event, jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }> => {
      const key = process.env.DEEPSEEK_API_KEY?.trim()
      if (!key) {
        return { ok: false, message: 'Set DEEPSEEK_API_KEY for revision sheets.' }
      }
      try {
        return await withSecondary((signal) =>
          generateRevisionSheetPdf({ jobId, store, signal, apiKey: key }),
        )
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Revision sheet failed.' }
      }
    },
  )

  ipcMain.handle(
    'mcq:shufflePractice',
    async (_event, jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }> => {
      try {
        return await withSecondary((signal) =>
          generateShuffledPracticePdf({ jobId, store, signal }),
        )
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Shuffle export failed.' }
      }
    },
  )

  ipcMain.handle(
    'mcq:tagTopics',
    async (_event, jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }> => {
      const key = process.env.DEEPSEEK_API_KEY?.trim()
      if (!key) {
        return { ok: false, message: 'Set DEEPSEEK_API_KEY to tag topics.' }
      }
      try {
        return await withSecondary((signal) =>
          tagMcqTopicsToFile({ jobId, store, signal, apiKey: key }),
        )
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Topic tagging failed.' }
      }
    },
  )

  ipcMain.handle(
    'mcq:weakTopicPdf',
    async (
      _event,
      jobId: string,
      topic: string,
    ): Promise<{ ok: boolean; filePath?: string; message?: string }> => {
      const key = process.env.DEEPSEEK_API_KEY?.trim()
      if (!key) {
        return { ok: false, message: 'Set DEEPSEEK_API_KEY for this export.' }
      }
      try {
        return await withSecondary((signal) =>
          generateWeakTopicMcqPdf({ jobId, store, signal, apiKey: key, topic }),
        )
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Weak-topic PDF failed.' }
      }
    },
  )
}
