import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

const BLANK_STATS_SIZE = 48
const BLANK_LUMA_STDDEV_MAX = 9
const BLANK_DARK_LUMA_MEAN_MAX = 22
const BLANK_DARK_LUMA_STDDEV_MAX = 11
const DUPLICATE_HASH_MAX_DISTANCE = 10
const AHASH_SIZE = 8
const CHANGE_DETECTION_SIZE = 64
const DEFAULT_CHANGE_THRESHOLD = 0.15
const DEFAULT_COOLDOWN_SECONDS = 2

export type SmartFilterConfig = {
  changeThreshold?: number
  cooldownSeconds?: number
  frameIntervalSeconds?: number
}

type ImageLike = { width: number; height: number; data: Buffer }

function lumaAt(img: ImageLike, x: number, y: number): number {
  const idx = (y * img.width + x) * 4
  const r = img.data[idx] ?? 0
  const g = img.data[idx + 1] ?? 0
  const b = img.data[idx + 2] ?? 0
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function downsampleLumas(img: ImageLike, size: number): number[] {
  const values: number[] = []
  if (img.width <= 0 || img.height <= 0) return values

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / size))
      const sy = Math.min(img.height - 1, Math.floor((y * img.height) / size))
      values.push(lumaAt(img, sx, sy))
    }
  }
  return values
}

function meanStd(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  let varSum = 0
  for (const v of values) {
    const d = v - mean
    varSum += d * d
  }
  return { mean, stdDev: Math.sqrt(varSum / values.length) }
}

function isBlankImage(img: ImageLike): boolean {
  const lumas = downsampleLumas(img, BLANK_STATS_SIZE)
  const { mean, stdDev } = meanStd(lumas)
  if (stdDev <= BLANK_LUMA_STDDEV_MAX) return true
  if (mean <= BLANK_DARK_LUMA_MEAN_MAX && stdDev <= BLANK_DARK_LUMA_STDDEV_MAX) return true
  return false
}

function averageHash64(img: ImageLike): bigint {
  const lumas = downsampleLumas(img, AHASH_SIZE)
  if (lumas.length === 0) return 0n
  const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length
  let h = 0n
  for (const l of lumas) {
    h = (h << 1n) | (l >= mean ? 1n : 0n)
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

async function decodePng(filePath: string): Promise<ImageLike> {
  const bytes = await fs.readFile(filePath)
  const png = PNG.sync.read(bytes)
  return { width: png.width, height: png.height, data: png.data }
}

export type FilterResult = {
  keptFiles: string[]
  skippedBlank: number
  skippedDuplicate: number
}

export type SmartFrameDecision = {
  file: string
  seconds: number
  accepted: boolean
  blank: boolean
  duplicate: boolean
  changeRatio: number
  phash: string
}

export type SmartFilterResult = {
  kept: SmartFrameDecision[]
  skippedBlank: number
  skippedDuplicate: number
  skippedLowChange: number
}

function roiBounds(img: ImageLike): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = Math.max(0, Math.floor(img.width * 0.08))
  const x1 = Math.max(x0 + 1, Math.floor(img.width * 0.92))
  const y0 = Math.max(0, Math.floor(img.height * 0.12))
  const y1 = Math.max(y0 + 1, Math.floor(img.height * 0.88))
  return { x0, y0, x1, y1 }
}

function downsampleRoiLuma(img: ImageLike, size: number): number[] {
  const values: number[] = []
  const roi = roiBounds(img)
  const rw = Math.max(1, roi.x1 - roi.x0)
  const rh = Math.max(1, roi.y1 - roi.y0)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(img.width - 1, roi.x0 + Math.floor((x * rw) / size))
      const sy = Math.min(img.height - 1, roi.y0 + Math.floor((y * rh) / size))
      values.push(lumaAt(img, sx, sy))
    }
  }
  return values
}

function changeRatio(curr: number[], prev: number[]): number {
  const n = Math.min(curr.length, prev.length)
  if (n === 0) return 1
  let changed = 0
  for (let i = 0; i < n; i++) {
    const c = curr[i] ?? 0
    const p = prev[i] ?? 0
    if (Math.abs(c - p) >= 12) changed++
  }
  return changed / n
}

export function parseFrameSeconds(filePath: string, frameIntervalSeconds = 1): number {
  const base = path.basename(filePath)
  const m = base.match(/(\d+)\.png$/)
  if (!m?.[1]) return 0
  const idx = Number(m[1])
  if (!Number.isFinite(idx) || idx < 1) return 0
  const interval = Number.isFinite(frameIntervalSeconds) && frameIntervalSeconds > 0 ? frameIntervalSeconds : 1
  return (idx - 1) * interval
}

export async function filterFrameFiles(frameFiles: string[]): Promise<FilterResult> {
  const keptFiles: string[] = []
  let skippedBlank = 0
  let skippedDuplicate = 0
  let lastHash: bigint | null = null

  for (const file of frameFiles) {
    try {
      const img = await decodePng(file)
      if (isBlankImage(img)) {
        skippedBlank++
        continue
      }
      const hash = averageHash64(img)
      if (lastHash !== null && hamming64(hash, lastHash) <= DUPLICATE_HASH_MAX_DISTANCE) {
        skippedDuplicate++
        continue
      }
      keptFiles.push(file)
      lastHash = hash
    } catch {
      keptFiles.push(file)
      lastHash = null
    }
  }

  return { keptFiles, skippedBlank, skippedDuplicate }
}

export async function listFrameFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir)
  return names
    .filter((n) => n.endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(dir, name))
}

export async function filterFramesSmart(
  frameFiles: string[],
  config: SmartFilterConfig = {},
): Promise<SmartFilterResult> {
  const threshold = config.changeThreshold ?? DEFAULT_CHANGE_THRESHOLD
  const cooldownSeconds = config.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS
  const frameIntervalSeconds = config.frameIntervalSeconds ?? 1

  const kept: SmartFrameDecision[] = []
  let skippedBlank = 0
  let skippedDuplicate = 0
  let skippedLowChange = 0
  let lastHash: bigint | null = null
  let lastAcceptedRoi: number[] | null = null
  let lastAcceptedSec = -Infinity

  for (const file of frameFiles) {
    const sec = parseFrameSeconds(file, frameIntervalSeconds)
    try {
      const img = await decodePng(file)
      if (isBlankImage(img)) {
        skippedBlank++
        kept.push({
          file,
          seconds: sec,
          accepted: false,
          blank: true,
          duplicate: false,
          changeRatio: 0,
          phash: '',
        })
        continue
      }

      const hash = averageHash64(img)
      const phash = hash.toString(16).padStart(16, '0')
      const isDuplicate = lastHash !== null && hamming64(hash, lastHash) <= DUPLICATE_HASH_MAX_DISTANCE
      if (isDuplicate) {
        skippedDuplicate++
        kept.push({
          file,
          seconds: sec,
          accepted: false,
          blank: false,
          duplicate: true,
          changeRatio: 0,
          phash,
        })
        continue
      }

      const roi = downsampleRoiLuma(img, CHANGE_DETECTION_SIZE)
      const delta = lastAcceptedRoi ? changeRatio(roi, lastAcceptedRoi) : 1
      const inCooldown = sec - lastAcceptedSec < cooldownSeconds
      if (inCooldown || delta < threshold) {
        skippedLowChange++
        kept.push({
          file,
          seconds: sec,
          accepted: false,
          blank: false,
          duplicate: false,
          changeRatio: delta,
          phash,
        })
        continue
      }

      kept.push({
        file,
        seconds: sec,
        accepted: true,
        blank: false,
        duplicate: false,
        changeRatio: delta,
        phash,
      })
      lastHash = hash
      lastAcceptedRoi = roi
      lastAcceptedSec = sec
    } catch {
      kept.push({
        file,
        seconds: sec,
        accepted: true,
        blank: false,
        duplicate: false,
        changeRatio: 1,
        phash: '',
      })
      lastHash = null
      lastAcceptedRoi = null
      lastAcceptedSec = sec
    }
  }

  return { kept, skippedBlank, skippedDuplicate, skippedLowChange }
}

