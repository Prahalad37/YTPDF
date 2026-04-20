import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Run Tesseract CLI: reads a PNG (or image) path, returns UTF-8 text. */
export async function runTesseract(
  imagePath: string,
  tesseractPath: string,
  lang = 'eng',
): Promise<{ text: string; meanConfidence: number | null }> {
  const TESSERACT_TIMEOUT_MS = 120_000
  const code = lang.trim() || 'eng'

  const { stdout, stderr } = await execFileAsync(
    tesseractPath,
    [imagePath, 'stdout', '-l', code, '--psm', '6'],
    {
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      timeout: TESSERACT_TIMEOUT_MS,
    },
  )
  const out = typeof stdout === 'string' ? stdout : String(stdout)
  const errStr = typeof stderr === 'string' ? stderr : String(stderr ?? '')
  const text = out.trim()
  const m = errStr.match(/Mean confidence:\s*([\d.]+)/i)
  const c = m?.[1] ? parseFloat(m[1]) : Number.NaN
  return { text, meanConfidence: Number.isFinite(c) ? c : null }
}
