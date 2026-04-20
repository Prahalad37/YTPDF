import type { McqQuestionsFile } from './mcqTypes.js'

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Minimal print-friendly HTML when DeepSeek is unavailable or fails. */
export function buildMcqPlainText(questions: McqQuestionsFile['questions']): string {
  const parts: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!
    const opts = q.options ?? {}
    parts.push(`Question ${i + 1}\n${q.stem}\n`)
    for (const k of Object.keys(opts).sort()) {
      parts.push(`  (${k}) ${opts[k]}\n`)
    }
    parts.push('\n')
  }
  return `${parts.join('').trim()}\n`
}

export function buildRawMcqHtmlFromQuestions(parsed: McqQuestionsFile): string {
  const questions = parsed.questions ?? []
  const rows = questions
    .map((q) => {
      const opts = q.options ?? {}
      const keys = Object.keys(opts).sort()
      const optLines = keys
        .map((k) => `<li><strong>${escapeHtml(k)}.</strong> ${escapeHtml(String(opts[k] ?? ''))}</li>`)
        .join('\n')
      return `<article class="q">
  <h2>${escapeHtml(q.id)}</h2>
  <p class="stem">${escapeHtml(q.stem)}</p>
  <ol class="opts">${optLines}</ol>
</article>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>MCQ practice (raw layout)</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #111; }
    h1 { font-size: 1.25rem; }
    article.q { page-break-inside: avoid; margin-bottom: 1.25rem; border-bottom: 1px solid #ddd; padding-bottom: 1rem; }
    article.q h2 { font-size: 1rem; margin: 0 0 0.5rem; }
    .stem { white-space: pre-wrap; line-height: 1.45; }
    ol.opts { margin: 0.5rem 0 0 1rem; padding: 0; list-style: none; }
    ol.opts li { margin: 0.25rem 0; }
  </style>
</head>
<body>
  <main>
    <h1>Multiple choice (OCR — unpolished)</h1>
    <p class="note">Generated without AI formatting. Text may contain OCR noise.</p>
    ${rows}
  </main>
</body>
</html>`
}

/** Print-friendly MCQ layout built locally after JSON correction (no LLM HTML). */
export function buildPolishedMcqHtmlFromQuestions(
  parsed: McqQuestionsFile,
  opts?: { subtitle?: string; bannerHtml?: string },
): string {
  const questions = parsed.questions ?? []
  const subtitle =
    opts?.subtitle ??
    'Formatted for print · OCR cleanup applied where needed · Framebase AI'
  const banner = opts?.bannerHtml ?? ''
  const rows = questions
    .map((q) => {
      const optsRec = q.options ?? {}
      const keys = Object.keys(optsRec).sort()
      const optLines = keys
        .map((k) => `<li><strong>${escapeHtml(k)}.</strong> ${escapeHtml(String(optsRec[k] ?? ''))}</li>`)
        .join('\n')
      return `<article class="q">
  <h2>${escapeHtml(q.id)}</h2>
  <p class="stem">${escapeHtml(q.stem)}</p>
  <ol class="opts">${optLines}</ol>
</article>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>MCQ practice</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 28px; color: #111; line-height: 1.45; }
    h1 { font-size: 1.35rem; margin-bottom: 0.35rem; }
    .sub { color: #444; font-size: 0.9rem; margin-bottom: 1.25rem; }
    .banner { background: #f4f7ff; border: 1px solid #dbe4ff; border-radius: 8px; padding: 10px 14px; margin-bottom: 1.25rem; font-size: 0.88rem; }
    article.q { page-break-inside: avoid; margin-bottom: 1.35rem; border-bottom: 1px solid #e5e5e5; padding-bottom: 1rem; }
    article.q h2 { font-size: 1rem; margin: 0 0 0.5rem; color: #1a1a1a; }
    .stem { white-space: pre-wrap; }
    ol.opts { margin: 0.5rem 0 0 1rem; padding: 0; list-style: none; }
    ol.opts li { margin: 0.3rem 0; }
  </style>
</head>
<body>
  <main>
    <h1>Multiple choice</h1>
    <p class="sub">${escapeHtml(subtitle)}</p>
    ${banner}
    ${rows}
  </main>
</body>
</html>`
}

export type AnswerKeyRow = { id: string; letter: string; rationale: string }

export function buildAnswerKeyHtmlFromRows(rows: AnswerKeyRow[]): string {
  const items = rows
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.id)}</strong> · <span class="letter">${escapeHtml(r.letter)}</span> — ${escapeHtml(r.rationale)}</li>`,
    )
    .join('\n')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Answer key</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 28px; color: #111; }
    h1 { font-size: 1.25rem; }
    .sub { color: #444; font-size: 0.9rem; }
    ol { line-height: 1.5; padding-left: 1.2rem; }
    .letter { font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Answer key</h1>
    <p class="sub">Verify against official keys when available.</p>
    <ol>${items}</ol>
  </main>
</body>
</html>`
}

export function buildNotesStudyHtml(sections: Array<{ title: string; html: string }>): string {
  const body = sections
    .map((s) => {
      const head = s.title.trim() ? `<h2>${escapeHtml(s.title.trim())}</h2>` : ''
      return `<div class="chunk">${head}${s.html}</div>`
    })
    .join('\n')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Study notes</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 28px; color: #111; line-height: 1.45; }
    h1 { font-size: 1.35rem; }
    .chunk { page-break-inside: avoid; margin-bottom: 1.5rem; }
    .chunk h2 { font-size: 1.05rem; margin: 1rem 0 0.5rem; }
  </style>
</head>
<body>
  <main>
    <h1>Study notes</h1>
    <p class="sub">Condensed from extracted MCQs · Framebase AI</p>
    ${body}
  </main>
</body>
</html>`
}

export function buildRevisionHtmlDocument(fragments: string[]): string {
  const inner = fragments.join('\n')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Revision sheet</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 28px; color: #111; line-height: 1.45; }
    h1 { font-size: 1.25rem; }
    section { page-break-inside: avoid; margin-bottom: 1.25rem; }
  </style>
</head>
<body>
  <main>
    <h1>Revision sheet</h1>
    <p class="sub">Quick recall from your question bank</p>
    ${inner}
  </main>
</body>
</html>`
}
