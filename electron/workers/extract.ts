import { spawn } from 'node:child_process'
import path from 'node:path'
import type { JobLogEntry, JobStage } from '../jobs/types.js'

export type ExtractOptions = {
  ffmpegPath: string
  videoPath: string
  outDir: string
  fpsIntervalSeconds: number
  stage: JobStage
  onLog: (entry: JobLogEntry) => Promise<void>
  /** Called with decoded timestamp (seconds) from ffmpeg stderr while encoding. */
  onProgress?: (decodedSeconds: number) => void
  signal: AbortSignal
}

function logLine(stage: JobStage, level: JobLogEntry['level'], message: string): JobLogEntry {
  return {
    ts: new Date().toISOString(),
    level,
    stage,
    message,
  }
}

/** libavcodec often prints these on stderr; they are not failures and clutter the job log. */
function isIgnorableFfmpegStderrLine(line: string): boolean {
  const s = line.trim()
  if (!s) return true
  if (s.includes('Late SEI is not implemented')) return true
  if (s.includes('If you want to help, upload a sample of this file')) return true
  if (/^\[h264\s+@/i.test(s)) return true
  if (/^\[warn\]\s*\[h264/i.test(s)) return true
  if (/is not implemented/i.test(s) && /ffmpeg|git/i.test(s.toLowerCase())) return true
  if (s.includes('Update your FFmpeg version to the newest one from Git')) return true
  if (/^\[out#0\/image2/i.test(s)) return true
  if (s.includes('muxing overhead: unknown')) return true
  return false
}

/** Parse ffmpeg stderr chunk for `time=HH:MM:SS.mm` */
export function parseFfmpegTimeSeconds(chunk: string): number | null {
  const m = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/)
  if (!m?.[1] || !m[2] || m[3] == null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = Number(m[3])
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(s)) return null
  return h * 3600 + min * 60 + s
}

export async function extractFrames(opts: ExtractOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const vf = `scale='min(1920,iw)':-2,fps=1/${opts.fpsIntervalSeconds}`
    const child = spawn(
      opts.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'info',
        '-threads',
        '0',
        '-i',
        opts.videoPath,
        '-vf',
        vf,
        path.join(opts.outDir, 'frame_%06d.png'),
      ],
      {
        env: process.env,
      },
    )

    const onAbort = () => {
      child.kill('SIGTERM')
      reject(new Error('cancelled'))
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    let errBuf = ''
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      errBuf += text
      const t = parseFfmpegTimeSeconds(text)
      if (t != null && opts.onProgress) {
        opts.onProgress(t)
      }
      const lines = text.split('\n').filter((l) => l.trim())
      for (const line of lines) {
        if (line.includes('time=') || line.includes('frame=')) continue
        const trimmed = line.trim()
        if (isIgnorableFfmpegStderrLine(trimmed)) continue
        void opts.onLog(logLine(opts.stage, 'warn', trimmed))
      }
    })
    child.stdout.on('data', (buf: Buffer) => {
      void opts.onLog(logLine(opts.stage, 'info', buf.toString('utf8').trim()))
    })
    child.once('error', (e) => {
      opts.signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.once('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with ${code ?? -1}: ${errBuf.slice(-400)}`))
    })
  })
}
