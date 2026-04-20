export type CaptureMode = 'mode_a' | 'mode_b'
export type ExtractionPreset = 'fast_notes' | 'mcq_hunter' | 'full_lecture' | 'exam_revision'

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
  extractionPreset?: ExtractionPreset
  advancedCapture?: {
    fpsIntervalSeconds?: number
    cooldownSeconds?: number
    changeThreshold?: number
  }
  fpsIntervalSeconds?: number
  cooldownSeconds?: number
  ocrLanguage?: string
}

export type AnalyzeResponse = {
  jobId: string
  modePlanned: CaptureMode
}

export type AnalyzeLocalResponse = {
  jobId: string
  modePlanned: CaptureMode
}

export type FrameArtifact = {
  name: string
  seconds: number
  path: string
  changeRatio: number
  phash: string
  ocrText?: string
  ocrConfidence?: number
  includeInPdf?: boolean
  dataUrl?: string
}

export type JobLogEntry = {
  ts: string
  level: 'info' | 'warn' | 'error'
  stage: JobStage
  message: string
}

export type JobProgress = {
  stage: JobStage
  message: string
  percent: number
}

export type McqProgressPhase =
  | 'scanning'
  | 'extracting'
  | 'detecting'
  | 'ai'
  | 'pdf'

export type McqProgressPayload = {
  jobId: string
  stage: string
  phase: McqProgressPhase
  current: number
  total: number
  message: string
}

export type McqAiMode = 'fast' | 'exam' | 'notes' | 'pyq'

export type McqGenerateResult = {
  ok: boolean
  mcqPdfPath?: string
  mcqJsonPath?: string
  htmlPath?: string
  txtPath?: string
  questionCount?: number
  usedDeepSeekFallback?: boolean
  message?: string
  mcqAiMode?: McqAiMode
  deepSeekCallCount?: number
  cacheHits?: number
  skippedPolishCount?: number
  answerKeyPdfPath?: string
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
  error?: {
    code: ErrorCode
    message: string
  }
  progress: JobProgress
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
  localFpsIntervalSec?: number
  localCooldownSec?: number
  extractionPreset?: ExtractionPreset
  localAdvancedCapture?: {
    fpsIntervalSeconds?: number
    cooldownSeconds?: number
    changeThreshold?: number
  }
  localSmartChangeThreshold?: number
  ocrLanguage?: string
  lastMcqCount?: number
  lastMcqAt?: string
  mcqJsonPath?: string
  mcqTxtPath?: string
  mcqPdfPath?: string
  answerKeyPdfPath?: string
  revisionSheetPath?: string
  studentStateJson?: string
}

declare global {
  interface Window {
    electronApi?: {
      analyzeJob(input: AnalyzeRequest): Promise<AnalyzeResponse>
      analyzeLocalFile(input: AnalyzeLocalRequest): Promise<AnalyzeLocalResponse>
      selectVideoFile(): Promise<{ path: string | null }>
      onJobProgress(
        callback: (payload: { jobId: string; state: JobState; progress: JobProgress }) => void,
      ): () => void
      getJobStatus(jobId: string): Promise<JobRecord | null>
      listJobs(limit?: number): Promise<JobRecord[]>
      getJobFrames(jobId: string): Promise<FrameArtifact[]>
      getFramePreview(
        jobId: string,
        frameName: string,
      ): Promise<{ dataUrl: string | null; message?: string }>
      getJobPdf(jobId: string): Promise<{ filePath: string | null }>
      openJobFolder(jobId: string): Promise<{ ok: boolean; message?: string }>
      getJobMcqArtifacts(jobId: string): Promise<{
        mcqJsonPath?: string
        mcqTxtPath?: string
        mcqPdfPath?: string
        answerKeyPdfPath?: string
        revisionSheetPath?: string
        lastMcqCount?: number
      } | null>
      getStudentState(jobId: string): Promise<string | null>
      setStudentState(jobId: string, json: string): Promise<{ ok: boolean; message?: string }>
      readMcqJson(jobId: string): Promise<{ ok: boolean; json?: string; message?: string }>
      cancelJob(jobId: string): Promise<boolean>
      pauseJob(jobId: string): Promise<boolean>
      resumeJob(jobId: string): Promise<boolean>
      removeJob(jobId: string): Promise<{ ok: boolean; message?: string }>
      updateJobTitle(jobId: string, title: string): Promise<{ ok: boolean; message?: string }>
      runFrameOcr(jobId: string): Promise<{ ok: boolean; message?: string }>
      setFrameIncludeInPdf(
        jobId: string,
        frameName: string,
        include: boolean,
      ): Promise<{ ok: boolean; message?: string }>
      rebuildPdf(jobId: string): Promise<{ ok: boolean; message?: string }>
      openPath(targetPath: string): Promise<{ ok: boolean; message?: string }>
      saveCopy(
        sourcePath: string,
        defaultName: string,
      ): Promise<{ ok: boolean; path?: string; message?: string }>
      generateMcqPdf(jobId: string, mode?: McqAiMode): Promise<McqGenerateResult>
      generateMcqPdfFromAnalyzedText(jobId: string, mode?: McqAiMode): Promise<McqGenerateResult>
      generateMcqAnswerKey(jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }>
      generateRevisionSheet(jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }>
      generateShuffledMcqPractice(jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }>
      tagMcqTopics(jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }>
      generateWeakTopicMcqPdf(
        jobId: string,
        topic: string,
      ): Promise<{ ok: boolean; filePath?: string; message?: string }>
      cancelMcqPdf(): Promise<{ ok: boolean }>
      cancelMcqSecondary(): Promise<{ ok: boolean }>
      onMcqProgress(callback: (payload: McqProgressPayload) => void): () => void
    }
  }
}
