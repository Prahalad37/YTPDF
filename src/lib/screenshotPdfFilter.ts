/** Downscale dimension for luminance mean/stddev (blank detection). */
const BLANK_STATS_SIZE = 48

/**
 * If population std-dev of luminance is below this, the frame is treated as uniform / blank.
 * Scale 0–255 per luma sample.
 */
const BLANK_LUMA_STDDEV_MAX = 9

/** Near-black frames (seek glitch): low mean and low spread. */
const BLANK_DARK_LUMA_MEAN_MAX = 22
const BLANK_DARK_LUMA_STDDEV_MAX = 11

/**
 * aHash Hamming distance at or below this vs last exported frame → duplicate (skip).
 * Typical identical JPEG: 0–6; same slide with compression: often under 10.
 */
const DUPLICATE_HASH_MAX_DISTANCE = 10

const AHASH_SIZE = 8

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Image decode failed'))
    img.src = dataUrl
  })
}

function lumaStatsFromImageData(data: ImageData): { mean: number; stdDev: number } {
  const { data: d, width, height } = data
  const n = width * height
  if (n === 0) return { mean: 0, stdDev: 0 }

  let sum = 0
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    sum += L
  }
  const mean = sum / n

  let varSum = 0
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const diff = L - mean
    varSum += diff * diff
  }
  const stdDev = Math.sqrt(varSum / n)
  return { mean, stdDev }
}

function drawToCanvas(
  img: HTMLImageElement,
  w: number,
  h: number,
): { ctx: CanvasRenderingContext2D; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get canvas context.')
  ctx.drawImage(img, 0, 0, w, h)
  return { ctx, canvas }
}

function isBlankFrame(img: HTMLImageElement): boolean {
  const { ctx, canvas } = drawToCanvas(img, BLANK_STATS_SIZE, BLANK_STATS_SIZE)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { mean, stdDev } = lumaStatsFromImageData(data)

  if (stdDev <= BLANK_LUMA_STDDEV_MAX) return true
  if (mean <= BLANK_DARK_LUMA_MEAN_MAX && stdDev <= BLANK_DARK_LUMA_STDDEV_MAX) return true
  return false
}

/**
 * True if the JPEG/PNG data URL decodes to a near-uniform or very dark frame (e.g. DRM black capture).
 * On decode failure, returns false so captures are not dropped silently.
 */
export async function isBlankCaptureDataUrl(dataUrl: string): Promise<boolean> {
  try {
    const img = await loadImage(dataUrl)
    return isBlankFrame(img)
  } catch {
    return false
  }
}

function averageHash64(img: HTMLImageElement): bigint {
  const { ctx } = drawToCanvas(img, AHASH_SIZE, AHASH_SIZE)
  const data = ctx.getImageData(0, 0, AHASH_SIZE, AHASH_SIZE)
  const d = data.data
  const lumas: number[] = []
  for (let i = 0; i < d.length; i += 4) {
    lumas.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])
  }
  const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length
  let h = 0n
  for (let i = 0; i < lumas.length; i++) {
    h = (h << 1n) | (lumas[i] >= mean ? 1n : 0n)
  }
  return h
}

function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  for (let i = 0; i < 64; i++) {
    if (x & 1n) n++
    x >>= 1n
  }
  return n
}

export type FilterScreenshotsPdfResult<T> = {
  kept: T[]
  skippedBlank: number
  skippedDuplicate: number
}

/**
 * Drops near-uniform/blank frames and consecutive near-duplicate slides (average hash vs last kept).
 * On decode/analysis failure, the item is kept so export does not go empty unexpectedly.
 */
export async function filterScreenshotsForPdf<T extends { imageDataUrl: string }>(
  items: T[],
): Promise<FilterScreenshotsPdfResult<T>> {
  const kept: T[] = []
  let skippedBlank = 0
  let skippedDuplicate = 0
  let lastKeptHash: bigint | null = null

  for (const item of items) {
    let img: HTMLImageElement
    try {
      img = await loadImage(item.imageDataUrl)
    } catch {
      kept.push(item)
      lastKeptHash = null
      continue
    }

    try {
      if (isBlankFrame(img)) {
        skippedBlank++
        continue
      }

      const hash = averageHash64(img)
      if (
        lastKeptHash !== null &&
        hamming64(hash, lastKeptHash) <= DUPLICATE_HASH_MAX_DISTANCE
      ) {
        skippedDuplicate++
        continue
      }

      kept.push(item)
      lastKeptHash = hash
    } catch {
      kept.push(item)
      lastKeptHash = null
    }
  }

  return { kept, skippedBlank, skippedDuplicate }
}
