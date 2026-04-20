import type { JobState } from './types.js'

const TERMINAL_STATES: ReadonlySet<JobState> = new Set(['done', 'failed', 'fallback_required', 'cancelled'])

const TRANSITIONS: Record<JobState, ReadonlySet<JobState>> = {
  queued: new Set(['probing', 'paused', 'cancelled']),
  probing: new Set(['downloading', 'extracting', 'fallback_required', 'failed', 'paused', 'cancelled']),
  downloading: new Set(['extracting', 'fallback_required', 'failed', 'paused', 'cancelled']),
  extracting: new Set(['filtering', 'fallback_required', 'failed', 'paused', 'cancelled']),
  filtering: new Set(['building_pdf', 'failed', 'paused', 'cancelled']),
  building_pdf: new Set(['done', 'failed', 'paused', 'cancelled']),
  paused: new Set(['probing', 'downloading', 'extracting', 'filtering', 'building_pdf', 'cancelled']),
  done: new Set(),
  failed: new Set(),
  fallback_required: new Set(),
  cancelled: new Set(),
}

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_STATES.has(state)
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].has(to)
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job state transition: ${from} -> ${to}`)
  }
}
