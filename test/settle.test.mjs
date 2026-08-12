import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSurfaceReply } from '../lib/settle.mjs'

test('surface reply parsing extracts a fenced array and validates items', () => {
  const raw = 'Here you go:\n```json\n[{"label":"Call Ana","reason":"waiting","space":"People","until":"2026-08-15"}]\n```\n'
  assert.deepEqual(parseSurfaceReply(raw), [{ label: 'Call Ana', reason: 'waiting', space: 'People', until: '2026-08-15' }])
  assert.deepEqual(parseSurfaceReply('normal answer: []'), [])
})

test('surface reply parsing rejects malformed item shapes and dates', () => {
  assert.throws(() => parseSurfaceReply('[{"label":12,"space":"People"}]'), /no valid surface list/)
  assert.throws(() => parseSurfaceReply('[{"label":"Call Ana","space":4}]'), /no valid surface list/)
  assert.throws(() => parseSurfaceReply('[{"label":"Call Ana","space":"People","until":"2026-02-30"}]'), /no valid surface list/)
})
