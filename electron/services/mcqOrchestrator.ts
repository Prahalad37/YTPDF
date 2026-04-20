import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { JobStore } from '../jobs/store.js'
import { renderHtmlToPdf } from '../pdf/htmlToPdf.js'
import { runPaddleWorkerOffMainThread, runTextBundleWorkerOffMainThread } from '../workers/mcqOcrBridge.js'
import {
  collapsePyqNearDuplicates,
  mcqAiBatchSize,
  shouldPolishQuestionWithLlm,
} from './mcqAiRouting.js'
import {
  batchedAnswerKeyRows,
  batchedNotesSections,
  polishMcqQuestionsWithLlm,
} from './mcqLlmPolish.js'
import {
  buildAnswerKeyHtmlFromRows,
  buildMcqPlainText,
  buildNotesStudyHtml,
  buildPolishedMcqHtmlFromQuestions,
  buildRawMcqHtmlFromQuestions,
  escapeHtml,
} from './mcqRawHtml.js'
import type {
  McqAiMode,
  McqGenerateResult,
  McqProgressPayload,
  McqProgressPhase,
  McqQuestionsFile,
} from './mcqTypes.js'

/** Default max time for Paddle / text-bundle subprocess (ms). Override with YTPDF_MCQ_OCR_TIMEOUT_MS. */
const DEFAULT_OCR_TIMEOUT_MS = 3_600_000

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

function ocrTimeoutSignal(user: AbortSignal): AbortSignal {
  const raw = process.env.YTPDF_MCQ_OCR_TIMEOUT_MS
  const ms = Math.max(60_000, Number(raw ?? DEFAULT_OCR_TIMEOUT_MS))
  const t = Number.isFinite(ms) ? ms : DEFAULT_OCR_TIMEOUT_MS
  return AbortSignal.any([user, AbortSignal.timeout(t)])
}

function mapStageToPhase(stage: string): McqProgressPhase {
  switch (stage) {
    case 'llm':
      return 'ai'
    case 'pdf':
      return 'pdf'
    case 'dedupe':
      return 'detecting'
    case 'ocr':
      return 'extracting'
    case 'init':
      return 'scanning'
    default:
      return 'extracting'
  }
}

function emit(
  jobId: string,
  onProgress: (p: McqProgressPayload) => void,
  partial: { stage: string; current: number; total: number; message: string },
): void {
  onProgress({
    jobId,
    stage: partial.stage,
    phase: mapStageToPhase(partial.stage),
    current: partial.current,
    total: partial.total,
    message: partial.message,
  })
}

async function finalizeMcqPdf(params: {
  jobId: string
  signal: AbortSignal
  onProgress: (p: McqProgressPayload) => void
  outDir: string
  jsonPath: string
  txtPath: string
  mode: McqAiMode
}): Promise<McqGenerateResult> {
  const { jobId, signal, onProgress, outDir, jsonPath, txtPath, mode } = params
  const key = process.env.DEEPSEEK_API_KEY?.trim()

  const jsonRaw = await readFile(jsonPath, 'utf8')
  let parsed = JSON.parse(jsonRaw) as McqQuestionsFile
  let questions = [...(parsed.questions ?? [])]

  if (mode === 'pyq') {
    questions = collapsePyqNearDuplicates(questions)
  }

  let deepSeekCallCount = 0
  let cacheHits = 0
  let skippedPolishCount = 0
  let usedFallback = false
  let answerKeyPdfPath: string | undefined

  const pyqBanner =
    mode === 'pyq'
      ? '<p class="banner"><strong>PYQ mode:</strong> near-duplicate question stems were merged locally before export.</p>'
      : ''

  emit(jobId, onProgress, {
    stage: 'llm',
    current: 0,
    total: 2,
    message:
      mode === 'notes'
        ? 'Generating study notes with DeepSeek…'
        : 'Preparing MCQ document…',
  })

  let html: string

  if (mode === 'notes') {
    if (!key) {
      html = buildNotesStudyHtml([
        {
          title: 'Offline',
          html: '<section><p>Set <code>DEEPSEEK_API_KEY</code> to enable summarization. Showing raw question stems below.</p></section>',
        },
        {
          title: 'Questions',
          html: `<section><pre style="white-space:pre-wrap;font-size:11px">${escapeHtml(
            questions.map((q) => `${q.id}: ${q.stem}`).join('\n\n'),
          )}</pre></section>`,
        },
      ])
      usedFallback = true
    } else {
      const sections = await batchedNotesSections({
        apiKey: key,
        signal,
        questions,
        onProgress: (m) =>
          emit(jobId, onProgress, { stage: 'llm', current: 0, total: 2, message: m }),
      })
      deepSeekCallCount =
        questions.length > 0 ? Math.ceil(questions.length / mcqAiBatchSize()) : 0
      html = buildNotesStudyHtml(sections)
    }
  } else {
    const anyLlm = questions.some((q) => shouldPolishQuestionWithLlm(q, mode))

    if (anyLlm && !key) {
      html = buildRawMcqHtmlFromQuestions({ ...parsed, questions })
      usedFallback = true
    } else if (!anyLlm) {
      html = buildPolishedMcqHtmlFromQuestions(
        { ...parsed, questions },
        {
          subtitle: 'High-confidence OCR — layout formatted locally (no LLM cleanup).',
          bannerHtml: pyqBanner,
        },
      )
      skippedPolishCount = questions.length
    } else {
      const polished = await polishMcqQuestionsWithLlm({
        apiKey: key!,
        signal,
        mode,
        questions,
        outDir,
        onProgress: (m) =>
          emit(jobId, onProgress, { stage: 'llm', current: 0, total: 2, message: m }),
      })
      questions = polished.questions
      deepSeekCallCount = polished.deepSeekCallCount
      cacheHits = polished.cacheHits
      skippedPolishCount = polished.skippedPolishCount
      html = buildPolishedMcqHtmlFromQuestions(
        { ...parsed, questions },
        {
          subtitle: 'OCR cleanup via DeepSeek where needed; layout formatted locally.',
          bannerHtml: pyqBanner,
        },
      )
    }
  }

  parsed = { ...parsed, questions }
  await writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8')
  await writeFile(txtPath, buildMcqPlainText(questions), 'utf8')

  const htmlPath =
    mode === 'notes'
      ? path.join(outDir, usedFallback ? 'mcq_notes_raw.html' : 'mcq_notes.html')
      : path.join(outDir, usedFallback ? 'mcq_raw.html' : 'mcq_polished.html')
  await writeFile(htmlPath, html, 'utf8')

  emit(jobId, onProgress, {
    stage: 'pdf',
    current: 2,
    total: 2,
    message: 'Rendering PDF…',
  })

  await yieldEventLoop()

  let pdfBytes: Uint8Array
  try {
    pdfBytes = await renderHtmlToPdf(html, signal)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, message: 'MCQ generation cancelled.' }
    }
    const msg = e instanceof Error ? e.message : 'PDF render failed'
    return { ok: false, message: msg }
  }

  await yieldEventLoop()

  const mcqPdfPath =
    mode === 'notes'
      ? path.join(outDir, 'mcq_notes.pdf')
      : path.join(outDir, 'mcq_exam.pdf')
  await writeFile(mcqPdfPath, pdfBytes)

  if (mode === 'exam' && key && questions.length > 0) {
    emit(jobId, onProgress, {
      stage: 'llm',
      current: 1,
      total: 2,
      message: 'Exam pack: building batched answer key…',
    })
    try {
      const rows = await batchedAnswerKeyRows({
        apiKey: key,
        signal,
        questions,
        onProgress: (m) =>
          emit(jobId, onProgress, { stage: 'llm', current: 1, total: 2, message: m }),
      })
      const akHtml = buildAnswerKeyHtmlFromRows(rows)
      const akBytes = await renderHtmlToPdf(akHtml, signal)
      answerKeyPdfPath = path.join(outDir, 'mcq_answer_key.pdf')
      await writeFile(answerKeyPdfPath, akBytes)
      deepSeekCallCount +=
        questions.length > 0 ? Math.ceil(questions.length / mcqAiBatchSize()) : 0
    } catch {
      /* answer key is optional; main MCQ PDF already succeeded */
    }
  }

  return {
    ok: true,
    mcqPdfPath,
    mcqJsonPath: jsonPath,
    htmlPath,
    txtPath,
    questionCount: questions.length,
    usedDeepSeekFallback: usedFallback,
    message: usedFallback
      ? mode === 'notes'
        ? 'Notes saved without full AI (missing API key or timeout).'
        : 'PDF saved without DeepSeek cleanup (no API key or offline). OCR text is unchanged.'
      : undefined,
    mcqAiMode: mode,
    deepSeekCallCount,
    cacheHits,
    skippedPolishCount,
    answerKeyPdfPath,
  }
}

export async function runMcqPipeline(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
  onProgress: (p: McqProgressPayload) => void
  mode?: McqAiMode
}): Promise<McqGenerateResult> {
  const { jobId, store, signal, onProgress } = params
  const mode = params.mode ?? 'fast'

  const job = await store.get(jobId)
  if (!job) {
    return { ok: false, message: 'Job not found.' }
  }
  if (job.state !== 'done') {
    return { ok: false, message: 'MCQ PDF is only available after extraction completes.' }
  }
  const framesDir = job.framesDir?.trim() || store.getFramesDir(jobId)
  try {
    await access(framesDir)
  } catch {
    return {
      ok: false,
      message:
        'Frames folder is missing on disk (expected under this job’s directory). Re-run extraction if files were moved or deleted.',
    }
  }

  const jobDir = store.getJobDir(jobId)
  const outDir = path.join(jobDir, 'mcq')
  await mkdir(outDir, { recursive: true })

  emit(jobId, onProgress, {
    stage: 'init',
    current: 0,
    total: 1,
    message: 'Starting MCQ OCR…',
  })

  const ocrSignal = ocrTimeoutSignal(signal)

  const ocr = await runPaddleWorkerOffMainThread({
    framesDir,
    outDir,
    signal: ocrSignal,
    onEvent: (ev) => {
      if (ev.type === 'progress') {
        emit(jobId, onProgress, {
          stage: ev.stage,
          current: ev.current,
          total: Math.max(1, ev.total),
          message: ev.message ?? '',
        })
      }
    },
  })

  if (!ocr.ok) {
    return { ok: false, message: ocr.message }
  }

  return finalizeMcqPdf({
    jobId,
    signal,
    onProgress,
    outDir,
    jsonPath: ocr.jsonPath,
    txtPath: ocr.txtPath,
    mode,
  })
}

export async function runMcqPipelineFromAnalyzedText(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
  onProgress: (p: McqProgressPayload) => void
  mode?: McqAiMode
}): Promise<McqGenerateResult> {
  const { jobId, store, signal, onProgress } = params
  const mode = params.mode ?? 'fast'

  const job = await store.get(jobId)
  if (!job) {
    return { ok: false, message: 'Job not found.' }
  }
  if (job.state !== 'done') {
    return { ok: false, message: 'MCQ PDF is only available after extraction completes.' }
  }

  const usable = job.frames.filter(
    (f) => typeof f.ocrText === 'string' && f.ocrText.trim().length > 0 && f.includeInPdf !== false,
  )
  if (usable.length === 0) {
    return {
      ok: false,
      message: 'Run Analyze text first (no OCR text on frames).',
    }
  }

  const jobDir = store.getJobDir(jobId)
  const outDir = path.join(jobDir, 'mcq')
  await mkdir(outDir, { recursive: true })

  const bundlePath = path.join(outDir, 'mcq_text_bundle.json')
  const bundle = usable.map((f) => ({
    name: f.name,
    text: f.ocrText ?? '',
    meanConfidence: f.ocrConfidence ?? 70,
  }))
  await writeFile(bundlePath, JSON.stringify(bundle), 'utf8')

  emit(jobId, onProgress, {
    stage: 'init',
    current: 0,
    total: Math.max(1, usable.length),
    message: 'Building MCQ JSON from analyzed text…',
  })

  const ocrSignal = ocrTimeoutSignal(signal)

  const ocr = await runTextBundleWorkerOffMainThread({
    bundlePath,
    outDir,
    signal: ocrSignal,
    onEvent: (ev) => {
      if (ev.type === 'progress') {
        emit(jobId, onProgress, {
          stage: ev.stage,
          current: ev.current,
          total: Math.max(1, ev.total),
          message: ev.message ?? '',
        })
      }
    },
  })

  if (!ocr.ok) {
    return { ok: false, message: ocr.message }
  }

  const jsonRaw = await readFile(ocr.jsonPath, 'utf8')
  const parsed = JSON.parse(jsonRaw) as McqQuestionsFile
  if ((parsed.questions ?? []).length === 0) {
    return {
      ok: false,
      message: 'No MCQ-like blocks found in analyzed text.',
    }
  }

  return finalizeMcqPdf({
    jobId,
    signal,
    onProgress,
    outDir,
    jsonPath: ocr.jsonPath,
    txtPath: ocr.txtPath,
    mode,
  })
}
