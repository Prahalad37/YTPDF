import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'

let pdfWindow: BrowserWindow | null = null

function getHiddenWindow(): BrowserWindow {
  if (pdfWindow && !pdfWindow.isDestroyed()) {
    return pdfWindow
  }
  pdfWindow = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  return pdfWindow
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/** Renders HTML to PDF bytes using Chromium print (same engine as the app). */
export async function renderHtmlToPdf(html: string, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  const win = getHiddenWindow()
  const tmp = path.join(tmpdir(), `ytpdf-mcq-${randomUUID()}.html`)
  await writeFile(tmp, html, 'utf8')
  try {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    await yieldEventLoop()
    await win.loadFile(tmp)
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    await yieldEventLoop()
    const data = await win.webContents.printToPDF({
      printBackground: true,
      displayHeaderFooter: false,
      margins: { marginType: 'default' },
    })
    await yieldEventLoop()
    return data
  } finally {
    await unlink(tmp).catch(() => undefined)
  }
}
