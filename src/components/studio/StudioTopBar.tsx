import { motion } from 'framer-motion'
import type { JobRecord } from '../../types/electron-api'
import { fileLabel } from '../../hooks/useStudioApp'

type Props = {
  sourcePath: string | null
  job: JobRecord | null
}

export function StudioTopBar({ sourcePath, job }: Props) {
  const name = sourcePath ? fileLabel(sourcePath) : 'No file selected'
  const duration = job?.videoDurationSec != null ? formatDur(job.videoDurationSec) : '—'
  const pct = job?.progress.percent ?? 0
  const msg = job?.progress.message ?? 'Ready'

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] bg-zinc-950/80 px-5 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <motion.div
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-500 shadow-lg shadow-indigo-500/20"
          whileHover={{ scale: 1.04 }}
          transition={{ type: 'spring', stiffness: 400 }}
        >
          <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        </motion.div>
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Framebase AI</p>
          <p className="max-w-[200px] truncate text-sm font-semibold text-zinc-100" title={name}>
            {name}
          </p>
        </div>
      </div>

      <div className="hidden items-center gap-8 md:flex">
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Duration</p>
          <p className="font-mono text-sm tabular-nums text-zinc-200">{duration}</p>
        </div>
        <div className="w-48">
          <div className="mb-1 flex justify-between text-[11px] text-zinc-500">
            <span>Progress</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-400"
              initial={false}
              animate={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
          <p className="mt-0.5 truncate text-center text-[10px] text-zinc-500">{msg}</p>
        </div>
      </div>

      <button
        type="button"
        className="btn-press rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10"
        title="Theme & preferences (coming soon)"
        disabled
      >
        Preferences
      </button>
    </header>
  )
}

function formatDur(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
