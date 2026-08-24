import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { captureAad, pageAad } from './pocket-aad.mjs'
import { PAIRING_CAPSULE_PATH, createPairingCapsule } from './pocket-pairing-code.mjs'

// The on-disk shape. Version 1 kept the relay credentials and the content
// key as plain fields; version 2 keeps them inside a sealed envelope and
// carries the key epoch beside the space.
const CONFIG_VERSION = 2
const LEGACY_CONFIG_VERSION = 1
// The envelope the phone and this computer share. Nothing older is read:
// a version 1 envelope arriving today is a downgrade, not a leftover.
const PROTOCOL_VERSION = 2
const DEFAULT_RELAY_URL = 'https://app.getdecember.me'
// A pairing code is a five-minute claim. The relay's claim endpoint enforces
// single use; the response must not invent a client-side boolean for it.
const CLAIM_TTL_MS = 5 * 60_000
const CLAIM_SKEW_MS = 30_000
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/
const SECRET_AAD = Buffer.from('december.pocket.secrets.v2')
const HKDF_SALT_PREFIX = 'december-relay/2|salt|'
const HKDF_INFO_PREFIX = 'december-relay/2|key|'

const encode = (value) => Buffer.from(value).toString('base64url')
const decode = (value) => Buffer.from(value, 'base64url')

function assertToken(value, field) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error(`Pocket relay returned an invalid ${field}`)
  return value
}

function validateRelayUrl(value) {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Pocket relay must use HTTPS')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

// One root key per epoch, and never the root key on the wire. Pages and
// captures get separate derived keys so a flaw in one direction cannot
// read the other, and both are bound to the space and the epoch they
// belong to.
function deriveKey(rootKey, { spaceId, epoch, purpose }) {
  if (purpose !== 'page' && purpose !== 'capture') throw new Error('Unsupported key purpose')
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Key epoch must be a positive integer')
  if (typeof spaceId !== 'string' || !spaceId) throw new Error('Key derivation requires a space ID')
  const salt = Buffer.from(`${HKDF_SALT_PREFIX}${spaceId}`, 'utf8')
  const info = Buffer.from(`${HKDF_INFO_PREFIX}${purpose}|${epoch}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', rootKey, salt, info, 32))
}

// The associated data is the part of the message that must be true but is
// not secret. Binding it means a page cannot be replayed as a capture, into
// another space, or under another epoch or revision.
function associatedData({ spaceId, epoch, purpose, sequence, deviceId }) {
  if (purpose === 'page') {
    return Buffer.from(pageAad({ spaceId, epoch, revision: Number(sequence), deviceId }))
  }
  if (purpose === 'capture') {
    return Buffer.from(captureAad({ spaceId, epoch, captureId: String(sequence), deviceId }))
  }
  throw new Error('Unsupported key purpose')
}

function encrypt(rootKey, context, value) {
  const { epoch } = context
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootKey, context), iv)
  cipher.setAAD(associatedData(context))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encode(JSON.stringify({
    v: PROTOCOL_VERSION,
    p: PROTOCOL_VERSION,
    alg: 'A256GCM',
    kdf: 'HKDF-SHA-256',
    epoch,
    iv: encode(iv),
    ciphertext: encode(ciphertext),
  }))
}

function decrypt(rootKey, payload, context) {
  const envelope = JSON.parse(decode(payload).toString('utf8'))
  if (envelope?.v !== PROTOCOL_VERSION) throw new Error(`unsupported Pocket payload version ${envelope?.v}`)
  if (envelope?.p !== PROTOCOL_VERSION || envelope?.alg !== 'A256GCM' || envelope?.kdf !== 'HKDF-SHA-256') throw new Error('unsupported Pocket payload')
  // Rollback rejection. An epoch below the one this computer accepts is a
  // replay of a key the phone was told to forget.
  const epoch = Number(envelope.epoch)
  if (!Number.isInteger(epoch)) throw new Error('Pocket payload has no key epoch')
  if (epoch < context.minEpoch) throw new Error('Pocket key epoch rolled back')
  if (epoch > context.epoch) throw new Error('Pocket payload uses an unknown key epoch')
  const combined = decode(envelope.ciphertext)
  if (combined.length < 17) throw new Error('invalid Pocket payload')
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(rootKey, { ...context, epoch }), decode(envelope.iv))
  decipher.setAAD(associatedData({ ...context, epoch }))
  decipher.setAuthTag(combined.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString('utf8'))
}

// Where the relay credentials and the content key rest between runs.
//
//   os          the desktop shell handed us a key the operating system
//               keychain protects; secrets are sealed before they touch disk
//   file        no shell, no keychain claim — the historical behaviour, a
//               0600 file, labelled honestly rather than pretending
//   basic_text  Linux with no usable keyring, or a keychain that failed;
//               Pocket secrets are not written at all
export const SECRET_BACKENDS = { PROTECTED: 'os', FILE: 'file', UNPROTECTED: 'basic_text' }

export function createSecretStore({ key, backend } = {}) {
  const master = key ? decode(key) : null
  if (master && master.length !== 32) throw new Error('Pocket secret key must be 32 bytes')
  const resolved = backend || (master ? SECRET_BACKENDS.PROTECTED : SECRET_BACKENDS.FILE)
  const protects = !!master && resolved === SECRET_BACKENDS.PROTECTED
  return {
    backend: resolved,
    master: protects ? master : null,
    protects,
    // The fail-safe. No keychain means no Pocket secrets on this disk; the
    // rest of December is untouched and stays entirely usable.
    persists: protects || resolved === SECRET_BACKENDS.FILE,
  }
}

function sealSecrets(store, value) {
  if (!store.protects) return encode(JSON.stringify({ p: 'plain', backend: store.backend, value }))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', store.master, iv)
  cipher.setAAD(SECRET_AAD)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encode(JSON.stringify({ p: 'aead', alg: 'A256GCM', iv: encode(iv), ciphertext: encode(ciphertext) }))
}

function openSecrets(store, sealed) {
  const envelope = JSON.parse(decode(sealed).toString('utf8'))
  if (store.protects) {
    // A protected computer refuses a plain envelope. Rewriting the file by
    // hand is the cheapest way to strip the keychain back off.
    if (envelope?.p !== 'aead') throw new Error('Pocket secrets on disk are not protected by this computer')
    const combined = decode(envelope.ciphertext)
    if (combined.length < 17) throw new Error('Pocket secrets on disk are damaged')
    const decipher = createDecipheriv('aes-256-gcm', store.master, decode(envelope.iv))
    decipher.setAAD(SECRET_AAD)
    decipher.setAuthTag(combined.subarray(-16))
    return JSON.parse(Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString('utf8'))
  }
  if (envelope?.p !== 'plain') throw new Error('Pocket secrets need this computer\'s keychain, which is unavailable')
  return envelope.value
}

function captureLocalId(clientId, captureId) {
  return `p${createHash('sha256').update(`${clientId}\0${captureId}`).digest('base64url').slice(0, 18)}`
}

async function responseJson(response) {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Pocket relay returned ${response.status}`)
    error.status = response.status
    throw error
  }
  return body
}

export class PocketSync {
  constructor({ dataDir, relayUrl, fetchImpl = fetch, timeoutMs = 5000, secret, env = process.env, now = () => Date.now() }) {
    this.filePath = join(dataDir, 'pocket.json')
    this.relayUrl = validateRelayUrl(relayUrl || env.DECEMBER_RELAY_URL || DEFAULT_RELAY_URL)
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.now = now
    this.store = createSecretStore(secret || {
      key: env.DECEMBER_POCKET_SECRET_KEY,
      backend: env.DECEMBER_POCKET_SECRET_BACKEND,
    })
    // Opened secrets live here and nowhere else in the state. When the
    // store cannot persist, this is the only copy and it dies with the run.
    this.secrets = null
    this.readOnly = false
    this.state = {
      version: CONFIG_VERSION,
      clientId: randomUUID(),
      space: null,
      secrets: null,
      claim: null,
      nextPageRevision: 1,
      pendingPage: null,
      captureCursor: 0,
      lastSyncedAt: null,
      lastError: null,
      requiresRepair: false,
      repairReset: false,
      pendingRevocation: null,
      pendingMove: null,
    }
    this.mutationQueue = Promise.resolve()
    this.flushPromise = null
    this.pullPromise = null
    this.movePromise = null
  }

  async init() {
    let saved = null
    try {
      saved = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return this
    }
    if (saved?.version === LEGACY_CONFIG_VERSION) return this.#migrateLegacy(saved)
    if (saved?.version !== CONFIG_VERSION) throw new Error('unsupported Pocket configuration')
    const { secrets, pendingRevocation, ...rest } = saved
    delete rest.claim
    this.state = { ...this.state, ...rest, secrets: secrets || null, pendingRevocation: pendingRevocation || null }
    if (!this.store.persists && (secrets || pendingRevocation || this.state.pendingMove)) {
      // Found secrets on a computer that must not hold them. Take them off
      // the disk now; December itself keeps working, only Pocket unpairs.
      await this.#purgeSecrets()
      return this
    }
    // v0.15.0 could write the migrated space without its sealed credential.
    // That credential cannot be recovered after restart, so discard the
    // orphaned local connection and let the person create a fresh one.
    if (this.state.space && !secrets) {
      this.secrets = null
      this.state.space = null
      this.state.secrets = null
      this.state.claim = null
      this.state.nextPageRevision = 1
      this.state.pendingPage = null
      this.state.captureCursor = 0
      this.state.lastSyncedAt = null
      this.state.lastError = null
      this.state.requiresRepair = false
      this.state.repairReset = true
      this.state.pendingRevocation = null
      this.state.pendingMove = null
      await this.#update(() => {})
      return this
    }
    if (secrets) {
      try {
        this.secrets = openSecrets(this.store, secrets)
      } catch (error) {
        // A keychain that is merely unavailable this run must not destroy a
        // pairing. Report it, touch nothing, and let the next run recover.
        this.readOnly = true
        this.state.lastError = String(error.message || error).slice(0, 200)
      }
    }
    return this
  }

  // Version 1 kept the desktop credential and the content key in the clear.
  // Seal them in one atomic rewrite, then mark the pairing for repair: the
  // phone still holds a version 1 key and has to be reconnected.
  async #migrateLegacy(saved) {
    const legacy = saved.connection
    this.state = {
      ...this.state,
      clientId: saved.clientId || this.state.clientId,
      nextPageRevision: Number(saved.nextPageRevision) || 1,
      captureCursor: Number(saved.captureCursor) || 0,
      lastSyncedAt: saved.lastSyncedAt || null,
    }
    if (!legacy?.spaceId || !this.store.persists) {
      this.state.lastError = legacy?.spaceId && !this.store.persists
        ? 'This computer has no key store for Pocket, so the phone pairing was removed.'
        : null
      await this.#update(() => {})
      return this
    }
    this.secrets = {
      deviceId: randomUUID(),
      desktopToken: legacy.desktopToken,
      contentKey: legacy.contentKey,
      epoch: 0,
    }
    this.state.space = { spaceId: legacy.spaceId, epoch: 0, pairedAt: null }
    this.state.secrets = sealSecrets(this.store, this.secrets)
    this.state.requiresRepair = true
    this.state.repairReset = false
    this.state.pendingPage = null
    await this.#update(() => {})
    return this
  }

  async #purgeSecrets() {
    this.secrets = null
    this.state.space = null
    this.state.secrets = null
    this.state.claim = null
    this.state.pendingPage = null
    this.state.pendingRevocation = null
    this.state.pendingMove = null
    this.state.requiresRepair = false
    this.state.repairReset = false
    this.state.captureCursor = 0
    this.state.nextPageRevision = 1
    this.state.lastError = 'This computer has no key store for Pocket, so the phone pairing was removed.'
    await this.#update(() => {})
  }

  status() {
    return {
      paired: this.#paired(),
      relayOrigin: this.relayUrl.origin,
      protocol: PROTOCOL_VERSION,
      epoch: this.state.space?.epoch ?? null,
      secretsBackend: this.store.backend,
      secretsProtected: this.store.protects,
      secretsPersisted: this.store.persists,
      requiresRepair: !!this.state.requiresRepair,
      repairReset: !!this.state.repairReset,
      revokePending: !!this.state.pendingRevocation,
      movePending: !!this.state.pendingMove,
      pendingRevision: this.state.pendingPage?.revision ?? null,
      captureCursor: this.state.captureCursor,
      lastSyncedAt: this.state.lastSyncedAt,
      lastError: this.state.lastError,
    }
  }

  #paired() {
    return !!this.state.space && !!this.secrets && !this.state.requiresRepair
  }

  async pair() {
    if (this.state.space) throw new Error('Pocket is already paired on this computer')
    if (!this.store.persists) throw new Error('This computer has no key store for Pocket, so a phone cannot be connected.')
    const deviceId = randomUUID()
    const created = await responseJson(await this.#request('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.state.clientId, deviceId, protocol: PROTOCOL_VERSION }),
    }, false))
    assertToken(created.spaceId, 'spaceId')
    assertToken(created.desktopToken, 'desktopToken')
    if (created.deviceId !== deviceId) throw new Error('Pocket relay returned a credential for another device')
    const claim = this.#readClaim(created.claim, created.protocolVersion)
    const contentKey = randomBytes(32)
    let presentation
    try {
      presentation = await this.#createPresentation(created.spaceId, 1, claim, contentKey, this.#authHeaders({
        spaceId: created.spaceId,
        epoch: 1,
        deviceId,
        desktopToken: created.desktopToken,
      }))
    } catch (error) {
      throw new Error('December could not store the manual pairing code. Check the connection and try Connect phone again.', { cause: error })
    }
    await this.#adopt({ spaceId: created.spaceId, epoch: 1, deviceId, desktopToken: created.desktopToken, contentKey })
    return { ...this.status(), ...presentation }
  }

  async reconnect() {
    return this.#rotateNow('reconnect')
  }

  async lostPhone() {
    return this.#rotateNow('lost-phone')
  }

  async lost() {
    return this.lostPhone()
  }

  // Compatibility for older local clients. Moving phones never comes through
  // an immediate rotation: each reason dispatches to its explicit lifecycle.
  async rotate({ reason = 'reconnect' } = {}) {
    if (reason === 'lost-phone') return this.lostPhone()
    if (reason === 'move-device') return this.beginMove()
    if (['reconnect', 'protocol-repair', 'replace-device'].includes(reason)) return this.reconnect()
    throw new Error('Pocket does not recognize that phone replacement action')
  }

  // Reconnect and lost-phone repair are immediate rotations. The relay first
  // revokes every phone and deletes old ciphertext; only then does December
  // adopt the fresh root key. A failed request leaves the old epoch untouched.
  async #rotateNow(reason) {
    if (!this.state.space || !this.secrets) throw new Error('Pocket is not paired')
    if (this.state.pendingMove && reason !== 'lost-phone') {
      throw new Error('Finish or cancel the phone move before reconnecting')
    }
    const spaceId = this.state.space.spaceId
    const epoch = (Number(this.state.space.epoch) || 0) + 1
    const created = await responseJson(await this.#request('/rotate', {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify({ spaceId, epoch, protocol: PROTOCOL_VERSION, reason, revokeDevices: true, deleteContent: true }),
    }))
    if (Number(created.epoch) !== epoch) throw new Error('Pocket relay refused the new key epoch')
    const desktopToken = created.desktopToken == null
      ? this.secrets.desktopToken
      : assertToken(created.desktopToken, 'desktopToken')
    const claim = this.#readClaim(created.claim, created.protocolVersion)
    const contentKey = randomBytes(32)
    await this.#adopt({ spaceId, epoch, deviceId: this.secrets.deviceId, desktopToken, contentKey })
    let presentation
    try {
      presentation = await this.#createPresentation(spaceId, epoch, claim, contentKey)
    } catch (error) {
      throw new Error('Phone access was revoked safely, but December could not store the new manual code. Check the connection and choose Reconnect phone for a fresh code.', { cause: error })
    }
    return { ...this.status(), ...presentation }
  }

  // A normal move is staged. The current phone and epoch remain authoritative
  // until the relay confirms that the new phone consumed the claim. The move
  // credential makes finalize idempotent even if its first response is lost.
  async beginMove() {
    if (!this.#paired()) throw new Error('Pocket is not paired')
    if (this.state.pendingMove) throw new Error('A phone move is already waiting to finish')
    const { spaceId, epoch: fromEpoch } = this.state.space
    const epoch = fromEpoch + 1
    let created
    try {
      created = await responseJson(await this.#request('/move/start', {
        method: 'POST',
        headers: this.#authHeaders(),
        body: JSON.stringify({ spaceId, fromEpoch, epoch, protocol: PROTOCOL_VERSION }),
      }))
    } catch (error) {
      if ([404, 405, 501].includes(error?.status)) {
        throw new Error('This relay cannot move a phone safely. Use Reconnect phone, or Phone lost or stolen if the old phone is gone.')
      }
      throw error
    }
    if (Number(created.epoch) !== epoch) throw new Error('Pocket relay refused to stage the new key epoch')
    const moveId = assertToken(created.moveId, 'moveId')
    const moveToken = assertToken(created.moveToken, 'moveToken')
    const desktopToken = assertToken(created.desktopToken, 'staged desktopToken')
    const claim = this.#readClaim(created.claim, created.protocolVersion)
    const contentKey = randomBytes(32)
    const pendingMove = sealSecrets(this.store, {
      moveId,
      moveToken,
      spaceId,
      epoch,
      deviceId: this.secrets.deviceId,
      desktopToken,
      contentKey: encode(contentKey),
      expiresAt: claim.expiresAt,
    })
    await this.#update((state) => {
      state.pendingMove = pendingMove
      state.lastError = null
    })
    let presentation
    try {
      presentation = await this.#createPresentation(spaceId, epoch, claim, contentKey)
    } catch (error) {
      try { await this.cancelMove() } catch {}
      const next = this.state.pendingMove
        ? 'Cancel the pending move, then try again.'
        : 'Check the connection and try Move to a new phone again.'
      throw new Error(`December could not store the manual pairing code. The old phone is still connected. ${next}`, { cause: error })
    }
    return { ...this.status(), ...presentation }
  }

  async move() {
    return this.beginMove()
  }

  async finalizeMove() {
    if (this.movePromise) return this.movePromise
    this.movePromise = this.#finalizeMove().finally(() => { this.movePromise = null })
    return this.movePromise
  }

  async #finalizeMove() {
    const move = this.#pendingMove()
    if (!move) throw new Error('There is no phone move waiting to finish')
    let finalized
    try {
      finalized = await responseJson(await this.#request('/move/finalize', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${move.moveToken}`,
          'content-type': 'application/json',
          'x-december-space-id': move.spaceId,
          'x-december-device-id': move.deviceId,
          'x-december-epoch': String(move.epoch),
        },
        body: JSON.stringify({ moveId: move.moveId, spaceId: move.spaceId, epoch: move.epoch }),
      }, false))
    } catch (error) {
      if (error?.status === 404 || error?.status === 410) {
        await this.#update((state) => { state.pendingMove = null })
        throw new Error('The phone move expired. The old phone is still connected; start Move to a new phone again.', { cause: error })
      }
      throw error
    }
    if (finalized.finalized !== true) throw new Error('The new phone has not claimed this move yet')
    if (Number(finalized.epoch) !== move.epoch) throw new Error('Pocket relay finalized another key epoch')
    if (finalized.desktopToken != null && assertToken(finalized.desktopToken, 'desktopToken') !== move.desktopToken) {
      throw new Error('Pocket relay returned another staged credential')
    }
    await this.#adopt({
      spaceId: move.spaceId,
      epoch: move.epoch,
      deviceId: move.deviceId,
      desktopToken: move.desktopToken,
      contentKey: decode(move.contentKey),
    })
    return this.status()
  }

  async cancelMove() {
    const move = this.#pendingMove()
    if (!move) {
      if (this.state.pendingMove) await this.#update((state) => { state.pendingMove = null })
      return this.status()
    }
    try {
      await responseJson(await this.#request('/move/cancel', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${move.moveToken}`,
          'content-type': 'application/json',
          'x-december-space-id': move.spaceId,
          'x-december-device-id': move.deviceId,
        },
        body: JSON.stringify({ moveId: move.moveId, spaceId: move.spaceId }),
      }, false))
    } catch (error) {
      const settled = error?.status === 404 || error?.status === 410
      if (!settled) throw error
    }
    await this.#update((state) => {
      state.pendingMove = null
      state.lastError = null
    })
    return this.status()
  }

  // Remote revoke. The relay is asked to delete the space and everything
  // stored in it before this computer forgets the pairing. If the relay
  // cannot be reached the request is kept — and only the request — so the
  // next sync finishes the job.
  async revoke() {
    const space = this.state.space
    const secrets = this.secrets
    if (!space || !secrets) {
      await this.#forget(null, null)
      return { ...this.status(), revoked: false }
    }
    try {
      await responseJson(await this.#request('/revoke', {
        method: 'POST',
        headers: this.#authHeaders(),
        body: JSON.stringify({ spaceId: space.spaceId, deviceId: secrets.deviceId, deleteContent: true }),
      }))
      await this.#forget(null, null)
      return { ...this.status(), revoked: true }
    } catch (error) {
      const message = String(error.message || error).slice(0, 200)
      await this.#forget({ spaceId: space.spaceId, deviceId: secrets.deviceId, desktopToken: secrets.desktopToken }, message)
      return { ...this.status(), revoked: false }
    }
  }

  // Kept for the local-only path: forget on this computer without asking the
  // relay. Revoke is what the settings surface calls.
  async disconnect() {
    await this.#forget(null, null)
    return this.status()
  }

  async retryRevocation() {
    const pending = this.state.pendingRevocation
    if (!pending) return this.status()
    let receipt = null
    try {
      receipt = openSecrets(this.store, pending)
    } catch {
      await this.#update((state) => { state.pendingRevocation = null })
      return this.status()
    }
    try {
      // The pairing is already gone from here, so this request carries the
      // receipt's own credential rather than a live connection.
      await responseJson(await this.#request('/revoke', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${receipt.desktopToken}`,
          'content-type': 'application/json',
          'x-december-space-id': receipt.spaceId,
          'x-december-device-id': receipt.deviceId,
        },
        body: JSON.stringify({ spaceId: receipt.spaceId, deviceId: receipt.deviceId, deleteContent: true }),
      }, false))
      await this.#update((state) => {
        state.pendingRevocation = null
        state.lastError = null
      })
    } catch (error) {
      // A relay that answered and refused has said all it is going to say:
      // the space is gone, or this credential no longer opens it. Either way
      // there is nothing left to retry, so the receipt goes too.
      const settled = error?.status >= 400 && error.status < 500 && error.status !== 429
      await this.#update((state) => {
        if (settled) state.pendingRevocation = null
        state.lastError = settled ? null : String(error.message || error).slice(0, 200)
      })
    }
    return this.status()
  }

  async queuePage(page) {
    if (!this.#paired()) return this.status()
    const { spaceId, epoch } = this.state.space
    const contentKey = decode(this.secrets.contentKey)
    await this.#update((state) => {
      const revision = state.nextPageRevision++
      state.pendingPage = {
        revision,
        epoch,
        payload: encrypt(contentKey, { spaceId, epoch, purpose: 'page', sequence: revision, deviceId: this.secrets.deviceId }, { version: PROTOCOL_VERSION, page }),
      }
    })
    void this.flush()
    return this.status()
  }

  async flush() {
    if (this.flushPromise) return this.flushPromise
    this.flushPromise = this.#flush().finally(() => { this.flushPromise = null })
    return this.flushPromise
  }

  async #flush() {
    const pending = this.state.pendingPage ? structuredClone(this.state.pendingPage) : null
    if (!pending || !this.#paired()) return this.status()
    try {
      const response = await this.#request('/page', {
        method: 'POST',
        headers: this.#authHeaders(),
        body: JSON.stringify(pending),
      })
      await responseJson(response)
      await this.#update((state) => {
        if (state.pendingPage?.revision === pending.revision) state.pendingPage = null
        state.lastSyncedAt = new Date(this.now()).toISOString()
        state.lastError = null
      })
    } catch (error) {
      await this.#update((state) => { state.lastError = String(error.message || error).slice(0, 200) })
    }
    if (this.state.pendingPage && this.state.pendingPage.revision !== pending.revision) return this.#flush()
    return this.status()
  }

  async pullCaptures(consume) {
    if (this.pullPromise) return this.pullPromise
    this.pullPromise = this.#pullCaptures(consume).finally(() => { this.pullPromise = null })
    return this.pullPromise
  }

  async #pullCaptures(consume) {
    if (this.state.pendingRevocation) await this.retryRevocation()
    if (!this.#paired()) return { imported: 0, ...this.status() }
    const { spaceId, epoch } = this.state.space
    const contentKey = decode(this.secrets.contentKey)
    let imported = 0
    try {
      const batch = await responseJson(await this.#request(`/captures?cursor=${this.state.captureCursor}&limit=100`, {
        headers: this.#authHeaders(),
      }))
      for (const item of batch.items || []) {
        const sequence = Number(item.sequence)
        // The cursor only ever goes forward. A relay that hands back an
        // already-acknowledged capture is replaying, not catching up.
        if (!Number.isInteger(sequence) || sequence <= this.state.captureCursor) {
          throw new Error('Pocket relay replayed an acknowledged capture')
        }
        assertToken(item.captureId, 'captureId')
        const value = decrypt(contentKey, item.payload, {
          spaceId,
          epoch,
          minEpoch: epoch,
          purpose: 'capture',
          sequence: item.captureId,
          deviceId: item.deviceId,
        })
        if (value?.v !== PROTOCOL_VERSION || value?.type !== 'capture' || typeof value.text !== 'string') {
          throw new Error('invalid Pocket capture')
        }
        await consume({
          id: captureLocalId(item.deviceId, item.captureId),
          text: value.text,
          at: value.createdAt || item.receivedAt,
        })
        await this.#update((state) => { state.captureCursor = sequence })
        imported++
      }
      if (this.state.captureCursor > 0) {
        await responseJson(await this.#request('/captures/ack', {
          method: 'POST',
          headers: this.#authHeaders(),
          body: JSON.stringify({ cursor: this.state.captureCursor }),
        }))
      }
      await this.#update((state) => { state.lastError = null })
    } catch (error) {
      await this.#update((state) => { state.lastError = String(error.message || error).slice(0, 200) })
    }
    return { imported, ...this.status() }
  }

  #readClaim(claim, protocolVersion) {
    if (protocolVersion != null && protocolVersion !== PROTOCOL_VERSION) {
      throw new Error('Pocket relay returned an unsupported protocol version')
    }
    const claimId = assertToken(claim?.claimId, 'pairing claim id')
    const claimSecret = assertToken(claim?.claimSecret, 'pairing claim secret')
    const expiresAt = Date.parse(claim.expiresAt)
    if (!Number.isFinite(expiresAt)) throw new Error('Pocket relay returned a pairing claim with no expiry')
    const life = expiresAt - this.now()
    if (life <= 0) throw new Error('Pocket relay returned an expired pairing claim')
    if (life > CLAIM_TTL_MS + CLAIM_SKEW_MS) throw new Error('Pocket pairing claims must expire within five minutes')
    return { claimId, claimSecret, expiresAt: new Date(expiresAt).toISOString() }
  }

  async #createPresentation(spaceId, epoch, claim, contentKey, authHeaders = this.#authHeaders()) {
    const pairingUrl = this.#pairingUrl(spaceId, epoch, claim, contentKey)
    const now = this.now()
    const expiresAt = new Date(Math.min(Date.parse(claim.expiresAt), now + CLAIM_TTL_MS)).toISOString()
    const capsule = createPairingCapsule({
      pairingBundle: {
        v: 1,
        protocolVersion: PROTOCOL_VERSION,
        spaceId,
        claimId: claim.claimId,
        claimSecret: claim.claimSecret,
        rootKey: encode(contentKey),
      },
    })
    // The authenticated upload contains exactly a routing selector and opaque
    // ciphertext. The manual secret and capsule plaintext never enter the body.
    await responseJson(await this.#request(PAIRING_CAPSULE_PATH, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(capsule.relay),
    }, false))
    return { pairingUrl, pairingCode: capsule.manualCode, pairingExpiresAt: expiresAt }
  }

  #pendingMove() {
    if (!this.state.pendingMove) return null
    try {
      return openSecrets(this.store, this.state.pendingMove)
    } catch {
      return null
    }
  }

  #pairingUrl(spaceId, epoch, claim, contentKey) {
    const fragment = new URLSearchParams({
      v: String(PROTOCOL_VERSION),
      space: spaceId,
      epoch: String(epoch),
      claim: claim.claimId,
      secret: claim.claimSecret,
      key: encode(contentKey),
    })
    return `${this.relayUrl.origin}/#${fragment.toString()}`
  }

  async #adopt({ spaceId, epoch, deviceId, desktopToken, contentKey }) {
    this.secrets = { deviceId, desktopToken, contentKey: encode(contentKey), epoch }
    const sealed = this.store.persists ? sealSecrets(this.store, this.secrets) : null
    await this.#update((state) => {
      state.space = { spaceId, epoch, pairedAt: new Date(this.now()).toISOString() }
      state.secrets = sealed
      // Pairing presentation data is memory-only and never joins status or
      // the durable configuration.
      state.claim = null
      state.requiresRepair = false
      state.repairReset = false
      state.pendingMove = null
      state.nextPageRevision = 1
      state.pendingPage = null
      state.captureCursor = 0
      state.lastSyncedAt = null
      state.lastError = null
    })
  }

  async #forget(revocationReceipt, message) {
    this.secrets = null
    const pending = revocationReceipt && this.store.persists ? sealSecrets(this.store, revocationReceipt) : null
    await this.#update((state) => {
      state.space = null
      state.secrets = null
      state.claim = null
      state.nextPageRevision = 1
      state.pendingPage = null
      state.captureCursor = 0
      state.lastSyncedAt = null
      state.requiresRepair = false
      state.repairReset = false
      state.pendingRevocation = pending
      state.pendingMove = null
      state.lastError = message
    })
    if (!pending) {
      try { await unlink(this.filePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }

  #authHeaders({
    spaceId = this.state.space?.spaceId,
    epoch = this.state.space?.epoch,
    deviceId = this.secrets?.deviceId,
    desktopToken = this.secrets?.desktopToken,
  } = {}) {
    return {
      authorization: `Bearer ${desktopToken}`,
      'content-type': 'application/json',
      'x-december-space-id': spaceId,
      'x-december-device-id': deviceId,
      'x-december-epoch': String(epoch),
    }
  }

  #request(path, options, authenticated = true) {
    if (authenticated && (!this.state.space || !this.secrets)) throw new Error('Pocket is not paired')
    return this.fetch(new URL(path, `${this.relayUrl.origin}/`), { ...options, signal: AbortSignal.timeout(this.timeoutMs) })
  }

  #update(operation) {
    const run = this.mutationQueue.then(async () => {
      operation(this.state)
      // A run that could not open its own secrets must not overwrite them.
      if (this.readOnly) return
      const onDisk = { ...this.state }
      if (!this.store.persists) {
        onDisk.secrets = null
        onDisk.pendingRevocation = null
      }
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${randomBytes(5).toString('hex')}.writing`
      await writeFile(temporary, `${JSON.stringify(onDisk, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
    })
    this.mutationQueue = run.catch(() => {})
    return run
  }
}

export async function createPocketSync(options) {
  return new PocketSync(options).init()
}

export const POCKET_PROTOCOL = PROTOCOL_VERSION
export const POCKET_CLAIM_TTL_MS = CLAIM_TTL_MS
export const pocketCrypto = { encrypt, decrypt, deriveKey, associatedData }
export const pocketSecrets = { seal: sealSecrets, open: openSecrets }
