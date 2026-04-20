import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FrameArtifact, JobRecord, McqAiMode } from '../../types/electron-api'
import type { QuestionPatternFlags } from '../../lib/questionPatterns'
import type { StudioViewModel } from '../../hooks/useStudioApp'
import { McqProgressPanel } from './McqProgressPanel'
import { useAnimatedNumber } from '../../hooks/useAnimatedNumber'
import { formatJobError } from '../../lib/formatJobError'
import { pipelineStageIndex, pipelineStageLine } from '../../lib/pipelineProgressPresentation'
import { topQuestionStems } from '../../lib/questionFrequency'
import { formatSavedDurationShort } from '../../lib/studioMetrics'
import { countTaggedTopics, estimateKeyTopics } from '../../lib/studioResultMetrics'
import type { McqQuestionsFile } from '../../types/mcq'

type GalleryFilter =
  | 'all'
  | 'questions'
  | 'slides'
  | 'textHeavy'
  | 'best'
  | 'duplicatesRemoved'

type Props = Pick<
  StudioViewModel,
  | 'job'
  | 'frames'
  | 'pipelineUiBusy'
  | 'ocrBusy'
  | 'rebuildBusy'
  | 'mcqBusy'
  | 'mcqProgressPayload'
  | 'mcqAiMode'
  | 'setMcqAiMode'
  | 'generateMcqPdfAuto'
  | 'cancelMcqPdf'
  | 'toggleFrameInclude'
  | 'duplicateGroupIndex'
  | 'duplicateGroupSizes'
  | 'analyzeQuestionPatterns'
  | 'formatTimestamp'
  | 'timeSavedMin'
  | 'junkPct'
  | 'studentState'
  | 'toggleBookmark'
  | 'toggleSolved'
  | 'generateWeakTopicPdf'
  | 'secondaryMcqBusy'
  | 'openPdf'
  | 'canUsePdfOutput'
  | 'savePdf'
  | 'exportMcqTxt'
  | 'generateShuffledPractice'
>

function framesEmptyCopy(
  job: JobRecord | null,
  runningPipeline: boolean,
  filterNote?: string,
): string {
  if (filterNote) return filterNote
  if (job?.state === 'failed' || job?.state === 'cancelled') {
    const friendly = formatJobError(job)
    return friendly?.detail ?? job.error?.message ?? 'Job did not complete.'
  }
  if (runningPipeline) {
    return "We're scanning your video — frames will appear as they're found."
  }
  if (job?.state === 'done') {
    return 'No frames matched this filter.'
  }
  return 'Drop a video and start extraction to preview frames.'
}

const FILTER_CHIPS: { id: GalleryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'questions', label: 'Questions' },
  { id: 'slides', label: 'Slides' },
  { id: 'best', label: 'Best frames' },
  { id: 'textHeavy', label: 'Text-heavy' },
  { id: 'duplicatesRemoved', label: 'Duplicates removed' },
]

function filterFrames(
  frames: FrameArtifact[],
  filter: GalleryFilter,
  duplicateGroupIndex: Map<string, number>,
  analyzeQuestionPatterns: (t: string) => QuestionPatternFlags,
): { out: FrameArtifact[]; note?: string } {
  if (filter === 'all') {
    return { out: frames }
  }
  if (filter === 'duplicatesRemoved') {
    const firstNameByGroup = new Map<number, string>()
    for (const f of frames) {
      const g = duplicateGroupIndex.get(f.name)
      if (g === undefined) continue
      if (!firstNameByGroup.has(g)) firstNameByGroup.set(g, f.name)
    }
    const out = frames.filter((f) => {
      const g = duplicateGroupIndex.get(f.name)
      if (g === undefined) return true
      return firstNameByGroup.get(g) === f.name
    })
    return { out }
  }
  if (filter === 'questions') {
    const out = frames.filter((f) => {
      const t = f.ocrText?.trim()
      if (!t) return false
      const fl = analyzeQuestionPatterns(t)
      return fl.hasQuestionMark || fl.mcqStyle
    })
    return { out }
  }
  if (filter === 'slides') {
    return { out: frames.filter((f) => f.changeRatio >= 0.2) }
  }
  if (filter === 'textHeavy') {
    const anyOcr = frames.some((f) => (f.ocrText?.length ?? 0) > 0)
    if (!anyOcr) {
      return { out: [], note: 'Run “Analyze text” to enable Text heavy filter.' }
    }
    return { out: frames.filter((f) => (f.ocrText?.length ?? 0) > 120) }
  }
  if (filter === 'best') {
    const scored = frames.map((f) => {
      const t = f.ocrText ?? ''
      const fl = t ? analyzeQuestionPatterns(t) : null
      const q = fl?.hasQuestionMark || fl?.mcqStyle ? 2 : 0
      const inc = f.includeInPdf !== false ? 1.5 : 0
      const txt = Math.min(1.2, t.length / 400)
      const motion = f.changeRatio
      const score = q + inc + txt + motion
      return { f, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const cut = Math.max(1, Math.ceil(scored.length * 0.55))
    return { out: scored.slice(0, cut).map((s) => s.f) }
  }
  return { out: frames }
}

function useDiscoveryLine(
  active: boolean,
  job: JobRecord | null,
  showGallery: boolean,
): { line: string; sub?: string } {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    if (!active || showGallery) return
    const id = window.setInterval(() => setPhase((p) => (p + 1) % 4), 2800)
    return () => clearInterval(id)
  }, [active, showGallery])

  if (!active) return { line: '' }
  const dur = job?.videoDurationSec
  const kept = job?.frames.length ?? 0
  const generic = [
    'Scanning video structure…',
    'Finding text-heavy frames…',
    'Spotting question layouts…',
    'Tuning motion detection…',
  ][phase]!

  if (dur != null && dur > 0) {
    const sub = kept > 0 ? `${kept} useful frames so far` : `${Math.round(dur)}s source · sampling`
    return { line: generic, sub }
  }
  return { line: generic, sub: 'Working locally on your file' }
}

function useEtaLine(active: boolean, job: JobRecord | null): string | null {
  const [startMs, setStartMs] = useState<number | null>(null)
  const [line, setLine] = useState<string | null>(null)

  useEffect(() => {
    queueMicrotask(() => {
      if (active) {
        setStartMs((prev) => prev ?? Date.now())
      } else {
        setStartMs(null)
        setLine(null)
      }
    })
  }, [active])

  useEffect(() => {
    if (!active || !job) {
      queueMicrotask(() => setLine(null))
      return
    }
    const p = job.progress.percent
    if (p < 4 || startMs == null) {
      queueMicrotask(() => setLine('ETA: estimating…'))
      return
    }
    const update = () => {
      const elapsedSec = (Date.now() - startMs) / 1000
      const remaining = (elapsedSec / p) * (100 - p)
      if (!Number.isFinite(remaining) || remaining < 0) {
        setLine(null)
        return
      }
      const totalSec = Math.round(remaining)
      const m = Math.floor(totalSec / 60)
      const s = totalSec % 60
      setLine(m > 0 ? `About ${m}m ${s}s left` : `About ${s}s left`)
    }
    update()
    const id = window.setInterval(update, 1000)
    return () => window.clearInterval(id)
  }, [active, job, startMs])

  if (!active || !job) return null
  return line
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04 },
  },
}

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
}

export function StudioMainStage(p: Props) {
  const running = p.pipelineUiBusy
  const done = p.job?.state === 'done'
  const [galleryFilter, setGalleryFilter] = useState<GalleryFilter>('all')
  const { out: filteredFrames, note: filterNote } = useMemo(
    () =>
      filterFrames(
        p.frames,
        galleryFilter,
        p.duplicateGroupIndex,
        p.analyzeQuestionPatterns,
      ),
    [p.frames, galleryFilter, p.duplicateGroupIndex, p.analyzeQuestionPatterns],
  )
  const showGallery = filteredFrames.length > 0
  const showSuccessCard = done && p.frames.length > 0
  const failed = p.job?.state === 'failed' || p.job?.state === 'cancelled'
  const showHero = !showGallery && !running && !failed && p.frames.length === 0

  const discovery = useDiscoveryLine(running, p.job, p.frames.length > 0)
  const eta = useEtaLine(running, p.job)
  const stageIdx = pipelineStageIndex(p.job)
  const stageLine = pipelineStageLine(p.job, stageIdx)

  const wow = useMemo(() => topQuestionStems(p.frames.map((f) => ({ ocrText: f.ocrText, name: f.name })), 8), [p.frames])

  const api = window.electronApi
  const mcqStackRef = useRef<HTMLDivElement>(null)
  const [mcqMetrics, setMcqMetrics] = useState<McqQuestionsFile | null>(null)

  useEffect(() => {
    if (!done || !p.job?.id || !api) {
      queueMicrotask(() => setMcqMetrics(null))
      return
    }
    void api.readMcqJson(p.job.id).then((r) => {
      if (!r.ok || !r.json) {
        setMcqMetrics(null)
        return
      }
      try {
        setMcqMetrics(JSON.parse(r.json) as McqQuestionsFile)
      } catch {
        setMcqMetrics(null)
      }
    })
  }, [done, p.job?.id, api])

  const topicCount = useMemo(() => {
    const tagged = countTaggedTopics(mcqMetrics)
    if (tagged != null) return tagged
    return estimateKeyTopics(p.frames, wow)
  }, [mcqMetrics, p.frames, wow])

  const toolsLocked = p.mcqBusy || p.ocrBusy || p.rebuildBusy || p.secondaryMcqBusy

  const animFrames = useAnimatedNumber(p.frames.length, 700)
  const animMcq = useAnimatedNumber(p.job?.lastMcqCount ?? 0, 900)
  const animSaved = useAnimatedNumber(p.timeSavedMin, 800)
  const animDup = useAnimatedNumber(p.job?.skippedDuplicate ?? 0, 750)
  const animTopics = useAnimatedNumber(topicCount, 820)

  const scrollToMcqControls = () => {
    mcqStackRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-950/30">
      <div className="border-b border-white/[0.06] px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Framebase AI</h1>
        <p className="text-sm text-zinc-500">AI study extractor · local-first · exam-ready outputs</p>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 pb-4 [-webkit-overflow-scrolling:touch]"
        style={{ overscrollBehavior: 'contain' }}
      >
        <AnimatePresence mode="wait">
          {showHero ? (
            <motion.div
              key="hero"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex min-h-[min(420px,50vh)] flex-col items-center justify-center rounded-3xl border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent p-10 text-center"
            >
              <div className="mb-6 flex gap-2">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="h-24 w-20 rounded-lg bg-gradient-to-br from-zinc-700/80 to-zinc-800"
                    initial={{ y: 10, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: i * 0.1 }}
                  />
                ))}
              </div>
              <h2 className="text-xl font-semibold text-zinc-100">Lecture to notes, locally</h2>
              <p className="mt-2 max-w-md text-sm text-zinc-500">
                Pick a mode in the sidebar, then use <span className="font-medium text-zinc-400">Generate Best Study Pack</span>{' '}
                — your video never leaves this Mac.
              </p>
            </motion.div>
          ) : null}

          {running && !showGallery && p.frames.length === 0 ? (
            <motion.div
              key="scanning"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex min-h-[320px] flex-col items-center justify-center gap-3 py-16"
            >
              <motion.div
                className="h-14 w-14 rounded-2xl border-2 border-indigo-500/40 border-t-indigo-400"
                animate={{ rotate: 360 }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
              />
              <p className="text-center text-sm font-medium text-zinc-200">{discovery.line}</p>
              {discovery.sub ? (
                <p className="text-center text-xs text-zinc-500">{discovery.sub}</p>
              ) : null}
              <p className="text-center text-[11px] text-indigo-300/90">{stageLine}</p>
              {eta ? <p className="font-mono text-xs text-zinc-500 tabular-nums">{eta}</p> : null}
              <p className="text-center text-[11px] text-zinc-600">
                {p.job?.progress.message ?? ''} · {p.job?.progress.percent ?? 0}%
              </p>
            </motion.div>
          ) : null}

          {failed && !showGallery ? (
            <div className="mx-auto max-w-lg rounded-2xl border border-rose-500/25 bg-rose-950/30 px-5 py-6 text-center">
              {(() => {
                const friendly = formatJobError(p.job)
                return (
                  <>
                    <p className="text-sm font-semibold text-rose-100">{friendly?.title ?? 'Something went wrong'}</p>
                    <p className="mt-2 text-sm text-rose-200/80">{friendly?.detail}</p>
                    {friendly?.hint ? <p className="mt-3 text-xs text-zinc-400">{friendly.hint}</p> : null}
                  </>
                )
              })()}
            </div>
          ) : null}

          {showGallery || (running && p.frames.length > 0) ? (
            <motion.div key="grid" variants={container} initial="hidden" animate="show" className="pt-4">
              {showSuccessCard ? (
                <motion.div variants={item} className="relative mb-6">
                  <motion.div
                    aria-hidden
                    className="pointer-events-none absolute -inset-3 rounded-[28px] bg-emerald-500/20 blur-2xl"
                    animate={{ opacity: [0.28, 0.48, 0.28], scale: [1, 1.02, 1] }}
                    transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                  />
                  <motion.div
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                    className="relative overflow-hidden rounded-2xl border border-emerald-500/35 bg-gradient-to-br from-emerald-950/70 via-zinc-950/90 to-zinc-950 p-6 shadow-[0_0_0_1px_rgba(52,211,153,0.12),0_24px_64px_-24px_rgba(16,185,129,0.35)] md:p-7"
                  >
                    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/90">
                          Pack ready
                        </p>
                        <h3 className="mt-1.5 text-xl font-semibold tracking-tight text-white md:text-2xl">
                          Nice work — here&apos;s what we captured
                        </h3>
                        <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">
                          Exam-style signal from your lecture: fewer dupes, clearer topics, and time back for real
                          practice.
                        </p>
                      </div>
                      <div className="rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2 text-right">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">Frames kept</p>
                        <p className="text-lg font-semibold tabular-nums text-zinc-100">{animFrames}</p>
                        <p className="text-[10px] text-zinc-600">{p.junkPct}% noise culled</p>
                      </div>
                    </div>

                    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                      {[
                        {
                          label: 'MCQs extracted',
                          value: animMcq,
                          hint:
                            p.job?.lastMcqCount == null || p.job.lastMcqCount === 0
                              ? 'Generate MCQ PDF to populate'
                              : undefined,
                        },
                        {
                          label: 'Key topics',
                          value: animTopics,
                          hint: countTaggedTopics(mcqMetrics) != null ? 'From tagged topics' : 'Estimated from slides & patterns',
                        },
                        {
                          label: 'Duplicates removed',
                          value: animDup,
                          hint: 'Skipped near-identical frames',
                        },
                        {
                          label: 'Time saved',
                          value: formatSavedDurationShort(animSaved),
                          hint: 'Vs manual screenshots',
                        },
                      ].map((row, i) => (
                        <motion.div
                          key={row.label}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.06 + i * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                          className="rounded-xl border border-white/[0.07] bg-black/35 px-4 py-3 backdrop-blur-sm"
                        >
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{row.label}</p>
                          <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-white">{row.value}</p>
                          {row.hint ? <p className="mt-1 text-[10px] leading-snug text-zinc-500">{row.hint}</p> : null}
                        </motion.div>
                      ))}
                    </div>

                    <div className="flex flex-col gap-3">
                      <motion.button
                        type="button"
                        disabled={!p.canUsePdfOutput}
                        onClick={() => void p.openPdf()}
                        whileHover={p.canUsePdfOutput ? { scale: 1.01 } : {}}
                        whileTap={p.canUsePdfOutput ? { scale: 0.995 } : {}}
                        className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 py-3.5 text-[15px] font-bold text-emerald-950 shadow-lg shadow-emerald-500/25 transition-[box-shadow] hover:shadow-emerald-400/35 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Open Study Pack
                      </motion.button>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <motion.button
                          type="button"
                          disabled={toolsLocked}
                          onClick={() => void p.generateShuffledPractice()}
                          whileHover={!toolsLocked ? { scale: 1.01 } : {}}
                          whileTap={!toolsLocked ? { scale: 0.99 } : {}}
                          className="rounded-2xl border border-emerald-400/35 bg-emerald-500/10 py-3 text-sm font-semibold text-emerald-50 hover:bg-emerald-500/18 disabled:opacity-40"
                        >
                          Start practice from this lecture
                        </motion.button>
                        <button
                          type="button"
                          onClick={scrollToMcqControls}
                          className="rounded-2xl border border-white/12 bg-white/[0.04] py-3 text-sm font-semibold text-zinc-100 hover:bg-white/[0.07]"
                        >
                          Practice mode
                        </button>
                      </div>
                      <div className="rounded-2xl border border-white/[0.06] bg-black/25 px-4 py-3">
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Export</p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={!p.canUsePdfOutput}
                            onClick={() => void p.savePdf()}
                            className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-35"
                          >
                            Save PDF copy…
                          </button>
                          <button
                            type="button"
                            disabled={toolsLocked}
                            onClick={() => void p.exportMcqTxt()}
                            className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-35"
                          >
                            MCQ text (.txt)
                          </button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                </motion.div>
              ) : null}

              {running && p.frames.length > 0 ? (
                <p className="mb-3 text-center text-[11px] text-zinc-500">
                  {stageLine}
                  {eta ? ` · ${eta}` : ''}
                </p>
              ) : null}

              {done && p.frames.length > 0 ? (
                <motion.div variants={item} className="mb-4">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Frame filters</p>
                  <div className="flex flex-wrap gap-2">
                    {FILTER_CHIPS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setGalleryFilter(c.id)}
                        className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${
                          galleryFilter === c.id
                            ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100 shadow-[0_0_20px_-6px_rgba(99,102,241,0.5)]'
                            : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20'
                        }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </motion.div>
              ) : null}

              {done && wow.length > 0 ? (
                <motion.div
                  variants={item}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4 }}
                  className="mb-6 overflow-hidden rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-950/40 to-zinc-950/80 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-violet-300/90">
                        Most asked patterns
                      </p>
                      <p className="mt-1 text-xs text-zinc-500">Repeated question stems spotted across frames (offline)</p>
                    </div>
                    <span className="rounded-lg border border-violet-500/30 bg-violet-500/15 px-2.5 py-1 text-[10px] font-medium text-violet-200">
                      Heuristic
                    </span>
                  </div>
                  <ol className="space-y-2.5">
                    {wow.map((w, i) => (
                      <li
                        key={w.stem}
                        className="flex gap-3 rounded-xl border border-white/[0.05] bg-black/25 px-3 py-2.5"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/20 text-[11px] font-bold tabular-nums text-violet-200">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-[12px] leading-snug text-zinc-200">{w.stem.slice(0, 140)}</p>
                          <p className="mt-1 text-[10px] text-zinc-500">Seen across frames · prioritize in review</p>
                        </div>
                        <span className="shrink-0 self-center tabular-nums text-sm font-semibold text-violet-300">
                          ×{w.count}
                        </span>
                      </li>
                    ))}
                  </ol>
                </motion.div>
              ) : null}

              {done && p.frames.length > 0 ? (
                <div ref={mcqStackRef} id="studio-mcq-stack" className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <p className="mb-3 text-xs text-zinc-500">
                    Generate an MCQ practice PDF from your frames. Raw OCR and PDF rebuild live under{' '}
                    <span className="font-medium text-zinc-400">Advanced</span> in the sidebar.
                  </p>
                  <div className="mb-3 flex flex-col gap-1">
                    <label className="text-[11px] font-medium text-zinc-400" htmlFor="mcq-ai-mode">
                      AI processing mode
                    </label>
                    <select
                      id="mcq-ai-mode"
                      value={p.mcqAiMode}
                      onChange={(e) => p.setMcqAiMode(e.target.value as McqAiMode)}
                      disabled={p.mcqBusy || p.ocrBusy || p.rebuildBusy}
                      className="max-w-md rounded-lg border border-white/10 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-indigo-500/50 disabled:opacity-40"
                    >
                      <option value="fast">Fast — skip AI when OCR is clean; batched cleanup otherwise</option>
                      <option value="exam">Exam — more AI cleanup + batched answer key PDF</option>
                      <option value="notes">Notes — study-notes PDF (batched summarization)</option>
                      <option value="pyq">PYQ — merge repeated stems locally, then normal cleanup</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={p.mcqBusy || p.ocrBusy || p.rebuildBusy}
                      onClick={() => void p.generateMcqPdfAuto()}
                      className="rounded-xl border border-emerald-500/45 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-40"
                    >
                      {p.mcqBusy ? 'Generating MCQ PDF…' : 'Generate MCQ PDF (auto)'}
                    </button>
                    {p.mcqBusy ? (
                      <button
                        type="button"
                        onClick={() => void p.cancelMcqPdf()}
                        className="rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-zinc-400 hover:bg-white/5"
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                  <McqProgressPanel active={p.mcqBusy} payload={p.mcqProgressPayload} />
                </div>
              ) : null}

              {done && p.job?.id ? (
                <McqStudentPanel
                  jobId={p.job.id}
                  studentState={p.studentState}
                  toggleBookmark={p.toggleBookmark}
                  toggleSolved={p.toggleSolved}
                  generateWeakTopicPdf={p.generateWeakTopicPdf}
                  secondaryBusy={p.secondaryMcqBusy}
                />
              ) : null}

              {filteredFrames.length === 0 && p.frames.length > 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">
                  {framesEmptyCopy(p.job, running, filterNote)}
                </p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
                  {filteredFrames.map((f) => (
                    <FrameCard
                      key={f.name}
                      f={f}
                      job={p.job}
                      jobId={p.job?.id ?? null}
                      duplicateGroupIndex={p.duplicateGroupIndex}
                      duplicateGroupSizes={p.duplicateGroupSizes}
                      analyzeQuestionPatterns={p.analyzeQuestionPatterns}
                      formatTimestamp={p.formatTimestamp}
                      toggleFrameInclude={p.toggleFrameInclude}
                    />
                  ))}
                </div>
              )}
            </motion.div>
          ) : null}

          {!showGallery && !running && !failed && p.frames.length > 0 ? (
            <p className="py-16 text-center text-sm text-zinc-500">{framesEmptyCopy(p.job, false, filterNote)}</p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}

function McqStudentPanel({
  jobId,
  studentState,
  toggleBookmark,
  toggleSolved,
  generateWeakTopicPdf,
  secondaryBusy,
}: {
  jobId: string
  studentState: StudioViewModel['studentState']
  toggleBookmark: StudioViewModel['toggleBookmark']
  toggleSolved: StudioViewModel['toggleSolved']
  generateWeakTopicPdf: StudioViewModel['generateWeakTopicPdf']
  secondaryBusy: boolean
}) {
  const api = window.electronApi
  const [mcq, setMcq] = useState<McqQuestionsFile | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [topic, setTopic] = useState('')
  const [hideSolved, setHideSolved] = useState(false)

  useEffect(() => {
    if (!api) return
    queueMicrotask(() => setLoadErr(null))
    void api.readMcqJson(jobId).then((r) => {
      if (!r.ok || !r.json) {
        setMcq(null)
        if (r.message) setLoadErr(r.message)
        return
      }
      try {
        setMcq(JSON.parse(r.json) as McqQuestionsFile)
      } catch {
        setLoadErr('Could not parse MCQ JSON.')
      }
    })
  }, [api, jobId])

  if (!mcq || (mcq.questions ?? []).length === 0) {
    return loadErr ? (
      <p className="mb-4 text-center text-[11px] text-zinc-600">{loadErr}</p>
    ) : null
  }

  const qsAll = mcq.questions ?? []
  const qs = hideSolved
    ? qsAll.filter((q) => !studentState.solvedQuestionIds.includes(q.id))
    : qsAll

  return (
    <div className="mb-6 rounded-2xl border border-white/[0.06] bg-zinc-900/40 p-4">
      <p className="mb-3 text-xs font-semibold text-zinc-300">Student tools · MCQs</p>
      <label className="mb-3 flex cursor-pointer items-center gap-2 text-[11px] text-zinc-500">
        <input
          type="checkbox"
          checked={hideSolved}
          onChange={(e) => setHideSolved(e.target.checked)}
          className="rounded border-zinc-600"
        />
        Hide solved (list only)
      </label>
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Weak topic (after Tag topics)"
          className="min-w-[160px] flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-xs text-zinc-100"
        />
        <button
          type="button"
          disabled={secondaryBusy || !topic.trim()}
          onClick={() => void generateWeakTopicPdf(topic)}
          className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-100 disabled:opacity-40"
        >
          PDF for topic
        </button>
      </div>
      <ul className="max-h-48 space-y-2 overflow-y-auto text-[11px]">
        {qs.length === 0 ? (
          <p className="text-[11px] text-zinc-600">All questions marked solved — uncheck a row or disable filter.</p>
        ) : null}
        {qs.slice(0, 40).map((q) => (
          <li
            key={q.id}
            className="flex flex-col gap-1 rounded-lg border border-white/[0.05] bg-black/20 px-2 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="line-clamp-2 text-zinc-400">{q.stem.slice(0, 140)}</span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void toggleBookmark(q.id)}
                className={`rounded px-2 py-0.5 text-[10px] ${
                  studentState.bookmarkedQuestionIds.includes(q.id)
                    ? 'bg-amber-500/25 text-amber-200'
                    : 'bg-white/5 text-zinc-500'
                }`}
              >
                Bookmark
              </button>
              <button
                type="button"
                onClick={() => void toggleSolved(q.id)}
                className={`rounded px-2 py-0.5 text-[10px] ${
                  studentState.solvedQuestionIds.includes(q.id)
                    ? 'bg-emerald-500/25 text-emerald-200'
                    : 'bg-white/5 text-zinc-500'
                }`}
              >
                Solved
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function FrameCard({
  f,
  job,
  jobId,
  duplicateGroupIndex,
  duplicateGroupSizes,
  analyzeQuestionPatterns,
  formatTimestamp,
  toggleFrameInclude,
}: {
  f: FrameArtifact
  job: JobRecord | null
  jobId: string | null
  duplicateGroupIndex: Map<string, number>
  duplicateGroupSizes: Map<number, number>
  analyzeQuestionPatterns: (t: string) => QuestionPatternFlags
  formatTimestamp: (s: number) => string
  toggleFrameInclude: (name: string, include: boolean) => void
}) {
  const gid = duplicateGroupIndex.get(f.name)
  const dupCount = gid !== undefined ? (duplicateGroupSizes.get(gid) ?? 0) : 0
  const flags = f.ocrText ? analyzeQuestionPatterns(f.ocrText) : null
  const done = job?.state === 'done'

  return (
    <motion.figure
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="overflow-hidden rounded-2xl border border-white/[0.08] bg-zinc-900/50 shadow-lg shadow-black/20"
    >
      {jobId ? (
        <LazyFrameThumb jobId={jobId} frameName={f.name} initialDataUrl={f.dataUrl} />
      ) : f.dataUrl ? (
        <img src={f.dataUrl} alt="" className="aspect-video w-full object-cover" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center bg-zinc-800 text-xs text-zinc-500">
          On disk
        </div>
      )}
      <figcaption className="border-t border-white/[0.06] px-3 py-2 text-[11px] text-zinc-500">
        {formatTimestamp(f.seconds)} · Δ{(f.changeRatio * 100).toFixed(0)}%
      </figcaption>
      {done ? (
        <div className="space-y-2 border-t border-white/[0.06] px-3 py-2">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={f.includeInPdf !== false}
              onChange={(e) => void toggleFrameInclude(f.name, e.target.checked)}
              className="rounded border-zinc-600"
            />
            Include in PDF
          </label>
          {dupCount > 1 && gid !== undefined ? (
            <span className="inline-block rounded-md bg-indigo-500/15 px-2 py-0.5 text-[10px] text-indigo-300">
              Dup group {gid + 1}
            </span>
          ) : null}
          {f.ocrText ? (
            <>
              <p className="line-clamp-4 text-[11px] leading-relaxed text-zinc-500">
                {f.ocrText.length > 160 ? `${f.ocrText.slice(0, 160)}…` : f.ocrText}
              </p>
              {flags ? (
                <div className="flex flex-wrap gap-1">
                  {flags.hasQuestionMark ? (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">?</span>
                  ) : null}
                  {flags.mcqStyle ? (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">MCQ</span>
                  ) : null}
                  {flags.romanEnumeration ? (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px]">i–iv</span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-[10px] text-zinc-600">Run “Analyze text” for OCR snippets.</p>
          )}
        </div>
      ) : null}
    </motion.figure>
  )
}

function LazyFrameThumb({
  jobId,
  frameName,
  initialDataUrl,
}: {
  jobId: string
  frameName: string
  initialDataUrl?: string
}) {
  const api = window.electronApi
  const [dataUrl, setDataUrl] = useState<string | undefined>(initialDataUrl)
  const [failed, setFailed] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (dataUrl || !api || startedRef.current) return
    const el = shellRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        startedRef.current = true
        io.disconnect()
        void api.getFramePreview(jobId, frameName).then((r) => {
          if (r.dataUrl) setDataUrl(r.dataUrl)
          else setFailed(true)
        })
      },
      { root: null, rootMargin: '320px 0px 320px 0px', threshold: 0.01 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [api, jobId, frameName, dataUrl])

  if (dataUrl) {
    return <img src={dataUrl} alt="" className="aspect-video w-full object-cover" decoding="async" />
  }
  if (failed) {
    return (
      <div className="flex aspect-video w-full items-center justify-center bg-zinc-800 px-2 text-center text-[10px] leading-snug text-zinc-500">
        Could not load preview
      </div>
    )
  }
  return <div ref={shellRef} className="aspect-video w-full animate-pulse bg-zinc-800/90" aria-hidden />
}
