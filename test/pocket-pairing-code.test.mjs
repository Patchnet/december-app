import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  createPairingCapsule,
  decryptPairingCapsule,
  encryptPairingBundle,
  formatManualCode,
  parseManualCode,
} from '../lib/pocket-pairing-code.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixtures/pairing-capsule-v1.json', import.meta.url), 'utf8'))
const selectorBytes = Buffer.from(fixture.selectorBytesHex, 'hex')
const secretBytes = Buffer.from(fixture.manualSecretBytesHex, 'hex')
const nonce = Buffer.from(fixture.nonceBytesHex, 'hex')
const capsule = { selector: fixture.selector, ciphertext: fixture.expectedCiphertext }

test('synthetic Relay fixture encrypts byte-for-byte and decrypts exactly', () => {
  const ciphertext = encryptPairingBundle({ pairingBundle: fixture.plaintext, selectorBytes, secretBytes, nonce })
  assert.equal(ciphertext, fixture.expectedCiphertext)
  assert.deepEqual(decryptPairingCapsule({ manualCode: fixture.canonicalCode, capsule }), fixture.plaintext)
})

test('capsule creation matches the deterministic compatibility fixture', () => {
  const values = [selectorBytes, secretBytes, nonce]
  const created = createPairingCapsule({
    pairingBundle: fixture.plaintext,
    randomBytesImpl: (length) => {
      const value = values.shift()
      assert.equal(value.length, length)
      return value
    },
  })
  assert.equal(created.manualCode, fixture.canonicalCode)
  assert.deepEqual(created.relay, capsule)
})

test('manual code carries independent 128-bit selector and secret values', () => {
  const parsed = parseManualCode(fixture.canonicalCode)
  assert.equal(parsed.selector, fixture.selector)
  assert.deepEqual(parsed.selectorBytes, selectorBytes)
  assert.deepEqual(parsed.secretBytes, secretBytes)
  assert.notDeepEqual(parsed.selectorBytes, parsed.secretBytes)
  assert.equal(formatManualCode(selectorBytes, secretBytes), fixture.canonicalCode)
})

test('only ASCII spaces and hyphens are accepted as optional display separators', () => {
  const grouped = fixture.canonicalCode.match(/.{1,4}/g).join('- ')
  assert.equal(parseManualCode(grouped).selector, fixture.selector)
  assert.equal(parseManualCode(fixture.canonicalCode.toLowerCase()).selector, fixture.selector)

  for (const malformed of [
    fixture.canonicalCode.replace(/^D2/, 'D2.'),
    `${fixture.canonicalCode}\t`,
    `${fixture.canonicalCode}\u00a0`,
    fixture.canonicalCode.replace('D2', 'D2\u2011'),
  ]) {
    assert.throws(() => parseManualCode(malformed), /invalid Pocket manual code/)
  }
})

test('manual code rejects excluded letters, wrong lengths, and non-canonical pad bits', () => {
  for (const excluded of ['I', 'L', 'O', 'U']) {
    const malformed = `${fixture.canonicalCode.slice(0, 3)}${excluded}${fixture.canonicalCode.slice(4)}`
    assert.throws(() => parseManualCode(malformed), /invalid Pocket manual code/)
  }
  assert.throws(() => parseManualCode(fixture.canonicalCode.slice(0, -1)), /invalid Pocket manual code/)
  assert.throws(() => parseManualCode(`${fixture.canonicalCode}0`), /invalid Pocket manual code/)

  // The selector's final W has canonical zero pad bits. X decodes to the same
  // 128 data bits but carries non-zero pad bits and must be refused.
  const nonCanonical = `${fixture.canonicalCode.slice(0, 27)}X${fixture.canonicalCode.slice(28)}`
  assert.throws(() => parseManualCode(nonCanonical), /invalid Pocket manual code/)
})

test('relay capsule contains no manual secret, root key, or plaintext claim', () => {
  const wire = JSON.stringify(capsule)
  assert.equal(wire.includes(fixture.canonicalCode), false)
  assert.equal(wire.includes(secretBytes.toString('base64url')), false)
  assert.equal(wire.includes(fixture.manualSecretBytesHex), false)
  assert.equal(wire.includes(fixture.plaintext.rootKey), false)
  assert.equal(wire.includes(fixture.plaintext.claimSecret), false)
  assert.deepEqual(Object.keys(capsule).sort(), ['ciphertext', 'selector'])
})

test('wrong secrets, modified ciphertext, and extra plaintext fields are refused', () => {
  const secretStart = 2 + 26
  const replacement = fixture.canonicalCode[secretStart] === '0' ? '1' : '0'
  const wrongSecret = `${fixture.canonicalCode.slice(0, secretStart)}${replacement}${fixture.canonicalCode.slice(secretStart + 1)}`
  assert.throws(
    () => decryptPairingCapsule({ manualCode: wrongSecret, capsule }),
    /authenticate|bad decrypt|Unsupported state/i,
  )

  const replacementCiphertext = fixture.expectedCiphertext[20] === 'A' ? 'B' : 'A'
  const modified = `${fixture.expectedCiphertext.slice(0, 20)}${replacementCiphertext}${fixture.expectedCiphertext.slice(21)}`
  assert.throws(
    () => decryptPairingCapsule({ manualCode: fixture.canonicalCode, capsule: { ...capsule, ciphertext: modified } }),
    /authenticate|bad decrypt|Unsupported state/i,
  )
  assert.throws(
    () => encryptPairingBundle({
      pairingBundle: { ...fixture.plaintext, expiresAt: '2099-01-01T00:00:00.000Z' },
      selectorBytes,
      secretBytes,
      nonce,
    }),
    /exactly the protocol fields/,
  )
})
