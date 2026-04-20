import { AnimatePresence, motion } from 'framer-motion'
import type { StudioViewModel } from '../../hooks/useStudioApp'
import { fileLabel, isActiveJobState } from '../../hooks/useStudioApp'
import { EXTRACTION_PRESETS, presetDisplayName } from '../../lib/extractionPresetLabels'
import { formatRelativeTime } from '../../lib/formatRelativeTime'

type Props = Pick<
  StudioViewModel,
  | 'sourcePath'
  | 'job'
  | 'sampleEverySec'
  | 'setSampleEverySec'
  | 'cooldownSecStr'
  | 'setCooldownSecStr'
  | 'changeThresholdStr'
  | 'setChangeThresholdStr'
  | 'ocrLanguageStr'
  | 'setOcrLanguageStr'
  | 'pdfExports'
  | 'extractionPreset'
  | 'setExtractionPreset'
  | 'advancedOpen'
  | 'setAdvancedOpen'
  | 'useCustomCapture'
  | 'setUseCustomCapture'
  | 'pickFile'
  | 'onDrop'
  | 'startJob'
  | 'rerunSameFile'
  | 'openJobOutputsFolder'
  | 'cancelJob'
  | 'pauseJob'
  | 'resumeJob'
  | 'savePdf'
  | 'openPdf'
  | 'canUsePdfOutput'
  | 'openExportPdf'
  | 'saveExportCopy'
  | 'viewExportJob'
  | 'renameExport'
  | 'deleteExport'
  | 'active'
  | 'startLocked'
  | 'generateAnswerKey'
  | 'generateRevisionSheet'
  | 'exportMcqTxt'
  | 'generateShuffledPractice'
  | 'tagMcqTopics'
  | 'mcqBusy'
  | 'secondaryMcqBusy'
  | 'runOcrAnalysis'
  | 'rebuildStudyPdf'
  | 'ocrBusy'
  | 'rebuildBusy'
>

function nextStepHint(p: {
  sourcePath: string | null
  job: Props['job']
  active: boolean | null
}): string {
  if (!p.sourcePath) {
    return 'Next: add a video from your Mac (drop or choose file).'
  }
  const st = p.job?.state
  if (Boolean(p.active) && st !== 'paused') {
    return 'Next: wait for extraction to finish, or pause if you need to stop.'
  }
  if (st === 'paused') {
    return 'Next: resume extraction, or cancel to change settings.'
  }
  if (st === 'done') {
    return 'Next: open your study PDF, or use Advanced for MCQs, OCR, and exports.'
  }
  if (st === 'failed' || st === 'cancelled') {
    return 'Next: fix the issue and run Generate again, or pick another video.'
  }
  if (st === 'fallback_required') {
    return 'Next: follow the on-screen message or try another file.'
  }
  return 'Next: choose a mode, then tap Generate Best Study Pack.'
}

export function StudioSidebar(p: Props) {
  const active = p.active
  const startLocked = p.startLocked
  const jobActive = p.job && isActiveJobState(p.job.state)
  const done = p.job?.state === 'done'
  const deliverBusy = p.mcqBusy || p.secondaryMcqBusy
  const toolsLocked = !done || deliverBusy || p.ocrBusy || p.rebuildBusy
  const primaryLabel =
    p.job?.state === 'paused'
      ? 'Paused — resume in the toolbar below'
      : active
        ? 'Generating study pack…'
        : 'Generate Best Study Pack'

  return (
    <aside className="flex h-full min-h-0 w-[28%] min-w-[300px] max-w-[420px] flex-col overflow-hidden border-r border-white/[0.06] bg-zinc-950/50">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-5">
        <section className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
          <p className="text-[10px] leading-relaxed text-zinc-500">
            <span className="font-medium text-zinc-400">Private on your Mac.</span> Video stays on disk. Extraction runs
            locally. Optional DeepSeek polish uses HTTPS only when you generate MCQ-style assets (API key required).
          </p>
        </section>

        <section className="mb-5">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Source</h2>
          <motion.button
            type="button"
            onClick={() => void p.pickFile()}
            className="btn-press mb-3 w-full rounded-2xl border border-white/[0.08] bg-white/[0.04] py-2.5 text-sm font-semibold text-zinc-100 shadow-sm hover:bg-white/[0.07]"
            whileTap={{ scale: 0.99 }}
          >
            Choose video…
          </motion.button>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(e) => void p.onDrop(e)}
            className="glass-panel rounded-2xl border border-dashed border-white/15 p-5 text-center transition-colors hover:border-emerald-500/40"
          >
            <p className="text-sm font-medium text-zinc-200">Drop a video here</p>
            <p className="mt-1 text-xs text-zinc-500">MP4, MOV, MKV…</p>
          </div>
          {p.sourcePath ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
            >
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Selected</p>
              <p className="truncate text-sm font-medium text-zinc-100" title={p.sourcePath}>
                {fileLabel(p.sourcePath)}
              </p>
            </motion.div>
          ) : null}
        </section>

        <section className="mb-5">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Mode</h2>
          <div className="grid grid-cols-2 gap-2">
            {EXTRACTION_PRESETS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => p.setExtractionPreset(m.id)}
                disabled={startLocked}
                className={`rounded-xl border px-2.5 py-2.5 text-left transition-all disabled:opacity-50 ${
                  p.extractionPreset === m.id
                    ? 'border-indigo-500/50 bg-indigo-500/10 shadow-[0_0_0_1px_rgba(99,102,241,0.25)]'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-white/10'
                }`}
              >
                <span className="text-base leading-none">{m.emoji}</span>
                <p className="mt-1 text-[11px] font-semibold leading-tight text-zinc-100">{m.shortTitle}</p>
              </button>
            ))}
          </div>
        </section>

        <p className="mb-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.07] px-3 py-2 text-[11px] leading-snug text-indigo-100/90">
          {nextStepHint({ sourcePath: p.sourcePath, job: p.job, active })}
        </p>

        <motion.button
          type="button"
          onClick={() => void p.startJob()}
          disabled={!p.sourcePath || startLocked}
          className="btn-press mb-4 w-full rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-500 py-3.5 text-[15px] font-bold text-white shadow-xl shadow-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          whileHover={!startLocked && p.sourcePath ? { scale: 1.01 } : {}}
        >
          {primaryLabel}
        </motion.button>

        {p.job && !done ? (
          <div className="mb-4">
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-[width] duration-300"
                style={{ width: `${Math.min(100, Math.max(0, p.job.progress.percent))}%` }}
              />
            </div>
            <p className="mb-3 text-[11px] text-zinc-500">
              {p.job.progress.percent}% · {p.job.progress.message}
            </p>
          </div>
        ) : null}

        {p.job?.request.kind === 'local' && done ? (
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void p.rerunSameFile()}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-indigo-300 hover:bg-white/5"
            >
              Run again (same file)
            </button>
            <button
              type="button"
              onClick={() => void p.openJobOutputsFolder()}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
            >
              Open job folder
            </button>
          </div>
        ) : null}

        {(jobActive || p.job) && (
          <div className="mb-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void p.cancelJob()}
              disabled={
                !p.job ||
                p.job.state === 'done' ||
                p.job.state === 'failed' ||
                p.job.state === 'cancelled' ||
                p.job.state === 'fallback_required'
              }
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-30"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void p.pauseJob()}
              disabled={
                !p.job ||
                (p.job.state !== 'probing' &&
                  p.job.state !== 'downloading' &&
                  p.job.state !== 'extracting' &&
                  p.job.state !== 'filtering' &&
                  p.job.state !== 'building_pdf')
              }
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-30"
            >
              Pause
            </button>
            <button
              type="button"
              onClick={() => void p.resumeJob()}
              disabled={p.job?.state !== 'paused'}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-30"
            >
              Resume
            </button>
          </div>
        )}

        {done ? (
          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Study PDF</h2>
            <motion.button
              type="button"
              onClick={() => void p.openPdf()}
              disabled={!p.canUsePdfOutput}
              className="btn-press w-full rounded-2xl border border-emerald-500/35 bg-emerald-500/12 py-3 text-sm font-semibold text-emerald-100 shadow-lg shadow-emerald-900/20 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-35"
              whileTap={{ scale: 0.995 }}
            >
              {p.canUsePdfOutput ? 'Open Study Pack' : 'Preparing Study Pack…'}
            </motion.button>
            {!p.canUsePdfOutput && p.job?.state === 'done' ? (
              <p className="mt-2 text-[10px] text-zinc-600">Available when the notes PDF is ready and no tool is running.</p>
            ) : null}
          </section>
        ) : null}

        <section className="mb-5">
          <button
            type="button"
            onClick={() => p.setAdvancedOpen(!p.advancedOpen)}
            className="flex w-full items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left text-xs font-semibold text-zinc-200"
          >
            <span>Advanced</span>
            <span className="text-zinc-500">{p.advancedOpen ? '▼' : '▶'}</span>
          </button>
          <AnimatePresence>
            {p.advancedOpen ? (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="space-y-2 border-l border-white/[0.06] py-3 pl-3">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Exports & tools</p>
                  <button
                    type="button"
                    onClick={() => void p.savePdf()}
                    disabled={!p.canUsePdfOutput}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-35"
                  >
                    Save study PDF copy…
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.exportMcqTxt()}
                    disabled={toolsLocked}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-35"
                  >
                    Export TXT
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.generateShuffledPractice()}
                    disabled={toolsLocked}
                    className="w-full rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-left text-xs font-medium text-sky-100 hover:bg-sky-500/18 disabled:opacity-35"
                  >
                    Shuffle practice
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.tagMcqTopics()}
                    disabled={toolsLocked}
                    className="w-full rounded-lg border border-zinc-600 bg-zinc-900/80 px-3 py-2 text-left text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-35"
                  >
                    Tag topics (DeepSeek)
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.generateAnswerKey()}
                    disabled={toolsLocked}
                    className="w-full rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-left text-xs font-medium text-violet-100 hover:bg-violet-500/18 disabled:opacity-35"
                  >
                    Answer key (DeepSeek)
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.generateRevisionSheet()}
                    disabled={toolsLocked}
                    className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-xs font-medium text-amber-100 hover:bg-amber-500/18 disabled:opacity-35"
                  >
                    Revision sheet (DeepSeek)
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.runOcrAnalysis()}
                    disabled={!done || p.ocrBusy || deliverBusy}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/[0.06] disabled:opacity-35"
                  >
                    {p.ocrBusy ? 'Running raw OCR…' : 'Raw OCR (re-scan frames)'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void p.rebuildStudyPdf()}
                    disabled={!done || p.rebuildBusy || p.ocrBusy || deliverBusy}
                    className="w-full rounded-lg border border-indigo-500/35 bg-indigo-500/10 px-3 py-2 text-left text-xs font-medium text-indigo-100 hover:bg-indigo-500/18 disabled:opacity-35"
                  >
                    {p.rebuildBusy ? 'Rebuilding PDF…' : 'Rebuild PDF'}
                  </button>

                  <div className="pt-2">
                    <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">Capture overrides</p>
                    <label className="mb-2 flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                      <input
                        type="checkbox"
                        checked={p.useCustomCapture}
                        onChange={(e) => p.setUseCustomCapture(e.target.checked)}
                        disabled={startLocked}
                        className="rounded border-zinc-600"
                      />
                      Custom timing & motion
                    </label>
                    <label className="mb-2 block">
                      <span className="text-[11px] text-zinc-500">OCR language (Tesseract -l)</span>
                      <input
                        type="text"
                        value={p.ocrLanguageStr}
                        onChange={(e) => p.setOcrLanguageStr(e.target.value)}
                        disabled={startLocked}
                        placeholder="eng, hin, …"
                        className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                      />
                    </label>
                    {p.useCustomCapture ? (
                      <>
                        <label className="mb-2 block">
                          <span className="text-[11px] text-zinc-500">Sample every (sec)</span>
                          <input
                            type="number"
                            min={0.25}
                            max={120}
                            step={0.25}
                            value={p.sampleEverySec}
                            onChange={(e) => p.setSampleEverySec(e.target.value)}
                            disabled={startLocked}
                            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                          />
                        </label>
                        <label className="mb-2 block">
                          <span className="text-[11px] text-zinc-500">Cooldown (sec)</span>
                          <input
                            type="number"
                            min={0}
                            max={300}
                            step={0.5}
                            value={p.cooldownSecStr}
                            onChange={(e) => p.setCooldownSecStr(e.target.value)}
                            disabled={startLocked}
                            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                          />
                        </label>
                        <label className="mb-2 block">
                          <span className="text-[11px] text-zinc-500">Motion gate (0–1)</span>
                          <input
                            type="number"
                            min={0.05}
                            max={0.5}
                            step={0.01}
                            value={p.changeThresholdStr}
                            onChange={(e) => p.setChangeThresholdStr(e.target.value)}
                            disabled={startLocked}
                            className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>

        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Recent jobs</h2>
          {p.pdfExports.length === 0 ? (
            <p className="text-xs text-zinc-600">No finished jobs yet — they land here when done.</p>
          ) : (
            <ul className="space-y-2">
              {p.pdfExports.slice(0, 10).map((j) => (
                <li key={j.id} className="glass-panel rounded-xl px-3 py-2">
                  <p className="truncate text-xs font-medium text-zinc-200">
                    {j.title ?? j.videoId ?? j.id.slice(0, 8)}
                  </p>
                  <p className="text-[10px] text-zinc-500">
                    {presetDisplayName(j.extractionPreset)} ·{' '}
                    {j.lastMcqCount != null ? `${j.lastMcqCount} MCQs` : 'Notes ready'} ·{' '}
                    {formatRelativeTime(j.updatedAt)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {j.pdfPath ? (
                      <>
                        <button
                          type="button"
                          className="text-[10px] font-medium text-indigo-400 hover:underline"
                          onClick={() => void p.openExportPdf(j.pdfPath!)}
                        >
                          Open PDF
                        </button>
                        <span className="text-zinc-700">·</span>
                        <button
                          type="button"
                          className="text-[10px] font-medium text-zinc-400 hover:underline"
                          onClick={() => void p.saveExportCopy(j)}
                        >
                          Save copy
                        </button>
                        <span className="text-zinc-700">·</span>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="text-[10px] font-medium text-zinc-400 hover:underline"
                      onClick={() => void p.viewExportJob(j)}
                    >
                      Open job
                    </button>
                    <span className="text-zinc-700">·</span>
                    <button
                      type="button"
                      className="text-[10px] font-medium text-zinc-400 hover:underline"
                      onClick={() => void p.renameExport(j)}
                    >
                      Rename
                    </button>
                    <span className="text-zinc-700">·</span>
                    <button
                      type="button"
                      className="text-[10px] font-medium text-rose-400/90 hover:underline"
                      onClick={() => void p.deleteExport(j)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  )
}
