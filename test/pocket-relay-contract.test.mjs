import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createPocketSync } from '../lib/pocket-sync.mjs'

const relayRoot = process.env.DECEMBER_RELAY_ROOT

test('December and the real Relay agree on pair, rotate, ready, sync, and revoke', {
  skip: relayRoot ? false : 'set DECEMBER_RELAY_ROOT to a december-relay checkout',
}, async (t) => {
  const { createRelayServer } = await import(pathToFileURL(join(relayRoot, 'src', 'server.mjs')))
  const relayData = await mkdtemp(join(tmpdir(), 'december-relay-contract-'))
  const appData = await mkdtemp(join(tmpdir(), 'december-app-contract-'))
  const { server, store } = await createRelayServer({ env: {}, dataDir: relayData })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await Promise.all([relayData, appData].map((directory) => rm(directory, { recursive: true, force: true })))
  })

  const relayUrl = `http://127.0.0.1:${server.address().port}`
  const pocket = await createPocketSync({
    dataDir: appData,
    relayUrl,
    secret: { key: randomBytes(32).toString('base64url'), backend: 'os' },
  })

  async function claimPhone(pairingUrl, deviceId) {
    const fragment = new URLSearchParams(new URL(pairingUrl).hash.slice(1))
    const response = await fetch(`${relayUrl}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        spaceId: fragment.get('space'),
        claimId: fragment.get('claim'),
        claimSecret: fragment.get('secret'),
        deviceId,
      }),
    })
    assert.equal(response.status, 201)
    return response.json()
  }

  const initial = await pocket.pair()
  const oldPhone = await claimPhone(initial.pairingUrl, 'phone-old')
  const phoneHeaders = (phone) => ({
    authorization: `Bearer ${phone.token}`,
    'content-type': 'application/json',
    'x-december-space-id': phone.spaceId,
  })
  assert.equal((await fetch(`${relayUrl}/devices/ready`, {
    method: 'POST', headers: phoneHeaders(oldPhone), body: JSON.stringify({ epoch: 1 }),
  })).status, 200)
  await pocket.queuePage({ spaces: [{ name: 'Home', blocks: [] }] })
  await pocket.flush()
  assert.equal((await fetch(`${relayUrl}/page`, { headers: phoneHeaders(oldPhone) })).status, 200)

  const moved = await pocket.rotate({ reason: 'move-device' })
  assert.equal(pocket.status().epoch, 2)
  assert.equal((await fetch(`${relayUrl}/page`, { headers: phoneHeaders(oldPhone) })).status, 401)

  const newPhone = await claimPhone(moved.pairingUrl, 'phone-new')
  assert.equal(newPhone.keyEpoch, 2)
  await pocket.queuePage({ spaces: [{ name: 'Home', blocks: [] }] })
  await pocket.flush()
  assert.equal((await fetch(`${relayUrl}/page`, { headers: phoneHeaders(newPhone) })).status, 200)
  assert.equal((await fetch(`${relayUrl}/devices/ready`, {
    method: 'POST', headers: phoneHeaders(newPhone), body: JSON.stringify({ epoch: 2 }),
  })).status, 200)
  assert.equal((await pocket.checkPhoneReady()).phoneReady, true)

  const spaceId = newPhone.spaceId
  assert.equal((await pocket.revoke()).revoked, true)
  assert.equal(store.getSpace(spaceId), null)
})
