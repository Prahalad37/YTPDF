import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFrameSeconds } from './filters.js'

test('parseFrameSeconds scales frame indexes by extraction interval', () => {
  assert.equal(parseFrameSeconds('/tmp/frame_000001.png', 30), 0)
  assert.equal(parseFrameSeconds('/tmp/frame_000003.png', 30), 60)
  assert.equal(parseFrameSeconds('/tmp/frame_000005.png', 0.25), 1)
})

test('parseFrameSeconds falls back to one-second spacing for invalid intervals', () => {
  assert.equal(parseFrameSeconds('/tmp/frame_000003.png', 0), 2)
  assert.equal(parseFrameSeconds('/tmp/frame_000003.png', Number.NaN), 2)
})
