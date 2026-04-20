import type { ExtractionPreset } from './extractionPresets.js'

export type { ExtractionPreset } from './extractionPresets.js'

export type CaptureMode = 'mode_a' | 'mode_b'

export type JobState =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'extracting'
  | 'filtering'
  | 'building_pdf'
  | 'paused'
  | 'done'
  | 'failed'
  | 'fallback_required'
  | 'cancelled'

export type JobStage = JobState

export type ErrorCode =
  | 'network'
  | 'protected_content'
  | 'binary_missing'
  | 'path_permission'
  | 'validation'
  | 'unknown'

export type JobRequest =
  | { kind: 'local'; filePath: string }
  | { kind: 'remote'; url: string; intervalSec: number }

export type AnalyzeRequest = {
  url: string
  intervalSec: number
}

export type AnalyzeLocalRequest = {
  filePath: string
  /** Student-facing mode; drives sample interval, cooldown, and change threshold unless advanced overrides are set. */
  extractionPreset?: ExtractionPreset
  /** When set, these override preset-derived capture parameters (Advanced panel). */
  advancedCapture?: {
    fpsIntervalSeconds?: number
    cooldownSeconds?: number
    changeThreshold?: number
  }
  /** Seconds between sampled frames (ffmpeg fps=1/N). Default 1. */
  fpsIntervalSeconds?: number
  /** Smart-filter cooldown after an accepted frame (seconds). Default 2. */
  cooldownSeconds?: number
  /** Tesseract `-l` argument (e.g. eng, hin). Default eng. */
  ocrLanguage?: string
}

export type JobProgress = {
  stage: JobStage
  message: string
  percent: number
}

export type FrameArtifact = {
  name: string
  seconds: number
  path: string
  changeRatio: number
  phash: string
  /** Raw OCR text when analysis has run. */
  ocrText?: string
  ocrConfidence?: number
  /** Include this frame in the exported PDF; default true when unset. */
  includeInPdf?: boolean
  dataUrl?: string
}

export type JobLogLevel = 'info' | 'warn' | 'error'

export type JobLogEntry = {
  ts: string
  level: JobLogLevel
  stage: JobStage
  message: string
}

export type JobError = {
  code: ErrorCode
  message: string
}

export type JobRecord = {
  id: string
  request: JobRequest
  createdAt: string
  updatedAt: string
  state: JobState
  modeUsed?: CaptureMode
  modePlanned?: CaptureMode
  fallbackRequired: boolean
  error?: JobError
  progress: JobProgress
  /** Known duration (seconds) for progress; set after ffprobe for local files. */
  videoDurationSec?: number
  videoId?: string
  title?: string
  videoPath?: string
  pdfPath?: string
  framesDir?: string
  frames: FrameArtifact[]
  skippedBlank: number
  skippedDuplicate: number
  logs: JobLogEntry[]
  /** Local pipeline: seconds between frame samples (default 1). */
  localFpsIntervalSec?: number
  /** Local pipeline: smart-filter cooldown in seconds (default 2). */
  localCooldownSec?: number
  /** Preset chosen when the job was created. */
  extractionPreset?: ExtractionPreset
  /** Advanced panel overrides; when absent, preset + duration heuristic applies. */
  localAdvancedCapture?: {
    fpsIntervalSeconds?: number
    cooldownSeconds?: number
    changeThreshold?: number
  }
  /** Perceptual hash / motion gate threshold used for this run. */
  localSmartChangeThreshold?: number
  /** Tesseract language code used for frame OCR. */
  ocrLanguage?: string
  lastMcqCount?: number
  lastMcqAt?: string
  mcqJsonPath?: string
  mcqTxtPath?: string
  mcqPdfPath?: string
  answerKeyPdfPath?: string
  revisionSheetPath?: string
  /** Bookmarks, solved IDs, etc. (JSON). */
  studentStateJson?: string
}

export type AnalyzeResponse = {
  jobId: string
  modePlanned: CaptureMode
}

export type AnalyzeLocalResponse = {
  jobId: string
  modePlanned: CaptureMode
}

