// Settings validation — the gear only accepts known engines, and reads
// never mutate. (Persistence itself is exercised by the running app.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSettings, updateSettings, ENGINES } from '../lib/settings.mjs'

test('defaults: a known engine and a string model', () => {
  const s = getSettings()
  assert.ok(ENGINES[s.engine], `engine "${s.engine}" is known`)
  assert.equal(typeof s.model, 'string')
})

test('getSettings returns a copy, not the live object', () => {
  const a = getSettings()
  a.engine = 'tampered'
  a.enginePaths.claude = 'tampered'
  assert.notEqual(getSettings().engine, 'tampered')
  assert.notEqual(getSettings().enginePaths.claude, 'tampered')
})

test('unknown engine is rejected before anything persists', async () => {
  await assert.rejects(() => updateSettings({ engine: 'skynet' }), /unknown engine/)
})

test('both engines carry a label and a binary', () => {
  for (const [key, e] of Object.entries(ENGINES)) {
    assert.ok(e.label, `${key} has a label`)
    assert.ok(e.bin, `${key} has a bin`)
  }
})
