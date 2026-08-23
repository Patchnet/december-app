import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  POCKET_CLAIM_TTL_MS,
  POCKET_PROTOCOL,
  createPocketSync,
  createSecretStore,
  pocketCrypto,
  pocketSecrets,
} from '../lib/pocket-sync.mjs'
import { decryptPairingCapsule, parseManualCode } from '../lib/pocket-pairing-code.mjs'
import { POCKET_KEY_FILE, navigationDecision, preparePocketSecret } from '../electron/runtime.mjs'

const dataDir = (name) => mkdtemp(join(tmpdir(), `december-${name}-`))
const masterKey = () => randomBytes(32).toString('base64url')
const protectedSecret = () => ({ key: masterKey(), backend: 'os' })
const fragmentOf = (pairingUrl) => new URLSearchParams(new URL(pairingUrl).hash.slice(1))
const keyOf = (pairingUrl) => Buffer.from(fragmentOf(pairingUrl).get('key'), 'base64url')
const pairingBundleOf = (pairingUrl) => {
  const fragment = fragmentOf(pairingUrl)
  const [claimId, claimSecret] = fragment.get('claim').split('.')
  return {
    v: 1,
    protocolVersion: Number(fragment.get('v')),
    spaceId: fragment.get('space'),
    claimId,
    claimSecret,
    rootKey: fragment.get('key'),
  }
}

function relayFixture({
  claimTtlMs = POCKET_CLAIM_TTL_MS,
  protocolVersion = POCKET_PROTOCOL,
  spaceId = 'space_test_1234567890',
  desktopToken = 'desktop_test_token_1234567890',
} = {}) {
  const requests = []
  const relay = {
    page: null,
    captures: [],
    capsules: new Map(),
    acknowledgedCursor: 0,
    revoked: false,
    epoch: 1,
    deleted: 0,
    move: null,
    moveClaimed: false,
  }
  const credentials = { spaceId, desktopToken }
  let claimSeed = 0
  const nextClaim = () => ({
    claimId: `claim_id_00000000000${++claimSeed}`,
    claimSecret: `claim_secret_00000000000${claimSeed}`,
    expiresAt: new Date(Date.now() + claimTtlMs).toISOString(),
  })

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path: `${parsed.pathname}${parsed.search}`, method: options.method || 'GET', body, headers: options.headers })
    if (parsed.pathname === '/pair') {
      return Response.json({ protocolVersion, ...credentials, deviceId: body.deviceId, claim: nextClaim() }, { status: 201 })
    }
    if (parsed.pathname === '/move/finalize') {
      if (options.headers?.authorization !== `Bearer ${relay.move?.moveToken}`) {
        return Response.json({ error: { message: 'forbidden' } }, { status: 403 })
      }
      if (!relay.moveClaimed) return Response.json({ finalized: false, epoch: body.epoch }, { status: 200 })
      relay.epoch = body.epoch
      relay.captures = []
      relay.page = null
      relay.deleted++
      credentials.desktopToken = relay.move.desktopToken
      return Response.json({ finalized: true, epoch: body.epoch, desktopToken: relay.move.desktopToken }, { status: 200 })
    }
    if (parsed.pathname === '/move/cancel') {
      if (options.headers?.authorization !== `Bearer ${relay.move?.moveToken}`) {
        return Response.json({ error: { message: 'forbidden' } }, { status: 403 })
      }
      relay.move = null
      return Response.json({ cancelled: true }, { status: 200 })
    }

    if (options.headers?.authorization !== `Bearer ${credentials.desktopToken}`) {
      return Response.json({ error: { message: 'forbidden' } }, { status: 403 })
    }
    if (parsed.pathname === '/pair/capsules') {
      relay.capsules.set(body.selector, body)
      return Response.json({ stored: true, expiresAt: new Date(Date.now() + POCKET_CLAIM_TTL_MS).toISOString() }, { status: 201 })
    }
    if (parsed.pathname === '/move/start') {
      relay.move = {
        moveId: 'move_test_1234567890',
        moveToken: 'move_token_1234567890',
        desktopToken: 'desktop_next_token_1234567890',
        epoch: body.epoch,
      }
      relay.moveClaimed = false
      return Response.json({ protocolVersion, ...relay.move, claim: nextClaim() }, { status: 201 })
    }
    if (parsed.pathname === '/rotate') {
      relay.epoch = body.epoch
      relay.captures = []
      relay.page = null
      relay.move = null
      relay.deleted++
      return Response.json({ protocolVersion, epoch: body.epoch, claim: nextClaim() }, { status: 200 })
    }
    if (parsed.pathname === '/revoke') {
      relay.revoked = true
      relay.captures = []
      relay.page = null
      return Response.json({ revoked: true }, { status: 200 })
    }
    if (parsed.pathname === '/page') {
      relay.page = body
      return Response.json({ revision: body.revision }, { status: 201 })
    }
    if (parsed.pathname === '/captures' && !options.method) {
      const cursor = Number(parsed.searchParams.get('cursor') || 0)
      const items = relay.captures.filter((item) => item.sequence > cursor)
      return Response.json({ items, nextCursor: items.at(-1)?.sequence || cursor })
    }
    if (parsed.pathname === '/captures/ack') {
      relay.acknowledgedCursor = body.cursor
      relay.captures = relay.captures.filter((item) => item.sequence > body.cursor)
      return Response.json({ acknowledgedCursor: body.cursor })
    }
    return Response.json({ error: { message: 'missing' } }, { status: 404 })
  }
  return { relay, requests, credentials, fetchImpl }
}

async function paired(name, options = {}) {
  const dir = await dataDir(name)
  const fixture = options.fixture || relayFixture()
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: protectedSecret(),
    ...options.sync,
  })
  const result = await pocket.pair()
  return {
    dir,
    fixture,
    pocket,
    pairingUrl: result.pairingUrl,
    pairingCode: result.pairingCode,
    pairingExpiresAt: result.pairingExpiresAt,
    key: keyOf(result.pairingUrl),
  }
}

const captureEnvelope = (key, spaceId, epoch, captureId, value) =>
  pocketCrypto.encrypt(key, { spaceId, epoch, purpose: 'capture', sequence: captureId }, value)

test('pairing keeps the content key in the fragment and publishes an encrypted page', async () => {
  const { fixture, pocket, pairingUrl, pairingCode, key } = await paired('pocket-sync')
  const url = new URL(pairingUrl)
  assert.equal(url.search, '')
  assert.equal(url.origin, 'http://127.0.0.1:8787')
  const fragment = fragmentOf(pairingUrl)
  assert.equal(fragment.get('space'), fixture.credentials.spaceId)
  assert.equal(fragment.get('v'), String(POCKET_PROTOCOL))
  assert.equal(fragment.get('epoch'), '1')
  assert.equal(key.length, 32)

  await pocket.queuePage({ spaces: [{ name: 'Home', blocks: [] }] })
  await pocket.flush()
  assert.equal(fixture.relay.page.revision, 1)
  assert.equal(fixture.relay.page.epoch, 1)
  assert.equal(fixture.relay.page.payload.includes('Home'), false)
  const decrypted = pocketCrypto.decrypt(key, fixture.relay.page.payload, {
    spaceId: fixture.credentials.spaceId,
    epoch: 1,
    minEpoch: 1,
    purpose: 'page',
    sequence: 1,
  })
  assert.deepEqual(decrypted, { version: POCKET_PROTOCOL, page: { spaces: [{ name: 'Home', blocks: [] }] } })

  const pairRequest = fixture.requests.find((request) => request.path === '/pair')
  assert.equal(JSON.stringify(pairRequest).includes(fragment.get('key')), false)
  assert.equal(JSON.stringify(pairRequest).includes(fragment.get('claim')), false)
  const capsuleRequest = fixture.requests.find((request) => request.path === '/pair/capsules')
  assert.deepEqual(Object.keys(capsuleRequest.body).sort(), ['ciphertext', 'selector'])
  assert.equal(capsuleRequest.method, 'POST')
  assert.equal(capsuleRequest.headers.authorization, `Bearer ${fixture.credentials.desktopToken}`)
  assert.equal(JSON.stringify(capsuleRequest).includes(fragment.get('key')), false)
  assert.equal(JSON.stringify(capsuleRequest).includes(fragment.get('claim')), false)
  const manualSecret = parseManualCode(pairingCode).secretBytes
  assert.equal(JSON.stringify(capsuleRequest).includes(manualSecret.toString('base64url')), false)
  assert.equal(JSON.stringify(capsuleRequest).includes(manualSecret.toString('hex')), false)
})

test('pending page revisions survive restart and retry', async () => {
  const dir = await dataDir('pocket-retry')
  const fixture = relayFixture()
  const secret = protectedSecret()
  let failPage = true
  const intermittentFetch = async (url, options) => {
    if (new URL(url).pathname === '/page' && failPage) throw new Error('offline')
    return fixture.fetchImpl(url, options)
  }
  const first = await createPocketSync({ dataDir: dir, relayUrl: 'http://localhost:8787', fetchImpl: intermittentFetch, secret })
  await first.pair()
  await first.queuePage({ spaces: [{ name: 'Waiting' }] })
  await first.flush()
  assert.equal(first.status().pendingRevision, 1)

  failPage = false
  const restarted = await createPocketSync({ dataDir: dir, relayUrl: 'http://localhost:8787', fetchImpl: intermittentFetch, secret })
  assert.equal(restarted.status().paired, true)
  await restarted.flush()
  assert.equal(restarted.status().pendingRevision, null)
  assert.equal(fixture.relay.page.revision, 1)
})

test('capture cursor advances only after the durable consumer and ack is retried safely', async () => {
  const { dir, fixture, pocket, key } = await paired('pocket-captures')
  fixture.relay.captures.push({
    sequence: 1,
    clientId: 'phone-a',
    captureId: 'capture_a_1234567890',
    payload: captureEnvelope(key, fixture.credentials.spaceId, 1, 'capture_a_1234567890', {
      v: POCKET_PROTOCOL,
      type: 'capture',
      text: 'Buy tea',
      createdAt: '2026-08-13T10:00:00.000Z',
    }),
    receivedAt: '2026-08-13T10:00:01.000Z',
  })

  const consumed = []
  const result = await pocket.pullCaptures((capture) => consumed.push(capture))
  assert.equal(result.imported, 1)
  assert.equal(consumed[0].text, 'Buy tea')
  assert.match(consumed[0].id, /^p[A-Za-z0-9_-]{18}$/)
  assert.equal(fixture.relay.acknowledgedCursor, 1)

  const second = await pocket.pullCaptures((capture) => consumed.push(capture))
  assert.equal(second.imported, 0)
  assert.equal(consumed.length, 1)
  const persisted = JSON.parse(await readFile(join(dir, 'pocket.json'), 'utf8'))
  assert.equal(persisted.captureCursor, 1)
})

test('core treats deterministic Pocket capture IDs as idempotent', async () => {
  const dir = await dataDir('pocket-core')
  const previous = process.env.DECEMBER_DATA_DIR
  process.env.DECEMBER_DATA_DIR = dir
  try {
    const core = await import(`../lib/core.mjs?pocket-test=${Date.now()}`)
    const first = await core.addCapture('Bring an umbrella', undefined, { id: 'premote-capture-id', at: '2026-08-13T12:00:00.000Z' })
    const duplicate = await core.addCapture('Bring an umbrella', undefined, { id: 'premote-capture-id', at: '2026-08-13T12:00:00.000Z' })
    assert.equal(first.id, 'premote-capture-id')
    assert.equal(duplicate.duplicate, true)
    assert.equal(core.project().captures.filter((capture) => capture.id === 'premote-capture-id').length, 1)
  } finally {
    if (previous == null) delete process.env.DECEMBER_DATA_DIR
    else process.env.DECEMBER_DATA_DIR = previous
  }
})

// --- pairing claims -------------------------------------------------------

test('a canonical Relay v2 pair response produces QR-link data and a manual code', async () => {
  const { fixture, pairingUrl, pairingCode } = await paired('pocket-canonical-claim')
  const fragment = fragmentOf(pairingUrl)
  assert.equal(fragment.get('space'), fixture.credentials.spaceId)
  assert.match(fragment.get('claim'), /^claim_id_[A-Za-z0-9_-]*\.claim_secret_[A-Za-z0-9_-]*$/)
  assert.match(pairingCode, /^D2[0-9A-HJKMNP-TV-Z]{52}$/)
  const capsule = fixture.relay.capsules.get(parseManualCode(pairingCode).selector)
  assert.deepEqual(decryptPairingCapsule({ manualCode: pairingCode, capsule }), pairingBundleOf(pairingUrl))
})

test('pairing presentation secrets are not persisted', async () => {
  const { pocket, pairingUrl, pairingCode, pairingExpiresAt } = await paired('pocket-claim')
  const fragment = fragmentOf(pairingUrl)
  assert.match(fragment.get('claim'), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.match(pairingCode, /^D2[0-9A-HJKMNP-TV-Z]{52}$/)
  const expiry = Date.parse(pairingExpiresAt)
  assert.ok(expiry - Date.now() <= POCKET_CLAIM_TTL_MS + 1000)
  const raw = await readFile(pocket.filePath, 'utf8')
  const persisted = JSON.parse(raw)
  assert.equal(persisted.claim, null)
  assert.equal(raw.includes(pairingCode), false)
  const manualSecret = parseManualCode(pairingCode).secretBytes
  assert.equal(raw.includes(manualSecret.toString('base64url')), false)
  assert.equal(raw.includes(manualSecret.toString('hex')), false)
  assert.equal('pairingExpiresAt' in pocket.status(), false)
  assert.equal('pairingCode' in pocket.status(), false)
  assert.equal(JSON.stringify(persisted).includes(pairingCode), false)
  assert.equal(JSON.stringify(persisted).includes(fragment.get('claim').split('.')[1]), false)
})

test('a relay offering a long-lived pairing claim is refused', async () => {
  const dir = await dataDir('pocket-long-claim')
  const fixture = relayFixture({ claimTtlMs: 60 * 60_000 })
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: protectedSecret(),
  })
  await assert.rejects(() => pocket.pair(), /expire within five minutes/)
  assert.equal(pocket.status().paired, false)
})

test('a relay answering with another protocol version is refused', async () => {
  const dir = await dataDir('pocket-wrong-protocol')
  const fixture = relayFixture({ protocolVersion: POCKET_PROTOCOL - 1 })
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: protectedSecret(),
  })
  await assert.rejects(() => pocket.pair(), /unsupported protocol version/)
  assert.equal(pocket.status().paired, false)
})

test('a relay answering with another device credential is refused', async () => {
  const dir = await dataDir('pocket-wrong-device')
  const fixture = relayFixture()
  const swapped = async (url, options) => {
    if (new URL(url).pathname === '/pair') {
      const answer = await fixture.fetchImpl(url, options)
      const body = await answer.json()
      return Response.json({ ...body, deviceId: 'somebody-else' }, { status: 201 })
    }
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({ dataDir: dir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: swapped, secret: protectedSecret() })
  await assert.rejects(() => pocket.pair(), /another device/)
})

test('pairing twice on one computer is refused; replacing is the way through', async () => {
  const { pocket } = await paired('pocket-double-pair')
  await assert.rejects(() => pocket.pair(), /already paired/)
})

// --- revoke, lost phone, rotation ----------------------------------------

test('disconnect asks the relay to delete the space before forgetting it', async () => {
  const { fixture, pocket } = await paired('pocket-revoke')
  const result = await pocket.revoke()
  assert.equal(result.revoked, true)
  assert.equal(fixture.relay.revoked, true)
  assert.equal(pocket.status().paired, false)
  assert.equal(pocket.status().revokePending, false)
  const revokeRequest = fixture.requests.find((request) => request.path === '/revoke')
  assert.equal(revokeRequest.body.deleteContent, true)
})

test('an unreachable relay still ends the pairing here and finishes the delete later', async () => {
  const dir = await dataDir('pocket-revoke-offline')
  const fixture = relayFixture()
  const secret = protectedSecret()
  let offline = true
  const flaky = async (url, options) => {
    if (offline && new URL(url).pathname === '/revoke') throw new Error('fetch failed')
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({ dataDir: dir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: flaky, secret })
  await pocket.pair()
  const result = await pocket.revoke()
  assert.equal(result.revoked, false)
  assert.equal(pocket.status().paired, false)
  assert.equal(pocket.status().revokePending, true)
  // Nothing but the receipt survives: no content key, no space.
  const persisted = JSON.parse(await readFile(join(dir, 'pocket.json'), 'utf8'))
  assert.equal(persisted.space, null)
  assert.equal(persisted.secrets, null)

  offline = false
  const restarted = await createPocketSync({ dataDir: dir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: flaky, secret })
  await restarted.retryRevocation()
  assert.equal(fixture.relay.revoked, true)
  assert.equal(restarted.status().revokePending, false)
})

test('a relay that answers and refuses the revoke ends the retry rather than nagging forever', async () => {
  const dir = await dataDir('pocket-revoke-gone')
  const fixture = relayFixture()
  let gone = false
  const answers = async (url, options) => {
    if (gone && new URL(url).pathname === '/revoke') {
      return Response.json({ error: { message: 'no such space' } }, { status: 404 })
    }
    if (new URL(url).pathname === '/revoke') throw new Error('fetch failed')
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({ dataDir: dir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: answers, secret: protectedSecret() })
  await pocket.pair()
  await pocket.revoke()
  assert.equal(pocket.status().revokePending, true)

  gone = true
  await pocket.retryRevocation()
  assert.equal(pocket.status().revokePending, false)
  assert.equal(pocket.status().lastError, null)
})

test('replacing a lost phone opens a new epoch with a new content key', async () => {
  const { fixture, pocket, key } = await paired('pocket-rotate')
  await pocket.queuePage({ spaces: [{ name: 'Before' }] })
  await pocket.flush()

  const rotated = await pocket.rotate({ reason: 'lost-phone' })
  const nextKey = keyOf(rotated.pairingUrl)
  assert.equal(pocket.status().epoch, 2)
  assert.equal(fragmentOf(rotated.pairingUrl).get('epoch'), '2')
  assert.notEqual(nextKey.toString('base64url'), key.toString('base64url'))
  assert.equal(fixture.relay.deleted, 1)
  const rotateRequest = fixture.requests.find((request) => request.path === '/rotate')
  assert.equal(rotateRequest.body.revokeDevices, true)
  assert.equal(rotateRequest.body.reason, 'lost-phone')

  await pocket.queuePage({ spaces: [{ name: 'After' }] })
  await pocket.flush()
  assert.equal(fixture.relay.page.epoch, 2)
  // The lost phone's key opens nothing written after the rotation.
  assert.throws(() => pocketCrypto.decrypt(key, fixture.relay.page.payload, {
    spaceId: fixture.credentials.spaceId,
    epoch: 2,
    minEpoch: 2,
    purpose: 'page',
    sequence: 1,
  }), /unable to authenticate|bad decrypt|Unsupported state/i)
})

test('a relay that refuses the new epoch leaves the old one in place', async () => {
  const dir = await dataDir('pocket-rotate-refused')
  const fixture = relayFixture()
  const stubborn = async (url, options) => {
    if (new URL(url).pathname === '/rotate') return Response.json({ epoch: 1, claim: null }, { status: 200 })
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({ dataDir: dir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: stubborn, secret: protectedSecret() })
  await pocket.pair()
  await assert.rejects(() => pocket.rotate(), /refused the new key epoch/)
  assert.equal(pocket.status().epoch, 1)
  assert.equal(pocket.status().paired, true)
})

test('reconnect is an explicit immediate rotation with a fresh presentation', async () => {
  const { fixture, pocket, key } = await paired('pocket-reconnect')
  const result = await pocket.reconnect()
  assert.equal(pocket.status().epoch, 2)
  assert.notEqual(keyOf(result.pairingUrl).toString('base64url'), key.toString('base64url'))
  assert.match(result.pairingCode, /^D2[0-9A-HJKMNP-TV-Z]{52}$/)
  const request = fixture.requests.find((item) => item.path === '/rotate')
  assert.equal(request.body.reason, 'reconnect')
  assert.equal(request.body.revokeDevices, true)
  assert.equal(request.body.deleteContent, true)
})

test('manual-code relay failure never transmits a secret and leaves initial pairing unadopted', async () => {
  const dir = await dataDir('pocket-capsule-offline')
  const fixture = relayFixture()
  const failing = async (url, options) => {
    if (new URL(url).pathname === '/pair/capsules') {
      const body = JSON.parse(options.body)
      fixture.requests.push({ path: '/pair-capsules-failed', body, headers: options.headers })
      return Response.json({ error: { message: 'capsule storage unavailable' } }, { status: 503 })
    }
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: failing,
    secret: protectedSecret(),
  })
  await assert.rejects(() => pocket.pair(), /could not store the manual pairing code/)
  assert.equal(pocket.status().paired, false)
  const request = fixture.requests.find((item) => item.path === '/pair-capsules-failed')
  assert.deepEqual(Object.keys(request.body).sort(), ['ciphertext', 'selector'])
  assert.match(request.headers.authorization, /^Bearer desktop_test_token_/)
})

test('a staged move keeps the old epoch until the new phone claims it', async () => {
  const { fixture, pocket, pairingUrl } = await paired('pocket-move')
  const oldKey = keyOf(pairingUrl)
  const staged = await pocket.rotate({ reason: 'move-device' })
  assert.equal(pocket.status().epoch, 1)
  assert.equal(pocket.status().paired, true)
  assert.equal(pocket.status().movePending, true)
  assert.equal(fixture.relay.deleted, 0)
  const request = fixture.requests.find((item) => item.path === '/move/start')
  assert.equal(request.body.fromEpoch, 1)
  assert.equal(request.body.epoch, 2)
  assert.equal('revokeDevices' in request.body, false)

  const capsule = fixture.relay.capsules.get(parseManualCode(staged.pairingCode).selector)
  assert.deepEqual(decryptPairingCapsule({ manualCode: staged.pairingCode, capsule }), pairingBundleOf(staged.pairingUrl))
  await assert.rejects(() => pocket.finalizeMove(), /has not claimed/)
  assert.equal(pocket.status().epoch, 1)
  assert.equal(pocket.secrets.contentKey, oldKey.toString('base64url'))

  fixture.relay.moveClaimed = true
  await pocket.finalizeMove()
  assert.equal(pocket.status().epoch, 2)
  assert.equal(pocket.status().movePending, false)
  assert.equal(fixture.relay.deleted, 1)
})

test('manual-code failure cancels a staged move and leaves the old phone connected', async () => {
  const dir = await dataDir('pocket-move-capsule-failure')
  const fixture = relayFixture()
  let moving = false
  const failing = async (url, options) => {
    const path = new URL(url).pathname
    if (path === '/pair/capsules' && moving) {
      const body = JSON.parse(options.body)
      fixture.requests.push({ path: '/pair-capsules-move-failed', body })
      return Response.json({ error: { message: 'capsule storage unavailable' } }, { status: 503 })
    }
    const response = await fixture.fetchImpl(url, options)
    if (path === '/move/start') moving = true
    return response
  }
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: failing,
    secret: protectedSecret(),
  })
  await pocket.pair()
  await assert.rejects(() => pocket.beginMove(), /old phone is still connected/)
  assert.equal(pocket.status().paired, true)
  assert.equal(pocket.status().epoch, 1)
  assert.equal(pocket.status().movePending, false)
  assert.equal(fixture.relay.deleted, 0)
  assert.equal(fixture.relay.move, null)
  const request = fixture.requests.find((item) => item.path === '/pair-capsules-move-failed')
  assert.deepEqual(Object.keys(request.body).sort(), ['ciphertext', 'selector'])
})

test('an interrupted move survives restart without revoking the old phone', async () => {
  const dir = await dataDir('pocket-move-restart')
  const fixture = relayFixture()
  const secret = protectedSecret()
  const first = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret,
  })
  await first.pair()
  const staged = await first.beginMove()
  const raw = await readFile(join(dir, 'pocket.json'), 'utf8')
  assert.equal(raw.includes(fixture.relay.move.moveToken), false)
  assert.equal(raw.includes(fixture.relay.move.desktopToken), false)
  assert.equal(raw.includes(fragmentOf(staged.pairingUrl).get('key')), false)

  const restarted = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret,
  })
  assert.equal(restarted.status().epoch, 1)
  assert.equal(restarted.status().paired, true)
  assert.equal(restarted.status().movePending, true)
  assert.equal(fixture.relay.deleted, 0)
  fixture.relay.moveClaimed = true
  await restarted.finalizeMove()
  assert.equal(restarted.status().epoch, 2)
})

test('move finalize retries safely when the relay finalized but its response was lost', async () => {
  const dir = await dataDir('pocket-move-finalize-replay')
  const fixture = relayFixture()
  let loseFinalizeResponse = true
  const flaky = async (url, options) => {
    const response = await fixture.fetchImpl(url, options)
    if (new URL(url).pathname === '/move/finalize' && loseFinalizeResponse) {
      loseFinalizeResponse = false
      throw new Error('response lost')
    }
    return response
  }
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: flaky,
    secret: protectedSecret(),
  })
  await pocket.pair()
  await pocket.beginMove()
  fixture.relay.moveClaimed = true

  await assert.rejects(() => pocket.finalizeMove(), /response lost/)
  assert.equal(pocket.status().epoch, 1)
  assert.equal(pocket.status().movePending, true)
  assert.equal(fixture.relay.epoch, 2)

  await pocket.finalizeMove()
  assert.equal(pocket.status().epoch, 2)
  assert.equal(pocket.status().movePending, false)
})

test('an expired staged move clears safely and leaves the old phone connected', async () => {
  const dir = await dataDir('pocket-move-expired')
  const fixture = relayFixture()
  const expired = async (url, options) => {
    if (new URL(url).pathname === '/move/finalize') {
      return Response.json({ error: { message: 'move expired' } }, { status: 410 })
    }
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: expired,
    secret: protectedSecret(),
  })
  await pocket.pair()
  await pocket.beginMove()
  await assert.rejects(() => pocket.finalizeMove(), /old phone is still connected/)
  assert.equal(pocket.status().movePending, false)
  assert.equal(pocket.status().paired, true)
  assert.equal(pocket.status().epoch, 1)
  assert.equal(fixture.relay.deleted, 0)
})

test('lost-phone rotation overrides an interrupted move and revokes immediately', async () => {
  const { fixture, pocket } = await paired('pocket-move-lost')
  await pocket.beginMove()
  const replacement = await pocket.lostPhone()
  assert.equal(fragmentOf(replacement.pairingUrl).get('epoch'), '2')
  assert.equal(pocket.status().movePending, false)
  assert.equal(fixture.relay.deleted, 1)
  const request = fixture.requests.find((item) => item.path === '/rotate')
  assert.equal(request.body.reason, 'lost-phone')
})

test('a relay without staged movement fails closed and keeps the old phone connected', async () => {
  const fixture = relayFixture()
  const unsupported = async (url, options) => {
    if (new URL(url).pathname === '/move/start') {
      return Response.json({ error: { message: 'missing' } }, { status: 404 })
    }
    return fixture.fetchImpl(url, options)
  }
  const dir = await dataDir('pocket-move-unsupported')
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: unsupported,
    secret: protectedSecret(),
  })
  await pocket.pair()
  await assert.rejects(() => pocket.beginMove(), /Use Reconnect phone, or Phone lost or stolen/)
  assert.equal(pocket.status().paired, true)
  assert.equal(pocket.status().epoch, 1)
  assert.equal(fixture.relay.deleted, 0)
})

// --- protocol v2: derived keys, bound data, rollback ----------------------

test('page and capture keys are derived apart from each other and from the root', () => {
  const root = randomBytes(32)
  const context = { spaceId: 'space_a', epoch: 3 }
  const page = pocketCrypto.deriveKey(root, { ...context, purpose: 'page' })
  const capture = pocketCrypto.deriveKey(root, { ...context, purpose: 'capture' })
  const otherSpace = pocketCrypto.deriveKey(root, { spaceId: 'space_b', epoch: 3, purpose: 'page' })
  const otherEpoch = pocketCrypto.deriveKey(root, { ...context, epoch: 4, purpose: 'page' })
  for (const derived of [page, capture, otherSpace, otherEpoch]) assert.equal(derived.length, 32)
  const seen = new Set([page, capture, otherSpace, otherEpoch, root].map((k) => k.toString('hex')))
  assert.equal(seen.size, 5)
})

test('an envelope replayed into another purpose, space, or position will not open', () => {
  const root = randomBytes(32)
  const context = { spaceId: 'space_a', epoch: 2, minEpoch: 2, purpose: 'capture', sequence: 'capture_one' }
  const sealed = pocketCrypto.encrypt(root, context, { v: POCKET_PROTOCOL, type: 'capture', text: 'hello' })
  assert.deepEqual(pocketCrypto.decrypt(root, sealed, context), { v: POCKET_PROTOCOL, type: 'capture', text: 'hello' })
  assert.throws(() => pocketCrypto.decrypt(root, sealed, { ...context, purpose: 'page' }), /another purpose/)
  assert.throws(() => pocketCrypto.decrypt(root, sealed, { ...context, spaceId: 'space_b' }), /another space/)
  assert.throws(() => pocketCrypto.decrypt(root, sealed, { ...context, sequence: 'capture_two' }), /does not match its position/)
})

test('an envelope from an older epoch is rejected as a rollback', () => {
  const root = randomBytes(32)
  const stale = pocketCrypto.encrypt(root, { spaceId: 'space_a', epoch: 1, purpose: 'capture', sequence: 'c1' }, { v: 2 })
  assert.throws(() => pocketCrypto.decrypt(root, stale, {
    spaceId: 'space_a', epoch: 2, minEpoch: 2, purpose: 'capture', sequence: 'c1',
  }), /rolled back/)
  const future = pocketCrypto.encrypt(root, { spaceId: 'space_a', epoch: 9, purpose: 'capture', sequence: 'c1' }, { v: 2 })
  assert.throws(() => pocketCrypto.decrypt(root, future, {
    spaceId: 'space_a', epoch: 2, minEpoch: 2, purpose: 'capture', sequence: 'c1',
  }), /unknown key epoch/)
})

test('a version 1 envelope is refused rather than accepted as a leftover', () => {
  const root = randomBytes(32)
  const legacy = Buffer.from(JSON.stringify({ v: 1, alg: 'A256GCM', iv: 'AAAA', ciphertext: 'AAAA' })).toString('base64url')
  assert.throws(() => pocketCrypto.decrypt(root, legacy, {
    spaceId: 'space_a', epoch: 1, minEpoch: 1, purpose: 'page', sequence: 1,
  }), /unsupported Pocket payload version 1/)
})

test('a relay replaying an acknowledged capture is refused and nothing is imported', async () => {
  const dir = await dataDir('pocket-replay')
  const fixture = relayFixture()
  let replay = false
  const item = () => ({
    sequence: 1,
    clientId: 'phone-a',
    captureId: 'capture_a_1234567890',
    payload: captureEnvelope(key, fixture.credentials.spaceId, 1, 'capture_a_1234567890', {
      v: POCKET_PROTOCOL, type: 'capture', text: 'Buy tea',
    }),
    receivedAt: '2026-08-13T10:00:01.000Z',
  })
  // A relay that has forgotten the acknowledgement, or is lying about it.
  const insistent = async (url, options) => {
    if (replay && new URL(url).pathname === '/captures' && !options?.method) {
      return Response.json({ items: [item()], nextCursor: 1 })
    }
    return fixture.fetchImpl(url, options)
  }
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: insistent,
    secret: protectedSecret(),
  })
  const key = keyOf((await pocket.pair()).pairingUrl)
  fixture.relay.captures.push(item())
  await pocket.pullCaptures(() => {})
  assert.equal(pocket.status().captureCursor, 1)

  replay = true
  const consumed = []
  const replayed = await pocket.pullCaptures((capture) => consumed.push(capture))
  assert.equal(replayed.imported, 0)
  assert.equal(consumed.length, 0)
  assert.match(pocket.status().lastError, /replayed an acknowledged capture/)
})

test('a capture sealed under a retired epoch is refused after rotation', async () => {
  const { fixture, pocket, key } = await paired('pocket-stale-capture')
  const spaceId = fixture.credentials.spaceId
  await pocket.rotate()
  fixture.relay.captures.push({
    sequence: 1,
    clientId: 'phone-lost',
    captureId: 'capture_old_123456789',
    payload: captureEnvelope(key, spaceId, 1, 'capture_old_123456789', { v: POCKET_PROTOCOL, type: 'capture', text: 'stale' }),
    receivedAt: '2026-08-13T10:00:01.000Z',
  })
  const consumed = []
  const result = await pocket.pullCaptures((capture) => consumed.push(capture))
  assert.equal(result.imported, 0)
  assert.equal(consumed.length, 0)
  assert.match(pocket.status().lastError, /rolled back/)
})

// --- secrets at rest ------------------------------------------------------

test('a protected computer seals the credentials and the content key on disk', async () => {
  const { dir, fixture, pocket } = await paired('pocket-sealed')
  const raw = await readFile(join(dir, 'pocket.json'), 'utf8')
  assert.equal(raw.includes(fixture.credentials.desktopToken), false)
  assert.equal(raw.includes(pocket.secrets.contentKey), false)
  const persisted = JSON.parse(raw)
  assert.equal(persisted.version, 2)
  assert.equal(persisted.space.spaceId, fixture.credentials.spaceId)
  const envelope = JSON.parse(Buffer.from(persisted.secrets, 'base64url').toString('utf8'))
  assert.equal(envelope.p, 'aead')
})

test('a sealed file will not open with a different key', async () => {
  const { dir, fixture } = await paired('pocket-wrong-key')
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: protectedSecret(),
  })
  assert.equal(pocket.status().paired, false)
  assert.match(pocket.status().lastError, /Unsupported state|unable to authenticate|damaged/i)
  // A key that failed to open must never overwrite what it could not read.
  const persisted = JSON.parse(await readFile(join(dir, 'pocket.json'), 'utf8'))
  assert.ok(persisted.secrets)
})

test('a protected computer refuses plain secrets someone wrote into the file', async () => {
  const { dir, fixture, pocket } = await paired('pocket-downgrade')
  const persisted = JSON.parse(await readFile(join(dir, 'pocket.json'), 'utf8'))
  const plain = createSecretStore({ backend: 'file' })
  persisted.secrets = pocketSecrets.seal(plain, pocket.secrets)
  await writeFile(join(dir, 'pocket.json'), JSON.stringify(persisted))

  const reopened = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: protectedSecret(),
  })
  assert.equal(reopened.status().paired, false)
  assert.match(reopened.status().lastError, /not protected by this computer/)
})

test('a computer with no key store keeps December usable and refuses to write Pocket secrets', async () => {
  const dir = await dataDir('pocket-basic-text')
  const fixture = relayFixture()
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: { backend: 'basic_text' },
  })
  assert.equal(pocket.status().secretsPersisted, false)
  await assert.rejects(() => pocket.pair(), /no key store/)
  assert.equal(pocket.status().paired, false)
})

test('secrets found on a computer with no key store are taken off the disk', async () => {
  const { dir, fixture } = await paired('pocket-basic-text-purge')
  const before = await readFile(join(dir, 'pocket.json'), 'utf8')
  assert.ok(JSON.parse(before).secrets)

  const stripped = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: { backend: 'basic_text' },
  })
  assert.equal(stripped.status().paired, false)
  assert.match(stripped.status().lastError, /no key store/)
  const after = JSON.parse(await readFile(join(dir, 'pocket.json'), 'utf8'))
  assert.equal(after.secrets, null)
  assert.equal(after.space, null)
})

// --- migration ------------------------------------------------------------

test('a version 1 file is sealed in one rewrite and marked for reconnection', async () => {
  const dir = await dataDir('pocket-migrate')
  const secret = protectedSecret()
  const legacy = {
    version: 1,
    clientId: 'client-1234',
    connection: {
      spaceId: 'space_legacy_1234567890',
      desktopToken: 'desktop_legacy_1234567890',
      pocketToken: 'pocket_legacy_1234567890',
      contentKey: randomBytes(32).toString('base64url'),
    },
    nextPageRevision: 7,
    captureCursor: 4,
    lastSyncedAt: '2026-08-13T10:00:00.000Z',
  }
  await writeFile(join(dir, 'pocket.json'), JSON.stringify(legacy))
  // The relay still knows this desktop by the credential it was issued.
  const fixture = relayFixture({ spaceId: legacy.connection.spaceId, desktopToken: legacy.connection.desktopToken })
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret,
  })
  const raw = await readFile(join(dir, 'pocket.json'), 'utf8')
  const persisted = JSON.parse(raw)
  assert.equal(raw.includes(legacy.connection.desktopToken), false)
  assert.equal(raw.includes(legacy.connection.contentKey), false)
  assert.equal(persisted.version, 2)
  assert.equal(JSON.parse(Buffer.from(persisted.secrets, 'base64url').toString('utf8')).p, 'aead')
  assert.equal(pocket.status().requiresRepair, true)
  assert.equal(pocket.status().paired, false)
  assert.equal(pocket.status().epoch, 0)

  // Nothing goes to the relay under the old envelope.
  await pocket.queuePage({ spaces: [{ name: 'Home' }] })
  await pocket.flush()
  assert.equal(fixture.relay.page, null)

  // A restart must retain the sealed credential needed to finish migration.
  const restarted = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret,
  })
  const repaired = await restarted.rotate()
  assert.equal(restarted.status().requiresRepair, false)
  assert.equal(restarted.status().paired, true)
  assert.equal(fragmentOf(repaired.pairingUrl).get('epoch'), '1')
})

test('an orphaned version 2 migration resets to a fresh phone connection', async () => {
  const dir = await dataDir('pocket-migrate-orphan')
  await writeFile(join(dir, 'pocket.json'), JSON.stringify({
    version: 2,
    clientId: 'client-1234',
    space: { spaceId: 'space_orphan_1234567890', epoch: 0, pairedAt: null },
    secrets: null,
    claim: null,
    nextPageRevision: 7,
    pendingPage: { revision: 6, epoch: 0, payload: 'unrecoverable' },
    captureCursor: 4,
    lastSyncedAt: '2026-08-13T10:00:00.000Z',
    lastError: null,
    requiresRepair: true,
    pendingRevocation: null,
    pendingMove: null,
  }))
  const fixture = relayFixture()
  const secret = protectedSecret()
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret,
  })

  assert.equal(pocket.status().paired, false)
  assert.equal(pocket.status().requiresRepair, false)
  assert.equal(pocket.status().repairReset, true)
  const reset = JSON.parse(await readFile(join(dir, 'pocket.json'), 'utf8'))
  assert.equal(reset.space, null)
  assert.equal(reset.secrets, null)
  assert.equal(reset.pendingPage, null)
  assert.equal(reset.captureCursor, 0)
  assert.equal(reset.nextPageRevision, 1)

  // The recovery notice and clean connection path also survive another restart.
  const restarted = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret,
  })
  assert.equal(restarted.status().repairReset, true)
  const paired = await restarted.pair()
  assert.match(paired.pairingUrl, /^http:\/\/127\.0\.0\.1:8787\/#/)
  assert.match(paired.pairingCode, /^D2[0-9A-HJKMNP-TV-Z]{52}$/)
  assert.equal(restarted.status().paired, true)
  assert.equal(restarted.status().repairReset, false)
})

test('a version 1 file on a computer with no key store loses its secrets outright', async () => {
  const dir = await dataDir('pocket-migrate-unprotected')
  await writeFile(join(dir, 'pocket.json'), JSON.stringify({
    version: 1,
    clientId: 'client-1234',
    connection: {
      spaceId: 'space_legacy_1234567890',
      desktopToken: 'desktop_legacy_1234567890',
      contentKey: randomBytes(32).toString('base64url'),
    },
  }))
  const fixture = relayFixture()
  const pocket = await createPocketSync({
    dataDir: dir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
    secret: { backend: 'basic_text' },
  })
  const raw = await readFile(join(dir, 'pocket.json'), 'utf8')
  assert.equal(raw.includes('desktop_legacy_1234567890'), false)
  assert.equal(pocket.status().paired, false)
  assert.equal(pocket.status().requiresRepair, false)
})

// --- the desktop shell's key store ---------------------------------------

function fakeFiles(seed = {}) {
  const written = new Map(Object.entries(seed))
  const removed = []
  const renames = []
  return {
    written,
    removed,
    renames,
    async mkdir() {},
    async readFile(path) {
      if (!written.has(path)) {
        const error = new Error(`ENOENT: ${path}`)
        error.code = 'ENOENT'
        throw error
      }
      return written.get(path)
    },
    async writeFile(path, body) { written.set(path, body) },
    async rename(from, to) {
      renames.push([from, to])
      written.set(to, written.get(from))
      written.delete(from)
    },
    async rm(path) {
      removed.push(path)
      written.delete(path)
    },
  }
}

// A stand-in for the platform key store: a real one would be DPAPI, the
// Keychain, or libsecret. The tag proves the value went through it.
const workingSafeStorage = (backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (value) => Buffer.from(`sealed:${value}`),
  decryptString: (buffer) => String(buffer).replace(/^sealed:/, ''),
})

test('a protected desktop unwraps one key and writes it through a rename', async () => {
  const files = fakeFiles()
  const prepared = await preparePocketSecret({
    userDataDir: '/user',
    safeStorage: workingSafeStorage(),
    platform: 'win32',
    files,
  })
  assert.equal(prepared.backend, 'os')
  assert.equal(Buffer.from(prepared.key, 'base64url').length, 32)
  assert.equal(files.renames.length, 1, 'the key file lands by rename, never half-written')
  assert.match(files.renames[0][0], /\.writing$/)
  const stored = files.written.get(join('/user', POCKET_KEY_FILE))
  assert.match(String(stored), /^sealed:/, 'the key on disk went through the platform key store')
  assert.equal(String(stored).includes(prepared.key), true)

  const again = await preparePocketSecret({
    userDataDir: '/user',
    safeStorage: workingSafeStorage(),
    platform: 'win32',
    files,
  })
  assert.equal(again.key, prepared.key, 'an existing key is reused, not replaced')
  assert.equal(files.renames.length, 1)
})

test('a Linux session with no keyring keeps no Pocket key at all', async () => {
  const file = join('/user', POCKET_KEY_FILE)
  const files = fakeFiles({ [file]: Buffer.from('sealed:leftover') })
  const prepared = await preparePocketSecret({
    userDataDir: '/user',
    safeStorage: workingSafeStorage('basic_text'),
    platform: 'linux',
    files,
  })
  assert.deepEqual(prepared, { backend: 'basic_text', key: null })
  assert.deepEqual(files.removed, [file], 'the leftover key is taken off the disk')
  assert.equal(files.written.has(file), false)
})

test('an unknown Linux backend is treated as no key store, not as a maybe', async () => {
  const prepared = await preparePocketSecret({
    userDataDir: '/user',
    safeStorage: workingSafeStorage('unknown'),
    platform: 'linux',
    files: fakeFiles(),
  })
  assert.equal(prepared.backend, 'basic_text')
  assert.equal(prepared.key, null)
})

test('a key store that is unavailable or fails late does not stop December', async () => {
  const unavailable = await preparePocketSecret({
    userDataDir: '/user',
    safeStorage: { isEncryptionAvailable: () => false },
    platform: 'darwin',
    files: fakeFiles(),
  })
  assert.equal(unavailable.backend, 'basic_text')

  const refuses = await preparePocketSecret({
    userDataDir: '/user',
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('keychain locked') },
    },
    platform: 'darwin',
    files: fakeFiles(),
  })
  assert.deepEqual(refuses, { backend: 'basic_text', key: null })

  const missing = await preparePocketSecret({ userDataDir: '/user', files: fakeFiles() })
  assert.equal(missing.backend, 'basic_text')
})

test('the desktop window only navigates to December itself', () => {
  const origin = 'http://127.0.0.1:3008'
  assert.equal(navigationDecision(`${origin}/?desktop=1`, origin), 'allow')
  assert.equal(navigationDecision('https://github.com/Patchnet/december-app', origin), 'external')
  assert.equal(navigationDecision('http://127.0.0.1:3009/', origin), 'block')
  assert.equal(navigationDecision('http://evil.example/', origin), 'block')
  assert.equal(navigationDecision('file:///etc/passwd', origin), 'block')
  assert.equal(navigationDecision('javascript:alert(1)', origin), 'block')
  assert.equal(navigationDecision('not a url', origin), 'block')
})

test('an unknown configuration version is refused rather than guessed at', async () => {
  const dir = await dataDir('pocket-future')
  await writeFile(join(dir, 'pocket.json'), JSON.stringify({ version: 99 }))
  await assert.rejects(
    () => createPocketSync({ dataDir: dir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: relayFixture().fetchImpl, secret: protectedSecret() }),
    /unsupported Pocket configuration/
  )
})
