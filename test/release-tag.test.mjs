import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertReleaseTag, checkReleaseTag } from '../scripts/check-release-tag.mjs'

test('release tags must exactly match the package version', () => {
  assert.equal(assertReleaseTag('v0.15.0', '0.15.0'), 'v0.15.0')
  assert.throws(() => assertReleaseTag('v0.15.1', '0.15.0'), /does not match/)
  assert.throws(() => assertReleaseTag('0.15.0', '0.15.0'), /does not match/)
  assert.throws(() => assertReleaseTag('', '0.15.0'), /missing/)
})

test('the release check reads the current package version', () => {
  assert.equal(checkReleaseTag({ tag: 'v0.14.0' }), 'v0.14.0')
  assert.throws(() => checkReleaseTag({ tag: 'v99.0.0' }), /v99\.0\.0 does not match package version v0\.14\.0/)
})
