// Settings validation — the gear only accepts known engines, and reads
// never mutate. (Persistence itself is exercised by the running app.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getSettings, updateSettings, ENGINES, resolveEngineBinary } from '../lib/settings.mjs'

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

test('Windows engine discovery finds native executables on PATH', () => {
  const found = resolveEngineBinary('codex', {
    env: { Path: 'C:\\tools;D:\\agents' },
    platform: 'win32',
    home: 'C:\\Users\\demo',
    exists: (candidate) => candidate === 'D:\\agents\\codex.exe',
  })
  assert.equal(found, 'D:\\agents\\codex.exe')
})

test('Windows engine discovery retains the older Claude npm executable', () => {
  const legacy = 'C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
  const found = resolveEngineBinary('claude', {
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' },
    platform: 'win32',
    home: 'C:\\Users\\demo',
    exists: (candidate) => candidate === legacy,
  })
  assert.equal(found, legacy)
})

test('first-run copy separates organizing engines from assistant connections', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(html, /Choose an organizing engine/)
  assert.match(html, /Connect assistants/)
  assert.match(html, /This is separate from choosing the engine above/)
})
