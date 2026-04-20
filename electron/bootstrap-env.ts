/**
 * Side-effect only: must be imported before other app modules so spawn/PATH lookups see tool dirs.
 * GUI Electron often inherits a minimal PATH (no Homebrew, Chocolatey, Scoop shims).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

const FFMPEG_ENV = 'YTPDF_FFMPEG_PATH'

const sep = path.delimiter
const cur = process.env.PATH ?? ''
const extra: string[] = []

if (process.platform === 'darwin') {
  extra.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
} else if (process.platform === 'linux') {
  extra.push('/usr/local/bin', '/usr/bin', '/bin')
} else if (process.platform === 'win32') {
  extra.push('C:\\ProgramData\\chocolatey\\bin')
  extra.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin'))
  if (process.env.USERPROFILE) {
    extra.push(path.join(process.env.USERPROFILE, 'scoop', 'shims'))
  }
  if (process.env.LOCALAPPDATA) {
    extra.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'))
  }
}

if (extra.length > 0) {
  process.env.PATH = [...extra, cur].filter(Boolean).join(sep)
}

/** If env was not passed through npm/Electron, still use Homebrew-style paths when the file exists. */
if (!process.env[FFMPEG_ENV]?.trim()) {
  const candidates: string[] =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
      : process.platform === 'linux'
        ? ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']
        : process.platform === 'win32'
          ? ['C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe']
          : []
  for (const p of candidates) {
    if (existsSync(p)) {
      process.env[FFMPEG_ENV] = p
      break
    }
  }
}
