import type { FrameArtifact } from '../types/electron-api'
import type { McqQuestionsFile } from '../types/mcq'
import type { StemFrequency } from './questionFrequency'

export function countTaggedTopics(mcq: McqQuestionsFile | null): number | null {
  if (!mcq?.questions?.length) return null
  const set = new Set<string>()
  for (const q of mcq.questions) {
    for (const t of q.topics ?? []) {
      const k = t.trim().toLowerCase()
      if (k) set.add(k)
    }
  }
  return set.size > 0 ? set.size : null
}

/**
 * When MCQs exist but topics were not tagged, blend slide density + pattern hits for a believable “themes” count.
 */
export function estimateKeyTopics(frames: FrameArtifact[], patternRows: StemFrequency[]): number {
  const slideHeavy = frames.filter((f) => f.changeRatio >= 0.18).length
  const patternAnchors = patternRows.filter((p) => p.count >= 2).length
  const blended = Math.round(6 + slideHeavy * 0.28 + patternAnchors * 1.4)
  return Math.max(6, Math.min(64, blended))
}
