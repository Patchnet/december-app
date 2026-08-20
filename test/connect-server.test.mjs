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
