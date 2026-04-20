/** MCQ / study export strategy — drives LLM routing and post-processing. */
export type McqAiMode = 'fast' | 'exam' | 'notes' | 'pyq'

/** High-level MCQ pipeline phase for UI (staged progress). */
export type McqProgressPhase =
  | 'scanning'
  | 'extracting'
  | 'detecting'
  | 'ai'
  | 'pdf'

export type McqProgressPayload = {
  jobId: string
  /** Legacy coarse stage (ocr | llm | pdf | …) — kept for compatibility. */
  stage: string
  phase: McqProgressPhase
  current: number
  total: number
  message: string
}

export type McqGenerateResult = {
  ok: boolean
  mcqPdfPath?: string
  mcqJsonPath?: string
  htmlPath?: string
  txtPath?: string
  questionCount?: number
  /** True when DeepSeek failed and a locally formatted HTML/PDF was used. */
  usedDeepSeekFallback?: boolean
  message?: string
  mcqAiMode?: McqAiMode
  deepSeekCallCount?: number
  cacheHits?: number
  skippedPolishCount?: number
  /** Exam mode: auto-generated answer key next to MCQ PDF when API succeeds. */
  answerKeyPdfPath?: string
}

export type McqQuestionsFile = {
  version: number
  framesDir?: string
  questions: Array<{
    id: string
    stem: string
    options: Record<string, string>
    sourceFrames: string[]
    confidence: number
    /** Added after optional DeepSeek topic pass. */
    topics?: string[]
  }>
}
