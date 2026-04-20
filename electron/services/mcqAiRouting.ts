import { createHash } from 'node:crypto'
import type { McqAiMode, McqQuestionsFile } from './mcqTypes.js'

export const MCQ_AI_BATCH_DEFAULT = 25

export function mcqAiBatchSize(): number {
  const n = Number(process.env.YTPDF_MCQ_AI_BATCH)
  if (Number.isFinite(n) && n >= 5 && n <= 40) return Math.floor(n)
  return MCQ_AI_BATCH_DEFAULT
}

/** Minimum confidence (0–1) to consider skipping LLM polish when text also looks clean. */
export function confidenceSkipThreshold(mode: McqAiMode): number {
  switch (mode) {
    case 'exam':
      return 0.93
    case 'fast':
    case 'pyq':
    case 'notes':
      return 0.87
    default:
      return 0.87
  }
}

function normalizeForHash(q: {
  stem: string
  options: Record<string, string>
}): string {
  const stem = q.stem.trim().replace(/\s+/g, ' ').toLowerCase()
  const keys = Object.keys(q.options).sort()
  const optPart = keys.map((k) => `${k}:${(q.options[k] ?? '').trim()}`).join('|')
  return `${stem}::${optPart}`
}

export function questionContentHash(
  q: McqQuestionsFile['questions'][number],
): string {
  return createHash('sha256').update(normalizeForHash(q), 'utf8').digest('hex')
}

const REPLACEMENT = /\uFFFD|�/

/** Spacing patterns typical of line-box OCR (word split mid-token). Forces DeepSeek even if confidence is high. */
function fieldLikelyHasOcrWordBreakArtifacts(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  // e.g. "quoru m", "set u p" last step handled in Python; leftover "foo b ar" patterns
  if (/\p{L}{4,}\s+\p{Ll}{1,2}(?=[\s?.!,;:]|$)/u.test(t)) return true
  // Title-cased stub + lowercase tail: "Trip ura"
  if (/\b\p{Lu}\p{Ll}{2,}\s+\p{Ll}{2,4}\b/u.test(t)) return true
  return false
}

/** Structural / garbage heuristics on OCR text (independent of model confidence). */
export function textLooksStructurallyClean(
  q: McqQuestionsFile['questions'][number],
): boolean {
  const stem = (q.stem ?? '').trim()
  const opts = q.options ?? {}
  const letters = ['A', 'B', 'C', 'D'] as const
  const filled = letters.filter((L) => String(opts[L] ?? '').trim().length > 0).length
  if (stem.length < 12) return false
  if (filled < 4) return false
  if (REPLACEMENT.test(stem)) return false
  for (const L of letters) {
    const t = String(opts[L] ?? '')
    if (REPLACEMENT.test(t)) return false
  }
  const alnum = (stem.match(/[\p{L}\p{N}]/gu) ?? []).length
  if (alnum / Math.max(stem.length, 1) < 0.45) return false
  return true
}

function questionLikelyHasOcrWordBreakArtifacts(
  q: McqQuestionsFile['questions'][number],
): boolean {
  if (fieldLikelyHasOcrWordBreakArtifacts(q.stem ?? '')) return true
  for (const L of ['A', 'B', 'C', 'D'] as const) {
    if (fieldLikelyHasOcrWordBreakArtifacts(String(q.options?.[L] ?? ''))) return true
  }
  return false
}

export function shouldPolishQuestionWithLlm(
  q: McqQuestionsFile['questions'][number],
  mode: McqAiMode,
): boolean {
  if (mode === 'notes') return false
  if (questionLikelyHasOcrWordBreakArtifacts(q)) return true
  const thr = confidenceSkipThreshold(mode)
  if (q.confidence >= thr && textLooksStructurallyClean(q)) return false
  return true
}

function tokenMultisetJaccard(a: string, b: string): number {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  const ta = norm(a)
  const tb = norm(b)
  const ca = new Map<string, number>()
  const cb = new Map<string, number>()
  for (const t of ta) ca.set(t, (ca.get(t) ?? 0) + 1)
  for (const t of tb) cb.set(t, (cb.get(t) ?? 0) + 1)
  let inter = 0
  for (const [t, n] of ca) {
    const m = Math.min(n, cb.get(t) ?? 0)
    inter += m
  }
  const ua = ta.length
  const ub = tb.length
  if (ua + ub === 0) return 1
  return inter / (ua + ub - inter)
}

/**
 * Extra repetition pass for PYQ-style decks: merge near-duplicate stems (keeps higher confidence).
 */
export function collapsePyqNearDuplicates(
  questions: McqQuestionsFile['questions'],
  mergeThreshold = 0.91,
): McqQuestionsFile['questions'] {
  if (questions.length <= 1) return questions
  const out: McqQuestionsFile['questions'] = []
  const reps: string[] = []

  for (const q of questions) {
    const stem = (q.stem ?? '').trim()
    if (stem.length < 8) {
      out.push(q)
      reps.push(`__short_${out.length}`)
      continue
    }
    let merged = false
    for (let j = 0; j < reps.length; j++) {
      const rep = reps[j]!
      if (rep.startsWith('__')) continue
      if (tokenMultisetJaccard(stem, rep) >= mergeThreshold) {
        const prev = out[j]!
        const sf = new Set([...(prev.sourceFrames ?? []), ...(q.sourceFrames ?? [])])
        prev.sourceFrames = [...sf].sort()
        prev.confidence = Math.max(prev.confidence ?? 0, q.confidence ?? 0)
        merged = true
        break
      }
    }
    if (!merged) {
      out.push({ ...q })
      reps.push(stem)
    }
  }

  for (let i = 0; i < out.length; i++) {
    out[i] = { ...out[i]!, id: `q${i + 1}` }
  }
  return out
}

export type McqPolishCacheFile = {
  v: 1
  polishByHash: Record<
    string,
    { stem: string; options: Record<string, string> }
  >
}

export function emptyPolishCache(): McqPolishCacheFile {
  return { v: 1, polishByHash: {} }
}
