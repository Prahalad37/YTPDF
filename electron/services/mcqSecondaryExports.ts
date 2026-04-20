import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { JobRecord } from '../jobs/types.js'
import type { JobStore } from '../jobs/store.js'
import { renderHtmlToPdf } from '../pdf/htmlToPdf.js'
import {
  batchedAnswerKeyRows,
  batchedRevisionFragments,
  batchedTopicAnnotations,
  polishMcqQuestionsWithLlm,
} from './mcqLlmPolish.js'
import {
  buildAnswerKeyHtmlFromRows,
  buildPolishedMcqHtmlFromQuestions,
  buildRevisionHtmlDocument,
} from './mcqRawHtml.js'
import type { McqQuestionsFile } from './mcqTypes.js'

export type SecondaryExportResult = { ok: boolean; filePath?: string; message?: string }

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function resolveMcqJsonPath(
  jobId: string,
  store: JobStore,
  job: JobRecord,
): Promise<string | null> {
  if (job.mcqJsonPath) {
    try {
      await access(job.mcqJsonPath)
      return job.mcqJsonPath
    } catch {
      /* try default */
    }
  }
  const fallback = path.join(store.getJobDir(jobId), 'mcq', 'mcq_questions.json')
  try {
    await access(fallback)
    return fallback
  } catch {
    return null
  }
}

async function loadQuestions(jsonPath: string): Promise<McqQuestionsFile> {
  const raw = await readFile(jsonPath, 'utf8')
  return JSON.parse(raw) as McqQuestionsFile
}

function shuffleInPlace<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]!
    a[i] = a[j]!
    a[j] = t
  }
  return a
}

function buildShuffledExamHtml(questions: McqQuestionsFile['questions'], title: string): string {
  const shuffled = shuffleInPlace(questions)
  const blocks = shuffled
    .map((q, i) => {
      const opts = Object.entries(q.options)
        .map(([k, v]) => `<li><strong>${escapeHtml(k)}.</strong> ${escapeHtml(v)}</li>`)
        .join('')
      return `<article class="q"><h2>Question ${i + 1}</h2><p>${escapeHtml(q.stem)}</p><ol type="A" class="opts">${opts}</ol></article>`
    })
    .join('\n')
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><style>
body{font-family:ui-sans-serif,system-ui;margin:28px;line-height:1.45;color:#111}
.q{page-break-inside:avoid;margin-bottom:2rem;border-bottom:1px solid #eee;padding-bottom:1rem}
.opts{list-style:none;padding-left:0}
</style></head><body><h1>${escapeHtml(title)}</h1><p>Shuffled practice — Framebase AI</p>${blocks}</body></html>`
}

export async function generateAnswerKeyPdf(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
  apiKey: string
}): Promise<SecondaryExportResult> {
  const job = await params.store.get(params.jobId)
  if (!job || job.state !== 'done') {
    return { ok: false, message: 'Complete extraction first.' }
  }
  const jsonPath = await resolveMcqJsonPath(params.jobId, params.store, job)
  if (!jsonPath) {
    return { ok: false, message: 'No MCQ data found. Generate an MCQ PDF first.' }
  }
  const parsed = await loadQuestions(jsonPath)
  if ((parsed.questions ?? []).length === 0) {
    return { ok: false, message: 'MCQ file has no questions.' }
  }
  const outDir = path.join(params.store.getJobDir(params.jobId), 'mcq')
  try {
    const qs = parsed.questions ?? []
    const rows = await batchedAnswerKeyRows({
      apiKey: params.apiKey,
      signal: params.signal,
      questions: qs,
    })
    const html = buildAnswerKeyHtmlFromRows(rows)
    const pdfBytes = await renderHtmlToPdf(html, params.signal)
    const outPath = path.join(outDir, 'mcq_answer_key.pdf')
    await writeFile(outPath, pdfBytes)
    await params.store.patchJobExportMeta(params.jobId, { answerKeyPdfPath: outPath })
    return { ok: true, filePath: outPath }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Answer key failed.'
    return { ok: false, message: msg }
  }
}

export async function generateRevisionSheetPdf(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
  apiKey: string
}): Promise<SecondaryExportResult> {
  const job = await params.store.get(params.jobId)
  if (!job || job.state !== 'done') {
    return { ok: false, message: 'Complete extraction first.' }
  }
  const jsonPath = await resolveMcqJsonPath(params.jobId, params.store, job)
  if (!jsonPath) {
    return { ok: false, message: 'No MCQ data found. Generate an MCQ PDF first.' }
  }
  const parsed = await loadQuestions(jsonPath)
  if ((parsed.questions ?? []).length === 0) {
    return { ok: false, message: 'MCQ file has no questions.' }
  }
  const outDir = path.join(params.store.getJobDir(params.jobId), 'mcq')
  try {
    const qs = parsed.questions ?? []
    const fragments = await batchedRevisionFragments({
      apiKey: params.apiKey,
      signal: params.signal,
      questions: qs,
    })
    const html = buildRevisionHtmlDocument(fragments)
    const pdfBytes = await renderHtmlToPdf(html, params.signal)
    const outPath = path.join(outDir, 'revision_sheet.pdf')
    await writeFile(outPath, pdfBytes)
    await params.store.patchJobExportMeta(params.jobId, { revisionSheetPath: outPath })
    return { ok: true, filePath: outPath }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Revision sheet failed.'
    return { ok: false, message: msg }
  }
}

export async function generateShuffledPracticePdf(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
}): Promise<SecondaryExportResult> {
  const job = await params.store.get(params.jobId)
  if (!job || job.state !== 'done') {
    return { ok: false, message: 'Complete extraction first.' }
  }
  const jsonPath = await resolveMcqJsonPath(params.jobId, params.store, job)
  if (!jsonPath) {
    return { ok: false, message: 'No MCQ data found. Generate an MCQ PDF first.' }
  }
  const parsed = await loadQuestions(jsonPath)
  const qs = parsed.questions ?? []
  if (qs.length === 0) {
    return { ok: false, message: 'MCQ file has no questions.' }
  }
  const outDir = path.join(params.store.getJobDir(params.jobId), 'mcq')
  const title = `${job.title ?? 'Practice'} — shuffled`
  try {
    const html = buildShuffledExamHtml(qs, title)
    const pdfBytes = await renderHtmlToPdf(html, params.signal)
    const outPath = path.join(outDir, 'mcq_practice_shuffled.pdf')
    await writeFile(outPath, pdfBytes)
    return { ok: true, filePath: outPath }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Shuffle export failed.'
    return { ok: false, message: msg }
  }
}

function slugTopic(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

export async function generateWeakTopicMcqPdf(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
  apiKey: string
  topic: string
}): Promise<SecondaryExportResult> {
  const job = await params.store.get(params.jobId)
  if (!job || job.state !== 'done') {
    return { ok: false, message: 'Complete extraction first.' }
  }
  const topic = params.topic.trim()
  if (!topic) {
    return { ok: false, message: 'Choose a topic.' }
  }
  const jsonPath = await resolveMcqJsonPath(params.jobId, params.store, job)
  if (!jsonPath) {
    return { ok: false, message: 'No MCQ data found.' }
  }
  const parsed = await loadQuestions(jsonPath)
  const needle = topic.toLowerCase()
  const filtered = (parsed.questions ?? []).filter((q) =>
    (q.topics ?? []).some((t) => t.toLowerCase().includes(needle)),
  )
  if (filtered.length === 0) {
    return {
      ok: false,
      message: 'No questions match that topic. Run “Tag topics” on MCQs first.',
    }
  }
  const subset: McqQuestionsFile = { ...parsed, questions: filtered }
  const outDir = path.join(params.store.getJobDir(params.jobId), 'mcq')
  try {
    let questions = filtered
    try {
      const polished = await polishMcqQuestionsWithLlm({
        apiKey: params.apiKey,
        signal: params.signal,
        mode: 'exam',
        questions: filtered,
        outDir,
      })
      questions = polished.questions
    } catch {
      /* use unpolished subset */
    }
    const html = buildPolishedMcqHtmlFromQuestions(
      { ...subset, questions },
      { subtitle: `Weak topic drill · ${topic}` },
    )
    const pdfBytes = await renderHtmlToPdf(html, params.signal)
    const outPath = path.join(outDir, `mcq_weak_${slugTopic(topic) || 'topic'}.pdf`)
    await writeFile(outPath, pdfBytes)
    return { ok: true, filePath: outPath }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Weak-topic PDF failed.'
    return { ok: false, message: msg }
  }
}

export async function tagMcqTopicsToFile(params: {
  jobId: string
  store: JobStore
  signal: AbortSignal
  apiKey: string
}): Promise<SecondaryExportResult> {
  const job = await params.store.get(params.jobId)
  if (!job || job.state !== 'done') {
    return { ok: false, message: 'Complete extraction first.' }
  }
  const jsonPath = await resolveMcqJsonPath(params.jobId, params.store, job)
  if (!jsonPath) {
    return { ok: false, message: 'No MCQ data found.' }
  }
  const parsed = await loadQuestions(jsonPath)
  if ((parsed.questions ?? []).length === 0) {
    return { ok: false, message: 'MCQ file has no questions.' }
  }
  const outDir = path.join(params.store.getJobDir(params.jobId), 'mcq')
  const outJson = path.join(outDir, 'mcq_questions_tagged.json')
  try {
    const qs = parsed.questions ?? []
    const tagged = await batchedTopicAnnotations({
      apiKey: params.apiKey,
      signal: params.signal,
      questions: qs,
    })
    const merged: McqQuestionsFile = { ...parsed, questions: tagged }
    await writeFile(outJson, JSON.stringify(merged, null, 2), 'utf8')
    await params.store.patchJobExportMeta(params.jobId, { mcqJsonPath: outJson })
    return { ok: true, filePath: outJson }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Topic tagging failed.'
    return { ok: false, message: msg }
  }
}
