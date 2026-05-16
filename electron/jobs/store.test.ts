import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JobStore } from './store.js'
import type { JobRecord, JobState } from './types.js'

function makeJob(id: string, state: JobState, updatedAt: string): JobRecord {
  return {
    id,
    request: { kind: 'remote', url: `https://example.com/${id}`, intervalSec: 5 },
    createdAt: updatedAt,
    updatedAt,
    state,
    modePlanned: 'mode_a',
    fallbackRequired: false,
    progress: { stage: state, message: state, percent: 0 },
    frames: [],
    skippedBlank: 0,
    skippedDuplicate: 0,
    logs: [],
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

test('cleanupOldArtifacts prunes old terminal jobs without deleting active jobs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytpdf-store-'))
  const store = new JobStore(dir)

  try {
    await store.init()
    await store.save(makeJob('newest-done', 'done', '2026-01-01T00:03:00.000Z'))
    await store.save(makeJob('old-done', 'done', '2026-01-01T00:02:00.000Z'))
    await store.save(makeJob('old-active', 'extracting', '2026-01-01T00:01:00.000Z'))

    await store.cleanupOldArtifacts(1)

    assert.notEqual(await store.get('newest-done'), null)
    assert.equal(await store.get('old-done'), null)
    assert.notEqual(await store.get('old-active'), null)
    assert.equal(await pathExists(store.getJobDir('old-done')), false)
    assert.equal(await pathExists(store.getJobDir('old-active')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
