import assert from 'node:assert/strict'
import test from 'node:test'
import { versionArgsForBinary } from './binaries.js'

test('uses binary-specific version arguments', () => {
  assert.deepEqual(versionArgsForBinary('yt-dlp'), ['--version'])
  assert.deepEqual(versionArgsForBinary('ffmpeg'), ['-hide_banner', '-version'])
})
