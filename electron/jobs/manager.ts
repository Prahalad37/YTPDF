import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { ffmpegInstallHint, resolveFfmpegOnly, resolveRuntimeBinaries, resolveTesseractPath } from './binaries.js'
import { filterFramesSmart, listFrameFiles } from './filters.js'
import {
  normalizeExtractionPreset,
  resolveLocalCaptureForJob,
  type ExtractionPreset,
} from './extractionPresets.js'
import { JobStore } from './store.js'
import { assertTransition, isTerminalState } from './state.js'
import type {
  AnalyzeLocalRequest,
  AnalyzeLocalResponse,
  AnalyzeRequest,
  AnalyzeResponse,
  ErrorCode,
  FrameArtifact,
  JobError,
  JobLogEntry,
  JobProgress,
  JobRecord,
  JobState,
  JobStage,
} from './types.js'
import { downloadVideo, probeUrl } from '../workers/download.js'
import { runTesseract } from '../workers/tesseract.js'
import { extractFrames } from '../workers/extract.js'
import { ffprobePathFromFfmpeg, getVideoDurationSec } from '../workers/ffprobe.js'

/** Lets the Electron main process handle IPC / timers so long PDF builds do not freeze the whole app. */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

type DumpJson = {
  id?: string
  title?: string
  is_live?: boolean
  live_status?: string
}

type RunningJob = {
  controller: AbortController
  pauseRequested: boolean
}

export type ProgressBroadcastPayload = {
  jobId: string
  state: JobState
  progress: JobProgress
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec % 60)
  const m = Math.floor((sec / 60) % 60)
  const h = Math.floor(sec / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function clampInterval(sec: number): number {
  if (!Number.isFinite(sec)) return 5
  return Math.max(1, Math.min(600, Math.floor(sec)))
}

/** Seconds between sampled frames for local extract (fps=1/N). */
function clampLocalFpsInterval(sec: number): number {
  if (!Number.isFinite(sec)) return 1
  return Math.min(120, Math.max(0.25, sec))
}

/** Smart-filter cooldown after an accepted frame (seconds). */
function clampLocalCooldown(sec: number): number {
  if (!Number.isFinite(sec)) return 2
  return Math.min(300, Math.max(0, sec))
}

function inferLive(meta: DumpJson): boolean {
  if (meta.is_live) return true
  const status = (meta.live_status ?? '').toLowerCase()
  return status === 'is_live' || status === 'is_upcoming' || status === 'post_live'
}

function classifyError(message: string): ErrorCode {
  const m = message.toLowerCase()
  if (m.includes('forbidden') || m.includes('private') || m.includes('members-only') || m.includes('drm')) {
    return 'protected_content'
  }
  if (m.includes('not found') && (m.includes('ffmpeg') || m.includes('yt-dlp'))) {
    return 'binary_missing'
  }
  if (m.includes('permission') || m.includes('enoent') || m.includes('eacces')) return 'path_permission'
  if (m.includes('invalid') || m.includes('url')) return 'validation'
  if (m.includes('network') || m.includes('timed out') || m.includes('unable to download')) return 'network'
  return 'unknown'
}

function terminalError(code: ErrorCode, message: string): JobError {
  return { code, message }
}

const JOB_TITLE_MAX_LENGTH = 200

/** Max raw PNGs returned during ffmpeg extract (before `job.frames` is populated). */
const RAW_PREVIEW_FRAME_CAP = 120

function pausedResumeStage(job: JobRecord): JobStage | undefined {
  if (job.state !== 'paused') return undefined
  const m = job.progress.message.match(/Paused at ([a-z_]+)/i)
  if (!m?.[1]) return undefined
  return m[1].toLowerCase() as JobStage
}

/** True while ffmpeg output may exist in `rawFramesDir` but final `job.frames` is still empty. */
function shouldOfferRawFramePreview(job: JobRecord): boolean {
  if (job.state === 'extracting' || job.state === 'filtering') return true
  if (job.state === 'paused') {
    const at = pausedResumeStage(job)
    return at === 'extracting' || at === 'filtering'
  }
  return false
}

function parseRawFrameFileIndex(filePath: string): number {
  const base = path.basename(filePath)
  const m = base.match(/(\d+)\.png$/i)
  if (!m?.[1]) return 1
  const idx = Number(m[1])
  return Number.isFinite(idx) && idx >= 1 ? idx : 1
}

function isTransientPipelineError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('worker exited') ||
    m.includes('exited with code') ||
    m.includes('econnreset') ||
    m.includes('spawn enoent') ||
    m.includes('timed out') ||
    m.includes('epipe')
  )
}

export class PipelineManager {
  private readonly store: JobStore
  private readonly running = new Map<string, RunningJob>()
  private readonly localPipelineRetried = new Set<string>()
  private progressBroadcaster?: (payload: ProgressBroadcastPayload) => void
  private lastBroadcastAt = new Map<string, number>()

  constructor(store: JobStore) {
    this.store = store
  }

  setProgressBroadcaster(fn: (payload: ProgressBroadcastPayload) => void): void {
    this.progressBroadcaster = fn
  }

  private broadcastThrottled(jobId: string, minIntervalMs = 220): void {
    const now = Date.now()
    const last = this.lastBroadcastAt.get(jobId) ?? 0
    if (now - last < minIntervalMs) return
    this.lastBroadcastAt.set(jobId, now)
    void this.store.get(jobId).then((job) => {
      if (!job) return
      this.progressBroadcaster?.({
        jobId,
        state: job.state,
        progress: job.progress,
      })
    })
  }

  async init(): Promise<void> {
    await this.store.init()
    const jobs = await this.store.list(50)
    for (const job of jobs) {
      if (!isTerminalState(job.state)) {
        await this.updateJob(job.id, (draft) => {
          this.transition(draft, 'failed')
          draft.error = terminalError('unknown', 'Job interrupted by app restart.')
          draft.progress = { stage: 'failed', message: 'Interrupted on restart', percent: 0 }
          this.log(draft, 'error', 'failed', 'Job interrupted by app restart.')
        })
      }
    }
    await this.store.cleanupOldArtifacts(20)
  }

  async analyzeLocal(request: AnalyzeLocalRequest): Promise<AnalyzeLocalResponse> {
    const id = randomUUID()
    const filePath = path.resolve(request.filePath.trim())
    const preset: ExtractionPreset = normalizeExtractionPreset(request.extractionPreset)
    const localAdvancedCapture: JobRecord['localAdvancedCapture'] =
      request.advancedCapture ??
      (request.fpsIntervalSeconds !== undefined || request.cooldownSeconds !== undefined
        ? {
            fpsIntervalSeconds:
              request.fpsIntervalSeconds === undefined
                ? undefined
                : clampLocalFpsInterval(request.fpsIntervalSeconds),
            cooldownSeconds:
              request.cooldownSeconds === undefined
                ? undefined
                : clampLocalCooldown(request.cooldownSeconds),
          }
        : undefined)
    const initialResolved = resolveLocalCaptureForJob({
      preset,
      durationSec: undefined,
      advanced: localAdvancedCapture,
    })
    const ocrLang = request.ocrLanguage?.trim() || 'eng'
    const record: JobRecord = {
      id,
      request: { kind: 'local', filePath },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      state: 'queued',
      modePlanned: 'mode_a',
      modeUsed: undefined,
      fallbackRequired: false,
      progress: { stage: 'queued', message: 'Queued', percent: 0 },
      frames: [],
      skippedBlank: 0,
      skippedDuplicate: 0,
      logs: [],
      extractionPreset: preset,
      localAdvancedCapture,
      localFpsIntervalSec: initialResolved.fpsIntervalSeconds,
      localCooldownSec: initialResolved.cooldownSeconds,
      localSmartChangeThreshold: initialResolved.changeThreshold,
      ocrLanguage: ocrLang,
    }
    this.log(
      record,
      'info',
      'queued',
      `Local job queued · ${preset} · sample ${initialResolved.fpsIntervalSeconds}s · cooldown ${initialResolved.cooldownSeconds}s · motion gate ${initialResolved.changeThreshold}.`,
    )
    await this.store.save(record)
    void this.runJob(id)
    return { jobId: id, modePlanned: 'mode_a' }
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    const id = randomUUID()
    const intervalSec = clampInterval(request.intervalSec)
    const record: JobRecord = {
      id,
      request: { kind: 'remote', url: request.url.trim(), intervalSec },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      state: 'queued',
      modePlanned: 'mode_a',
      modeUsed: undefined,
      fallbackRequired: false,
      progress: { stage: 'queued', message: 'Queued', percent: 0 },
      frames: [],
      skippedBlank: 0,
      skippedDuplicate: 0,
      logs: [],
    }
    this.log(record, 'info', 'queued', 'Job queued.')
    await this.store.save(record)
    void this.runJob(id)
    return { jobId: id, modePlanned: 'mode_a' }
  }

  async getStatus(jobId: string): Promise<JobRecord | null> {
    return this.store.get(jobId)
  }

  async listJobs(limit = 10): Promise<JobRecord[]> {
    return this.store.list(limit)
  }

  async getFrames(jobId: string): Promise<FrameArtifact[]> {
    const job = await this.store.get(jobId)
    if (!job) return []
    /** Omit embedded thumbnails — renderer lazy-loads per frame via `getFramePreviewDataUrl` to avoid huge IPC payloads. */
    if (job.frames.length > 0) {
      return job.frames.map((frame) => ({ ...frame, dataUrl: undefined }) satisfies FrameArtifact)
    }
    if (!shouldOfferRawFramePreview(job)) return []

    const rawFiles = await listFrameFiles(this.store.getRawFramesDir(jobId))
    if (rawFiles.length === 0) return []

    const capped =
      rawFiles.length > RAW_PREVIEW_FRAME_CAP
        ? rawFiles.slice(-RAW_PREVIEW_FRAME_CAP)
        : rawFiles
    const fps = job.localFpsIntervalSec ?? 1

    return capped.map((file) => {
      const name = path.basename(file)
      const idx = parseRawFrameFileIndex(file)
      const seconds = Math.max(0, (idx - 1) * fps)
      return {
        name,
        seconds,
        path: file,
        changeRatio: 0,
        phash: '',
      } satisfies FrameArtifact
    })
  }

  /** Single-frame PNG as data URL for gallery lazy-load (caps size to protect renderer memory). */
  async getFramePreviewDataUrl(
    jobId: string,
    frameName: string,
  ): Promise<{ dataUrl: string | null; message?: string }> {
    const job = await this.store.get(jobId)
    if (!job) return { dataUrl: null, message: 'Job not found.' }
    const safeName = path.basename(frameName)
    const fromFinal = job.frames.find((f) => f.name === safeName)
    let diskPath: string | null = fromFinal?.path ?? null
    if (!diskPath) {
      const candidate = path.join(this.store.getRawFramesDir(jobId), safeName)
      try {
        await access(candidate)
        diskPath = candidate
      } catch {
        diskPath = null
      }
    }
    if (!diskPath) return { dataUrl: null, message: 'Frame not found.' }
    const maxBytes = 8 * 1024 * 1024
    try {
      const st = await fs.stat(diskPath)
      if (st.size > maxBytes) {
        return { dataUrl: null, message: 'Frame file is too large to preview.' }
      }
      const bytes = await fs.readFile(diskPath)
      return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
    } catch {
      return { dataUrl: null, message: 'Could not read frame file.' }
    }
  }

  async getPdfPath(jobId: string): Promise<string | null> {
    const job = await this.store.get(jobId)
    return job?.pdfPath ?? null
  }

  /**
   * Removes a job from SQLite and deletes its `jobs/<id>` folder.
   * If the pipeline is running, aborts and waits for shutdown before deleting.
   */
  async removeJob(jobId: string): Promise<{ ok: boolean; message?: string }> {
    const running = this.running.get(jobId)
    if (running) {
      running.controller.abort()
      const deadline = Date.now() + 30_000
      while (this.running.has(jobId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (this.running.has(jobId)) {
        return { ok: false, message: 'Job is still shutting down. Try again in a moment.' }
      }
    }
    const job = await this.store.get(jobId)
    if (!job) return { ok: false, message: 'Job not found.' }
    await this.store.deleteJobCascade(jobId)
    return { ok: true }
  }

  async updateJobTitle(jobId: string, title: string): Promise<{ ok: boolean; message?: string }> {
    const t = title.trim()
    if (t.length === 0) return { ok: false, message: 'Title is empty.' }
    if (t.length > JOB_TITLE_MAX_LENGTH) {
      return { ok: false, message: `Title must be ${JOB_TITLE_MAX_LENGTH} characters or less.` }
    }
    try {
      await this.updateJob(jobId, (draft) => {
        draft.title = t
      })
      return { ok: true }
    } catch {
      return { ok: false, message: 'Job not found.' }
    }
  }

  /** Runs Tesseract on each kept frame and stores `ocr_text` / `ocr_confidence`. Job must be `done`. */
  async runFrameOcr(jobId: string): Promise<{ ok: boolean; message?: string }> {
    const tess = await resolveTesseractPath()
    if (!tess.path) return { ok: false, message: tess.message }
    const job = await this.store.get(jobId)
    if (!job) return { ok: false, message: 'Job not found.' }
    if (job.state !== 'done') {
      return { ok: false, message: 'OCR is only available after the job finishes.' }
    }
    if (job.frames.length === 0) return { ok: false, message: 'No frames to OCR.' }
    const total = job.frames.length
    for (let i = 0; i < total; i++) {
      const fr = job.frames[i]
      if (!fr) continue
      try {
        const lang = job.ocrLanguage?.trim() || 'eng'
        const { text, meanConfidence } = await runTesseract(fr.path, tess.path, lang)
        await this.store.updateFrameOcr(jobId, fr.name, text, meanConfidence)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'OCR failed'
        await this.store.updateFrameOcr(jobId, fr.name, `[OCR error] ${msg}`, null)
      }
      const pct = Math.min(99, Math.round((100 * (i + 1)) / total))
      await this.store.patchJobProgress(jobId, `OCR ${i + 1}/${total}…`, pct, nowIso())
      this.broadcastThrottled(jobId)
      await yieldEventLoop()
    }
    await this.updateJob(jobId, (draft) => {
      draft.progress = { stage: 'done', message: 'Complete', percent: 100 }
      this.log(draft, 'info', 'done', 'Frame OCR finished.')
    })
    this.broadcastThrottled(jobId, 0)
    return { ok: true }
  }

  async setFrameIncludeInPdf(
    jobId: string,
    frameName: string,
    include: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    const job = await this.store.get(jobId)
    if (!job) return { ok: false, message: 'Job not found.' }
    if (!job.frames.some((f) => f.name === frameName)) {
      return { ok: false, message: 'Frame not found.' }
    }
    await this.store.setFrameIncludeInPdf(jobId, frameName, include)
    return { ok: true }
  }

  /** Rebuilds `study.pdf` using frames where `includeInPdf` is true. */
  async rebuildPdfFromIncludedFrames(jobId: string): Promise<{ ok: boolean; message?: string }> {
    const job = await this.store.get(jobId)
    if (!job) return { ok: false, message: 'Job not found.' }
    if (job.state !== 'done') {
      return { ok: false, message: 'PDF rebuild requires a completed job.' }
    }
    const kept = job.frames.filter((f) => f.includeInPdf !== false)
    if (kept.length === 0) {
      return { ok: false, message: 'Select at least one frame to include in the PDF.' }
    }
    const pdfPath = this.store.getPdfPath(jobId)
    const label = job.videoId ?? job.title ?? job.id.slice(0, 8)
    try {
      await this.buildPdf(kept, pdfPath, label, jobId)
      await this.updateJob(jobId, (draft) => {
        draft.pdfPath = pdfPath
        draft.progress = { stage: 'done', message: 'Complete', percent: 100 }
      })
      this.broadcastThrottled(jobId, 0)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'PDF rebuild failed'
      return { ok: false, message: msg }
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const running = this.running.get(jobId)
    if (running) {
      running.controller.abort()
      return true
    }
    const job = await this.store.get(jobId)
    if (!job || isTerminalState(job.state)) return false
    await this.updateJob(jobId, (draft) => {
      this.transition(draft, 'cancelled')
      draft.error = terminalError('validation', 'Cancelled by user.')
      draft.progress = { stage: 'cancelled', message: 'Cancelled', percent: 100 }
      this.log(draft, 'warn', 'cancelled', 'Job cancelled before start.')
    })
    return true
  }

  async pause(jobId: string): Promise<boolean> {
    const running = this.running.get(jobId)
    if (!running) return false
    running.pauseRequested = true
    return true
  }

  async resume(jobId: string): Promise<boolean> {
    const job = await this.store.get(jobId)
    if (!job || job.state !== 'paused') return false
    void this.runJob(jobId)
    return true
  }

  private transition(job: JobRecord, next: JobState): void {
    assertTransition(job.state, next)
    job.state = next
  }

  private log(job: JobRecord, level: JobLogEntry['level'], stage: JobStage, message: string): void {
    if (!message.trim()) return
    job.logs.push({
      ts: nowIso(),
      level,
      stage,
      message,
    })
    if (job.logs.length > 1000) {
      job.logs = job.logs.slice(-1000)
    }
  }

  private async updateJob(
    jobId: string,
    mutator: (job: JobRecord) => void | Promise<void>,
  ): Promise<JobRecord> {
    const current = await this.store.get(jobId)
    if (!current) throw new Error(`Job ${jobId} not found`)
    await mutator(current)
    current.updatedAt = nowIso()
    await this.store.save(current)
    return current
  }

  private async setProgress(jobId: string, progress: JobProgress): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.progress = progress
    })
  }

  private async maybePause(jobId: string, stage: JobStage): Promise<boolean> {
    const running = this.running.get(jobId)
    if (!running?.pauseRequested) return false
    await this.updateJob(jobId, (job) => {
      this.transition(job, 'paused')
      job.progress = {
        stage: 'paused',
        message: `Paused at ${stage}`,
        percent: job.progress.percent,
      }
      this.log(job, 'info', 'paused', `Pause checkpoint reached at ${stage}.`)
    })
    this.running.delete(jobId)
    return true
  }

  private async runLocalPipeline(jobId: string, controller: AbortController): Promise<void> {
    const ready = await resolveFfmpegOnly()
    if (!ready.ffmpegPath) {
      const detail = ready.health[0]?.message ?? ffmpegInstallHint()
      await this.updateJob(jobId, (draft) => {
        if (draft.state !== 'failed') this.transition(draft, 'failed')
        draft.error = terminalError('binary_missing', detail)
        draft.progress = { stage: 'failed', message: 'ffmpeg missing', percent: 0 }
        this.log(draft, 'error', 'probing', detail)
      })
      return
    }

    const job = await this.store.get(jobId)
    if (!job || job.request.kind !== 'local') return
    const filePath = job.request.filePath

    try {
      await access(filePath)
      const st = await stat(filePath)
      if (!st.isFile()) throw new Error('Not a regular file.')
    } catch {
      await this.updateJob(jobId, (draft) => {
        if (draft.state !== 'failed') this.transition(draft, 'failed')
        draft.error = terminalError('path_permission', `Cannot read file: ${filePath}`)
        draft.progress = { stage: 'failed', message: 'Invalid file', percent: 0 }
      })
      return
    }

    const ffmpegPath = ready.ffmpegPath!
    const ffprobePath = ffprobePathFromFfmpeg(ffmpegPath)
    const durationSec = await getVideoDurationSec(ffprobePath, filePath)
    const baseName = path.basename(filePath)
    const slug = path.basename(filePath, path.extname(filePath))

    const preset = job.extractionPreset ?? normalizeExtractionPreset(undefined)
    const resolvedCapture = resolveLocalCaptureForJob({
      preset,
      durationSec,
      advanced: job.localAdvancedCapture,
    })

    await this.updateJob(jobId, (draft) => {
      draft.videoDurationSec = durationSec ?? undefined
      draft.videoPath = filePath
      draft.title = baseName
      draft.videoId = slug
      draft.modeUsed = 'mode_a'
      draft.localFpsIntervalSec = resolvedCapture.fpsIntervalSeconds
      draft.localCooldownSec = resolvedCapture.cooldownSeconds
      draft.localSmartChangeThreshold = resolvedCapture.changeThreshold
      draft.progress = {
        stage: 'probing',
        message: durationSec
          ? `Ready · ${formatClock(durationSec)} total`
          : 'Ready · duration unknown',
        percent: 10,
      }
    })
    this.broadcastThrottled(jobId, 0)

    if (await this.maybePause(jobId, 'probing')) return

    await this.updateJob(jobId, (draft) => {
      this.transition(draft, 'extracting')
      draft.progress = { stage: 'extracting', message: 'Extracting frames…', percent: 12 }
    })

    if (await this.maybePause(jobId, 'extracting')) return

    const refreshed = await this.store.get(jobId)
    const fpsInterval = refreshed?.localFpsIntervalSec ?? 1
    const cooldownSec = refreshed?.localCooldownSec ?? 2
    const changeThreshold = refreshed?.localSmartChangeThreshold ?? 0.15

    const rawFramesDir = this.store.getRawFramesDir(jobId)
    let lastUi = 0
    await extractFrames({
      ffmpegPath,
      videoPath: filePath,
      outDir: rawFramesDir,
      fpsIntervalSeconds: fpsInterval,
      stage: 'extracting',
      onLog: async (entry) => {
        await this.updateJob(jobId, (draft) => this.log(draft, entry.level, entry.stage, entry.message))
      },
      onProgress: (t) => {
        const now = Date.now()
        if (now - lastUi < 200) return
        lastUi = now
        const d = durationSec && durationSec > 0 ? durationSec : null
        const pct = d ? Math.round(12 + Math.min(55, (t / d) * 55)) : Math.min(65, 12 + Math.floor(t / 30))
        const msg = d
          ? `Extracting ${formatClock(t)} / ${formatClock(d)}`
          : `Extracting ${formatClock(t)}`
        void this.updateJob(jobId, (draft) => {
          draft.progress = { stage: 'extracting', message: msg, percent: pct }
        })
        this.broadcastThrottled(jobId)
      },
      signal: controller.signal,
    })

    const rawFrames = await listFrameFiles(rawFramesDir)
    if (rawFrames.length === 0) {
      throw new Error('No frames were extracted.')
    }

    await this.updateJob(jobId, (draft) => {
      this.transition(draft, 'filtering')
      draft.progress = { stage: 'filtering', message: 'Filtering frames…', percent: 72 }
    })
    if (await this.maybePause(jobId, 'filtering')) return

    const filtered = await filterFramesSmart(rawFrames, {
      changeThreshold,
      cooldownSeconds: cooldownSec,
    })
    const accepted = filtered.kept.filter((k) => k.accepted)
    const finalFramesDir = this.store.getFramesDir(jobId)
    const frames: FrameArtifact[] = []
    for (const [i, item] of accepted.entries()) {
      const name = `frame_${String(i + 1).padStart(6, '0')}.png`
      const dst = path.join(finalFramesDir, name)
      await fs.copyFile(item.file, dst)
      frames.push({
        name,
        seconds: item.seconds,
        path: dst,
        changeRatio: item.changeRatio,
        phash: item.phash,
      })
    }
    await this.updateJob(jobId, (draft) => {
      draft.frames = frames
      draft.skippedBlank = filtered.skippedBlank
      draft.skippedDuplicate = filtered.skippedDuplicate + filtered.skippedLowChange
      draft.progress = { stage: 'filtering', message: `Kept ${frames.length} frame(s)`, percent: 85 }
      this.log(
        draft,
        'info',
        'filtering',
        `Filter accepted ${frames.length} frames, skipped blank=${filtered.skippedBlank}, duplicate=${filtered.skippedDuplicate}, lowChange=${filtered.skippedLowChange}.`,
      )
    })

    await this.updateJob(jobId, (draft) => {
      this.transition(draft, 'building_pdf')
      draft.progress = { stage: 'building_pdf', message: 'Building PDF…', percent: 90 }
    })
    if (await this.maybePause(jobId, 'building_pdf')) return

    const finalJob = await this.store.get(jobId)
    if (!finalJob) return
    const pdfPath = this.store.getPdfPath(jobId)
    const label = finalJob.videoId ?? slug
    await this.buildPdf(finalJob.frames, pdfPath, label)
    await this.updateJob(jobId, (draft) => {
      this.transition(draft, 'done')
      draft.pdfPath = pdfPath
      draft.framesDir = this.store.getFramesDir(jobId)
      draft.modeUsed = 'mode_a'
      draft.progress = { stage: 'done', message: 'Complete', percent: 100 }
      this.log(draft, 'info', 'done', 'Pipeline completed successfully.')
    })
    this.localPipelineRetried.delete(jobId)
    this.broadcastThrottled(jobId, 0)
  }

  private async runJob(jobId: string): Promise<void> {
    const existing = this.running.get(jobId)
    if (existing) return
    const controller = new AbortController()
    this.running.set(jobId, { controller, pauseRequested: false })
    /** When we re-queue after a transient error, a nested `runJob` owns `running` — outer `finally` must not delete it. */
    let clearRunningInFinally = true

    try {
      const job = await this.store.get(jobId)
      if (!job) return
      if (job.state === 'paused') {
        const resumeTarget = job.progress.message.match(/Paused at ([a-z_]+)/)?.[1] as JobStage | undefined
        const next: JobState =
          resumeTarget === 'probing'
            ? 'probing'
            : resumeTarget === 'downloading'
              ? 'downloading'
              : resumeTarget === 'extracting'
                ? 'extracting'
                : resumeTarget === 'filtering'
                  ? 'filtering'
                  : 'building_pdf'
        await this.updateJob(jobId, (draft) => {
          this.transition(draft, next)
          this.log(draft, 'info', next, `Resumed from pause at ${resumeTarget ?? 'unknown stage'}.`)
        })
      } else if (job.state === 'queued') {
        await this.updateJob(jobId, (draft) => {
          this.transition(draft, 'probing')
          const msg =
            draft.request.kind === 'local'
              ? 'Preparing local file…'
              : 'Checking binaries and probing URL…'
          draft.progress = { stage: 'probing', message: msg, percent: 5 }
        })
      } else if (isTerminalState(job.state)) {
        return
      }

      const routeJob = await this.store.get(jobId)
      if (!routeJob) return
      if (routeJob.request.kind === 'local') {
        await this.runLocalPipeline(jobId, controller)
        return
      }

      const ready = await resolveRuntimeBinaries()
      if (!ready.binaries) {
        await this.updateJob(jobId, (draft) => {
          const prev = draft.state
          if (prev !== 'fallback_required') this.transition(draft, 'fallback_required')
          draft.modeUsed = 'mode_b'
          draft.fallbackRequired = true
          draft.error = terminalError(
            'binary_missing',
            ready.health.filter((h) => !h.ok).map((h) => h.message).join(' '),
          )
          draft.progress = {
            stage: 'fallback_required',
            message: 'Missing binaries. Use capture fallback mode.',
            percent: 100,
          }
          for (const item of ready.health) {
            this.log(draft, item.ok ? 'info' : 'error', 'probing', `${item.name}: ${item.message}`)
          }
        })
        return
      }

      if (await this.maybePause(jobId, 'probing')) return
      const binaries = ready.binaries

      const probingJob = await this.store.get(jobId)
      if (!probingJob || probingJob.request.kind !== 'remote') return
      const jobDir = this.store.getJobDir(jobId)
      await this.store.ensureJobDirs(jobId)
      const metadataRaw = await probeUrl({
        ytDlpPath: binaries.ytDlpPath,
        url: probingJob.request.url,
        cwd: jobDir,
        stage: 'probing',
        onLog: async (entry) => {
          await this.updateJob(jobId, (draft) => this.log(draft, entry.level, entry.stage, entry.message))
        },
        signal: controller.signal,
      })
      const meta = JSON.parse(metadataRaw) as DumpJson
      await fs.writeFile(this.store.getMetadataPath(jobId), metadataRaw, 'utf8')
      await this.updateJob(jobId, (draft) => {
        draft.videoId = meta.id
        draft.title = meta.title
        if (inferLive(meta)) {
          this.transition(draft, 'fallback_required')
          draft.modeUsed = 'mode_b'
          draft.fallbackRequired = true
          draft.error = terminalError(
            'protected_content',
            'Live or protected stream detected. Use capture fallback mode.',
          )
          draft.progress = {
            stage: 'fallback_required',
            message: 'Live/protected stream. Use capture fallback mode.',
            percent: 100,
          }
          this.log(draft, 'warn', 'probing', 'Live/protected stream detected.')
        } else {
          this.log(draft, 'info', 'probing', `Probe complete for ${meta.id ?? 'unknown video'}.`)
        }
      })

      const afterProbe = await this.store.get(jobId)
      if (!afterProbe || afterProbe.state === 'fallback_required') return
      if (afterProbe.request.kind !== 'remote') return

      await this.updateJob(jobId, (draft) => {
        this.transition(draft, 'downloading')
        draft.progress = { stage: 'downloading', message: 'Downloading video…', percent: 22 }
      })
      if (await this.maybePause(jobId, 'downloading')) return
      const outputPattern = this.store.getDownloadedVideoPattern(jobId)
      await downloadVideo({
        ytDlpPath: binaries.ytDlpPath,
        url: afterProbe.request.url,
        outputPattern,
        cwd: jobDir,
        stage: 'downloading',
        onLog: async (entry) => {
          await this.updateJob(jobId, (draft) => this.log(draft, entry.level, entry.stage, entry.message))
        },
        signal: controller.signal,
      })
      const files = await fs.readdir(jobDir)
      const videoName = files.find((f) => /^video\./.test(f) && !f.endsWith('.json'))
      if (!videoName) throw new Error('Download finished but no media file was found.')
      const videoPath = path.join(jobDir, videoName)
      await this.updateJob(jobId, (draft) => {
        draft.videoPath = videoPath
        draft.modeUsed = 'mode_a'
      })

      await this.updateJob(jobId, (draft) => {
        this.transition(draft, 'extracting')
        draft.progress = { stage: 'extracting', message: 'Extracting frame samples…', percent: 45 }
      })
      if (await this.maybePause(jobId, 'extracting')) return
      const rawFramesDir = this.store.getRawFramesDir(jobId)
      await extractFrames({
        ffmpegPath: binaries.ffmpegPath,
        videoPath,
        outDir: rawFramesDir,
        fpsIntervalSeconds: 1,
        stage: 'extracting',
        onLog: async (entry) => {
          await this.updateJob(jobId, (draft) => this.log(draft, entry.level, entry.stage, entry.message))
        },
        signal: controller.signal,
      })
      const rawFrames = await listFrameFiles(rawFramesDir)
      if (rawFrames.length === 0) {
        throw new Error('No frames were extracted. Try another video.')
      }

      await this.updateJob(jobId, (draft) => {
        this.transition(draft, 'filtering')
        draft.progress = { stage: 'filtering', message: 'Running smart frame filter…', percent: 68 }
      })
      if (await this.maybePause(jobId, 'filtering')) return
      const filtered = await filterFramesSmart(rawFrames, {
        changeThreshold: 0.15,
        cooldownSeconds: 2,
      })
      const accepted = filtered.kept.filter((k) => k.accepted)
      const finalFramesDir = this.store.getFramesDir(jobId)
      const frames: FrameArtifact[] = []
      for (const [i, item] of accepted.entries()) {
        const name = `frame_${String(i + 1).padStart(6, '0')}.png`
        const dst = path.join(finalFramesDir, name)
        await fs.copyFile(item.file, dst)
        frames.push({
          name,
          seconds: item.seconds,
          path: dst,
          changeRatio: item.changeRatio,
          phash: item.phash,
        })
      }
      await this.updateJob(jobId, (draft) => {
        draft.frames = frames
        draft.skippedBlank = filtered.skippedBlank
        draft.skippedDuplicate = filtered.skippedDuplicate + filtered.skippedLowChange
        this.log(
          draft,
          'info',
          'filtering',
          `Filter accepted ${frames.length} frames, skipped blank=${filtered.skippedBlank}, duplicate=${filtered.skippedDuplicate}, lowChange=${filtered.skippedLowChange}.`,
        )
      })

      await this.updateJob(jobId, (draft) => {
        this.transition(draft, 'building_pdf')
        draft.progress = { stage: 'building_pdf', message: 'Building backend PDF…', percent: 86 }
      })
      if (await this.maybePause(jobId, 'building_pdf')) return
      const finalJob = await this.store.get(jobId)
      if (!finalJob) return
      const pdfPath = this.store.getPdfPath(jobId)
      await this.buildPdf(finalJob.frames, pdfPath, finalJob.videoId ?? 'unknown-video')
      await this.updateJob(jobId, (draft) => {
        this.transition(draft, 'done')
        draft.pdfPath = pdfPath
        draft.framesDir = this.store.getFramesDir(jobId)
        draft.modeUsed = 'mode_a'
        draft.progress = { stage: 'done', message: 'Mode A complete', percent: 100 }
        this.log(draft, 'info', 'done', 'Pipeline completed successfully.')
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Processing failed.'
      if (msg === 'cancelled' || controller.signal.aborted) {
        await this.updateJob(jobId, (draft) => {
          if (!isTerminalState(draft.state)) this.transition(draft, 'cancelled')
          draft.error = terminalError('validation', 'Cancelled by user.')
          draft.progress = { stage: 'cancelled', message: 'Cancelled', percent: 100 }
          this.log(draft, 'warn', 'cancelled', 'Job cancelled by user request.')
        })
      } else {
        const snap = await this.store.get(jobId)
        const isLocal = snap?.request.kind === 'local'
        if (
          isLocal &&
          isTransientPipelineError(msg) &&
          !this.localPipelineRetried.has(jobId)
        ) {
          this.localPipelineRetried.add(jobId)
          await this.updateJob(jobId, (draft) => {
            draft.state = 'queued'
            draft.error = undefined
            draft.progress = {
              stage: 'queued',
              message: 'Recovering after a temporary worker issue — retrying once…',
              percent: 0,
            }
            this.log(draft, 'warn', 'queued', `Auto-retry after transient error: ${msg}`)
          })
          clearRunningInFinally = false
          this.running.delete(jobId)
          void this.runJob(jobId)
          return
        }
        const code = classifyError(msg)
        await this.updateJob(jobId, (draft) => {
          const fallback = code === 'protected_content' || code === 'binary_missing'
          if (fallback) {
            if (draft.state !== 'fallback_required') this.transition(draft, 'fallback_required')
            draft.modeUsed = 'mode_b'
            draft.fallbackRequired = true
            draft.progress = {
              stage: 'fallback_required',
              message: 'Cannot process directly. Use capture fallback mode.',
              percent: 100,
            }
          } else {
            if (draft.state !== 'failed') this.transition(draft, 'failed')
            draft.progress = { stage: 'failed', message: 'Failed', percent: 0 }
          }
          draft.error = terminalError(code, msg)
          this.log(draft, 'error', fallback ? 'fallback_required' : 'failed', msg)
        })
      }
    } finally {
      if (clearRunningInFinally) {
        this.running.delete(jobId)
      }
      await this.store.cleanupOldArtifacts(20)
    }
  }

  private async buildPdf(
    frames: FrameArtifact[],
    outPath: string,
    videoId: string,
    progressJobId?: string,
  ): Promise<void> {
    const doc = await PDFDocument.create()
    const body = await doc.embedFont(StandardFonts.Helvetica)
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    const perPage = 2
    const margin = 44
    const gap = 10
    const pages = Math.max(1, Math.ceil(frames.length / perPage))

    if (progressJobId) {
      await this.store.patchJobProgress(progressJobId, `Building PDF 0/${pages}…`, 0, nowIso())
      this.broadcastThrottled(progressJobId, 0)
    }

    for (let p = 0; p < pages; p++) {
      const page = doc.addPage()
      const { width, height } = page.getSize()
      page.drawText(`Video study — ${videoId}`, {
        x: margin,
        y: height - margin,
        size: 10,
        font: body,
        color: rgb(0.4, 0.4, 0.44),
      })
      const cellHeight = (height - margin * 2 - 28 - gap) / 2
      for (let row = 0; row < perPage; row++) {
        const idx = p * perPage + row
        const item = frames[idx]
        if (!item) continue
        const bytes = await fs.readFile(item.path)
        const image = await doc.embedPng(bytes)
        const maxW = width - margin * 2
        const maxH = cellHeight - 26
        const scale = Math.min(maxW / image.width, maxH / image.height)
        const drawW = image.width * scale
        const drawH = image.height * scale
        const top = height - margin - 18 - row * (cellHeight + gap)
        const x = margin + (maxW - drawW) / 2
        const y = top - drawH
        page.drawImage(image, { x, y, width: drawW, height: drawH })
        page.drawText(`${item.seconds.toFixed(0)}s`, {
          x: margin,
          y: y - 10,
          size: 9,
          font: bold,
          color: rgb(0.12, 0.12, 0.14),
        })
      }
      page.drawText(`${p + 1}/${pages}`, {
        x: width / 2 - 12,
        y: margin / 2,
        size: 9,
        font: body,
        color: rgb(0.45, 0.45, 0.48),
      })
      if (progressJobId) {
        const pct = Math.min(99, Math.max(1, Math.round((100 * (p + 1)) / pages)))
        await this.store.patchJobProgress(
          progressJobId,
          `Building PDF ${p + 1}/${pages}…`,
          pct,
          nowIso(),
        )
        this.broadcastThrottled(progressJobId)
      }
      await yieldEventLoop()
    }

    if (progressJobId) {
      await this.store.patchJobProgress(progressJobId, 'Saving PDF file…', 99, nowIso())
      this.broadcastThrottled(progressJobId, 0)
    }
    await yieldEventLoop()
    const bytes = await doc.save()
    await fs.writeFile(outPath, bytes)
  }
}
