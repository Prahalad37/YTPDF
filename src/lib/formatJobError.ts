import type { ErrorCode, JobRecord } from '../types/electron-api'

export type FriendlyJobError = {
  title: string
  detail: string
  hint?: string
}

export function formatJobError(job: JobRecord | null): FriendlyJobError | null {
  if (!job?.error) return null
  const { code, message } = job.error
  const m = message.toLowerCase()

  if (m.includes('worker exited') || m.includes('exited with code')) {
    return {
      title: 'A helper process stopped unexpectedly.',
      detail: 'The OCR or video helper exited early — often a memory or path issue.',
      hint: 'The app will try one automatic retry. If it persists, check Advanced → Logs or reinstall dependencies.',
    }
  }
  if (m.includes('tesseract') || m.includes('ocr engine')) {
    return {
      title: 'Text recognition (OCR) could not run.',
      detail: message,
      hint: 'Confirm Tesseract is installed and paths are valid. Try again after restarting the app.',
    }
  }
  if (m.includes('paddle') || m.includes('python')) {
    return {
      title: 'The MCQ OCR engine did not start.',
      detail: message,
      hint: 'Try “Generate MCQ from analyzed text” after running Analyze text, or check Python worker setup.',
    }
  }
  if (code === 'binary_missing') {
    return {
      title: 'A required tool is missing.',
      detail: message,
      hint: 'Install ffmpeg / yt-dlp per the README, then restart Framebase AI.',
    }
  }
  if (code === 'path_permission') {
    return {
      title: 'Could not read the file or folder.',
      detail: message,
      hint: 'Check file permissions and that the video still exists at the same path.',
    }
  }
  if (code === 'network') {
    return {
      title: 'Network problem.',
      detail: message,
      hint: 'Check your connection. DeepSeek features need internet when enabled.',
    }
  }

  const codeHint: Partial<Record<ErrorCode, string>> = {
    protected_content: 'This source may be protected or live-only.',
    validation: 'Check the file or URL and try again.',
    unknown: 'See Advanced → Logs for technical detail.',
  }

  return {
    title: 'Something went wrong.',
    detail: message,
    hint: codeHint[code],
  }
}
