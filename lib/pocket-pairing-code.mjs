import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export const PAIRING_CAPSULE_VERSION = 1
export const PAIRING_CAPSULE_PATH = '/pair/capsules'
export const PAIRING_CAPSULE_FETCH_PATH = '/pair/capsules/fetch'

const PROTOCOL_VERSION = 2
const SELECTOR_BYTES = 16
const SECRET_BYTES = 16
const NONCE_BYTES = 12
const TAG_BYTES = 16
const CODE_PREFIX = 'D2'
const ENCODED_COMPONENT_LENGTH = 26
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CAPSULE_INFO = Buffer.from('december-relay/2|manual-capsule|key|1', 'utf8')
const BUNDLE_FIELDS = ['v', 'protocolVersion', 'spaceId', 'claimId', 'claimSecret', 'rootKey']

const encode64 = (value) => Buffer.from(value).toString('base64url')

function decode64(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`invalid Pocket pairing capsule ${field}`)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (encode64(decoded) !== value) throw new Error(`invalid Pocket pairing capsule ${field}`)
  return decoded
}

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
  for (const character of value) {
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

function capsuleAad(selector) {
  return Buffer.from(`december-relay/2|manual-capsule|aad|1|${selector}`, 'utf8')
}

function deriveCapsuleKey(selector, secretBytes) {
  const salt = Buffer.from(`december-relay/2|manual-capsule|salt|${selector}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', secretBytes, salt, CAPSULE_INFO, 32))
}

function pairingPlaintext(pairingBundle) {
  if (!pairingBundle || typeof pairingBundle !== 'object' || Array.isArray(pairingBundle)) {
    throw new Error('Pocket pairing bundle is required')
  }
  const keys = Object.keys(pairingBundle)
  if (keys.length !== BUNDLE_FIELDS.length || BUNDLE_FIELDS.some((field) => !keys.includes(field))) {
    throw new Error('Pocket pairing bundle must contain exactly the protocol fields')
  }
  if (pairingBundle.v !== PAIRING_CAPSULE_VERSION || pairingBundle.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('unsupported Pocket pairing bundle')
  }
  for (const field of BUNDLE_FIELDS.slice(2)) {
    if (typeof pairingBundle[field] !== 'string' || !pairingBundle[field]) {
      throw new Error(`Pocket pairing bundle has an invalid ${field}`)
    }
  }
  return {
    v: pairingBundle.v,
    protocolVersion: pairingBundle.protocolVersion,
    spaceId: pairingBundle.spaceId,
    claimId: pairingBundle.claimId,
    claimSecret: pairingBundle.claimSecret,
    rootKey: pairingBundle.rootKey,
  }
}

export function formatManualCode(selectorBytes, secretBytes) {
  if (selectorBytes.length !== SELECTOR_BYTES || secretBytes.length !== SECRET_BYTES) {
    throw new Error('Pocket manual code components have the wrong length')
  }
  return `${CODE_PREFIX}${base32Encode(selectorBytes)}${base32Encode(secretBytes)}`
}

export function parseManualCode(code) {
  if (typeof code !== 'string') throw new Error('invalid Pocket manual code')
  // The Relay contract permits only ASCII spaces and hyphens as display
  // separators. Everything else, including Unicode lookalikes, is data.
  const normalized = code.replace(/[ -]/g, '').toUpperCase()
  const expectedLength = CODE_PREFIX.length + (ENCODED_COMPONENT_LENGTH * 2)
  if (normalized.length !== expectedLength || !normalized.startsWith(CODE_PREFIX)) {
    throw new Error('invalid Pocket manual code')
  }
  const selectorText = normalized.slice(CODE_PREFIX.length, CODE_PREFIX.length + ENCODED_COMPONENT_LENGTH)
  const secretText = normalized.slice(CODE_PREFIX.length + ENCODED_COMPONENT_LENGTH)
  const selectorBytes = base32Decode(selectorText)
  const secretBytes = base32Decode(secretText)
  if (selectorBytes.length !== SELECTOR_BYTES || secretBytes.length !== SECRET_BYTES) {
    throw new Error('invalid Pocket manual code')
  }
  // A 128-bit input leaves two zero pad bits in its 26th base32 character.
  // Round-tripping rejects alternate encodings with non-zero pad bits.
  if (base32Encode(selectorBytes) !== selectorText || base32Encode(secretBytes) !== secretText) {
    throw new Error('invalid Pocket manual code')
  }
  return { selector: encode64(selectorBytes), selectorBytes, secretBytes }
}

export function encryptPairingBundle({ pairingBundle, selectorBytes, secretBytes, nonce = randomBytes(NONCE_BYTES) }) {
  if (selectorBytes.length !== SELECTOR_BYTES || secretBytes.length !== SECRET_BYTES || nonce.length !== NONCE_BYTES) {
    throw new Error('Pocket pairing capsule has invalid key material')
  }
  const selector = encode64(selectorBytes)
  const cipher = createCipheriv('aes-256-gcm', deriveCapsuleKey(selector, secretBytes), nonce)
  cipher.setAAD(capsuleAad(selector))
  const plaintext = JSON.stringify(pairingPlaintext(pairingBundle))
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encode64(Buffer.concat([nonce, sealed]))
}

export function createPairingCapsule({ pairingBundle, randomBytesImpl = randomBytes } = {}) {
  const selectorBytes = randomBytesImpl(SELECTOR_BYTES)
  const secretBytes = randomBytesImpl(SECRET_BYTES)
  const selector = encode64(selectorBytes)
  const ciphertext = encryptPairingBundle({
    pairingBundle,
    selectorBytes,
    secretBytes,
    nonce: randomBytesImpl(NONCE_BYTES),
  })
  return {
    manualCode: formatManualCode(selectorBytes, secretBytes),
    relay: { selector, ciphertext },
  }
}

export function decryptPairingCapsule({ manualCode, capsule }) {
  const { selector, secretBytes } = parseManualCode(manualCode)
  if (capsule?.selector !== selector) {
    throw new Error('Pocket pairing capsule does not match this code')
  }
  const combined = decode64(capsule?.ciphertext, 'ciphertext')
  if (combined.length <= NONCE_BYTES + TAG_BYTES) throw new Error('invalid Pocket pairing capsule')
  const nonce = combined.subarray(0, NONCE_BYTES)
  const sealed = combined.subarray(NONCE_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', deriveCapsuleKey(selector, secretBytes), nonce)
  decipher.setAAD(capsuleAad(selector))
  decipher.setAuthTag(sealed.subarray(-TAG_BYTES))
  const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -TAG_BYTES)), decipher.final()]).toString('utf8')
  return pairingPlaintext(JSON.parse(plaintext))
}
