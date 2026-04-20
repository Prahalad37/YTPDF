import { access } from 'node:fs/promises'
import path from 'node:path'
import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export type BinaryHealth = {
  name: 'yt-dlp' | 'ffmpeg'
  path: string
  ok: boolean
  message: string
}

export type RuntimeBinaries = {
  ytDlpPath: string
  ffmpegPath: string
}

const YT_DLP_ENV = 'YTPDF_YT_DLP_PATH'
const FFMPEG_ENV = 'YTPDF_FFMPEG_PATH'
const TESSERACT_ENV = 'YTPDF_TESSERACT_PATH'

/** Typical install paths when GUI Electron gets a minimal PATH (e.g. no Homebrew on PATH). */
function wellKnownBinaryPaths(binary: 'yt-dlp' | 'ffmpeg'): string[] {
  if (process.platform === 'darwin') {
    const standard = [`/opt/homebrew/bin/${binary}`, `/usr/local/bin/${binary}`]
    if (binary === 'ffmpeg') {
      return [
        '/opt/homebrew/opt/ffmpeg/bin/ffmpeg',
        '/usr/local/opt/ffmpeg/bin/ffmpeg',
        ...standard,
      ]
    }
    return standard
  }
  if (process.platform === 'linux') {
    return [`/usr/bin/${binary}`, `/usr/local/bin/${binary}`]
  }
  return []
}

/** Resolve binary using the current PATH (after bootstrap-env). */
function pathFromShellLookup(command: 'ffmpeg' | 'yt-dlp' | 'tesseract'): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where.exe', [command], {
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
      }).trim()
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      return line ?? null
    }
    const out = execFileSync('/usr/bin/which', [command], {
      encoding: 'utf8',
      env: process.env,
    })
      .trim()
      .split('\n')[0]
      ?.trim()
    return out || null
  } catch {
    return null
  }
}

function candidatePaths(binary: 'yt-dlp' | 'ffmpeg'): string[] {
  const out: string[] = []
  const rawEnv = process.env[binary === 'yt-dlp' ? YT_DLP_ENV : FFMPEG_ENV]
  const envPath = typeof rawEnv === 'string' ? rawEnv.trim() : ''
  if (envPath) out.push(envPath)
  const fromPath = pathFromShellLookup(binary)
  if (fromPath) out.push(fromPath.trim())
  out.push(...wellKnownBinaryPaths(binary))
  out.push(binary)
  const bundled = path.join(process.cwd(), 'bin', process.platform, binary)
  out.push(bundled)
  if (process.platform === 'win32') out.push(`${bundled}.exe`)
  return [...new Set(out)]
}

async function isExecutable(cmd: string): Promise<boolean> {
  if (cmd.includes(path.sep)) {
    try {
      await access(cmd)
      return true
    } catch {
      return false
    }
  }
  return true
}

/** Prefer execFile over spawn — more reliable for absolute paths to CLI tools on macOS/Linux. */
async function binaryRunsVersion(cmd: string): Promise<boolean> {
  try {
    await execFile(cmd, ['-hide_banner', '-version'], {
      env: process.env,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

async function resolveOne(name: 'yt-dlp' | 'ffmpeg'): Promise<BinaryHealth> {
  const envKey = name === 'yt-dlp' ? YT_DLP_ENV : FFMPEG_ENV
  const envOverride = typeof process.env[envKey] === 'string' ? process.env[envKey]!.trim() : ''

  const candidates = candidatePaths(name)
  for (const c of candidates) {
    if (!(await isExecutable(c))) continue
    if (await binaryRunsVersion(c)) {
      return {
        name,
        path: c,
        ok: true,
        message: `${name} ready`,
      }
    }
  }

  if (name === 'ffmpeg' && envOverride) {
    return {
      name,
      path: envOverride,
      ok: false,
      message: `ffmpeg at "${envOverride}" did not run. Open Terminal and run: "${envOverride}" -version`,
    }
  }

  return {
    name,
    path: candidates[0] ?? name,
    ok: false,
    message: `${name} not found. Install binary or set env ${name === 'yt-dlp' ? YT_DLP_ENV : FFMPEG_ENV}.`,
  }
}

/** User-facing hint when a binary cannot be resolved (platform-specific install commands). */
export function ffmpegInstallHint(): string {
  const env = FFMPEG_ENV
  switch (process.platform) {
    case 'darwin':
      return `ffmpeg not found. Install with Homebrew (brew install ffmpeg) or set ${env} to the full path of the ffmpeg executable.`
    case 'win32':
      return `ffmpeg not found. Install (e.g. winget install ffmpeg, or choco install ffmpeg) or set ${env} to ffmpeg.exe.`
    case 'linux':
      return `ffmpeg not found. Install with your package manager (e.g. sudo apt install ffmpeg) or set ${env}.`
    default:
      return `ffmpeg not found. Install ffmpeg or set ${env}.`
  }
}

export async function resolveRuntimeBinaries(): Promise<{
  binaries: RuntimeBinaries | null
  health: BinaryHealth[]
}> {
  const yt = await resolveOne('yt-dlp')
  const ff = await resolveOne('ffmpeg')
  if (!yt.ok || !ff.ok) {
    return { binaries: null, health: [yt, ff] }
  }
  return {
    binaries: {
      ytDlpPath: yt.path,
      ffmpegPath: ff.path,
    },
    health: [yt, ff],
  }
}

/** Local-file pipeline only needs ffmpeg (no yt-dlp). */
export async function resolveFfmpegOnly(): Promise<{
  ffmpegPath: string | null
  health: BinaryHealth[]
}> {
  const ff = await resolveOne('ffmpeg')
  if (!ff.ok) return { ffmpegPath: null, health: [ff] }
  return { ffmpegPath: ff.path, health: [ff] }
}

function tesseractCandidatePaths(): string[] {
  const out: string[] = []
  const env = typeof process.env[TESSERACT_ENV] === 'string' ? process.env[TESSERACT_ENV]!.trim() : ''
  if (env) out.push(env)
  const fromWhich = pathFromShellLookup('tesseract')
  if (fromWhich) out.push(fromWhich)
  if (process.platform === 'darwin') {
    out.push('/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract')
  } else if (process.platform === 'linux') {
    out.push('/usr/bin/tesseract', '/usr/local/bin/tesseract')
  }
  out.push('tesseract')
  return [...new Set(out)]
}

async function tesseractRunsVersion(cmd: string): Promise<boolean> {
  try {
    await execFile(cmd, ['--version'], {
      env: process.env,
      timeout: 15_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

/** OCR for frame analysis; optional install (brew install tesseract). */
export async function resolveTesseractPath(): Promise<{ path: string | null; message: string }> {
  for (const c of tesseractCandidatePaths()) {
    if (!(await isExecutable(c))) continue
    if (await tesseractRunsVersion(c)) {
      return { path: c, message: 'tesseract ready' }
    }
  }
  return {
    path: null,
    message: `tesseract not found. Install (e.g. brew install tesseract on macOS) or set ${TESSERACT_ENV} to the executable path.`,
  }
}
