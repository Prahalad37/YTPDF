import type { ExtractionPreset } from '../types/electron-api'

export const EXTRACTION_PRESETS: {
  id: ExtractionPreset
  /** Short label for compact mode pickers */
  shortTitle: string
  title: string
  desc: string
  emoji: string
}[] = [
  {
    id: 'fast_notes',
    shortTitle: 'Fast',
    title: 'Fast Notes',
    desc: 'Fewer frames, quicker pass',
    emoji: '⚡',
  },
  {
    id: 'mcq_hunter',
    shortTitle: 'MCQ Hunter',
    title: 'MCQ Hunter',
    desc: 'Catch options & stems',
    emoji: '🎯',
  },
  {
    id: 'full_lecture',
    shortTitle: 'Notes',
    title: 'Full Lecture Notes',
    desc: 'Balanced slide coverage',
    emoji: '📚',
  },
  {
    id: 'exam_revision',
    shortTitle: 'Exam Revision',
    title: 'Exam Revision',
    desc: 'High-signal recap style',
    emoji: '🧠',
  },
]

export function presetDisplayName(id: ExtractionPreset | undefined): string {
  const p = EXTRACTION_PRESETS.find((x) => x.id === id)
  return p ? `${p.emoji} ${p.title}` : 'Full Lecture Notes'
}
