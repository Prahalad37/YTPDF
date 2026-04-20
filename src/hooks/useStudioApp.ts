import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import type {
  ExtractionPreset,
  FrameArtifact,
  JobRecord,
  McqAiMode,
  McqProgressPayload,
} from '../types/electron-api'
import { formatTimestamp } from '../lib/formatTime'
import { analyzeQuestionPatterns, groupDuplicateFrames } from '../lib/questionPatterns'
import { estimateTimeSavedMinutes, junkRemovedPercent } from '../lib/studioMetrics'
import { defaultStudentState, parseStudentState, serializeStudentState, type StudentStateV1 } from '../lib/studentState'

function exportStamp(): string {
  const d = new Date()
  return d.toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

function stripFrameDataUrls(frames: FrameArtifact[]): FrameArtifact[] {
  return frames.map((frame) => ({ ...frame, dataUrl: undefined }))
}

export function fileLabel(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] ?? path
}

export function isActiveJobState(state: JobRecord['state']): boolean {
  return (
    state === 'queued' ||
    state === 'probing' ||
    state === 'downloading' ||
    state === 'extracting' ||
    state === 'filtering' ||
    state === 'building_pdf'
  )
}

export function useStudioApp() {
  const api = window.electronApi

  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<JobRecord | null>(null)
  const [frames, setFrames] = useState<FrameArtifact[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sampleEverySec, setSampleEverySec] = useState('1')
  const [cooldownSecStr, setCooldownSecStr] = useState('2')
  const [changeThresholdStr, setChangeThresholdStr] = useState('0.15')
  const [ocrLanguageStr, setOcrLanguageStr] = useState('eng')
  const [pdfExports, setPdfExports] = useState<JobRecord[]>([])
  const [ocrBusy, setOcrBusy] = useState(false)
  const [rebuildBusy, setRebuildBusy] = useState(false)
  const [mcqBusy, setMcqBusy] = useState(false)
  const [secondaryMcqBusy, setSecondaryMcqBusy] = useState(false)
  const [mcqProgressPayload, setMcqProgressPayload] = useState<McqProgressPayload | null>(null)
  const [mcqAiMode, setMcqAiMode] = useState<McqAiMode>('fast')
  const [extractionPreset, setExtractionPreset] = useState<ExtractionPreset>('full_lecture')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [useCustomCapture, setUseCustomCapture] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [studentState, setStudentState] = useState<StudentStateV1>(defaultStudentState())

  const refreshExports = useCallback(async () => {
    if (!api) return
    const exports = await api.listJobs(50)
    setPdfExports(exports.filter((j) => j.state === 'done'))
  }, [api])

  const refreshJob = useCallback(
    async (id: string) => {
      if (!api) return
      const status = await api.getJobStatus(id)
      setJob(status)
      if (status?.state === 'done') {
        const fromRecord =
          status.frames.length > 0 ? stripFrameDataUrls(status.frames) : await api.getJobFrames(id)
        setFrames(fromRecord)
        await refreshExports()
      } else if (status && isActiveJobState(status.state)) {
        const f = await api.getJobFrames(id)
        if (f.length > 0) setFrames(f)
      } else if (status?.state === 'paused') {
        const f = await api.getJobFrames(id)
        if (f.length > 0) setFrames(f)
      } else if (status) {
        setFrames([])
      }
    },
    [api, refreshExports],
  )

  useEffect(() => {
    if (!api || !jobId) return
    void api.getStudentState(jobId).then((raw) => setStudentState(parseStudentState(raw)))
  }, [api, jobId])

  useEffect(() => {
    if (!api) return
    const unsubMcq = api.onMcqProgress((payload: McqProgressPayload) => {
      if (payload.jobId !== jobId) return
      setMcqProgressPayload(payload)
    })
    return unsubMcq
  }, [api, jobId])

  useEffect(() => {
    if (!api) return
    const unsub = api.onJobProgress((payload) => {
      if (payload.jobId !== jobId) return
      setJob((prev) =>
        prev
          ? {
              ...prev,
              state: payload.state,
              progress: payload.progress,
            }
          : prev,
      )
      if (payload.state === 'done') {
        void refreshJob(payload.jobId)
      }
    })
    return unsub
  }, [api, jobId, refreshJob])

  useEffect(() => {
    if (!api || !jobId || !job || job.id !== jobId) return
    if (!isActiveJobState(job.state)) return
    const id = window.setInterval(() => {
      void refreshJob(jobId)
    }, 1200)
    return () => window.clearInterval(id)
  }, [api, jobId, job, refreshJob])

  /** Heal gallery if `job` from IPC includes frames but React `frames` stayed empty (e.g. race). */
  useEffect(() => {
    if (!job || job.state !== 'done' || job.frames.length === 0) return
    const snap = job
    queueMicrotask(() => {
      setFrames((prev) => {
        if (prev.length > 0) return prev
        return stripFrameDataUrls(snap.frames)
      })
    })
  }, [job])

  useEffect(() => {
    if (!api) return
    void api.listJobs(1).then((jobs) => {
      if (jobs.length === 0) return
      const latest = jobs[0]
      setJobId(latest.id)
      setJob(latest)
      if (latest.request.kind === 'local') {
        setSourcePath(latest.request.filePath)
      }
      if (latest.localFpsIntervalSec != null) {
        setSampleEverySec(String(latest.localFpsIntervalSec))
      }
      if (latest.localCooldownSec != null) {
        setCooldownSecStr(String(latest.localCooldownSec))
      }
      if (latest.localSmartChangeThreshold != null) {
        setChangeThresholdStr(String(latest.localSmartChangeThreshold))
      }
      if (latest.extractionPreset) {
        setExtractionPreset(latest.extractionPreset)
      }
      if (latest.ocrLanguage) {
        setOcrLanguageStr(latest.ocrLanguage)
      }
      setUseCustomCapture(Boolean(latest.localAdvancedCapture))
      if (latest.state === 'done') {
        if (latest.frames.length > 0) {
          setFrames(stripFrameDataUrls(latest.frames))
        } else {
          void api.getJobFrames(latest.id).then(setFrames)
        }
      }
    })
    void api.listJobs(50).then((all) => {
      setPdfExports(all.filter((j) => j.state === 'done'))
    })
  }, [api])

  const persistStudentState = useCallback(
    async (next: StudentStateV1) => {
      if (!api || !jobId) return
      setStudentState(next)
      await api.setStudentState(jobId, serializeStudentState(next))
    },
    [api, jobId],
  )

  const pickFile = useCallback(async () => {
    if (!api) return
    setError(null)
    const r = await api.selectVideoFile()
    if (r.path) setSourcePath(r.path)
  }, [api])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (!f) return
    const p = (f as File & { path?: string }).path
    if (typeof p === 'string' && p.length > 0) {
      setSourcePath(p)
      setError(null)
    } else {
      setError('Drag a file from Finder (path required).')
    }
  }, [])

  const startJob = useCallback(async () => {
    if (!api || !sourcePath) {
      setError('Choose a video file first.')
      return
    }
    setError(null)
    try {
      const req: Parameters<typeof api.analyzeLocalFile>[0] = {
        filePath: sourcePath,
        extractionPreset,
        ocrLanguage: ocrLanguageStr.trim() || 'eng',
      }
      if (useCustomCapture) {
        const fps = parseFloat(sampleEverySec)
        const cd = parseFloat(cooldownSecStr)
        const thRaw = changeThresholdStr.trim()
        const th = thRaw === '' ? undefined : parseFloat(thRaw)
        req.advancedCapture = {
          fpsIntervalSeconds: Number.isFinite(fps) ? fps : undefined,
          cooldownSeconds: Number.isFinite(cd) ? cd : undefined,
          changeThreshold: Number.isFinite(th) ? th : undefined,
        }
      }
      const res = await api.analyzeLocalFile(req)
      setJobId(res.jobId)
      setFrames([])
      setJob(null)
      await refreshJob(res.jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start job.')
    }
  }, [
    api,
    sourcePath,
    extractionPreset,
    ocrLanguageStr,
    useCustomCapture,
    sampleEverySec,
    cooldownSecStr,
    changeThresholdStr,
    refreshJob,
  ])

  const rerunSameFile = useCallback(async () => {
    if (!api || !job || job.request.kind !== 'local') return
    setSourcePath(job.request.filePath)
    setExtractionPreset(job.extractionPreset ?? 'full_lecture')
    setOcrLanguageStr(job.ocrLanguage ?? 'eng')
    setUseCustomCapture(Boolean(job.localAdvancedCapture))
    if (job.localFpsIntervalSec != null) setSampleEverySec(String(job.localFpsIntervalSec))
    if (job.localCooldownSec != null) setCooldownSecStr(String(job.localCooldownSec))
    if (job.localSmartChangeThreshold != null) {
      setChangeThresholdStr(String(job.localSmartChangeThreshold))
    }
    setError(null)
    try {
      const req: Parameters<typeof api.analyzeLocalFile>[0] = {
        filePath: job.request.filePath,
        extractionPreset: job.extractionPreset ?? 'full_lecture',
        ocrLanguage: job.ocrLanguage ?? 'eng',
      }
      if (job.localAdvancedCapture) {
        req.advancedCapture = job.localAdvancedCapture
      }
      const res = await api.analyzeLocalFile(req)
      setJobId(res.jobId)
      setFrames([])
      setJob(null)
      await refreshJob(res.jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start job.')
    }
  }, [api, job, refreshJob])

  const openJobOutputsFolder = useCallback(async () => {
    if (!api || !jobId) return
    const r = await api.openJobFolder(jobId)
    if (!r.ok) setError(r.message ?? 'Could not open folder.')
  }, [api, jobId])

  const cancelJob = useCallback(async () => {
    if (!api || !jobId) return
    await api.cancelJob(jobId)
    await refreshJob(jobId)
  }, [api, jobId, refreshJob])

  const pauseJob = useCallback(async () => {
    if (!api || !jobId) return
    await api.pauseJob(jobId)
    await refreshJob(jobId)
  }, [api, jobId, refreshJob])

  const resumeJob = useCallback(async () => {
    if (!api || !jobId) return
    await api.resumeJob(jobId)
    await refreshJob(jobId)
  }, [api, jobId, refreshJob])

  const savePdf = useCallback(async () => {
    if (!api || !jobId) return
    const pdf = await api.getJobPdf(jobId)
    if (!pdf.filePath) {
      setError('No PDF yet.')
      return
    }
    const name = job?.videoId ? `study-${job.videoId}-${exportStamp()}.pdf` : `study-${exportStamp()}.pdf`
    const saved = await api.saveCopy(pdf.filePath, name)
    if (!saved.ok) setError(saved.message ?? 'Save failed.')
  }, [api, jobId, job])

  const openPdf = useCallback(async () => {
    if (!api || !jobId) return
    const pdf = await api.getJobPdf(jobId)
    if (!pdf.filePath) {
      setError('No PDF path.')
      return
    }
    await api.openPath(pdf.filePath)
  }, [api, jobId])

  const openExportPdf = useCallback(
    async (pdfPath: string) => {
      if (!api) return
      await api.openPath(pdfPath)
    },
    [api],
  )

  const saveExportCopy = useCallback(
    async (j: JobRecord) => {
      if (!api || !j.pdfPath) return
      const name = j.videoId ? `study-${j.videoId}-${exportStamp()}.pdf` : `study-${exportStamp()}.pdf`
      const saved = await api.saveCopy(j.pdfPath, name)
      if (!saved.ok) setError(saved.message ?? 'Save failed.')
    },
    [api],
  )

  const viewExportJob = useCallback(
    async (j: JobRecord) => {
      if (!api) return
      setJobId(j.id)
      setJob(null)
      setError(null)
      if (j.request.kind === 'local') {
        setSourcePath(j.request.filePath)
      }
      if (j.extractionPreset) setExtractionPreset(j.extractionPreset)
      await refreshJob(j.id)
      const f = await api.getJobFrames(j.id)
      setFrames(f)
    },
    [api, refreshJob],
  )

  const renameExport = useCallback(
    async (j: JobRecord) => {
      if (!api) return
      setError(null)
      const current = j.title ?? j.videoId ?? j.id.slice(0, 8)
      const next = window.prompt('Export name', current)
      if (next === null) return
      const r = await api.updateJobTitle(j.id, next)
      if (!r.ok) {
        setError(r.message ?? 'Could not rename.')
        return
      }
      await refreshExports()
      if (jobId === j.id) void refreshJob(j.id)
    },
    [api, jobId, refreshExports, refreshJob],
  )

  const runOcrAnalysis = useCallback(async () => {
    if (!api || !jobId) return
    setOcrBusy(true)
    setError(null)
    try {
      const r = await api.runFrameOcr(jobId)
      if (!r.ok) setError(r.message ?? 'OCR failed.')
      await refreshJob(jobId)
    } finally {
      setOcrBusy(false)
    }
  }, [api, jobId, refreshJob])

  const toggleFrameInclude = useCallback(
    async (frameName: string, include: boolean) => {
      if (!api || !jobId) return
      setError(null)
      const r = await api.setFrameIncludeInPdf(jobId, frameName, include)
      if (!r.ok) setError(r.message ?? 'Could not update frame.')
      await refreshJob(jobId)
    },
    [api, jobId, refreshJob],
  )

  const generateMcqPdf = useCallback(async () => {
    if (!api || !jobId) return
    setError(null)
    setMcqBusy(true)
    setMcqProgressPayload({
      jobId,
      stage: 'init',
      phase: 'scanning',
      current: 0,
      total: 0,
      message: 'Preparing…',
    })
    try {
      const r = await api.generateMcqPdf(jobId, mcqAiMode)
      if (!r.ok) {
        setError(r.message ?? 'MCQ PDF failed.')
        return
      }
      if (r.mcqPdfPath) {
        await api.openPath(r.mcqPdfPath)
      }
      await refreshJob(jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MCQ PDF failed.')
    } finally {
      setMcqBusy(false)
      setMcqProgressPayload(null)
    }
  }, [api, jobId, mcqAiMode, refreshJob])

  const generateMcqPdfFromAnalyzedText = useCallback(async () => {
    if (!api || !jobId) return
    setError(null)
    setMcqBusy(true)
    setMcqProgressPayload({
      jobId,
      stage: 'init',
      phase: 'scanning',
      current: 0,
      total: 0,
      message: 'Preparing…',
    })
    try {
      const r = await api.generateMcqPdfFromAnalyzedText(jobId, mcqAiMode)
      if (!r.ok) {
        setError(r.message ?? 'MCQ PDF failed.')
        return
      }
      if (r.mcqPdfPath) {
        await api.openPath(r.mcqPdfPath)
      }
      await refreshJob(jobId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MCQ PDF failed.')
    } finally {
      setMcqBusy(false)
      setMcqProgressPayload(null)
    }
  }, [api, jobId, mcqAiMode, refreshJob])

  const cancelMcqPdf = useCallback(async () => {
    if (!api) return
    await api.cancelMcqPdf()
  }, [api])

  const generateAnswerKey = useCallback(async () => {
    if (!api || !jobId) return
    setSecondaryMcqBusy(true)
    setError(null)
    try {
      const r = await api.generateMcqAnswerKey(jobId)
      if (!r.ok) {
        setError(r.message ?? 'Answer key failed.')
        return
      }
      if (r.filePath) await api.openPath(r.filePath)
      await refreshJob(jobId)
    } finally {
      setSecondaryMcqBusy(false)
    }
  }, [api, jobId, refreshJob])

  const generateRevisionSheet = useCallback(async () => {
    if (!api || !jobId) return
    setSecondaryMcqBusy(true)
    setError(null)
    try {
      const r = await api.generateRevisionSheet(jobId)
      if (!r.ok) {
        setError(r.message ?? 'Revision sheet failed.')
        return
      }
      if (r.filePath) await api.openPath(r.filePath)
      await refreshJob(jobId)
    } finally {
      setSecondaryMcqBusy(false)
    }
  }, [api, jobId, refreshJob])

  const exportMcqTxt = useCallback(async () => {
    if (!api || !jobId) return
    setError(null)
    const art = await api.getJobMcqArtifacts(jobId)
    const p = art?.mcqTxtPath
    if (!p) {
      setError('No TXT export yet. Generate an MCQ PDF first.')
      return
    }
    await api.openPath(p)
  }, [api, jobId])

  const generateShuffledPractice = useCallback(async () => {
    if (!api || !jobId) return
    setSecondaryMcqBusy(true)
    setError(null)
    try {
      const r = await api.generateShuffledMcqPractice(jobId)
      if (!r.ok) {
        setError(r.message ?? 'Shuffle export failed.')
        return
      }
      if (r.filePath) await api.openPath(r.filePath)
    } finally {
      setSecondaryMcqBusy(false)
    }
  }, [api, jobId])

  const tagMcqTopics = useCallback(async () => {
    if (!api || !jobId) return
    setSecondaryMcqBusy(true)
    setError(null)
    try {
      const r = await api.tagMcqTopics(jobId)
      if (!r.ok) {
        setError(r.message ?? 'Topic tagging failed.')
        return
      }
      await refreshJob(jobId)
    } finally {
      setSecondaryMcqBusy(false)
    }
  }, [api, jobId, refreshJob])

  const generateWeakTopicPdf = useCallback(
    async (topic: string) => {
      if (!api || !jobId) return
      setSecondaryMcqBusy(true)
      setError(null)
      try {
        const r = await api.generateWeakTopicMcqPdf(jobId, topic)
        if (!r.ok) {
          setError(r.message ?? 'Weak-topic PDF failed.')
          return
        }
        if (r.filePath) await api.openPath(r.filePath)
      } finally {
        setSecondaryMcqBusy(false)
      }
    },
    [api, jobId],
  )

  const rebuildStudyPdf = useCallback(async () => {
    if (!api || !jobId) return
    setError(null)
    setRebuildBusy(true)
    try {
      const r = await api.rebuildPdf(jobId)
      if (!r.ok) {
        setError(r.message ?? 'PDF rebuild failed.')
        await refreshJob(jobId)
        return
      }
      const status = await api.getJobStatus(jobId)
      setJob(status)
      await refreshExports()
    } finally {
      setRebuildBusy(false)
    }
  }, [api, jobId, refreshJob, refreshExports])

  const duplicateGroupIndex = useMemo(
    () => groupDuplicateFrames(frames.map((f) => ({ name: f.name, ocrText: f.ocrText }))),
    [frames],
  )

  const duplicateGroupSizes = useMemo(() => {
    const m = new Map<number, number>()
    duplicateGroupIndex.forEach((g) => {
      m.set(g, (m.get(g) ?? 0) + 1)
    })
    return m
  }, [duplicateGroupIndex])

  const deleteExport = useCallback(
    async (j: JobRecord) => {
      if (!api) return
      setError(null)
      const label = j.title ?? j.videoId ?? j.id.slice(0, 8)
      if (
        !window.confirm(
          `Delete export “${label}”? This removes the PDF and job data from this app.`,
        )
      ) {
        return
      }
      const r = await api.removeJob(j.id)
      if (!r.ok) {
        setError(r.message ?? 'Could not delete.')
        return
      }
      if (jobId === j.id) {
        setJobId(null)
        setJob(null)
        setFrames([])
      }
      await refreshExports()
    },
    [api, jobId, refreshExports],
  )

  const active = job && isActiveJobState(job.state)
  /** True while a job occupies the pipeline (including pause); Start stays disabled until done/failed/cancelled/fallback. */
  const startLocked = Boolean(
    job &&
      !['done', 'failed', 'cancelled', 'fallback_required'].includes(job.state),
  )
  const pipelineUiBusy = startLocked
  const pdfOutputLocked = ocrBusy || rebuildBusy || mcqBusy || secondaryMcqBusy
  const canUsePdfOutput =
    job?.state === 'done' && Boolean(job.pdfPath) && !pdfOutputLocked && job.progress.percent >= 100

  const timeSavedMin = useMemo(() => estimateTimeSavedMinutes(job), [job])
  const junkPct = useMemo(() => junkRemovedPercent(job), [job])

  const hasAnalyzedOcrText = useMemo(
    () => frames.some((f) => Boolean(f.ocrText?.trim()) && f.includeInPdf !== false),
    [frames],
  )

  const generateMcqPdfAuto = useCallback(async () => {
    if (hasAnalyzedOcrText) {
      await generateMcqPdfFromAnalyzedText()
    } else {
      await generateMcqPdf()
    }
  }, [generateMcqPdf, generateMcqPdfFromAnalyzedText, hasAnalyzedOcrText])

  const toggleBookmark = useCallback(
    async (questionId: string) => {
      const set = new Set(studentState.bookmarkedQuestionIds)
      if (set.has(questionId)) set.delete(questionId)
      else set.add(questionId)
      await persistStudentState({
        ...studentState,
        bookmarkedQuestionIds: [...set],
      })
    },
    [persistStudentState, studentState],
  )

  const toggleSolved = useCallback(
    async (questionId: string) => {
      const set = new Set(studentState.solvedQuestionIds)
      if (set.has(questionId)) set.delete(questionId)
      else set.add(questionId)
      await persistStudentState({
        ...studentState,
        solvedQuestionIds: [...set],
      })
    },
    [persistStudentState, studentState],
  )

  return {
    api,
    sourcePath,
    setSourcePath,
    jobId,
    job,
    frames,
    error,
    setError,
    sampleEverySec,
    setSampleEverySec,
    cooldownSecStr,
    setCooldownSecStr,
    changeThresholdStr,
    setChangeThresholdStr,
    ocrLanguageStr,
    setOcrLanguageStr,
    pdfExports,
    ocrBusy,
    rebuildBusy,
    mcqBusy,
    secondaryMcqBusy,
    mcqProgressPayload,
    mcqAiMode,
    setMcqAiMode,
    generateMcqPdf,
    generateMcqPdfFromAnalyzedText,
    generateMcqPdfAuto,
    hasAnalyzedOcrText,
    cancelMcqPdf,
    generateAnswerKey,
    generateRevisionSheet,
    exportMcqTxt,
    generateShuffledPractice,
    tagMcqTopics,
    generateWeakTopicPdf,
    extractionPreset,
    setExtractionPreset,
    advancedOpen,
    setAdvancedOpen,
    useCustomCapture,
    setUseCustomCapture,
    logsOpen,
    setLogsOpen,
    refreshJob,
    pickFile,
    onDrop,
    startJob,
    rerunSameFile,
    openJobOutputsFolder,
    cancelJob,
    pauseJob,
    resumeJob,
    savePdf,
    openPdf,
    openExportPdf,
    saveExportCopy,
    viewExportJob,
    renameExport,
    deleteExport,
    runOcrAnalysis,
    toggleFrameInclude,
    rebuildStudyPdf,
    duplicateGroupIndex,
    duplicateGroupSizes,
    active,
    startLocked,
    pipelineUiBusy,
    pdfOutputLocked,
    canUsePdfOutput,
    timeSavedMin,
    junkPct,
    analyzeQuestionPatterns,
    formatTimestamp,
    studentState,
    toggleBookmark,
    toggleSolved,
    persistStudentState,
  }
}

export type StudioViewModel = ReturnType<typeof useStudioApp>
