import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const CONFIG_VERSION = 1
const DEFAULT_RELAY_URL = 'https://app.getdecember.me'

const encode = (value) => Buffer.from(value).toString('base64url')
const decode = (value) => Buffer.from(value, 'base64url')

function validateRelayUrl(value) {
  const url = new URL(value)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Pocket relay must use HTTPS')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

function encrypt(key, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encode(JSON.stringify({ v: 1, alg: 'A256GCM', iv: encode(iv), ciphertext: encode(ciphertext) }))
}

function decrypt(key, payload) {
  const envelope = JSON.parse(decode(payload).toString('utf8'))
  if (envelope?.v !== 1 || envelope?.alg !== 'A256GCM') throw new Error('unsupported Pocket payload')
  const combined = decode(envelope.ciphertext)
  if (combined.length < 17) throw new Error('invalid Pocket payload')
  const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv))
  decipher.setAuthTag(combined.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString('utf8'))
}

function captureLocalId(clientId, captureId) {
  return `p${createHash('sha256').update(`${clientId}\0${captureId}`).digest('base64url').slice(0, 18)}`
}

async function responseJson(response) {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || `Pocket relay returned ${response.status}`)
  return body
}

export class PocketSync {
  constructor({ dataDir, relayUrl, fetchImpl = fetch, timeoutMs = 5000 }) {
    this.filePath = join(dataDir, 'pocket.json')
    this.relayUrl = validateRelayUrl(relayUrl || process.env.DECEMBER_RELAY_URL || DEFAULT_RELAY_URL)
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.state = {
      version: CONFIG_VERSION,
      clientId: randomUUID(),
      connection: null,
      nextPageRevision: 1,
      pendingPage: null,
      captureCursor: 0,
      lastSyncedAt: null,
      lastError: null,
    }
    this.mutationQueue = Promise.resolve()
    this.flushPromise = null
    this.pullPromise = null
  }

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (saved?.version !== CONFIG_VERSION) throw new Error('unsupported Pocket configuration')
      this.state = { ...this.state, ...saved }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return this
  }

  status() {
    return {
      paired: !!this.state.connection,
      relayOrigin: this.relayUrl.origin,
      pendingRevision: this.state.pendingPage?.revision ?? null,
      captureCursor: this.state.captureCursor,
      lastSyncedAt: this.state.lastSyncedAt,
      lastError: this.state.lastError,
    }
  }

  async pair() {
    const response = await this.#request('/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.state.clientId }),
    }, false)
    const created = await responseJson(response)
    for (const field of ['spaceId', 'desktopToken', 'pocketToken']) {
      if (typeof created[field] !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(created[field])) {
        throw new Error(`Pocket relay returned an invalid ${field}`)
      }
    }
    const contentKey = randomBytes(32)
    await this.#update((state) => {
      state.connection = {
        spaceId: created.spaceId,
        desktopToken: created.desktopToken,
        pocketToken: created.pocketToken,
        contentKey: encode(contentKey),
      }
      state.nextPageRevision = 1
      state.pendingPage = null
      state.captureCursor = 0
      state.lastSyncedAt = null
      state.lastError = null
    })
    return {
      ...this.status(),
      pairingUrl: `${this.relayUrl.origin}/#space=${encodeURIComponent(created.spaceId)}&token=${encodeURIComponent(created.pocketToken)}&key=${encode(contentKey)}`,
    }
  }

  async disconnect() {
    await this.#update((state) => {
      state.connection = null
      state.nextPageRevision = 1
      state.pendingPage = null
      state.captureCursor = 0
      state.lastSyncedAt = null
      state.lastError = null
    })
    try { await unlink(this.filePath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    return this.status()
  }

  async queuePage(page) {
    if (!this.state.connection) return this.status()
    await this.#update((state) => {
      const revision = state.nextPageRevision++
      state.pendingPage = {
        revision,
        payload: encrypt(decode(state.connection.contentKey), { version: 1, page }),
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
    if (!pending || !this.state.connection) return this.status()
    try {
      const response = await this.#request('/page', {
        method: 'POST',
        headers: this.#authHeaders(),
        body: JSON.stringify(pending),
      })
      await responseJson(response)
      await this.#update((state) => {
        if (state.pendingPage?.revision === pending.revision) state.pendingPage = null
        state.lastSyncedAt = new Date().toISOString()
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
    const connection = this.state.connection
    if (!connection) return { imported: 0, ...this.status() }
    let imported = 0
    try {
      const batch = await responseJson(await this.#request(`/captures?cursor=${this.state.captureCursor}&limit=100`, {
        headers: this.#authHeaders(),
      }))
      for (const item of batch.items || []) {
        const value = decrypt(decode(connection.contentKey), item.payload)
        if (value?.v !== 1 || value?.type !== 'capture' || typeof value.text !== 'string') throw new Error('invalid Pocket capture')
        await consume({
          id: captureLocalId(item.clientId, item.captureId),
          text: value.text,
          at: value.createdAt || item.receivedAt,
        })
        await this.#update((state) => { state.captureCursor = item.sequence })
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

  #authHeaders() {
    return {
      authorization: `Bearer ${this.state.connection.desktopToken}`,
      'content-type': 'application/json',
      'x-december-space-id': this.state.connection.spaceId,
    }
  }

  #request(path, options, authenticated = true) {
    if (authenticated && !this.state.connection) throw new Error('Pocket is not paired')
    return this.fetch(new URL(path, `${this.relayUrl.origin}/`), { ...options, signal: AbortSignal.timeout(this.timeoutMs) })
  }

  #update(operation) {
    const run = this.mutationQueue.then(async () => {
      operation(this.state)
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${randomBytes(5).toString('hex')}.writing`
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.filePath)
    })
    this.mutationQueue = run.catch(() => {})
    return run
  }
}

export async function createPocketSync(options) {
  return new PocketSync(options).init()
}

export const pocketCrypto = { encrypt, decrypt }
