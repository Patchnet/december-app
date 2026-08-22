import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The on-disk shape. Version 1 kept the relay credentials and the content
// key as plain fields; version 2 keeps them inside a sealed envelope and
// carries the key epoch beside the space.
const CONFIG_VERSION = 2
const LEGACY_CONFIG_VERSION = 1
// The envelope the phone and this computer share. Nothing older is read:
// a version 1 envelope arriving today is a downgrade, not a leftover.
const PROTOCOL_VERSION = 2
const DEFAULT_RELAY_URL = 'https://app.getdecember.me'
// A pairing code is a five-minute, single-use claim. A relay that offers a
// longer or reusable one is not answering the protocol December speaks.
const CLAIM_TTL_MS = 5 * 60_000
const CLAIM_SKEW_MS = 30_000
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/
const SECRET_AAD = Buffer.from('december.pocket.secrets.v2')
const HKDF_SALT = Buffer.from('december.pocket.v2.hkdf')

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
  const info = Buffer.from(`december.pocket.v${PROTOCOL_VERSION}|${purpose}|${spaceId}|${epoch}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', rootKey, HKDF_SALT, info, 32))
}

// The associated data is the part of the message that must be true but is
// not secret. Binding it means a page cannot be replayed as a capture, into
// another space, or under another epoch or revision.
function associatedData({ spaceId, epoch, purpose, sequence }) {
  return Buffer.from(JSON.stringify([`december.pocket.v${PROTOCOL_VERSION}`, purpose, spaceId, epoch, String(sequence)]), 'utf8')
}

function encrypt(rootKey, context, value) {
  const { spaceId, epoch, purpose, sequence } = context
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootKey, context), iv)
  cipher.setAAD(associatedData(context))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encode(JSON.stringify({
    v: PROTOCOL_VERSION,
    alg: 'A256GCM',
    kdf: 'HKDF-SHA256',
    space: spaceId,
    epoch,
    purpose,
    seq: String(sequence),
    iv: encode(iv),
    ciphertext: encode(ciphertext),
  }))
}

function decrypt(rootKey, payload, context) {
  const envelope = JSON.parse(decode(payload).toString('utf8'))
  if (envelope?.v !== PROTOCOL_VERSION) throw new Error(`unsupported Pocket payload version ${envelope?.v}`)
  if (envelope?.alg !== 'A256GCM' || envelope?.kdf !== 'HKDF-SHA256') throw new Error('unsupported Pocket payload')
  if (envelope.space !== context.spaceId) throw new Error('Pocket payload belongs to another space')
  if (envelope.purpose !== context.purpose) throw new Error('Pocket payload was made for another purpose')
  if (envelope.seq !== String(context.sequence)) throw new Error('Pocket payload does not match its position')
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
      pendingRevocation: null,
    }
    this.mutationQueue = Promise.resolve()
    this.flushPromise = null
    this.pullPromise = null
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
    this.state = { ...this.state, ...rest, secrets: secrets || null, pendingRevocation: pendingRevocation || null }
    if (!this.store.persists && (secrets || pendingRevocation)) {
      // Found secrets on a computer that must not hold them. Take them off
      // the disk now; December itself keeps working, only Pocket unpairs.
      await this.#purgeSecrets()
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
    this.state.requiresRepair = true
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
    this.state.requiresRepair = false
    this.state.captureCursor = 0
    this.state.nextPageRevision = 1
    this.state.lastError = 'This computer has no key store for Pocket, so the phone pairing was removed.'
    await this.#update(() => {})
  }

  status() {
    const claim = this.state.claim
    const live = claim && Date.parse(claim.expiresAt) > this.now()
    return {
      paired: this.#paired(),
      relayOrigin: this.relayUrl.origin,
      protocol: PROTOCOL_VERSION,
      epoch: this.state.space?.epoch ?? null,
      secretsBackend: this.store.backend,
      secretsProtected: this.store.protects,
      secretsPersisted: this.store.persists,
      requiresRepair: !!this.state.requiresRepair,
      revokePending: !!this.state.pendingRevocation,
      pairingExpiresAt: live ? claim.expiresAt : null,
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
    const claim = this.#readClaim(created.claim)
    const contentKey = randomBytes(32)
    await this.#adopt({ spaceId: created.spaceId, epoch: 1, deviceId, desktopToken: created.desktopToken, contentKey, claim })
    return { ...this.status(), pairingUrl: this.#pairingUrl(created.spaceId, 1, claim, contentKey) }
  }

  // Losing a phone and replacing a phone are the same act: the old device
  // credential is revoked at the relay, the stored ciphertext is dropped,
  // and a fresh content key opens a new epoch. Anything the lost phone still
  // holds decrypts nothing and is refused as a rollback if it is replayed.
  async rotate({ reason = 'replace-device' } = {}) {
    if (!this.state.space || !this.secrets) throw new Error('Pocket is not paired')
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
    const claim = this.#readClaim(created.claim)
    const contentKey = randomBytes(32)
    await this.#adopt({ spaceId, epoch, deviceId: this.secrets.deviceId, desktopToken, contentKey, claim })
    return { ...this.status(), pairingUrl: this.#pairingUrl(spaceId, epoch, claim, contentKey) }
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
        payload: encrypt(contentKey, { spaceId, epoch, purpose: 'page', sequence: revision }, { version: PROTOCOL_VERSION, page }),
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
        })
        if (value?.v !== PROTOCOL_VERSION || value?.type !== 'capture' || typeof value.text !== 'string') {
          throw new Error('invalid Pocket capture')
        }
        await consume({
          id: captureLocalId(item.clientId, item.captureId),
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

  #readClaim(claim) {
    assertToken(claim?.id, 'pairing claim id')
    assertToken(claim?.secret, 'pairing claim secret')
    if (claim.singleUse !== true) throw new Error('Pocket relay returned a reusable pairing claim')
    const expiresAt = Date.parse(claim.expiresAt)
    if (!Number.isFinite(expiresAt)) throw new Error('Pocket relay returned a pairing claim with no expiry')
    const life = expiresAt - this.now()
    if (life <= 0) throw new Error('Pocket relay returned an expired pairing claim')
    if (life > CLAIM_TTL_MS + CLAIM_SKEW_MS) throw new Error('Pocket pairing claims must expire within five minutes')
    return { id: claim.id, secret: claim.secret, expiresAt: new Date(expiresAt).toISOString() }
  }

  #pairingUrl(spaceId, epoch, claim, contentKey) {
    const fragment = new URLSearchParams({
      v: String(PROTOCOL_VERSION),
      space: spaceId,
      epoch: String(epoch),
      claim: `${claim.id}.${claim.secret}`,
      key: encode(contentKey),
    })
    return `${this.relayUrl.origin}/#${fragment.toString()}`
  }

  async #adopt({ spaceId, epoch, deviceId, desktopToken, contentKey, claim }) {
    this.secrets = { deviceId, desktopToken, contentKey: encode(contentKey), epoch }
    const sealed = this.store.persists ? sealSecrets(this.store, this.secrets) : null
    await this.#update((state) => {
      state.space = { spaceId, epoch, pairedAt: new Date(this.now()).toISOString() }
      state.secrets = sealed
      // The secret half of the claim is never written down. Only its
      // identity and expiry are, so the page can say how long the code has
      // left and stop offering one the relay would already refuse.
      state.claim = { id: claim.id, expiresAt: claim.expiresAt }
      state.requiresRepair = false
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
      state.pendingRevocation = pending
      state.lastError = message
    })
    if (!pending) {
      try { await unlink(this.filePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }

  #authHeaders() {
    return {
      authorization: `Bearer ${this.secrets.desktopToken}`,
      'content-type': 'application/json',
      'x-december-space-id': this.state.space.spaceId,
      'x-december-device-id': this.secrets.deviceId,
      'x-december-epoch': String(this.state.space.epoch),
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
