import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  deepseekAnswerKeyBatchJson,
  deepseekCorrectMcqBatchJson,
  deepseekNotesSectionJson,
  deepseekRevisionFragmentJson,
  deepseekTopicTagBatchJson,
} from './deepseekClient.js'
import {
  emptyPolishCache,
  mcqAiBatchSize,
  questionContentHash,
  shouldPolishQuestionWithLlm,
  type McqPolishCacheFile,
} from './mcqAiRouting.js'
import type { AnswerKeyRow } from './mcqRawHtml.js'
import type { McqAiMode, McqQuestionsFile } from './mcqTypes.js'

const CACHE_FILENAME = 'deepseek_mcq_cache.json'

function chunkIndices(indices: number[], size: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < indices.length; i += size) {
    out.push(indices.slice(i, i + size))
  }
  return out
}

export async function polishMcqQuestionsWithLlm(opts: {
  apiKey: string
  signal: AbortSignal
  mode: McqAiMode
  questions: McqQuestionsFile['questions']
  outDir: string
  onProgress?: (message: string) => void
}): Promise<{
  questions: McqQuestionsFile['questions']
  deepSeekCallCount: number
  cacheHits: number
  skippedPolishCount: number
}> {
  const batchSize = mcqAiBatchSize()
  const questions = opts.questions.map((q) => ({ ...q, options: { ...q.options } }))

  const cachePath = path.join(opts.outDir, CACHE_FILENAME)
  let cache: McqPolishCacheFile = emptyPolishCache()
  try {
    const raw = await readFile(cachePath, 'utf8')
    const j = JSON.parse(raw) as McqPolishCacheFile
    if (j?.v === 1 && j.polishByHash && typeof j.polishByHash === 'object') {
      cache = j
    }
  } catch {
    /* no cache file yet */
  }

  let deepSeekCallCount = 0
  let cacheHits = 0
  let skippedPolishCount = 0

  const needFlags = questions.map((q) => shouldPolishQuestionWithLlm(q, opts.mode))
  for (const f of needFlags) {
    if (!f) skippedPolishCount++
  }

  const indicesNeeding = needFlags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0)
  const batches = chunkIndices(indicesNeeding, batchSize)

  for (const batchIdx of batches) {
    const toCall: McqQuestionsFile['questions'] = []
    const callPositions: number[] = []

    for (let j = 0; j < batchIdx.length; j++) {
      const qi = batchIdx[j]!
      const q = questions[qi]!
      const h = questionContentHash(q)
      const hit = cache.polishByHash[h]
      if (hit) {
        cacheHits++
        questions[qi] = {
          ...questions[qi]!,
          stem: hit.stem,
          options: { ...hit.options },
        }
      } else {
        toCall.push(q)
        callPositions.push(j)
      }
    }

    if (toCall.length === 0) continue

    opts.onProgress?.(`DeepSeek OCR cleanup · ${toCall.length} question(s)…`)

    let corrected: Array<{ id: string; stem: string; options: Record<string, string> }>
    try {
      corrected = await deepseekCorrectMcqBatchJson({
        apiKey: opts.apiKey,
        signal: opts.signal,
        batch: toCall,
      })
      deepSeekCallCount++
    } catch {
      corrected = toCall.map((q) => ({
        id: q.id,
        stem: q.stem,
        options: { ...q.options },
      }))
    }

    for (let k = 0; k < corrected.length; k++) {
      const orig = toCall[k]
      const c = corrected[k]
      if (!orig || !c) continue
      const h = questionContentHash(orig)
      cache.polishByHash[h] = { stem: c.stem, options: { ...c.options } }
      const j = callPositions[k]
      if (j === undefined) continue
      const qi = batchIdx[j]!
      questions[qi] = {
        ...questions[qi]!,
        stem: c.stem,
        options: { ...c.options },
      }
    }
  }

  try {
    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* ignore cache write errors */
  }

  return { questions, deepSeekCallCount, cacheHits, skippedPolishCount }
}

export async function batchedAnswerKeyRows(opts: {
  apiKey: string
  signal: AbortSignal
  questions: McqQuestionsFile['questions']
  onProgress?: (message: string) => void
}): Promise<AnswerKeyRow[]> {
  const bs = mcqAiBatchSize()
  const qs = opts.questions
  const rows: AnswerKeyRow[] = []
  for (let i = 0; i < qs.length; i += bs) {
    const batch = qs.slice(i, i + bs)
    opts.onProgress?.(`Answer key · batch ${Math.floor(i / bs) + 1}…`)
    try {
      const part = await deepseekAnswerKeyBatchJson({
        apiKey: opts.apiKey,
        signal: opts.signal,
        batch,
      })
      for (let k = 0; k < batch.length; k++) {
        const r = part[k]
        const q = batch[k]!
        rows.push(
          r
            ? r
            : {
                id: q.id,
                letter: '?',
                rationale: 'Missing model row — verify manually.',
              },
        )
      }
    } catch {
      for (const q of batch) {
        rows.push({
          id: q.id,
          letter: '?',
          rationale: 'DeepSeek unavailable — verify manually.',
        })
      }
    }
  }
  return rows
}

export async function batchedNotesSections(opts: {
  apiKey: string
  signal: AbortSignal
  questions: McqQuestionsFile['questions']
  onProgress?: (message: string) => void
}): Promise<Array<{ title: string; html: string }>> {
  const bs = mcqAiBatchSize()
  const qs = opts.questions
  const sections: Array<{ title: string; html: string }> = []
  for (let i = 0; i < qs.length; i += bs) {
    const batch = qs.slice(i, i + bs)
    opts.onProgress?.(`Study notes · section ${Math.floor(i / bs) + 1}…`)
    try {
      const sec = await deepseekNotesSectionJson({
        apiKey: opts.apiKey,
        signal: opts.signal,
        batch,
      })
      sections.push(sec)
    } catch {
      sections.push({
        title: `Batch ${Math.floor(i / bs) + 1}`,
        html: `<section><p>Section unavailable (offline or timeout). Use raw MCQ export.</p><pre>${escapeMinimal(
          batch.map((q) => q.stem).join('\n---\n'),
        )}</pre></section>`,
      })
    }
  }
  return sections
}

function escapeMinimal(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

export async function batchedTopicAnnotations(opts: {
  apiKey: string
  signal: AbortSignal
  questions: McqQuestionsFile['questions']
  onProgress?: (message: string) => void
}): Promise<McqQuestionsFile['questions']> {
  const bs = mcqAiBatchSize()
  const out = opts.questions.map((q) => ({ ...q, options: { ...q.options } }))
  for (let i = 0; i < out.length; i += bs) {
    const batch = out.slice(i, i + bs)
    opts.onProgress?.(`Topic tags · batch ${Math.floor(i / bs) + 1}…`)
    try {
      const tags = await deepseekTopicTagBatchJson({
        apiKey: opts.apiKey,
        signal: opts.signal,
        batch,
      })
      for (let k = 0; k < batch.length; k++) {
        const row = tags[k]
        const qi = i + k
        if (row && out[qi]) {
          out[qi] = { ...out[qi]!, topics: row.topics.length ? row.topics : undefined }
        }
      }
    } catch {
      /* keep existing topics unchanged for this batch */
    }
  }
  return out
}

export async function batchedRevisionFragments(opts: {
  apiKey: string
  signal: AbortSignal
  questions: McqQuestionsFile['questions']
  onProgress?: (message: string) => void
}): Promise<string[]> {
  const bs = mcqAiBatchSize()
  const qs = opts.questions
  const fragments: string[] = []
  for (let i = 0; i < qs.length; i += bs) {
    const batch = qs.slice(i, i + bs)
    opts.onProgress?.(`Revision sheet · batch ${Math.floor(i / bs) + 1}…`)
    try {
      const html = await deepseekRevisionFragmentJson({
        apiKey: opts.apiKey,
        signal: opts.signal,
        batch,
      })
      fragments.push(html)
    } catch {
      fragments.push(
        `<section><h2>Batch ${Math.floor(i / bs) + 1}</h2><p>Revision fragment unavailable.</p></section>`,
      )
    }
  }
  return fragments
}
