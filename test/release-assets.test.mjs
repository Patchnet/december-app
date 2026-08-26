import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  assertLatestMetadata,
  expectedReleaseAssets,
  verifyReleaseAssets,
} from '../scripts/verify-release-assets.mjs'

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

const metadata = (version) => [
  `version: ${version}`,
  'files:',
  `  - url: December-Setup-${version}-x64.exe`,
  '    sha512: synthetic-file-hash',
  `path: December-Setup-${version}-x64.exe`,
  'sha512: synthetic-installer-hash',
  '',
].join('\n')

test('release verification requires the installer, blockmap, and updater metadata', () => {
  assert.deepEqual(expectedReleaseAssets('1.2.3'), [
    'December-Setup-1.2.3-x64.exe',
    'December-Setup-1.2.3-x64.exe.blockmap',
    'latest.yml',
  ])
  assert.deepEqual(assertLatestMetadata(metadata('1.2.3'), '1.2.3'), {
    version: '1.2.3',
    path: 'December-Setup-1.2.3-x64.exe',
  })
  assert.throws(() => assertLatestMetadata(metadata('1.2.4'), '1.2.3'), /does not match/)
  assert.throws(() => assertLatestMetadata('version: 1.2.3\n', '1.2.3'), /path/)
})

test('release verification retries an incomplete release and opens published latest.yml', async () => {
  const version = packageVersion
  const assets = expectedReleaseAssets(version)
  let releaseRequests = 0
  let waits = 0
  const fetchImpl = async (url) => {
    if (url === 'https://downloads.invalid/latest.yml') {
      return new Response(metadata(version), { status: 200 })
    }
    releaseRequests += 1
    const visible = releaseRequests === 1 ? assets.slice(0, 2) : assets
    return Response.json({
      assets: visible.map((name) => ({
        name,
        browser_download_url: name === 'latest.yml' ? 'https://downloads.invalid/latest.yml' : '',
      })),
    })
  }

  const result = await verifyReleaseAssets({
    tag: `v${version}`,
    repository: 'Patchnet/december-app',
    fetchImpl,
    attempts: 2,
    delayMs: 0,
    sleep: async () => { waits += 1 },
  })

  assert.equal(releaseRequests, 2)
  assert.equal(waits, 1)
  assert.equal(result.metadata.version, version)
})

test('release verification fails when updater metadata never becomes visible', async () => {
  const version = packageVersion
  const visible = expectedReleaseAssets(version).slice(0, 2)
  await assert.rejects(
    verifyReleaseAssets({
      tag: `v${version}`,
      repository: 'Patchnet/december-app',
      fetchImpl: async () => Response.json({ assets: visible.map((name) => ({ name })) }),
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
    }),
    /missing required assets: latest\.yml/,
  )
})
