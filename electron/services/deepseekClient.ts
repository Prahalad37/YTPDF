import {
  PROMPT_ANSWER_KEY_JSON,
  PROMPT_MCQ_FORMAT_HTML,
  PROMPT_MCQ_OCR_CORRECT_JSON,
  PROMPT_NOTES_SECTION_JSON,
  PROMPT_REVISION_FRAGMENT_JSON,
  PROMPT_TOPIC_TAGS_JSON,
} from './deepseekPrompts.js'
import type { McqQuestionsFile } from './mcqTypes.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-chat'
const MAX_RETRIES = 4
const DEEPSEEK_REQUEST_TIMEOUT_MS = (() => {
  const n = Number(process.env.YTPDF_DEEPSEEK_TIMEOUT_MS)
  if (Number.isFinite(n) && n >= 15_000) return n
  return 120_000
})()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function unwrapHtmlBlock(s: string): string {
  const fenced = s.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  return s.trim()
}

function unwrapJsonBlock(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  return s.trim()
}

type ChatMessage = { role: 'system' | 'user'; content: string }

async function deepseekChatContent(opts: {
  apiKey: string
  signal: AbortSignal
  messages: ChatMessage[]
  temperature: number
}): Promise<string> {
  let lastErr: Error = new Error('DeepSeek request failed')

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (opts.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      const attemptSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(DEEPSEEK_REQUEST_TIMEOUT_MS)])
      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: opts.messages,
          temperature: opts.temperature,
        }),
        signal: attemptSignal,
      })

      if (res.status === 429 || res.status >= 500) {
        await sleep(2 ** attempt * 500)
        continue
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 600)}`)
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content
      if (!content || content.trim().length === 0) {
        throw new Error('Empty response from DeepSeek')
      }
      return content.trim()
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (opts.signal.aborted) {
        throw lastErr
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(2 ** attempt * 400)
      }
    }
  }

  throw lastErr
}

async function deepseekHtmlDocument(opts: {
  apiKey: string
  signal: AbortSignal
  system: string
  user: string
}): Promise<string> {
  const content = await deepseekChatContent({
    apiKey: opts.apiKey,
    signal: opts.signal,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    temperature: 0.2,
  })
  const html = unwrapHtmlBlock(content)
  if (!html.toLowerCase().includes('<html')) {
    throw new Error('Model did not return a valid HTML document')
  }
  return html
}

async function deepseekJsonRaw(opts: {
  apiKey: string
  signal: AbortSignal
  system: string
  user: string
  temperature: number
}): Promise<string> {
  const content = await deepseekChatContent({
    apiKey: opts.apiKey,
    signal: opts.signal,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    temperature: opts.temperature,
  })
  return unwrapJsonBlock(content)
}

type McqQ = McqQuestionsFile['questions'][number]

function asRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(o)) {
    if (typeof val === 'string') out[k] = val
    else if (val != null) out[k] = String(val)
  }
  return out
}

/** One API call: OCR-correct a batch of questions; returns parallel array or throws. */
export async function deepseekCorrectMcqBatchJson(opts: {
  apiKey: string
  signal: AbortSignal
  batch: McqQ[]
}): Promise<Array<{ id: string; stem: string; options: Record<string, string> }>> {
  const payload = opts.batch.map((q) => ({
    id: q.id,
    stem: q.stem,
    options: q.options ?? {},
  }))
  const user = `${PROMPT_MCQ_OCR_CORRECT_JSON.userPrefix}${JSON.stringify(payload)}`
  const raw = await deepseekJsonRaw({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system: PROMPT_MCQ_OCR_CORRECT_JSON.system,
    user,
    temperature: 0.15,
  })
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('MCQ correction model returned non-array JSON')
  }
  if (parsed.length !== opts.batch.length) {
    throw new Error(`MCQ correction length mismatch: got ${parsed.length}, expected ${opts.batch.length}`)
  }
  const out: Array<{ id: string; stem: string; options: Record<string, string> }> = []
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i]
    const src = opts.batch[i]!
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Invalid MCQ correction row')
    }
    const obj = row as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : src.id
    const stem = typeof obj.stem === 'string' ? obj.stem : src.stem
    const options = asRecord(obj.options) ?? src.options ?? {}
    out.push({ id, stem, options })
  }
  return out
}

export async function deepseekAnswerKeyBatchJson(opts: {
  apiKey: string
  signal: AbortSignal
  batch: McqQ[]
}): Promise<Array<{ id: string; letter: string; rationale: string }>> {
  const payload = opts.batch.map((q) => ({
    id: q.id,
    stem: q.stem,
    options: q.options ?? {},
  }))
  const user = `Questions:\n${JSON.stringify(payload)}`
  const raw = await deepseekJsonRaw({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system: PROMPT_ANSWER_KEY_JSON.system,
    user,
    temperature: 0.2,
  })
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('Answer key model returned non-array JSON')
  }
  if (parsed.length !== opts.batch.length) {
    throw new Error(`Answer key length mismatch: got ${parsed.length}, expected ${opts.batch.length}`)
  }
  const rows: Array<{ id: string; letter: string; rationale: string }> = []
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i]
    const src = opts.batch[i]!
    if (!row || typeof row !== 'object') {
      throw new Error('Invalid answer key row')
    }
    const obj = row as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : src.id
    const letter = String(obj.letter ?? '?').trim().toUpperCase().slice(0, 1)
    const rationale =
      typeof obj.rationale === 'string' ? obj.rationale : '—'
    rows.push({ id, letter, rationale })
  }
  return rows
}

export async function deepseekTopicTagBatchJson(opts: {
  apiKey: string
  signal: AbortSignal
  batch: McqQ[]
}): Promise<Array<{ id: string; topics: string[] }>> {
  const payload = opts.batch.map((q) => ({
    id: q.id,
    stem: q.stem,
    options: q.options ?? {},
  }))
  const user = `Tag these:\n${JSON.stringify(payload)}`
  const raw = await deepseekJsonRaw({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system: PROMPT_TOPIC_TAGS_JSON.system,
    user,
    temperature: 0.15,
  })
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('Topic tag model returned non-array JSON')
  }
  if (parsed.length !== opts.batch.length) {
    throw new Error(`Topic tag length mismatch: got ${parsed.length}, expected ${opts.batch.length}`)
  }
  const out: Array<{ id: string; topics: string[] }> = []
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i]
    const src = opts.batch[i]!
    if (!row || typeof row !== 'object') {
      throw new Error('Invalid topic row')
    }
    const obj = row as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : src.id
    let topics: string[] = []
    if (Array.isArray(obj.topics)) {
      topics = obj.topics.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
    }
    if (topics.length > 3) topics = topics.slice(0, 3)
    out.push({ id, topics })
  }
  return out
}

export async function deepseekNotesSectionJson(opts: {
  apiKey: string
  signal: AbortSignal
  batch: McqQ[]
}): Promise<{ title: string; html: string }> {
  const payload = opts.batch.map((q) => ({
    id: q.id,
    stem: q.stem,
    options: q.options ?? {},
  }))
  const user = `Summarize into one section:\n${JSON.stringify(payload)}`
  const raw = await deepseekJsonRaw({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system: PROMPT_NOTES_SECTION_JSON.system,
    user,
    temperature: 0.35,
  })
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const title = typeof parsed.title === 'string' ? parsed.title : 'Notes'
  const html = typeof parsed.html === 'string' ? parsed.html : '<section><p>(empty)</p></section>'
  return { title, html }
}

export async function deepseekRevisionFragmentJson(opts: {
  apiKey: string
  signal: AbortSignal
  batch: McqQ[]
}): Promise<string> {
  const payload = opts.batch.map((q) => ({
    id: q.id,
    stem: q.stem,
    options: q.options ?? {},
  }))
  const user = `Revision fragment for:\n${JSON.stringify(payload)}`
  const raw = await deepseekJsonRaw({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system: PROMPT_REVISION_FRAGMENT_JSON.system,
    user,
    temperature: 0.3,
  })
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const html = typeof parsed.html === 'string' ? parsed.html : ''
  if (!html.trim()) {
    throw new Error('Empty revision fragment')
  }
  return html
}

export async function deepseekPolishMcqHtml(opts: {
  apiKey: string
  questionsJson: string
  signal: AbortSignal
}): Promise<string> {
  const user = [
    PROMPT_MCQ_FORMAT_HTML.userIntro,
    '',
    opts.questionsJson,
    '',
    'Return only the full HTML document.',
  ].join('\n')

  return deepseekHtmlDocument({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system: PROMPT_MCQ_FORMAT_HTML.system,
    user,
  })
}

export async function deepseekAnswerKeyHtml(opts: {
  apiKey: string
  questionsJson: string
  signal: AbortSignal
}): Promise<string> {
  const system = [
    'You create a clean answer-key document for educators.',
    'Output exactly one complete HTML5 document with print styles.',
    'For each question in the JSON, infer the most likely correct option (A–D) from the stem and options; if uncertain, mark "Best guess: X (verify)".',
    'Use numbered list: question id, correct letter, one-line rationale.',
    'Do not include markdown fences or text outside the HTML document.',
  ].join(' ')

  const user = ['Questions JSON:', '', opts.questionsJson, '', 'Return only the HTML document.'].join('\n')

  return deepseekHtmlDocument({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system,
    user,
  })
}

export async function deepseekRevisionSheetHtml(opts: {
  apiKey: string
  questionsJson: string
  signal: AbortSignal
}): Promise<string> {
  const system = [
    'You create a dense revision sheet for students.',
    'Output exactly one complete HTML5 document with print styles and clear h2 sections.',
    'Group content by topic tags you infer from the questions.',
    'Use bullet lists of key facts, traps, and formulas — no full exam reproduction.',
    'Do not include markdown fences or text outside the HTML document.',
  ].join(' ')

  const user = ['Questions JSON:', '', opts.questionsJson, '', 'Return only the HTML document.'].join('\n')

  return deepseekHtmlDocument({
    apiKey: opts.apiKey,
    signal: opts.signal,
    system,
    user,
  })
}

export async function deepseekAnnotateMcqTopics(opts: {
  apiKey: string
  questionsJson: string
  signal: AbortSignal
}): Promise<string> {
  const system = [
    'You label educational MCQs with short topic tags for filtering.',
    'Output ONLY valid JSON (no markdown fences): same schema as input with each question object gaining a "topics" array of 1-3 short strings (e.g. ["Optics","NEET"]).',
    'Preserve all existing fields: id, stem, options, sourceFrames, confidence.',
  ].join(' ')

  let lastErr: Error = new Error('DeepSeek request failed')

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (opts.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      const attemptSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(DEEPSEEK_REQUEST_TIMEOUT_MS)])
      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `Annotate topics for this JSON. Return JSON only.\n\n${opts.questionsJson}`,
            },
          ],
          temperature: 0.15,
        }),
        signal: attemptSignal,
      })

      if (res.status === 429 || res.status >= 500) {
        await sleep(2 ** attempt * 500)
        continue
      }

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 600)}`)
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content
      if (!content || content.trim().length === 0) {
        throw new Error('Empty response from DeepSeek')
      }
      const raw = unwrapJsonBlock(content)
      JSON.parse(raw)
      return raw
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (opts.signal.aborted) {
        throw lastErr
      }
      if (attempt < MAX_RETRIES - 1) {
        await sleep(2 ** attempt * 400)
      }
    }
  }

  throw lastErr
}
