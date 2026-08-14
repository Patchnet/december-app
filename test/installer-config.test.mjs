import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { build } = pkg
const { nsis } = build

test('Windows package uses the assisted NSIS wizard with a per-user default', () => {
  assert.equal(nsis.oneClick, false)
  assert.equal(nsis.perMachine, false)
  assert.equal(nsis.selectPerMachineByDefault, false)
  assert.equal(nsis.allowElevation, true)
  assert.equal(nsis.allowToChangeInstallationDirectory, true)
})

test('assisted wizard creates standard December shortcuts', () => {
  assert.equal(nsis.createDesktopShortcut, true)
  assert.equal(nsis.createStartMenuShortcut, true)
  assert.equal(nsis.shortcutName, 'December')
})

test('assisted wizard keeps standard finish and uninstall behavior', () => {
  assert.equal(nsis.runAfterFinish, true)
  assert.equal(nsis.removeDefaultUninstallWelcomePage, false)
  assert.equal(nsis.uninstallDisplayName, 'December')
})

test('installer has no custom hook for provider authentication', () => {
  assert.equal(nsis.script, undefined)
  assert.equal(nsis.include, undefined)
  assert.deepEqual(
    readdirSync(join(root, 'build')).filter((name) => /\.nsi$|\.nsh$/i.test(name)),
    []
  )
})

test('installer and uninstaller use the existing December icon', () => {
  assert.equal(nsis.installerIcon, 'build/icon.ico')
  assert.equal(nsis.uninstallerIcon, 'build/icon.ico')
  assert.equal(build.win.icon, 'build/icon.ico')
  assert.ok(existsSync(join(root, 'build', 'icon.ico')))
})

test('installer keeps the stable artifact name, package contents, and zero runtime dependencies', () => {
  assert.equal(build.win.artifactName, '${productName}-Setup-${version}-${arch}.${ext}')
  assert.deepEqual(build.files, [
    'electron/**/*',
    'lib/**/*',
    'public/**/*',
    'server.mjs',
    'mcp-server.mjs',
    'package.json',
  ])
  assert.deepEqual(pkg.dependencies ?? {}, {})
})
