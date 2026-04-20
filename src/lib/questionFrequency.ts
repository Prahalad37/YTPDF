/**
 * Normalize question stems for naive duplicate / frequency detection.
 */
export function normalizeStem(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .trim()
    .slice(0, 200)
}

export type StemFrequency = { stem: string; count: number; sampleFrame?: string }

export function topQuestionStems(
  items: Array<{ ocrText?: string; name: string }>,
  limit = 12,
): StemFrequency[] {
  const lineRe = /^\s*\d+[.)]\s+(.+)/m
  const qRe = /(what|which|why|how|select|choose|assertion|reason|fill in|true|false)/i
  const counts = new Map<string, { count: number; sampleFrame?: string }>()

  for (const it of items) {
    const text = it.ocrText?.trim()
    if (!text || text.length < 12) continue
    if (!qRe.test(text)) continue
    const lines = text.split(/\n+/)
    for (const line of lines) {
      const m = line.match(lineRe)
      const raw = (m?.[1] ?? line).trim()
      if (raw.length < 15) continue
      const key = normalizeStem(raw)
      if (key.length < 12) continue
      const cur = counts.get(key) ?? { count: 0, sampleFrame: it.name }
      cur.count += 1
      if (!cur.sampleFrame) cur.sampleFrame = it.name
      counts.set(key, cur)
    }
  }

  return [...counts.entries()]
    .map(([stem, v]) => ({ stem, count: v.count, sampleFrame: v.sampleFrame }))
    .filter((x) => x.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}
