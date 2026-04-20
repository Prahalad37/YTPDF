import { spawn } from 'node:child_process'
import type { JobLogEntry, JobStage } from '../jobs/types.js'

export type DownloadOptions = {
  ytDlpPath: string
  url: string
  outputPattern: string
  cwd: string
  stage: JobStage
  onLog: (entry: JobLogEntry) => Promise<void>
  signal: AbortSignal
}

export type ProbeOptions = {
  ytDlpPath: string
  url: string
  cwd: string
  stage: JobStage
  onLog: (entry: JobLogEntry) => Promise<void>
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

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  stage: JobStage,
  onLog: (entry: JobLogEntry) => Promise<void>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env })
    let out = ''
    let err = ''

    const onAbort = () => {
      child.kill('SIGTERM')
      reject(new Error('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      out += text
      void onLog(logLine(stage, 'info', text.trim()))
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8')
      err += text
      void onLog(logLine(stage, 'warn', text.trim()))
    })
    child.once('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (code === 0) resolve(out)
      else reject(new Error(`${cmd} exited with ${code ?? -1}: ${err || out}`))
    })
  })
}

export async function probeUrl(opts: ProbeOptions): Promise<string> {
  return runCommand(
    opts.ytDlpPath,
    ['--dump-single-json', '--no-playlist', opts.url],
    opts.cwd,
    opts.stage,
    opts.onLog,
    opts.signal,
  )
}

export async function downloadVideo(opts: DownloadOptions): Promise<void> {
  await runCommand(
    opts.ytDlpPath,
    [
      '--no-playlist',
      '-f',
      'bv*[height<=720]+ba/b[height<=720]/b',
      '--merge-output-format',
      'mp4',
      '-o',
      opts.outputPattern,
      opts.url,
    ],
    opts.cwd,
    opts.stage,
    opts.onLog,
    opts.signal,
  )
}
