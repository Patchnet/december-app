import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PAIRING_CAPSULE_TTL_MS,
  createPairingCapsule,
  decryptPairingCapsule,
  parseManualCode,
} from '../lib/pocket-pairing-code.mjs'

const NOW = Date.parse('2026-08-22T18:00:00.000Z')
const BUNDLE = 'https://relay.example/#v=2&space=space_synthetic_1234&epoch=4&claim=claim_synthetic.secret_synthetic&key=c3ludGhldGljLWtleQ'

function deterministicBytes() {
  let seed = 1
  return (length) => Buffer.from(Array.from({ length }, () => seed++ & 255))
}

test('manual code encrypts and recovers the exact QR pairing bundle', () => {
  const capsule = createPairingCapsule({ pairingBundle: BUNDLE, now: NOW, randomBytesImpl: deterministicBytes() })
  assert.equal(decryptPairingCapsule({ manualCode: capsule.manualCode, capsule: capsule.relay, now: NOW }), BUNDLE)
  assert.equal(Date.parse(capsule.expiresAt) - NOW, PAIRING_CAPSULE_TTL_MS)
  assert.equal(parseManualCode(capsule.manualCode).selector, capsule.relay.selector)
})

test('selector and manual secret carry independent 128-bit random values', () => {
  const capsule = createPairingCapsule({ pairingBundle: BUNDLE, now: NOW, randomBytesImpl: deterministicBytes() })
  const parsed = parseManualCode(capsule.manualCode)
  assert.equal(parsed.selectorBytes.length, 16)
  assert.equal(parsed.secretBytes.length, 16)
  assert.notDeepEqual(parsed.selectorBytes, parsed.secretBytes)
})

test('relay capsule contains no manual secret, root key, or plaintext claim', () => {
  const capsule = createPairingCapsule({ pairingBundle: BUNDLE, now: NOW, randomBytesImpl: deterministicBytes() })
  const wire = JSON.stringify(capsule.relay)
  const fragment = new URLSearchParams(new URL(BUNDLE).hash.slice(1))
  assert.equal(wire.includes(capsule.manualCode), false)
  assert.equal(wire.includes(fragment.get('key')), false)
  assert.equal(wire.includes(fragment.get('claim')), false)
  assert.deepEqual(Object.keys(capsule.relay).sort(), ['ciphertext', 'selector'])
})

test('manual capsule expires after five minutes and refuses a longer lifetime', () => {
  const capsule = createPairingCapsule({ pairingBundle: BUNDLE, now: NOW, randomBytesImpl: deterministicBytes() })
  assert.throws(
    () => decryptPairingCapsule({ manualCode: capsule.manualCode, capsule: capsule.relay, now: NOW + PAIRING_CAPSULE_TTL_MS }),
    /expired/,
  )
  assert.throws(
    () => createPairingCapsule({
      pairingBundle: BUNDLE,
      now: NOW,
      expiresAt: new Date(NOW + PAIRING_CAPSULE_TTL_MS + 1).toISOString(),
      randomBytesImpl: deterministicBytes(),
    }),
    /within five minutes/,
  )
})

test('wrong manual secrets and modified capsule metadata do not decrypt', () => {
  const first = createPairingCapsule({ pairingBundle: BUNDLE, now: NOW, randomBytesImpl: deterministicBytes() })
  const [selectorPart, secretPart] = first.manualCode.split('.')
  const replacement = secretPart[0] === '0' ? '1' : '0'
  const wrongSecret = `${selectorPart}.${replacement}${secretPart.slice(1)}`
  assert.throws(
    () => decryptPairingCapsule({ manualCode: wrongSecret, capsule: first.relay, now: NOW }),
    /authenticate|bad decrypt|Unsupported state/i,
  )
  assert.throws(
    () => decryptPairingCapsule({
      manualCode: first.manualCode,
      capsule: {
        ...first.relay,
        ciphertext: Buffer.from(JSON.stringify({
          ...JSON.parse(Buffer.from(first.relay.ciphertext, 'base64url').toString('utf8')),
          expiresAt: new Date(NOW + 60_000).toISOString(),
        })).toString('base64url'),
      },
      now: NOW,
    }),
    /authenticate|bad decrypt|Unsupported state/i,
  )
})
