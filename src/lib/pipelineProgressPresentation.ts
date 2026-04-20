import type { JobRecord, JobState } from '../types/electron-api'

export const PIPELINE_STAGE_LABELS = [
  'Reading video',
  'Finding important frames',
  'Reading text',
  'Organizing questions',
  'Creating PDF',
] as const

/** Maps backend state + percent to a monotonic 1–5 index for UI (never decreases within a job). */
export function pipelineStageIndex(job: JobRecord | null): number {
  if (!job) return 1
  const s = job.state as JobState
  const p = job.progress.percent

  if (s === 'queued' || s === 'probing') return 1
  if (s === 'downloading') return 1
  if (s === 'extracting') {
    if (p < 40) return 2
    return 2
  }
  if (s === 'filtering') {
    if (p < 78) return 3
    return 4
  }
  if (s === 'building_pdf') return 5
  if (s === 'done') return 5
  if (s === 'paused') return Math.min(5, Math.max(1, Math.ceil(p / 25)))
  return Math.min(5, Math.max(1, Math.ceil(p / 20)))
}

export function pipelineStageLine(_job: JobRecord | null, index1Based: number): string {
  const i = Math.min(PIPELINE_STAGE_LABELS.length, Math.max(1, index1Based))
  return `${i}/${PIPELINE_STAGE_LABELS.length} ${PIPELINE_STAGE_LABELS[i - 1]}`
}
