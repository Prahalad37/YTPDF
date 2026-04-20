import { AnimatePresence, motion } from 'framer-motion'
import type { JobRecord } from '../../types/electron-api'

type Props = {
  job: JobRecord | null
  /** Gallery list length (may include raw preview frames before `job.frames` is populated). */
  galleryFrameCount: number
  logsOpen: boolean
  setLogsOpen: (v: boolean) => void
}

export function StudioBottomBar({ job, galleryFrameCount, logsOpen, setLogsOpen }: Props) {
  const logs = job?.logs.slice(-40) ?? []

  return (
    <footer className="shrink-0 border-t border-white/[0.06] bg-zinc-950/90 backdrop-blur-xl">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-500">
          {job ? (
            <>
              <span>
                <span className="text-zinc-600">
                  {galleryFrameCount > 0 && job.frames.length === 0 ? 'Captures · ' : 'Frames · '}
                </span>
                <span className="font-mono tabular-nums text-zinc-300">
                  {galleryFrameCount > 0 && job.frames.length === 0 ? galleryFrameCount : job.frames.length}
                </span>
                {galleryFrameCount > 0 && job.frames.length === 0 ? (
                  <span className="ml-1 text-zinc-600">(preview)</span>
                ) : null}
              </span>
              <span>
                <span className="text-zinc-600">Skipped · </span>
                <span className="font-mono tabular-nums text-zinc-300">
                  {job.skippedBlank + job.skippedDuplicate}
                </span>
              </span>
              {job.videoDurationSec != null ? (
                <span>
                  <span className="text-zinc-600">Source · </span>
                  <span className="tabular-nums text-zinc-400">{Math.round(job.videoDurationSec)}s</span>
                </span>
              ) : null}
            </>
          ) : (
            <span>Ready when you are.</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setLogsOpen(!logsOpen)}
          className="rounded-lg border border-white/10 px-3 py-1 text-[11px] font-medium text-zinc-400 hover:bg-white/5"
        >
          {logsOpen ? 'Hide Advanced' : 'Advanced'}
        </button>
      </div>
      <AnimatePresence>
        {logsOpen ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-white/[0.04] bg-black/30"
          >
            <div className="px-5 py-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Technical logs</p>
              {logs.length === 0 ? (
                <p className="text-[10px] text-zinc-600">No log lines for this job yet.</p>
              ) : (
                <pre className="max-h-36 overflow-auto text-[10px] leading-relaxed text-zinc-500">
                  {logs.map((l, i) => (
                    <span key={`${l.ts}-${i}`} className="block">
                      [{l.level}] {l.message}
                    </span>
                  ))}
                </pre>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </footer>
  )
}
