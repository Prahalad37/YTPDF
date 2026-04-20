export type ViewportSize = { width: number; height: number }

function isUserDeniedOrAborted(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'NotAllowedError' || e.name === 'AbortError')
  )
}

type DisplayMediaOptions = DisplayMediaStreamOptions & { preferCurrentTab?: boolean }

/**
 * Requests tab/window capture. Prefers the current tab (Chrome) and browser surface when supported;
 * falls back to plain video capture so unsupported constraints do not block sharing.
 * User should pick this browser tab so the player is visible.
 */
export async function requestDisplayStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is not supported in this browser.')
  }

  const preferTab: DisplayMediaOptions = {
    audio: false,
    preferCurrentTab: true,
    video: { displaySurface: 'browser' },
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia(preferTab)
  } catch (e) {
    if (isUserDeniedOrAborted(e)) throw e
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      preferCurrentTab: true,
      video: true,
    } as DisplayMediaOptions)
  } catch (e) {
    if (isUserDeniedOrAborted(e)) throw e
  }

  return navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  })
}

/**
 * Attaches a stream to a video element and waits until a frame is available.
 */
export function attachStreamToVideo(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<void> {
  return new Promise((resolve, reject) => {
    video.srcObject = stream
    const onLoaded = () => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('error', onErr)
      if (video.videoWidth > 0 && video.videoHeight > 0) resolve()
      else reject(new Error('Capture stream has no video dimensions yet.'))
    }
    const onErr = () => {
      video.removeEventListener('loadeddata', onLoaded)
      video.removeEventListener('error', onErr)
      reject(new Error('Failed to load capture stream.'))
    }
    video.addEventListener('loadeddata', onLoaded)
    video.addEventListener('error', onErr)
    void video.play().catch(onErr)
  })
}

/**
 * Crops a viewport rectangle from a tab-capture video frame.
 * Maps CSS-pixel rect (relative to viewport) using viewport size at capture time.
 */
export function captureRegionToDataUrl(
  video: HTMLVideoElement,
  region: DOMRectReadOnly,
  viewport: ViewportSize,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.92,
): string {
  const vw = viewport.width
  const vh = viewport.height
  if (vw <= 0 || vh <= 0) {
    throw new Error('Invalid viewport size.')
  }
  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error('Video frame not ready.')
  }

  const scaleX = video.videoWidth / vw
  const scaleY = video.videoHeight / vh

  let sx = region.left * scaleX
  let sy = region.top * scaleY
  let sw = region.width * scaleX
  let sh = region.height * scaleY

  sx = Math.max(0, Math.min(sx, video.videoWidth - 1))
  sy = Math.max(0, Math.min(sy, video.videoHeight - 1))
  sw = Math.max(1, Math.min(sw, video.videoWidth - sx))
  sh = Math.max(1, Math.min(sh, video.videoHeight - sy))

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw)
  canvas.height = Math.round(sh)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get canvas context.')

  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL(mimeType, quality)
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return
  for (const t of stream.getTracks()) t.stop()
}
