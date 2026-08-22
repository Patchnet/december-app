import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect as connectNet, createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSecretStore, pocketCrypto, pocketSecrets } from '../lib/pocket-sync.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// the canonical skill's own version — tests follow it instead of pinning a literal
const skillVersion = (await readFile(join(ROOT, 'skills', 'december', 'SKILL.md'), 'utf8')).match(/^version: (.+)$/m)[1].trim()
const skillVersionPattern = new RegExp('version: ' + skillVersion.replace(/[.]/g, '\.'))

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

async function filesBelow(root) {
  const found = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push(path.slice(root.length + 1).replaceAll('\\', '/'))
    }
  }
  await walk(root)
  return found.sort()
}

async function waitForServer(url, child) {
  let detail = ''
  child.stderr.on('data', (chunk) => { detail = (detail + chunk).slice(-1000) })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`scratch server exited early: ${detail}`)
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`scratch server did not start: ${detail}`)
}

test('server rejects untrusted or missing Host on every surface', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-host-check-'))
  const data = join(base, 'data')
  const port = await freePort()
  const url = `http://localhost:${port}`
  const generatedMcp = join(ROOT, `mcp.${port}.json`)
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DECEMBER_DATA_DIR: data,
      DECEMBER_CLAUDE: join(base, 'missing-claude'),
      DECEMBER_CODEX: join(base, 'missing-codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(generatedMcp, { force: true })
    await rm(base, { recursive: true, force: true })
  })
  await waitForServer(url, child)

  const rawStatus = (path, host, method = 'GET') => new Promise((resolveStatus, rejectStatus) => {
    const options = { host: '127.0.0.1', port, path, method, setHost: host !== null }
    if (host !== null) options.headers = { host }
    const req = httpRequest(options, (res) => {
      res.resume()
      resolveStatus(res.statusCode)
    })
    req.on('error', rejectStatus)
    req.end()
  })
  const missingHostStatus = () => new Promise((resolveStatus, rejectStatus) => {
    const socket = connectNet(port, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.end('GET /api/health HTTP/1.0\r\n\r\n'))
    socket.on('data', (chunk) => { response += chunk })
    socket.on('error', rejectStatus)
    socket.on('close', () => resolveStatus(Number(response.match(/^HTTP\/\d\.\d (\d+)/)?.[1])))
  })

  // Reads, static files, writes, and Pocket all pass through the same gate.
  assert.equal(await rawStatus('/api/state', 'evil.example'), 403)
  assert.equal(await rawStatus('/', 'evil.example'), 403)
  assert.equal(await rawStatus('/api/capture', 'evil.example', 'POST'), 403)
  assert.equal(await rawStatus('/api/pocket', 'evil.example'), 403)
  assert.equal(await rawStatus('/api/pocket/pair', 'evil.example', 'POST'), 403)
  assert.equal(await missingHostStatus(), 403, 'a missing Host fails closed')

  assert.equal(await rawStatus('/api/health', `localhost:${port}`), 200)
  assert.equal(await rawStatus('/api/health', `127.0.0.1:${port}`), 200)
  assert.equal((await fetch(`${url}/api/pocket`)).status, 200)

  const foreignWrite = await fetch(`${url}/api/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'nope' }),
  })
  assert.equal(foreignWrite.status, 403, 'Origin validation remains in force for writes')
})

test('JSON body limit is byte-exact, mutation-safe, and leaves the server healthy', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-body-limit-'))
  const data = join(base, 'data')
  const port = await freePort()
  const url = `http://localhost:${port}`
  const generatedMcp = join(ROOT, `mcp.${port}.json`)
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DECEMBER_DATA_DIR: data,
      DECEMBER_CLAUDE: join(base, 'missing-claude'),
      DECEMBER_CODEX: join(base, 'missing-codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(generatedMcp, { force: true })
    await rm(base, { recursive: true, force: true })
  })
  await waitForServer(url, child)

  const atLimit = JSON.stringify({ question: 'x'.repeat(999_985) })
  assert.equal(Buffer.byteLength(atLimit), 1_000_000)
  const accepted = await fetch(`${url}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: atLimit,
  })
  assert.equal(accepted.status, 503, 'the exact byte limit reaches the route')

  const before = await (await fetch(`${url}/api/state`)).json()
  const overLimit = JSON.stringify({ text: 'é'.repeat(499_995) })
  assert.equal(Buffer.byteLength(overLimit), 1_000_001)
  assert.ok(overLimit.length < 1_000_000, 'the limit counts bytes, not JavaScript characters')
  const refused = await fetch(`${url}/api/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: overLimit,
  })
  assert.equal(refused.status, 413)
  assert.match((await refused.json()).error, /body too large/)

  const health = await fetch(`${url}/api/health`)
  assert.equal(health.status, 200)
  assert.equal(child.exitCode, null)
  const after = await (await fetch(`${url}/api/state`)).json()
  assert.deepEqual(after.captures, before.captures, 'oversized capture made no partial mutation')
  assert.equal(after.updatedAt, before.updatedAt, 'oversized capture caused no persistence write')
})

test('/api/state uses revisions for compact polling and batch capture writes once', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-poll-'))
  const data = join(base, 'data')
  const port = await freePort()
  const url = `http://localhost:${port}`
  const generatedMcp = join(ROOT, `mcp.${port}.json`)
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DECEMBER_DATA_DIR: data,
      DECEMBER_CLAUDE: join(base, 'missing-claude'),
      DECEMBER_CODEX: join(base, 'missing-codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(generatedMcp, { force: true })
    await rm(base, { recursive: true, force: true })
  })
  await waitForServer(url, child)

  const first = await (await fetch(`${url}/api/state`)).json()
  assert.ok(first.fingerprint)
  assert.equal(first.revision, 0)
  const unchanged = await (await fetch(`${url}/api/state?since=${encodeURIComponent(first.fingerprint)}`)).json()
  assert.deepEqual(Object.keys(unchanged).sort(), ['canUndo', 'canUndoManual', 'fingerprint', 'revision', 'settle', 'unchanged'])
  assert.equal(unchanged.unchanged, true)

  const captured = await fetch(`${url}/api/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'paid rent\nran three miles\npaid rent' }),
  })
  assert.equal(captured.status, 200)
  const after = await (await fetch(`${url}/api/state?since=${encodeURIComponent(first.fingerprint)}`)).json()
  assert.equal(after.unchanged, undefined)
  assert.equal(after.revision, 1, 'the whole dump is one durable state write')
  assert.deepEqual(after.captures.map((capture) => capture.text), ['paid rent', 'ran three miles'])
})

test('client polling keeps live flags and rejects incomplete, stale, and overlapping responses', async () => {
  const source = await readFile(join(ROOT, 'public', 'app.js'), 'utf8')
  assert.match(source, /request !== pollRequest/)
  assert.match(source, /incoming\.revision < current\.revision/)
  assert.match(source, /!Array\.isArray\(incoming\.spaces\) \|\| !Array\.isArray\(incoming\.captures\)/)
  assert.match(source, /Object\.hasOwn\(incoming, field\)/)
})

test('scratch server GET is read-only and POST writes only the injected home', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-connect-server-'))
  const home = join(base, 'home')
  const appData = join(home, 'AppData', 'Roaming')
  const cursorConfig = join(home, '.cursor', 'mcp.json')
  const data = join(base, 'data')
  await mkdir(dirname(cursorConfig), { recursive: true })
  await writeFile(cursorConfig, '{"fixture":true,"mcpServers":{}}\n')
  const beforeGet = await filesBelow(home)
  const port = await freePort()
  const url = `http://localhost:${port}`
  const generatedMcp = join(ROOT, `mcp.${port}.json`)
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DECEMBER_DATA_DIR: data,
      DECEMBER_CONNECT_HOME: home,
      DECEMBER_CONNECT_APPDATA: appData,
      DECEMBER_CONNECT_ROOT: ROOT,
      DECEMBER_CONNECT_URL: url,
      DECEMBER_CLAUDE: join(base, 'missing-claude'),
      DECEMBER_CODEX: join(base, 'missing-codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(generatedMcp, { force: true })
    await rm(base, { recursive: true, force: true })
  })

  await waitForServer(url, child)
  const doctor = await fetch(`${url}/api/connect`)
  assert.equal(doctor.status, 200)
  const initial = await doctor.json()
  assert.equal(initial.clients.cursor.state, 'available')
  assert.deepEqual(await filesBelow(home), beforeGet, 'GET must not create config or skill files')

  const connected = await fetch(`${url}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'cursor' }),
  })
  assert.equal(connected.status, 200)
  const result = await connected.json()
  assert.equal(result.status.state, 'connected')
  const cursor = JSON.parse(await readFile(cursorConfig, 'utf8'))
  assert.equal(cursor.fixture, true)
  assert.equal(cursor.mcpServers.december.env.DECEMBER_URL, url)
  assert.match(await readFile(join(home, '.cursor', 'skills', 'december', 'SKILL.md'), 'utf8'), skillVersionPattern)
})

test('node connect.mjs --yes completes against an injected home', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-connect-cli-'))
  const home = join(base, 'home')
  const codexConfig = join(home, '.codex', 'config.toml')
  await mkdir(dirname(codexConfig), { recursive: true })
  await writeFile(codexConfig, 'model = "fixture"\n')
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/api/tools' ? { tools: [] } : { ok: true }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://localhost:${server.address().port}`
  t.after(async () => {
    server.close()
    await once(server, 'close')
    await rm(base, { recursive: true, force: true })
  })

  const child = spawn(process.execPath, ['connect.mjs', '--yes'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DECEMBER_DATA_DIR: join(base, 'data'),
      DECEMBER_CONNECT_HOME: home,
      DECEMBER_CONNECT_APPDATA: join(home, 'AppData', 'Roaming'),
      DECEMBER_CONNECT_ROOT: ROOT,
      DECEMBER_CONNECT_URL: url,
      DECEMBER_CLAUDE: join(base, 'missing-claude'),
      DECEMBER_CODEX: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, stderr)
  assert.match(stdout, /December connection doctor/)
  assert.match(stdout, /Codex\s+connected/)
  const config = await readFile(codexConfig, 'utf8')
  assert.match(config, /\[mcp_servers\.december\]/)
  assert.match(config, /DECEMBER_URL/)
  assert.match(await readFile(join(home, '.codex', 'skills', 'december', 'SKILL.md'), 'utf8'), skillVersionPattern)
})

test('shutdown drains the latest coalesced Pocket page', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-pocket-shutdown-'))
  const data = join(base, 'data')
  await mkdir(data, { recursive: true })
  const contentKey = Buffer.alloc(32, 7)
  const spaceId = 'space_fixture_123456'
  const fileStore = createSecretStore({ backend: 'file' })
  await writeFile(join(data, 'pocket.json'), JSON.stringify({
    version: 2,
    clientId: 'shutdown-fixture',
    space: { spaceId, epoch: 1, pairedAt: '2026-08-21T00:00:00.000Z' },
    secrets: pocketSecrets.seal(fileStore, {
      deviceId: 'device_fixture_123456',
      desktopToken: 'desktop_fixture_123456',
      contentKey: contentKey.toString('base64url'),
      epoch: 1,
    }),
    claim: null,
    nextPageRevision: 1,
    pendingPage: null,
    captureCursor: 0,
    lastSyncedAt: null,
    lastError: null,
    requiresRepair: false,
    pendingRevocation: null,
  }))

  let resolvePage
  const pageReceived = new Promise((resolveReceived) => { resolvePage = resolveReceived })
  const relay = createHttpServer(async (req, res) => {
    if (req.url === '/page' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75))
      const page = JSON.parse(body)
      resolvePage(page)
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ revision: page.revision }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [] }))
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')

  const port = await freePort()
  const url = `http://localhost:${port}`
  const generatedMcp = join(ROOT, `mcp.${port}.json`)
  const serverUrl = new URL('../server.mjs', import.meta.url).href
  const launcher = `const server = await import(${JSON.stringify(serverUrl)}); process.on('message', async () => { await server.shutdown({ exit: false }); process.send('drained', () => process.disconnect()) })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', launcher], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DECEMBER_DATA_DIR: data,
      DECEMBER_RELAY_URL: `http://127.0.0.1:${relay.address().port}`,
      DECEMBER_CLAUDE: join(base, 'missing-claude'),
      DECEMBER_CODEX: join(base, 'missing-codex'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const childExit = once(child, 'exit')
  let childError = ''
  child.stderr.on('data', (chunk) => { childError += chunk })
  t.after(async () => {
    if (child.exitCode === null) {
      if (child.connected) child.disconnect()
      child.kill('SIGKILL')
      await childExit.catch(() => {})
    }
    relay.close()
    await once(relay, 'close').catch(() => {})
    await rm(generatedMcp, { force: true })
    await rm(base, { recursive: true, force: true })
  })
  await waitForServer(url, child)

  const response = await fetch(`${url}/api/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'survive shutdown' }),
  })
  assert.equal(response.status, 200)
  child.send('shutdown')
  const [message] = await once(child, 'message')
  assert.equal(message, 'drained', childError)

  const uploaded = await Promise.race([
    pageReceived,
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('Pocket page was not drained')), 2000)),
  ])
  const decrypted = pocketCrypto.decrypt(contentKey, uploaded.payload, {
    spaceId,
    epoch: 1,
    minEpoch: 1,
    purpose: 'page',
    sequence: uploaded.revision,
  })
  assert.equal(decrypted.page.captures[0].text, 'survive shutdown')
  const [exitCode, exitSignal] = await childExit
  assert.equal(exitSignal, null, childError)
  assert.equal(exitCode, 0, childError)
})
