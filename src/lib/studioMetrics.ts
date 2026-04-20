import type { JobRecord } from '../types/electron-api'

/** Rough “manual screenshot” time avoided: ~8s per dropped frame + 3s per kept frame to curate. */
export function estimateTimeSavedMinutes(job: JobRecord | null): number {
  if (!job) return 0
  const dropped = job.skippedBlank + job.skippedDuplicate
  const kept = job.frames.length
  const seconds = dropped * 8 + kept * 3
  return Math.max(0, Math.round(seconds / 60))
}

export function formatSavedDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/** Compact label for hero metrics, e.g. "2h 30m" / "45m". */
export function formatSavedDurationShort(minutes: number): string {
  if (minutes <= 0) return '0m'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function junkRemovedPercent(job: JobRecord | null): number {
  if (!job) return 0
  const total = job.frames.length + job.skippedBlank + job.skippedDuplicate
  if (total <= 0) return 0
  const junk = job.skippedBlank + job.skippedDuplicate
  return Math.min(99, Math.round((junk / total) * 100))
}
