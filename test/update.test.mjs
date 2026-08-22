import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  configureUpdater,
  requestUpdateCheck,
  restartDialogOptions,
  shouldAnnounce,
  shouldCheckForUpdates,
  updateFailedDialogOptions,
  upToDateDialogOptions,
} from '../electron/update.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('only the packaged app checks for updates', () => {
  assert.equal(shouldCheckForUpdates({ packaged: true }), true)
  assert.equal(shouldCheckForUpdates({ packaged: false }), false)
})

test('launch stays quiet unless an update is already downloaded', () => {
  assert.equal(shouldAnnounce({ source: 'launch', kind: 'downloaded' }), true)
  assert.equal(shouldAnnounce({ source: 'launch', kind: 'not-available' }), false)
  assert.equal(shouldAnnounce({ source: 'launch', kind: 'error' }), false)
})

test('a manual check reports up to date or a failed lookup', () => {
  assert.equal(shouldAnnounce({ source: 'manual', kind: 'downloaded' }), true)
  assert.equal(shouldAnnounce({ source: 'manual', kind: 'not-available' }), true)
  assert.equal(shouldAnnounce({ source: 'manual', kind: 'error' }), true)
})

test('updater downloads in the background and never installs on quit', () => {
  const updater = {}
  configureUpdater(updater)
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowPrerelease, false)
})

test('an updater rejection is absorbed because the error event owns presentation', async () => {
  let checks = 0
  const result = await requestUpdateCheck({
    checkForUpdates() {
      checks += 1
      return Promise.reject(new Error('same failure emitted as an error event'))
    },
  })
  assert.equal(checks, 1)
  assert.equal(result, null)

  const main = readFileSync(join(root, 'electron', 'main.mjs'), 'utf8')
  assert.match(main, /requestUpdateCheck\(updater\)/)
  assert.match(main, /updater\.on\('error',[\s\S]*?updateFailedDialogOptions\(error\)/)
  assert.doesNotMatch(main, /checkForUpdates\(\)\.catch/)
})

test('restart dialog asks before replacing the running app', () => {
  const options = restartDialogOptions('0.15.0')
  assert.equal(options.message, 'December 0.15.0 is ready.')
  assert.deepEqual(options.buttons, ['Restart', 'Later'])
  assert.equal(options.defaultId, 0)
  assert.equal(options.cancelId, 1)
})

test('manual follow-up dialogs stay short', () => {
  assert.match(upToDateDialogOptions('0.14.0').message, /0\.14\.0/)
  assert.match(updateFailedDialogOptions(new Error('no latest.yml')).detail, /no latest\.yml/)
})
