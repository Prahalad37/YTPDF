const PAD = (n: number) => String(Math.floor(n)).padStart(2, '0')

/** Formats seconds as HH:MM:SS (hours omitted if zero). */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${PAD(m)}:${PAD(s)}`
  return `${m}:${PAD(s)}`
}
