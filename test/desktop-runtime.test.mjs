import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { resolveDataDir } from '../lib/core.mjs'
import { resolveEngineBinary } from '../lib/settings.mjs'
import { DESKTOP_FALLBACK_PORT, DESKTOP_PORT, selectDesktopPort } from '../electron/runtime.mjs'

test('data directory defaults to the repository data folder', () => {
  const root = resolve('example-root')
  assert.equal(resolveDataDir(root, {}), join(root, 'data'))
})

test('DECEMBER_DATA_DIR overrides and normalizes the data folder', () => {
  assert.equal(resolveDataDir('ignored', { DECEMBER_DATA_DIR: '.tmp-december' }), resolve('.tmp-december'))
})

test('desktop keeps its fixed loopback port when available', () => {
  assert.equal(selectDesktopPort([DESKTOP_PORT, DESKTOP_FALLBACK_PORT]), DESKTOP_PORT)
})

test('desktop uses one conservative fallback rather than fighting a dev server', () => {
  assert.equal(selectDesktopPort([DESKTOP_FALLBACK_PORT]), DESKTOP_FALLBACK_PORT)
})

test('desktop gives a clear error when both owned ports are occupied', () => {
  assert.throws(() => selectDesktopPort([]), /already in use/)
})

test('engine environment override wins without probing PATH', () => {
  assert.equal(
    resolveEngineBinary('claude', { env: { DECEMBER_CLAUDE: 'C:\\tools\\claude.exe' }, platform: 'win32' }),
    'C:\\tools\\claude.exe'
  )
})

test('GUI launches resolve common macOS binary locations', () => {
  const found = resolveEngineBinary('codex', {
    env: {},
    platform: 'darwin',
    home: '/Users/example',
    exists: (candidate) => candidate === '/opt/homebrew/bin/codex',
  })
  assert.equal(found, '/opt/homebrew/bin/codex')
})
