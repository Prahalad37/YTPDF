import './bootstrap-env.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { resolveMcqJsonPath } from './services/mcqSecondaryExports.js'
import { registerMcqIpc } from './ipc/registerMcqIpc.js'
import { JobStore } from './jobs/store.js'
import { PipelineManager } from './jobs/pipeline.js'
import type { AnalyzeLocalRequest, AnalyzeRequest } from './jobs/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

let mainWindow: BrowserWindow | null = null
const store = new JobStore(path.join(app.getPath('userData'), 'ytpdf-mode-a'))
const pipeline = new PipelineManager(store)

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: 'Framebase AI',
    width: 1380,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Match typical Electron+Vite dev setups; sandboxed preload can block contextBridge for http:// dev URLs.
      sandbox: false,
    },
  })

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('job:analyze', async (_event, req: AnalyzeRequest) => {
    return pipeline.analyze(req)
  })

  ipcMain.handle('job:analyzeLocal', async (_event, req: AnalyzeLocalRequest) => {
    return pipeline.analyzeLocal(req)
  })

  ipcMain.handle('fs:selectVideo', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts = {
      title: 'Choose video file',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [
        {
          name: 'Video',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mpeg', 'mpg'],
        },
      ],
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return { path: null as string | null }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('job:status', async (_event, jobId: string) => {
    return pipeline.getStatus(jobId)
  })

  ipcMain.handle('job:list', async (_event, limit?: number) => {
    return pipeline.listJobs(limit ?? 10)
  })

  ipcMain.handle('job:frames', async (_event, jobId: string) => {
    return pipeline.getFrames(jobId)
  })

  ipcMain.handle('job:framePreview', async (_event, jobId: string, frameName: string) => {
    return pipeline.getFramePreviewDataUrl(jobId, frameName)
  })

  ipcMain.handle('job:pdf', async (_event, jobId: string) => {
    const filePath = await pipeline.getPdfPath(jobId)
    return { filePath }
  })

  ipcMain.handle('job:cancel', async (_event, jobId: string) => {
    return pipeline.cancel(jobId)
  })

  ipcMain.handle('job:pause', async (_event, jobId: string) => {
    return pipeline.pause(jobId)
  })

  ipcMain.handle('job:resume', async (_event, jobId: string) => {
    return pipeline.resume(jobId)
  })

  ipcMain.handle('job:remove', async (_event, jobId: string) => {
    return pipeline.removeJob(jobId)
  })

  ipcMain.handle('job:updateTitle', async (_event, jobId: string, title: string) => {
    return pipeline.updateJobTitle(jobId, title)
  })

  ipcMain.handle('job:runFrameOcr', async (_event, jobId: string) => {
    return pipeline.runFrameOcr(jobId)
  })

  ipcMain.handle(
    'job:setFrameInclude',
    async (_event, jobId: string, frameName: string, include: boolean) => {
      return pipeline.setFrameIncludeInPdf(jobId, frameName, include)
    },
  )

  ipcMain.handle('job:rebuildPdf', async (_event, jobId: string) => {
    return pipeline.rebuildPdfFromIncludedFrames(jobId)
  })

  ipcMain.handle('fs:openPath', async (_event, p: string) => {
    if (!p) return { ok: false, message: 'Path is empty.' }
    const message = await shell.openPath(p)
    return { ok: message.length === 0, message }
  })

  ipcMain.handle('job:openJobFolder', async (_event, jobId: string) => {
    if (!jobId) return { ok: false as const, message: 'No job id.' }
    const job = await store.get(jobId)
    if (!job) return { ok: false as const, message: 'Job not found.' }
    const dir = store.getJobDir(job.id)
    const message = await shell.openPath(dir)
    return { ok: message.length === 0, message: message || undefined }
  })

  ipcMain.handle('job:mcqArtifacts', async (_event, jobId: string) => {
    const j = await store.get(jobId)
    if (!j) return null
    return {
      mcqJsonPath: j.mcqJsonPath,
      mcqTxtPath: j.mcqTxtPath,
      mcqPdfPath: j.mcqPdfPath,
      answerKeyPdfPath: j.answerKeyPdfPath,
      revisionSheetPath: j.revisionSheetPath,
      lastMcqCount: j.lastMcqCount,
    }
  })

  ipcMain.handle('job:getStudentState', async (_event, jobId: string) => {
    const j = await store.get(jobId)
    return j?.studentStateJson ?? null
  })

  ipcMain.handle(
    'job:readMcqJson',
    async (_event, jobId: string): Promise<{ ok: boolean; json?: string; message?: string }> => {
      const j = await store.get(jobId)
      if (!j) return { ok: false, message: 'Job not found.' }
      const p = await resolveMcqJsonPath(jobId, store, j)
      if (!p) return { ok: false, message: 'No MCQ JSON for this job yet.' }
      try {
        const raw = await readFile(p, 'utf8')
        return { ok: true, json: raw }
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Read failed.' }
      }
    },
  )

  ipcMain.handle(
    'job:setStudentState',
    async (_event, jobId: string, json: string): Promise<{ ok: boolean; message?: string }> => {
      try {
        JSON.parse(json)
      } catch {
        return { ok: false, message: 'Invalid JSON.' }
      }
      const updated = await store.patchStudentState(jobId, json)
      if (!updated) return { ok: false, message: 'Job not found.' }
      return { ok: true }
    },
  )

  ipcMain.handle('fs:saveCopy', async (_event, sourcePath: string, defaultName: string) => {
    if (!sourcePath) return { ok: false, message: 'Source path missing.' }
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      title: 'Save file',
    })
    if (result.canceled || !result.filePath) return { ok: false, message: 'Save canceled.' }
    const srcDir = path.dirname(sourcePath)
    const target = result.filePath
    if (srcDir === path.dirname(target) && path.basename(sourcePath) === path.basename(target)) {
      return { ok: true, message: '' }
    }
    const fs = await import('node:fs/promises')
    await fs.copyFile(sourcePath, target)
    return { ok: true, path: target }
  })

  registerMcqIpc({
    store,
    getTargetWindow: () => BrowserWindow.getFocusedWindow() ?? mainWindow,
  })
}

void app.whenReady().then(async () => {
  registerIpcHandlers()
  await pipeline.init()
  await createWindow()
  pipeline.setProgressBroadcaster((payload) => {
    mainWindow?.webContents.send('job:progress', payload)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

