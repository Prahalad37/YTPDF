import { contextBridge, ipcRenderer } from 'electron'
import type {
  AnalyzeLocalRequest,
  AnalyzeLocalResponse,
  AnalyzeRequest,
  AnalyzeResponse,
  FrameArtifact,
  JobRecord,
  JobState,
  JobProgress,
} from './jobs/types.js'
import type { McqAiMode, McqGenerateResult, McqProgressPayload } from './services/mcqTypes.js'

const api = {
  analyzeJob(input: AnalyzeRequest): Promise<AnalyzeResponse> {
    return ipcRenderer.invoke('job:analyze', input)
  },
  analyzeLocalFile(input: AnalyzeLocalRequest): Promise<AnalyzeLocalResponse> {
    return ipcRenderer.invoke('job:analyzeLocal', input)
  },
  selectVideoFile(): Promise<{ path: string | null }> {
    return ipcRenderer.invoke('fs:selectVideo')
  },
  onJobProgress(
    callback: (payload: { jobId: string; state: JobState; progress: JobProgress }) => void,
  ): () => void {
    const handler = (
      _event: unknown,
      payload: { jobId: string; state: JobState; progress: JobProgress },
    ): void => {
      callback(payload)
    }
    ipcRenderer.on('job:progress', handler)
    return () => {
      ipcRenderer.removeListener('job:progress', handler)
    }
  },
  getJobStatus(jobId: string): Promise<JobRecord | null> {
    return ipcRenderer.invoke('job:status', jobId)
  },
  listJobs(limit?: number): Promise<JobRecord[]> {
    return ipcRenderer.invoke('job:list', limit)
  },
  getJobFrames(jobId: string): Promise<FrameArtifact[]> {
    return ipcRenderer.invoke('job:frames', jobId)
  },
  getFramePreview(
    jobId: string,
    frameName: string,
  ): Promise<{ dataUrl: string | null; message?: string }> {
    return ipcRenderer.invoke('job:framePreview', jobId, frameName)
  },
  getJobPdf(jobId: string): Promise<{ filePath: string | null }> {
    return ipcRenderer.invoke('job:pdf', jobId)
  },
  openJobFolder(jobId: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:openJobFolder', jobId)
  },
  getJobMcqArtifacts(jobId: string): Promise<{
    mcqJsonPath?: string
    mcqTxtPath?: string
    mcqPdfPath?: string
    answerKeyPdfPath?: string
    revisionSheetPath?: string
    lastMcqCount?: number
  } | null> {
    return ipcRenderer.invoke('job:mcqArtifacts', jobId)
  },
  getStudentState(jobId: string): Promise<string | null> {
    return ipcRenderer.invoke('job:getStudentState', jobId)
  },
  setStudentState(jobId: string, json: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:setStudentState', jobId, json)
  },
  readMcqJson(jobId: string): Promise<{ ok: boolean; json?: string; message?: string }> {
    return ipcRenderer.invoke('job:readMcqJson', jobId)
  },
  cancelJob(jobId: string): Promise<boolean> {
    return ipcRenderer.invoke('job:cancel', jobId)
  },
  pauseJob(jobId: string): Promise<boolean> {
    return ipcRenderer.invoke('job:pause', jobId)
  },
  resumeJob(jobId: string): Promise<boolean> {
    return ipcRenderer.invoke('job:resume', jobId)
  },
  removeJob(jobId: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:remove', jobId)
  },
  updateJobTitle(jobId: string, title: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:updateTitle', jobId, title)
  },
  runFrameOcr(jobId: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:runFrameOcr', jobId)
  },
  setFrameIncludeInPdf(
    jobId: string,
    frameName: string,
    include: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:setFrameInclude', jobId, frameName, include)
  },
  rebuildPdf(jobId: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('job:rebuildPdf', jobId)
  },
  openPath(targetPath: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke('fs:openPath', targetPath)
  },
  saveCopy(
    sourcePath: string,
    defaultName: string,
  ): Promise<{ ok: boolean; path?: string; message?: string }> {
    return ipcRenderer.invoke('fs:saveCopy', sourcePath, defaultName)
  },
  generateMcqPdf(jobId: string, mode?: McqAiMode): Promise<McqGenerateResult> {
    return ipcRenderer.invoke('mcq:generate', jobId, mode)
  },
  generateMcqPdfFromAnalyzedText(jobId: string, mode?: McqAiMode): Promise<McqGenerateResult> {
    return ipcRenderer.invoke('mcq:generateFromAnalyzedText', jobId, mode)
  },
  generateMcqAnswerKey(
    jobId: string,
  ): Promise<{ ok: boolean; filePath?: string; message?: string }> {
    return ipcRenderer.invoke('mcq:answerKey', jobId)
  },
  generateRevisionSheet(
    jobId: string,
  ): Promise<{ ok: boolean; filePath?: string; message?: string }> {
    return ipcRenderer.invoke('mcq:revisionSheet', jobId)
  },
  generateShuffledMcqPractice(
    jobId: string,
  ): Promise<{ ok: boolean; filePath?: string; message?: string }> {
    return ipcRenderer.invoke('mcq:shufflePractice', jobId)
  },
  tagMcqTopics(jobId: string): Promise<{ ok: boolean; filePath?: string; message?: string }> {
    return ipcRenderer.invoke('mcq:tagTopics', jobId)
  },
  generateWeakTopicMcqPdf(
    jobId: string,
    topic: string,
  ): Promise<{ ok: boolean; filePath?: string; message?: string }> {
    return ipcRenderer.invoke('mcq:weakTopicPdf', jobId, topic)
  },
  cancelMcqPdf(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('mcq:cancel')
  },
  cancelMcqSecondary(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('mcq:cancelSecondary')
  },
  onMcqProgress(callback: (payload: McqProgressPayload) => void): () => void {
    const handler = (_event: unknown, payload: McqProgressPayload): void => {
      callback(payload)
    }
    ipcRenderer.on('mcq:progress', handler)
    return () => {
      ipcRenderer.removeListener('mcq:progress', handler)
    }
  },
}

contextBridge.exposeInMainWorld('electronApi', api)
