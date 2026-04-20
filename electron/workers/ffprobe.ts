import { spawn } from 'node:child_process'
import path from 'node:path'

/** Resolve ffprobe next to ffmpeg (same directory). */
export function ffprobePathFromFfmpeg(ffmpegPath: string): string {
  const dir = path.dirname(ffmpegPath)
  const base = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  return path.join(dir, base)
}

/**
 * Returns duration in seconds, or null if unknown.
 */
export async function getVideoDurationSec(ffprobePath: string, videoPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ],
      { env: process.env },
    )
    let out = ''
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    child.once('error', () => resolve(null))
    child.once('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const n = Number(out.trim())
      if (!Number.isFinite(n) || n <= 0) resolve(null)
      else resolve(n)
    })
  })
}
