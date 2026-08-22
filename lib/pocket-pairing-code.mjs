import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export const PAIRING_CAPSULE_VERSION = 1
export const PAIRING_CAPSULE_TTL_MS = 5 * 60_000
export const PAIRING_CAPSULE_PATH = '/pairing-capsules'

const SELECTOR_BYTES = 16
const SECRET_BYTES = 16
const IV_BYTES = 12
const CODE_PREFIX = 'D2'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CAPSULE_INFO = Buffer.from('december.pocket.pairing-capsule.v1', 'utf8')

const encode64 = (value) => Buffer.from(value).toString('base64url')
const decode64 = (value) => Buffer.from(value, 'base64url')

function base32Encode(value) {
  let bits = 0
  let accumulator = 0
  let output = ''
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += ALPHABET[(accumulator >>> bits) & 31]
    }
  }
  if (bits > 0) output += ALPHABET[(accumulator << (5 - bits)) & 31]
  return output
}

function base32Decode(value) {
  let bits = 0
  let accumulator = 0
  const bytes = []
  for (const character of value.toUpperCase()) {
    const index = ALPHABET.indexOf(character)
    if (index < 0) throw new Error('invalid Pocket manual code')
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >>> bits) & 255)
    }
  }
  return Buffer.from(bytes)
}

const group = (value) => value.match(/.{1,4}/g).join('-')

function capsuleAad({ selector, expiresAt }) {
  return Buffer.from(JSON.stringify([
    'december.pocket.pairing-capsule',
    PAIRING_CAPSULE_VERSION,
    selector,
    expiresAt,
  ]), 'utf8')
}

function deriveCapsuleKey(selectorBytes, secretBytes) {
  return Buffer.from(hkdfSync('sha256', secretBytes, selectorBytes, CAPSULE_INFO, 32))
}

export function formatManualCode(selectorBytes, secretBytes) {
  if (selectorBytes.length !== SELECTOR_BYTES || secretBytes.length !== SECRET_BYTES) {
    throw new Error('Pocket manual code components have the wrong length')
  }
  return `${CODE_PREFIX}-${group(base32Encode(selectorBytes))}.${group(base32Encode(secretBytes))}`
}

export function parseManualCode(code) {
  const normalized = String(code || '').trim().toUpperCase()
  const [selectorPart, secretPart, extra] = normalized.split('.')
  if (extra != null || !selectorPart?.startsWith(`${CODE_PREFIX}-`) || !secretPart) {
    throw new Error('invalid Pocket manual code')
  }
  const selectorText = selectorPart.slice(CODE_PREFIX.length + 1).replaceAll('-', '')
  const secretText = secretPart.replaceAll('-', '')
  const selectorBytes = base32Decode(selectorText)
  const secretBytes = base32Decode(secretText)
  if (selectorBytes.length !== SELECTOR_BYTES || secretBytes.length !== SECRET_BYTES) {
    throw new Error('invalid Pocket manual code')
  }
  if (base32Encode(selectorBytes) !== selectorText || base32Encode(secretBytes) !== secretText) {
    throw new Error('invalid Pocket manual code')
  }
  return { selector: encode64(selectorBytes), selectorBytes, secretBytes }
}

export function encryptPairingBundle({ pairingBundle, selectorBytes, secretBytes, expiresAt, iv = randomBytes(IV_BYTES) }) {
  if (typeof pairingBundle !== 'string' || !pairingBundle) throw new Error('Pocket pairing bundle is required')
  if (selectorBytes.length !== SELECTOR_BYTES || secretBytes.length !== SECRET_BYTES || iv.length !== IV_BYTES) {
    throw new Error('Pocket pairing capsule has invalid key material')
  }
  const selector = encode64(selectorBytes)
  const cipher = createCipheriv('aes-256-gcm', deriveCapsuleKey(selectorBytes, secretBytes), iv)
  cipher.setAAD(capsuleAad({ selector, expiresAt }))
  const ciphertext = Buffer.concat([cipher.update(pairingBundle, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encode64(JSON.stringify({
    v: PAIRING_CAPSULE_VERSION,
    alg: 'A256GCM',
    kdf: 'HKDF-SHA256',
    expiresAt,
    iv: encode64(iv),
    ciphertext: encode64(ciphertext),
  }))
}

export function createPairingCapsule({ pairingBundle, now = Date.now(), expiresAt, randomBytesImpl = randomBytes } = {}) {
  const selectorBytes = randomBytesImpl(SELECTOR_BYTES)
  const secretBytes = randomBytesImpl(SECRET_BYTES)
  const expires = expiresAt == null ? now + PAIRING_CAPSULE_TTL_MS : Date.parse(expiresAt)
  if (!Number.isFinite(expires) || expires <= now || expires - now > PAIRING_CAPSULE_TTL_MS) {
    throw new Error('Pocket pairing capsule must expire within five minutes')
  }
  const normalizedExpiry = new Date(expires).toISOString()
  const selector = encode64(selectorBytes)
  const ciphertext = encryptPairingBundle({
    pairingBundle,
    selectorBytes,
    secretBytes,
    expiresAt: normalizedExpiry,
    iv: randomBytesImpl(IV_BYTES),
  })
  return {
    manualCode: formatManualCode(selectorBytes, secretBytes),
    expiresAt: normalizedExpiry,
    relay: {
      selector,
      ciphertext,
    },
  }
}

export function decryptPairingCapsule({ manualCode, capsule, now = Date.now() }) {
  const { selector, selectorBytes, secretBytes } = parseManualCode(manualCode)
  if (capsule?.selector !== selector) {
    throw new Error('Pocket pairing capsule does not match this code')
  }
  const envelope = JSON.parse(decode64(capsule.ciphertext).toString('utf8'))
  if (envelope?.v !== PAIRING_CAPSULE_VERSION || envelope?.alg !== 'A256GCM' || envelope?.kdf !== 'HKDF-SHA256') {
    throw new Error('unsupported Pocket pairing capsule')
  }
  const expiresAt = Date.parse(envelope.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Pocket manual code has expired')
  if (expiresAt - now > PAIRING_CAPSULE_TTL_MS) throw new Error('Pocket pairing capsule lasts longer than five minutes')
  const combined = decode64(envelope.ciphertext)
  if (combined.length < 17) throw new Error('invalid Pocket pairing capsule')
  const decipher = createDecipheriv('aes-256-gcm', deriveCapsuleKey(selectorBytes, secretBytes), decode64(envelope.iv))
  decipher.setAAD(capsuleAad({ selector, expiresAt: envelope.expiresAt }))
  decipher.setAuthTag(combined.subarray(-16))
  return Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString('utf8')
}
