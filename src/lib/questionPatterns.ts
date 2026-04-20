/**
 * Heuristics for exam-style slide text (post-OCR). Best-effort; OCR noise tolerated lightly.
 */

export type QuestionPatternFlags = {
  hasQuestionMark: boolean
  mcqStyle: boolean
  romanEnumeration: boolean
}

const ROMAN_LINE = /(?:^|\s)(i{1,3}|iv|v|vi{0,3}|ix|x)\s*[).:]/i
const MCQ_PARENS = /\(\s*[A-Da-d]\s*\)/
const MCQ_DOT = /(?:^|\s)[A-Da-d]\s*[).]\s/m
const QUESTION_MARK = /\?/

export function normalizeOcrText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s?.:();-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function analyzeQuestionPatterns(text: string): QuestionPatternFlags {
  const n = text.trim()
  return {
    hasQuestionMark: QUESTION_MARK.test(n),
    mcqStyle: MCQ_PARENS.test(n) || MCQ_DOT.test(n),
    romanEnumeration: ROMAN_LINE.test(n),
  }
}

/** Ratio in [0,1]; 1 = identical. */
export function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const matrix: number[][] = []
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  const row0 = matrix[0]
  if (!row0) return 0
  for (let j = 0; j <= a.length; j++) {
    row0[j] = j
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const bi = b[i - 1]
      const aj = a[j - 1]
      const row = matrix[i]
      const prevRow = matrix[i - 1]
      if (!row || !prevRow) continue
      if (bi === aj) {
        row[j] = prevRow[j - 1] ?? 0
      } else {
        row[j] = Math.min(
          (prevRow[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (prevRow[j - 1] ?? 0) + 1,
        )
      }
    }
  }
  const lastRow = matrix[b.length]
  const dist = lastRow?.[a.length] ?? Math.max(a.length, b.length)
  return 1 - dist / Math.max(a.length, b.length)
}

const DEFAULT_SIMILARITY = 0.88

/** Greedy clustering: each frame assigned a group id; similar OCR text shares an id. */
export function groupDuplicateFrames(
  frames: Array<{ name: string; ocrText?: string }>,
  similarity = DEFAULT_SIMILARITY,
): Map<string, number> {
  const nameToGroup = new Map<string, number>()
  const groups: { repNorm: string }[] = []

  for (const f of frames) {
    const norm = f.ocrText ? normalizeOcrText(f.ocrText) : ''
    if (norm.length < 4) {
      const id = groups.length
      groups.push({ repNorm: `__empty_${f.name}` })
      nameToGroup.set(f.name, id)
      continue
    }
    let idx = -1
    for (let g = 0; g < groups.length; g++) {
      const gr = groups[g]
      if (!gr || gr.repNorm.startsWith('__empty_')) continue
      if (levenshteinRatio(norm, gr.repNorm) >= similarity) {
        idx = g
        break
      }
    }
    if (idx < 0) {
      idx = groups.length
      groups.push({ repNorm: norm })
    }
    nameToGroup.set(f.name, idx)
  }

  return nameToGroup
}
