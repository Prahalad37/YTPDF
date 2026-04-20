import { AnimatePresence, motion } from 'framer-motion'
import type { McqProgressPayload } from '../../types/electron-api'

const PHASE_LABELS = [
  'Scanning frames',
  'Extracting text',
  'Detecting questions',
  'AI processing',
  'Generating PDF',
] as const

const PHASE_ORDER: Array<McqProgressPayload['phase']> = [
  'scanning',
  'extracting',
  'detecting',
  'ai',
  'pdf',
]

function phaseIndex(phase: McqProgressPayload['phase']): number {
  const i = PHASE_ORDER.indexOf(phase)
  return i >= 0 ? i : 0
}

function barFillPercent(p: McqProgressPayload): number {
  if (p.total <= 0) return 0
  return Math.min(100, Math.round((100 * p.current) / p.total))
}

type Props = {
  active: boolean
  payload: McqProgressPayload | null
}

export function McqProgressPanel({ active, payload }: Props) {
  const phaseIdx = payload ? phaseIndex(payload.phase) : 0
  const pct = payload ? barFillPercent(payload) : 0
  const indeterminate = active && (!payload || payload.total <= 0)
  const message = payload?.message ?? 'Connecting…'

  return (
    <AnimatePresence>
      {active ? (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mt-3 overflow-hidden rounded-xl border border-emerald-500/25 bg-gradient-to-b from-emerald-950/40 to-zinc-950/80 px-3 py-3 shadow-lg shadow-emerald-950/20"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <motion.span
                className="relative flex h-8 w-8 shrink-0 items-center justify-center"
                aria-hidden
              >
                <span className="absolute inset-0 rounded-full border-2 border-emerald-500/30" />
                <motion.span
                  className="absolute inset-0 rounded-full border-2 border-transparent border-t-emerald-400"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
                />
              </motion.span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-200/90">
                  Generating MCQ exam PDF
                </p>
                <p className="truncate text-[12px] text-zinc-300">{message}</p>
              </div>
            </div>
            {!indeterminate && payload && payload.total > 0 ? (
              <span className="shrink-0 tabular-nums text-xs font-medium text-emerald-300/90">
                {pct}%
              </span>
            ) : null}
          </div>

          <div className="mb-3 grid grid-cols-5 gap-1">
            {PHASE_LABELS.map((label, i) => {
              const done = i < phaseIdx
              const current = i === phaseIdx
              return (
                <div key={label} className="flex flex-col items-center gap-1">
                  <motion.span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                      done
                        ? 'bg-emerald-500 text-emerald-950'
                        : current
                          ? 'bg-emerald-400/90 text-emerald-950 shadow-[0_0_12px_rgba(52,211,153,0.45)]'
                          : 'bg-zinc-800 text-zinc-500'
                    }`}
                    animate={current ? { scale: [1, 1.08, 1] } : {}}
                    transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    {done ? '✓' : i + 1}
                  </motion.span>
                  <span
                    className={`text-center text-[9px] leading-tight ${
                      current ? 'text-emerald-200' : 'text-zinc-500'
                    }`}
                  >
                    {label}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="relative h-2 overflow-hidden rounded-full bg-zinc-800/90">
            {indeterminate ? (
              <motion.div
                className="absolute inset-y-0 w-[40%] rounded-full bg-gradient-to-r from-emerald-700/40 via-emerald-400 to-teal-400/90 shadow-[0_0_12px_rgba(52,211,153,0.35)]"
                initial={{ left: '-40%' }}
                animate={{ left: ['-40%', '110%'] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
              />
            ) : (
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-emerald-600 via-teal-500 to-emerald-400"
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20 }}
              />
            )}
          </div>

          {payload && payload.total > 0 && (payload.phase === 'scanning' || payload.phase === 'extracting') ? (
            <p className="mt-2 text-[10px] text-zinc-500">
              Step {payload.current} of {payload.total} · {payload.phase === 'scanning' ? 'Scan' : 'OCR'}
            </p>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
