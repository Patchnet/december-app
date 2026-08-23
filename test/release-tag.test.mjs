import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertReleaseTag, checkReleaseTag } from '../scripts/check-release-tag.mjs'

test('release tags must exactly match the package version', () => {
  assert.equal(assertReleaseTag('v1.2.3', '1.2.3'), 'v1.2.3')
  assert.throws(() => assertReleaseTag('v1.2.4', '1.2.3'), /does not match/)
  assert.throws(() => assertReleaseTag('1.2.3', '1.2.3'), /does not match/)
  assert.throws(() => assertReleaseTag('', '1.2.3'), /missing/)
})

test('the release check reads the current package version', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const currentTag = `v${version}`
  const [major, minor, patch] = version.split('.').map(Number)
  const wrongTag = `v${major}.${minor}.${patch + 1}`

  assert.equal(checkReleaseTag({ tag: currentTag }), currentTag)
  assert.throws(
    () => checkReleaseTag({ tag: wrongTag }),
    (error) => error.message === `release tag ${wrongTag} does not match package version ${currentTag}`,
  )
})
