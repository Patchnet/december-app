import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPocketSync, pocketCrypto } from '../lib/pocket-sync.mjs'

function relayFixture() {
  const requests = []
  const relay = {
    page: null,
    captures: [],
    acknowledgedCursor: 0,
  }
  const credentials = {
    spaceId: 'space_test_1234567890',
    desktopToken: 'desktop_test_token_1234567890',
    pocketToken: 'pocket_test_token_1234567890',
  }

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path: `${parsed.pathname}${parsed.search}`, method: options.method || 'GET', body })
    if (parsed.pathname === '/pair') return Response.json(credentials, { status: 201 })

    if (options.headers?.authorization !== `Bearer ${credentials.desktopToken}`) {
      return Response.json({ error: { message: 'forbidden' } }, { status: 403 })
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

test('pairing keeps the content key in the fragment and publishes an encrypted page', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'december-pocket-sync-'))
  const fixture = relayFixture()
  const pocket = await createPocketSync({
    dataDir,
    relayUrl: 'http://127.0.0.1:8787',
    fetchImpl: fixture.fetchImpl,
  })

  const paired = await pocket.pair()
  const pairingUrl = new URL(paired.pairingUrl)
  assert.equal(pairingUrl.search, '')
  assert.equal(pairingUrl.origin, 'http://127.0.0.1:8787')
  const fragment = new URLSearchParams(pairingUrl.hash.slice(1))
  assert.equal(fragment.get('space'), fixture.credentials.spaceId)
  assert.equal(fragment.get('token'), fixture.credentials.pocketToken)
  assert.equal(Buffer.from(fragment.get('key'), 'base64url').length, 32)

  await pocket.queuePage({ spaces: [{ name: 'Home', blocks: [] }] })
  await pocket.flush()
  assert.equal(fixture.relay.page.revision, 1)
  assert.equal(fixture.relay.page.payload.includes('Home'), false)
  const decrypted = pocketCrypto.decrypt(Buffer.from(fragment.get('key'), 'base64url'), fixture.relay.page.payload)
  assert.deepEqual(decrypted, { version: 1, page: { spaces: [{ name: 'Home', blocks: [] }] } })

  const pairRequest = fixture.requests.find((request) => request.path === '/pair')
  assert.equal(JSON.stringify(pairRequest).includes(fragment.get('key')), false)
  assert.equal(JSON.stringify(pairRequest).includes(fixture.credentials.pocketToken), false)
})

test('pending page revisions survive restart and retry', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'december-pocket-retry-'))
  const fixture = relayFixture()
  let failPage = true
  const intermittentFetch = async (url, options) => {
    if (new URL(url).pathname === '/page' && failPage) throw new Error('offline')
    return fixture.fetchImpl(url, options)
  }
  const first = await createPocketSync({ dataDir, relayUrl: 'http://localhost:8787', fetchImpl: intermittentFetch })
  await first.pair()
  await first.queuePage({ spaces: [{ name: 'Waiting' }] })
  await first.flush()
  assert.equal(first.status().pendingRevision, 1)

  failPage = false
  const restarted = await createPocketSync({ dataDir, relayUrl: 'http://localhost:8787', fetchImpl: intermittentFetch })
  await restarted.flush()
  assert.equal(restarted.status().pendingRevision, null)
  assert.equal(fixture.relay.page.revision, 1)
})

test('capture cursor advances only after the durable consumer and ack is retried safely', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'december-pocket-captures-'))
  const fixture = relayFixture()
  const pocket = await createPocketSync({ dataDir, relayUrl: 'http://127.0.0.1:8787', fetchImpl: fixture.fetchImpl })
  const paired = await pocket.pair()
  const key = Buffer.from(new URLSearchParams(new URL(paired.pairingUrl).hash.slice(1)).get('key'), 'base64url')
  fixture.relay.captures.push({
    sequence: 1,
    clientId: 'phone-a',
    captureId: 'capture-a',
    payload: pocketCrypto.encrypt(key, { v: 1, type: 'capture', text: 'Buy tea', createdAt: '2026-08-13T10:00:00.000Z' }),
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
  const persisted = JSON.parse(await readFile(join(dataDir, 'pocket.json'), 'utf8'))
  assert.equal(persisted.captureCursor, 1)
})

test('core treats deterministic Pocket capture IDs as idempotent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'december-pocket-core-'))
  const previous = process.env.DECEMBER_DATA_DIR
  process.env.DECEMBER_DATA_DIR = dataDir
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
