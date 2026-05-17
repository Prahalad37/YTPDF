import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { JobStore } from '../../../dist-electron/electron/jobs/store.js'

const TERMINAL_STATE = 'done'
const ACTIVE_STATE = 'paused'

function jobRecord(id, state, updatedAt) {
  return {
    id,
    request: { kind: 'local', filePath: `/videos/${id}.mp4` },
    createdAt: updatedAt,
    updatedAt,
    state,
    modePlanned: 'mode_a',
    modeUsed: state === TERMINAL_STATE ? 'mode_a' : undefined,
    fallbackRequired: false,
    progress: { stage: state, message: state, percent: state === TERMINAL_STATE ? 100 : 50 },
    videoId: id,
    title: id,
    pdfPath: undefined,
    framesDir: undefined,
    frames: [],
    skippedBlank: 0,
    skippedDuplicate: 0,
    logs: [],
  }
}

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ytpdf-store-test-'))
  const store = new JobStore(dir)
  try {
    await store.init()
    await fn(store)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('cleanupOldArtifacts preserves historical jobs and job folders', async () => {
  await withStore(async (store) => {
    const oldDone = jobRecord('old-done', TERMINAL_STATE, '2026-01-01T00:00:00.000Z')
    const newerDone = jobRecord('newer-done', TERMINAL_STATE, '2026-01-02T00:00:00.000Z')
    const paused = jobRecord('paused-job', ACTIVE_STATE, '2026-01-03T00:00:00.000Z')

    await store.save(oldDone)
    await writeFile(path.join(store.getJobDir(oldDone.id), 'sentinel.txt'), 'keep', 'utf8')
    await store.save(newerDone)
    await store.save(paused)

    await store.cleanupOldArtifacts(1)

    assert.equal((await store.get(oldDone.id))?.id, oldDone.id)
    assert.equal((await store.get(newerDone.id))?.id, newerDone.id)
    assert.equal((await store.get(paused.id))?.id, paused.id)

    const listedIds = (await store.list(10)).map((job) => job.id).sort()
    assert.deepEqual(listedIds, ['newer-done', 'old-done', 'paused-job'])
  })
})

test('explicit cascade delete still removes a chosen job and its folder', async () => {
  await withStore(async (store) => {
    const record = jobRecord('delete-me', TERMINAL_STATE, '2026-01-01T00:00:00.000Z')

    await store.save(record)
    await writeFile(path.join(store.getJobDir(record.id), 'sentinel.txt'), 'delete', 'utf8')

    await store.deleteJobCascade(record.id)

    assert.equal(await store.get(record.id), null)
    await assert.rejects(
      writeFile(path.join(store.getJobDir(record.id), 'sentinel.txt'), 'gone', 'utf8'),
      { code: 'ENOENT' },
    )
  })
})
