import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

/**
 * Directory containing `mcq_worker/` (development: repo `python/`).
 * Packaged builds may ship the same tree under `resources/python/`.
 */
export function getPythonPackageRoot(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'python')
    if (existsSync(bundled)) {
      return bundled
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  // dist-electron/electron/python/this.js -> ../../../python
  return path.join(here, '..', '..', '..', 'python')
}

/**
 * Interpreter for the MCQ worker.
 * 1. `YTPDF_PYTHON` if set (absolute path).
 * 2. `python/.venv` if present (recommended on macOS Homebrew — avoids PEP 668).
 * 3. `python3` / `python` on PATH.
 */
export function getPythonExecutable(): string {
  const env = process.env.YTPDF_PYTHON?.trim()
  if (env && env.length > 0) {
    return env
  }
  const root = getPythonPackageRoot()
  const venvCandidates =
    process.platform === 'win32'
      ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
      : [path.join(root, '.venv', 'bin', 'python3'), path.join(root, '.venv', 'bin', 'python')]
  for (const p of venvCandidates) {
    if (existsSync(p)) {
      return p
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}
