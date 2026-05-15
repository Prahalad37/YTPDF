import assert from 'node:assert/strict'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { JobStore } from '../dist-electron/electron/jobs/store.js'

function makeJob(id, updatedAt) {
  return {
    id,
    request: { kind: 'local', filePath: `/videos/${id}.mp4` },
    createdAt: updatedAt,
    updatedAt,
    state: 'done',
    modePlanned: 'mode_a',
    modeUsed: 'mode_a',
    fallbackRequired: false,
    progress: { stage: 'done', message: 'Complete', percent: 100 },
    frames: [],
    skippedBlank: 0,
    skippedDuplicate: 0,
    logs: [],
  }
}

test('background cleanup preserves persisted jobs and artifacts', async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'ytpdf-job-store-'))
  const store = new JobStore(baseDir)

  try {
    await store.init()

    for (let i = 0; i < 21; i += 1) {
      const id = `job-${String(i).padStart(2, '0')}`
      await store.save(makeJob(id, new Date(2026, 0, i + 1).toISOString()))
    }

    await store.cleanupOldArtifacts(20)

    for (let i = 0; i < 21; i += 1) {
      const id = `job-${String(i).padStart(2, '0')}`
      assert.ok(await store.get(id), `${id} should remain in the database`)
      await stat(store.getJobDir(id))
    }
  } finally {
    store.db?.close()
    await rm(baseDir, { recursive: true, force: true })
  }
})
