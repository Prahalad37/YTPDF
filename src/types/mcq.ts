export type McqQuestionsFile = {
  version: number
  framesDir?: string
  questions: Array<{
    id: string
    stem: string
    options: Record<string, string>
    sourceFrames: string[]
    confidence: number
    topics?: string[]
  }>
}
