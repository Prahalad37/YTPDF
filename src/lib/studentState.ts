export type StudentStateV1 = {
  version: 1
  bookmarkedQuestionIds: string[]
  solvedQuestionIds: string[]
}

export const defaultStudentState = (): StudentStateV1 => ({
  version: 1,
  bookmarkedQuestionIds: [],
  solvedQuestionIds: [],
})

export function parseStudentState(raw: string | null | undefined): StudentStateV1 {
  if (!raw) return defaultStudentState()
  try {
    const j = JSON.parse(raw) as Partial<StudentStateV1>
    if (j.version !== 1) return defaultStudentState()
    return {
      version: 1,
      bookmarkedQuestionIds: Array.isArray(j.bookmarkedQuestionIds)
        ? j.bookmarkedQuestionIds.filter((x) => typeof x === 'string')
        : [],
      solvedQuestionIds: Array.isArray(j.solvedQuestionIds)
        ? j.solvedQuestionIds.filter((x) => typeof x === 'string')
        : [],
    }
  } catch {
    return defaultStudentState()
  }
}

export function serializeStudentState(s: StudentStateV1): string {
  return JSON.stringify(s)
}
