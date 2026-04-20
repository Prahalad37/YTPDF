const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/

function extractFromQuery(search: string): string | null {
  const params = new URLSearchParams(search)
  const v = params.get('v')
  if (v && VIDEO_ID_PATTERN.test(v)) return v
  return null
}

/**
 * Extracts an 11-character YouTube video id from common URL shapes.
 */
export function parseYoutubeVideoId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  if (VIDEO_ID_PATTERN.test(raw)) return raw

  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./, '')

    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '').split('/')[0] ?? ''
      return VIDEO_ID_PATTERN.test(id) ? id : null
    }

    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const path = url.pathname
      if (path === '/watch') return extractFromQuery(url.search)
      const embedMatch = path.match(/^\/embed\/([a-zA-Z0-9_-]{11})/)
      if (embedMatch) return embedMatch[1]
      const shortMatch = path.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/)
      if (shortMatch) return shortMatch[1]
      const liveMatch = path.match(/^\/live\/([a-zA-Z0-9_-]{11})/)
      if (liveMatch) return liveMatch[1]
    }

    return null
  } catch {
    return null
  }
}
