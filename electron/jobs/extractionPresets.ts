export type ExtractionPreset = 'fast_notes' | 'mcq_hunter' | 'full_lecture' | 'exam_revision'

export type ResolvedLocalCapture = {
  fpsIntervalSeconds: number
  cooldownSeconds: number
  changeThreshold: number
}

const PRESETS: Record<ExtractionPreset, ResolvedLocalCapture> = {
  fast_notes: { fpsIntervalSeconds: 3, cooldownSeconds: 2.5, changeThreshold: 0.22 },
  mcq_hunter: { fpsIntervalSeconds: 0.5, cooldownSeconds: 1, changeThreshold: 0.1 },
  full_lecture: { fpsIntervalSeconds: 1, cooldownSeconds: 2, changeThreshold: 0.15 },
  exam_revision: { fpsIntervalSeconds: 2, cooldownSeconds: 2.5, changeThreshold: 0.18 },
}

export function normalizeExtractionPreset(value: string | undefined): ExtractionPreset {
  if (value === 'fast_notes' || value === 'mcq_hunter' || value === 'exam_revision') {
    return value
  }
  return 'full_lecture'
}

export function baseParamsForPreset(preset: ExtractionPreset): ResolvedLocalCapture {
  return { ...PRESETS[preset] }
}

/** Slightly fewer samples on very long sources when not using advanced overrides. */
export function applyDurationHeuristic(
  params: ResolvedLocalCapture,
  durationSec: number | null | undefined,
): ResolvedLocalCapture {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec < 600) {
    return params
  }
  const mult = durationSec > 3600 ? 1.35 : 1.15
  return {
    fpsIntervalSeconds: Math.min(120, params.fpsIntervalSeconds * mult),
    cooldownSeconds: Math.min(300, params.cooldownSeconds * 1.1),
    changeThreshold: params.changeThreshold,
  }
}

export function mergeAdvancedCapture(
  base: ResolvedLocalCapture,
  advanced?: {
    fpsIntervalSeconds?: number
    cooldownSeconds?: number
    changeThreshold?: number
  },
): ResolvedLocalCapture {
  if (!advanced) return base
  return {
    fpsIntervalSeconds:
      advanced.fpsIntervalSeconds !== undefined
        ? advanced.fpsIntervalSeconds
        : base.fpsIntervalSeconds,
    cooldownSeconds:
      advanced.cooldownSeconds !== undefined ? advanced.cooldownSeconds : base.cooldownSeconds,
    changeThreshold:
      advanced.changeThreshold !== undefined ? advanced.changeThreshold : base.changeThreshold,
  }
}

export function resolveLocalCaptureForJob(input: {
  preset: ExtractionPreset
  durationSec?: number | null
  advanced?: {
    fpsIntervalSeconds?: number
    cooldownSeconds?: number
    changeThreshold?: number
  }
}): ResolvedLocalCapture {
  let p = baseParamsForPreset(input.preset)
  const hasAdvanced =
    input.advanced &&
    (input.advanced.fpsIntervalSeconds !== undefined ||
      input.advanced.cooldownSeconds !== undefined ||
      input.advanced.changeThreshold !== undefined)
  if (!hasAdvanced) {
    p = applyDurationHeuristic(p, input.durationSec)
  }
  return mergeAdvancedCapture(p, input.advanced)
}
