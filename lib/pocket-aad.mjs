// Canonical additional-authenticated-data encoding for December Relay protocol 2.
//
// Keep this output byte-for-byte compatible with december-relay/public/aad.mjs.
// Shared golden vectors in both repositories make future drift fail CI.

const encoder = new TextEncoder()

export const AAD_LABEL = 'december-relay'
export const PROTOCOL_VERSION = 2
const PAYLOAD_TYPES = new Set(['page', 'capture'])

function fieldBytes(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`AAD field ${name} must be a non-empty string`)
  return encoder.encode(value)
}

function integerField(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`AAD field ${name} must be a positive integer`)
  return String(value)
}

export function canonicalAad({ spaceId, epoch, type, reference, deviceId }) {
  if (!PAYLOAD_TYPES.has(type)) throw new Error('AAD field type must be "page" or "capture"')
  const fields = [
    fieldBytes(AAD_LABEL, 'label'),
    fieldBytes(String(PROTOCOL_VERSION), 'protocolVersion'),
    fieldBytes(spaceId, 'spaceId'),
    fieldBytes(integerField(epoch, 'epoch'), 'epoch'),
    fieldBytes(type, 'type'),
    fieldBytes(reference, 'reference'),
    fieldBytes(deviceId, 'deviceId'),
  ]

  let size = 0
  const prefixes = fields.map((bytes) => {
    const prefix = encoder.encode(`${bytes.length}:`)
    size += prefix.length + bytes.length + 1
    return prefix
  })

  const out = new Uint8Array(size)
  let offset = 0
  for (let index = 0; index < fields.length; index += 1) {
    out.set(prefixes[index], offset)
    offset += prefixes[index].length
    out.set(fields[index], offset)
    offset += fields[index].length
    out[offset] = 0x7c
    offset += 1
  }
  return out
}

export function pageAad({ spaceId, epoch, revision, deviceId }) {
  return canonicalAad({ spaceId, epoch, type: 'page', reference: integerField(revision, 'revision'), deviceId })
}

export function captureAad({ spaceId, epoch, captureId, deviceId }) {
  return canonicalAad({ spaceId, epoch, type: 'capture', reference: captureId, deviceId })
}
