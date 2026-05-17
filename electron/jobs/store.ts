import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { CaptureMode, ErrorCode, JobLogEntry, JobRecord, JobRequest } from './types.js'
import { normalizeExtractionPreset, type ExtractionPreset } from './extractionPresets.js'

type JobRow = {
  id: string
  request_url: string
  request_interval_sec: number
  request_kind?: string
  request_file_path: string | null
  created_at: string
  updated_at: string
  state: JobRecord['state']
  mode_planned: string | null
  mode_used: string | null
  fallback_required: number
  error_code: string | null
  error_message: string | null
  progress_stage: JobRecord['progress']['stage']
  progress_message: string
  progress_percent: number
  video_duration_sec?: number | null
  video_id: string | null
  title: string | null
  video_path: string | null
  pdf_path: string | null
  frames_dir: string | null
  skipped_blank: number
  skipped_duplicate: number
  local_fps_interval_sec?: number | null
  local_cooldown_sec?: number | null
  extraction_preset?: string | null
  advanced_capture_json?: string | null
  local_smart_change_threshold?: number | null
  ocr_language?: string | null
  last_mcq_count?: number | null
  last_mcq_at?: string | null
  mcq_json_path?: string | null
  mcq_txt_path?: string | null
  mcq_pdf_path?: string | null
  answer_key_pdf_path?: string | null
  revision_sheet_path?: string | null
  student_state_json?: string | null
}

type FrameRow = {
  name: string
  seconds: number
  path: string
  change_ratio: number
  phash: string
  ocr_text: string | null
  ocr_confidence: number | null
  include_in_pdf: number
}

type LogRow = {
  ts: string
  level: JobLogEntry['level']
  stage: JobLogEntry['stage']
  message: string
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asCaptureMode(value: string | null): CaptureMode | undefined {
  if (value === 'mode_a' || value === 'mode_b') return value
  return undefined
}

function requestToRowParts(
  r: JobRequest,
): {
  request_url: string
  request_interval_sec: number
  request_kind: string
  request_file_path: string | null
} {
  if (r.kind === 'local') {
    return {
      request_url: path.basename(r.filePath),
      request_interval_sec: 0,
      request_kind: 'local',
      request_file_path: r.filePath,
    }
  }
  return {
    request_url: r.url,
    request_interval_sec: r.intervalSec,
    request_kind: 'remote',
    request_file_path: null,
  }
}

function rowToRequest(row: JobRow): JobRequest {
  const kind = row.request_kind ?? (row.request_file_path ? 'local' : 'remote')
  if (kind === 'local' && row.request_file_path) {
    return { kind: 'local', filePath: row.request_file_path }
  }
  return {
    kind: 'remote',
    url: row.request_url,
    intervalSec: asNumber(row.request_interval_sec, 5),
  }
}

export class JobStore {
  private readonly baseDir: string
  private readonly jobsDir: string
  private readonly dbPath: string
  private db: DatabaseSync | null = null

  private upsertJobStmt: StatementSync | null = null
  private replaceFramesDeleteStmt: StatementSync | null = null
  private insertFrameStmt: StatementSync | null = null
  private replaceLogsDeleteStmt: StatementSync | null = null
  private insertLogStmt: StatementSync | null = null
  private getJobStmt: StatementSync | null = null
  private listJobsStmt: StatementSync | null = null
  private listFramesStmt: StatementSync | null = null
  private listLogsStmt: StatementSync | null = null
  private deleteJobStmt: StatementSync | null = null
  private deleteJobFramesStmt: StatementSync | null = null
  private deleteJobArtifactsStmt: StatementSync | null = null
  private deleteJobLogsStmt: StatementSync | null = null
  private upsertArtifactStmt: StatementSync | null = null
  private updateFrameOcrStmt: StatementSync | null = null
  private setFrameIncludeInPdfStmt: StatementSync | null = null
  private patchJobProgressStmt: StatementSync | null = null

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.jobsDir = path.join(baseDir, 'jobs')
    this.dbPath = path.join(baseDir, 'jobs.db')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true })
    await fs.mkdir(this.jobsDir, { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        request_url TEXT NOT NULL,
        request_interval_sec INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        mode_planned TEXT,
        mode_used TEXT,
        fallback_required INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        progress_stage TEXT NOT NULL,
        progress_message TEXT NOT NULL,
        progress_percent INTEGER NOT NULL,
        video_id TEXT,
        title TEXT,
        video_path TEXT,
        pdf_path TEXT,
        frames_dir TEXT,
        skipped_blank INTEGER NOT NULL DEFAULT 0,
        skipped_duplicate INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS job_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        name TEXT NOT NULL,
        seconds REAL NOT NULL,
        path TEXT NOT NULL,
        change_ratio REAL NOT NULL DEFAULT 0,
        phash TEXT NOT NULL DEFAULT '',
        ocr_text TEXT,
        ocr_confidence REAL,
        include_in_pdf INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS job_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        meta_json TEXT,
        UNIQUE(job_id, kind, path),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_frames_job_id ON job_frames(job_id);
      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);
    `)
    this.migrateJobsTable()
    this.migrateJobFramesTable()
    this.prepareStatements()
  }

  private migrateJobFramesTable(): void {
    const db = this.requireDb()
    const rows = db.prepare('PRAGMA table_info(job_frames)').all() as Array<{ name: string }>
    const names = new Set(rows.map((r) => r.name))
    if (!names.has('ocr_text')) {
      db.exec(`ALTER TABLE job_frames ADD COLUMN ocr_text TEXT`)
    }
    if (!names.has('include_in_pdf')) {
      db.exec(`ALTER TABLE job_frames ADD COLUMN include_in_pdf INTEGER NOT NULL DEFAULT 1`)
    }
  }

  private migrateJobsTable(): void {
    const db = this.requireDb()
    const rows = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>
    const names = new Set(rows.map((r) => r.name))
    if (!names.has('request_kind')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN request_kind TEXT NOT NULL DEFAULT 'remote'`)
    }
    if (!names.has('request_file_path')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN request_file_path TEXT`)
    }
    if (!names.has('video_duration_sec')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN video_duration_sec REAL`)
    }
    if (!names.has('local_fps_interval_sec')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN local_fps_interval_sec REAL`)
    }
    if (!names.has('local_cooldown_sec')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN local_cooldown_sec REAL`)
    }
    if (!names.has('extraction_preset')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN extraction_preset TEXT`)
    }
    if (!names.has('advanced_capture_json')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN advanced_capture_json TEXT`)
    }
    if (!names.has('local_smart_change_threshold')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN local_smart_change_threshold REAL`)
    }
    if (!names.has('ocr_language')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ocr_language TEXT`)
    }
    if (!names.has('last_mcq_count')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN last_mcq_count INTEGER`)
    }
    if (!names.has('last_mcq_at')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN last_mcq_at TEXT`)
    }
    if (!names.has('mcq_json_path')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN mcq_json_path TEXT`)
    }
    if (!names.has('mcq_txt_path')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN mcq_txt_path TEXT`)
    }
    if (!names.has('mcq_pdf_path')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN mcq_pdf_path TEXT`)
    }
    if (!names.has('answer_key_pdf_path')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN answer_key_pdf_path TEXT`)
    }
    if (!names.has('revision_sheet_path')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN revision_sheet_path TEXT`)
    }
    if (!names.has('student_state_json')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN student_state_json TEXT`)
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('JobStore not initialized.')
    return this.db
  }

  private prepareStatements(): void {
    const db = this.requireDb()
    this.upsertJobStmt = db.prepare(`
      INSERT INTO jobs (
        id, request_url, request_interval_sec, request_kind, request_file_path, created_at, updated_at, state, mode_planned, mode_used,
        fallback_required, error_code, error_message, progress_stage, progress_message, progress_percent,
        video_duration_sec, video_id, title, video_path, pdf_path, frames_dir, skipped_blank, skipped_duplicate,
        local_fps_interval_sec, local_cooldown_sec,
        extraction_preset, advanced_capture_json, local_smart_change_threshold, ocr_language,
        last_mcq_count, last_mcq_at, mcq_json_path, mcq_txt_path, mcq_pdf_path, answer_key_pdf_path, revision_sheet_path, student_state_json
      ) VALUES (
        @id, @request_url, @request_interval_sec, @request_kind, @request_file_path, @created_at, @updated_at, @state, @mode_planned, @mode_used,
        @fallback_required, @error_code, @error_message, @progress_stage, @progress_message, @progress_percent,
        @video_duration_sec, @video_id, @title, @video_path, @pdf_path, @frames_dir, @skipped_blank, @skipped_duplicate,
        @local_fps_interval_sec, @local_cooldown_sec,
        @extraction_preset, @advanced_capture_json, @local_smart_change_threshold, @ocr_language,
        @last_mcq_count, @last_mcq_at, @mcq_json_path, @mcq_txt_path, @mcq_pdf_path, @answer_key_pdf_path, @revision_sheet_path, @student_state_json
      )
      ON CONFLICT(id) DO UPDATE SET
        request_url=excluded.request_url,
        request_interval_sec=excluded.request_interval_sec,
        request_kind=excluded.request_kind,
        request_file_path=excluded.request_file_path,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at,
        state=excluded.state,
        mode_planned=excluded.mode_planned,
        mode_used=excluded.mode_used,
        fallback_required=excluded.fallback_required,
        error_code=excluded.error_code,
        error_message=excluded.error_message,
        progress_stage=excluded.progress_stage,
        progress_message=excluded.progress_message,
        progress_percent=excluded.progress_percent,
        video_duration_sec=excluded.video_duration_sec,
        video_id=excluded.video_id,
        title=excluded.title,
        video_path=excluded.video_path,
        pdf_path=excluded.pdf_path,
        frames_dir=excluded.frames_dir,
        skipped_blank=excluded.skipped_blank,
        skipped_duplicate=excluded.skipped_duplicate,
        local_fps_interval_sec=excluded.local_fps_interval_sec,
        local_cooldown_sec=excluded.local_cooldown_sec,
        extraction_preset=excluded.extraction_preset,
        advanced_capture_json=excluded.advanced_capture_json,
        local_smart_change_threshold=excluded.local_smart_change_threshold,
        ocr_language=excluded.ocr_language,
        last_mcq_count=excluded.last_mcq_count,
        last_mcq_at=excluded.last_mcq_at,
        mcq_json_path=excluded.mcq_json_path,
        mcq_txt_path=excluded.mcq_txt_path,
        mcq_pdf_path=excluded.mcq_pdf_path,
        answer_key_pdf_path=excluded.answer_key_pdf_path,
        revision_sheet_path=excluded.revision_sheet_path,
        student_state_json=excluded.student_state_json
    `)
    this.replaceFramesDeleteStmt = db.prepare('DELETE FROM job_frames WHERE job_id = ?')
    this.insertFrameStmt = db.prepare(`
      INSERT INTO job_frames(job_id, name, seconds, path, change_ratio, phash, ocr_text, ocr_confidence, include_in_pdf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.replaceLogsDeleteStmt = db.prepare('DELETE FROM job_logs WHERE job_id = ?')
    this.insertLogStmt = db.prepare(`
      INSERT INTO job_logs(job_id, ts, level, stage, message)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.getJobStmt = db.prepare('SELECT * FROM jobs WHERE id = ?')
    this.listJobsStmt = db.prepare('SELECT * FROM jobs ORDER BY datetime(updated_at) DESC LIMIT ?')
    this.listFramesStmt = db.prepare(`
      SELECT name, seconds, path, change_ratio, phash, ocr_text, ocr_confidence, include_in_pdf
      FROM job_frames
      WHERE job_id = ?
      ORDER BY seconds ASC, id ASC
    `)
    this.listLogsStmt = db.prepare(`
      SELECT ts, level, stage, message
      FROM job_logs
      WHERE job_id = ?
      ORDER BY id ASC
    `)
    this.deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?')
    this.deleteJobFramesStmt = db.prepare('DELETE FROM job_frames WHERE job_id = ?')
    this.deleteJobArtifactsStmt = db.prepare('DELETE FROM job_artifacts WHERE job_id = ?')
    this.deleteJobLogsStmt = db.prepare('DELETE FROM job_logs WHERE job_id = ?')
    this.upsertArtifactStmt = db.prepare(`
      INSERT INTO job_artifacts(job_id, kind, path, meta_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id, kind, path) DO UPDATE SET
        meta_json = excluded.meta_json
    `)
    this.updateFrameOcrStmt = db.prepare(`
      UPDATE job_frames SET ocr_text = ?, ocr_confidence = ? WHERE job_id = ? AND name = ?
    `)
    this.setFrameIncludeInPdfStmt = db.prepare(`
      UPDATE job_frames SET include_in_pdf = ? WHERE job_id = ? AND name = ?
    `)
    this.patchJobProgressStmt = db.prepare(`
      UPDATE jobs SET progress_message = ?, progress_percent = ?, updated_at = ? WHERE id = ?
    `)
  }

  async updateFrameOcr(
    jobId: string,
    frameName: string,
    ocrText: string,
    ocrConfidence: number | null,
  ): Promise<void> {
    this.updateFrameOcrStmt?.run(ocrText, ocrConfidence, jobId, frameName)
  }

  async setFrameIncludeInPdf(jobId: string, frameName: string, include: boolean): Promise<void> {
    this.setFrameIncludeInPdfStmt?.run(include ? 1 : 0, jobId, frameName)
  }

  /** Updates only `jobs` progress columns — avoids rewriting all `job_frames` (used during OCR). */
  async patchJobProgress(jobId: string, message: string, percent: number, updatedAt: string): Promise<void> {
    this.patchJobProgressStmt?.run(message, percent, updatedAt, jobId)
  }

  getJobDir(jobId: string): string {
    return path.join(this.jobsDir, jobId)
  }

  getFramesDir(jobId: string): string {
    return path.join(this.getJobDir(jobId), 'frames')
  }

  getRawFramesDir(jobId: string): string {
    return path.join(this.getJobDir(jobId), 'frames-raw')
  }

  getMetadataPath(jobId: string): string {
    return path.join(this.getJobDir(jobId), 'metadata.json')
  }

  getPdfPath(jobId: string): string {
    return path.join(this.getJobDir(jobId), 'study.pdf')
  }

  getDownloadedVideoPattern(jobId: string): string {
    return path.join(this.getJobDir(jobId), 'video.%(ext)s')
  }

  async ensureJobDirs(jobId: string): Promise<void> {
    await fs.mkdir(this.getJobDir(jobId), { recursive: true })
    await fs.mkdir(this.getFramesDir(jobId), { recursive: true })
    await fs.mkdir(this.getRawFramesDir(jobId), { recursive: true })
  }

  private jobToRow(record: JobRecord): JobRow {
    const req = requestToRowParts(record.request)
    const adv = record.localAdvancedCapture
    return {
      id: record.id,
      ...req,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      state: record.state,
      mode_planned: record.modePlanned ?? null,
      mode_used: record.modeUsed ?? null,
      fallback_required: record.fallbackRequired ? 1 : 0,
      error_code: record.error?.code ?? null,
      error_message: record.error?.message ?? null,
      progress_stage: record.progress.stage,
      progress_message: record.progress.message,
      progress_percent: record.progress.percent,
      video_duration_sec: record.videoDurationSec ?? null,
      video_id: record.videoId ?? null,
      title: record.title ?? null,
      video_path: record.videoPath ?? null,
      pdf_path: record.pdfPath ?? null,
      frames_dir: record.framesDir ?? null,
      skipped_blank: record.skippedBlank,
      skipped_duplicate: record.skippedDuplicate,
      local_fps_interval_sec: record.localFpsIntervalSec ?? null,
      local_cooldown_sec: record.localCooldownSec ?? null,
      extraction_preset: record.extractionPreset ?? null,
      advanced_capture_json: adv ? JSON.stringify(adv) : null,
      local_smart_change_threshold: record.localSmartChangeThreshold ?? null,
      ocr_language: record.ocrLanguage ?? null,
      last_mcq_count: record.lastMcqCount ?? null,
      last_mcq_at: record.lastMcqAt ?? null,
      mcq_json_path: record.mcqJsonPath ?? null,
      mcq_txt_path: record.mcqTxtPath ?? null,
      mcq_pdf_path: record.mcqPdfPath ?? null,
      answer_key_pdf_path: record.answerKeyPdfPath ?? null,
      revision_sheet_path: record.revisionSheetPath ?? null,
      student_state_json: record.studentStateJson ?? null,
    }
  }

  private rowToJob(row: JobRow, frames: FrameRow[], logs: LogRow[]): JobRecord {
    let localAdvanced: JobRecord['localAdvancedCapture'] = undefined
    if (row.advanced_capture_json) {
      try {
        localAdvanced = JSON.parse(row.advanced_capture_json) as JobRecord['localAdvancedCapture']
      } catch {
        localAdvanced = undefined
      }
    }
    const presetRaw = row.extraction_preset
    const extractionPreset: ExtractionPreset | undefined =
      typeof presetRaw === 'string' && presetRaw.length > 0
        ? normalizeExtractionPreset(presetRaw)
        : undefined
    return {
      id: row.id,
      request: rowToRequest(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: row.state,
      modePlanned: asCaptureMode(row.mode_planned),
      modeUsed: asCaptureMode(row.mode_used),
      fallbackRequired: row.fallback_required === 1,
      error:
        row.error_code && row.error_message
          ? {
              code: row.error_code as ErrorCode,
              message: row.error_message,
            }
          : undefined,
      progress: {
        stage: row.progress_stage,
        message: row.progress_message,
        percent: asNumber(row.progress_percent, 0),
      },
      videoDurationSec: row.video_duration_sec != null ? asNumber(row.video_duration_sec) : undefined,
      videoId: row.video_id ?? undefined,
      title: row.title ?? undefined,
      videoPath: row.video_path ?? undefined,
      pdfPath: row.pdf_path ?? undefined,
      framesDir: row.frames_dir ?? undefined,
      frames: frames.map((f) => ({
        name: f.name,
        seconds: f.seconds,
        path: f.path,
        changeRatio: f.change_ratio,
        phash: f.phash,
        ocrText: f.ocr_text ?? undefined,
        ocrConfidence: f.ocr_confidence ?? undefined,
        includeInPdf: f.include_in_pdf === 0 ? false : true,
      })),
      skippedBlank: asNumber(row.skipped_blank, 0),
      skippedDuplicate: asNumber(row.skipped_duplicate, 0),
      localFpsIntervalSec:
        row.local_fps_interval_sec != null ? asNumber(row.local_fps_interval_sec) : undefined,
      localCooldownSec: row.local_cooldown_sec != null ? asNumber(row.local_cooldown_sec) : undefined,
      extractionPreset,
      localAdvancedCapture: localAdvanced,
      localSmartChangeThreshold:
        row.local_smart_change_threshold != null
          ? asNumber(row.local_smart_change_threshold)
          : undefined,
      ocrLanguage: row.ocr_language ?? undefined,
      lastMcqCount: row.last_mcq_count != null ? asNumber(row.last_mcq_count, 0) : undefined,
      lastMcqAt: row.last_mcq_at ?? undefined,
      mcqJsonPath: row.mcq_json_path ?? undefined,
      mcqTxtPath: row.mcq_txt_path ?? undefined,
      mcqPdfPath: row.mcq_pdf_path ?? undefined,
      answerKeyPdfPath: row.answer_key_pdf_path ?? undefined,
      revisionSheetPath: row.revision_sheet_path ?? undefined,
      studentStateJson: row.student_state_json ?? undefined,
      logs: logs.map((l) => ({
        ts: l.ts,
        level: l.level,
        stage: l.stage,
        message: l.message,
      })),
    }
  }

  async save(record: JobRecord): Promise<void> {
    await this.ensureJobDirs(record.id)
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.jobToRow(record)
      this.upsertJobStmt?.run({
        ...row,
        mode_planned: row.mode_planned,
        mode_used: row.mode_used,
      })
      this.replaceFramesDeleteStmt?.run(record.id)
      for (const frame of record.frames) {
        this.insertFrameStmt?.run(
          record.id,
          frame.name,
          frame.seconds,
          frame.path,
          frame.changeRatio,
          frame.phash,
          frame.ocrText ?? null,
          frame.ocrConfidence ?? null,
          frame.includeInPdf === false ? 0 : 1,
        )
      }
      this.replaceLogsDeleteStmt?.run(record.id)
      for (const log of record.logs.slice(-1000)) {
        this.insertLogStmt?.run(record.id, log.ts, log.level, log.stage, log.message)
      }
      if (record.videoPath) {
        this.upsertArtifactStmt?.run(record.id, 'video', record.videoPath, null)
      }
      if (record.pdfPath) {
        this.upsertArtifactStmt?.run(record.id, 'pdf', record.pdfPath, null)
      }
      for (const frame of record.frames) {
        this.upsertArtifactStmt?.run(
          record.id,
          'frame',
          frame.path,
          JSON.stringify({ seconds: frame.seconds, changeRatio: frame.changeRatio, phash: frame.phash }),
        )
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const row = this.getJobStmt?.get(jobId) as JobRow | undefined
    if (!row) return null
    const frames = (this.listFramesStmt?.all(jobId) as FrameRow[] | undefined) ?? []
    const logs = (this.listLogsStmt?.all(jobId) as LogRow[] | undefined) ?? []
    return this.rowToJob(row, frames, logs)
  }

  async list(limit = 10): Promise<JobRecord[]> {
    const rows = (this.listJobsStmt?.all(limit) as JobRow[] | undefined) ?? []
    const out: JobRecord[] = []
    for (const row of rows) {
      const frames = (this.listFramesStmt?.all(row.id) as FrameRow[] | undefined) ?? []
      const logs = (this.listLogsStmt?.all(row.id) as LogRow[] | undefined) ?? []
      out.push(this.rowToJob(row, frames, logs))
    }
    return out
  }

  /** Partial update for export paths without rewriting frames. */
  async patchJobExportMeta(
    jobId: string,
    patch: {
      lastMcqCount?: number
      lastMcqAt?: string
      mcqJsonPath?: string | null
      mcqTxtPath?: string | null
      mcqPdfPath?: string | null
      answerKeyPdfPath?: string | null
      revisionSheetPath?: string | null
    },
  ): Promise<void> {
    const row = this.getJobStmt?.get(jobId) as JobRow | undefined
    if (!row) return
    const db = this.requireDb()
    const updatedAt = new Date().toISOString()
    db.prepare(`
      UPDATE jobs SET
        last_mcq_count = ?,
        last_mcq_at = ?,
        mcq_json_path = ?,
        mcq_txt_path = ?,
        mcq_pdf_path = ?,
        answer_key_pdf_path = ?,
        revision_sheet_path = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.lastMcqCount !== undefined ? patch.lastMcqCount : row.last_mcq_count ?? null,
      patch.lastMcqAt !== undefined ? patch.lastMcqAt : row.last_mcq_at ?? null,
      patch.mcqJsonPath !== undefined ? patch.mcqJsonPath : row.mcq_json_path ?? null,
      patch.mcqTxtPath !== undefined ? patch.mcqTxtPath : row.mcq_txt_path ?? null,
      patch.mcqPdfPath !== undefined ? patch.mcqPdfPath : row.mcq_pdf_path ?? null,
      patch.answerKeyPdfPath !== undefined ? patch.answerKeyPdfPath : row.answer_key_pdf_path ?? null,
      patch.revisionSheetPath !== undefined ? patch.revisionSheetPath : row.revision_sheet_path ?? null,
      updatedAt,
      jobId,
    )
  }

  async patchStudentState(jobId: string, studentStateJson: string | null): Promise<void> {
    const db = this.requireDb()
    db.prepare(`UPDATE jobs SET student_state_json = ?, updated_at = ? WHERE id = ?`).run(
      studentStateJson,
      new Date().toISOString(),
      jobId,
    )
  }

  async removeJobDir(jobId: string): Promise<void> {
    await fs.rm(this.getJobDir(jobId), { recursive: true, force: true })
  }

  /** Deletes one job’s DB rows (frames, artifacts, logs, job) then removes its on-disk folder. */
  async deleteJobCascade(jobId: string): Promise<void> {
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteJobFramesStmt?.run(jobId)
      this.deleteJobArtifactsStmt?.run(jobId)
      this.deleteJobLogsStmt?.run(jobId)
      this.deleteJobStmt?.run(jobId)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    await this.removeJobDir(jobId)
  }

  async cleanupOldArtifacts(_maxJobs = 20): Promise<void> {
    // Historical jobs are user-created outputs; only explicit deletion should remove them.
  }
}

