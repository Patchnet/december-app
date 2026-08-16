import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import { manners, resetManners, skillBody, skillVersion } from '../lib/manners.mjs'
import { TOOLS } from '../lib/tools.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = join(ROOT, 'skills', 'december', 'SKILL.md')

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

async function waitForServer(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child && child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`)
    try {
      const res = await fetch(`${url}/api/state`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server never came up')
}

/** Speak JSON-RPC to the MCP adapter over stdio and read one reply. */
async function initializeAdapter(env) {
  const child = spawn(process.execPath, ['mcp-server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const reply = once(lines, 'line')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
  const [line] = await reply
  child.kill('SIGTERM')
  return JSON.parse(line)
}

// ------------------------------------------------------------------ parsing

test('the skill body is the prose, and the version comes from the frontmatter', () => {
  const text = '---\nname: december\nversion: 1.2.3\n---\n\n# December\n\nBe kind.\n'
  assert.equal(skillBody(text), '# December\n\nBe kind.')
  assert.equal(skillVersion(text), '1.2.3')
})

test('manners without frontmatter are still served, at an unknown version', () => {
  assert.equal(skillBody('# December\n\nBe kind.\n'), '# December\n\nBe kind.')
  assert.equal(skillVersion('# December'), '0.0.0')
})

// ------------------------------------------------------------------- source

test('manners read the canonical skill, so the two carriers cannot drift', async () => {
  resetManners()
  const served = await manners()
  const canonical = await readFile(SKILL, 'utf8')
  assert.equal(served.version, skillVersion(canonical))
  assert.equal(served.manners, skillBody(canonical))
  // the load-bearing rules an assistant must not be missing
  assert.match(served.manners, /House manners/)
  assert.match(served.manners, /Never delete/)
  assert.doesNotMatch(served.manners, /^---$/m, 'frontmatter must not reach an assistant')
})

// ------------------------------------------------------------------ the API

test('GET /api/manners serves the live text and its version', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'december-manners-'))
  const port = await freePort()
  const url = `http://localhost:${port}`
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DECEMBER_DATA_DIR: join(base, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(base, { recursive: true, force: true })
  })

  await waitForServer(url, child)
  const res = await fetch(`${url}/api/manners`)
  assert.equal(res.status, 200)
  const body = await res.json()
  const canonical = await readFile(SKILL, 'utf8')
  assert.equal(body.version, skillVersion(canonical))
  assert.equal(body.manners, skillBody(canonical))
})

// -------------------------------------------------------------- the adapter

test('initialize carries the manners as MCP instructions', async (t) => {
  const port = await freePort()
  const stub = createHttpServer((req, res) => {
    if (req.url === '/api/manners') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ manners: 'Be a good guest.', version: '9.9.9' }))
      return
    }
    res.writeHead(404).end()
  })
  stub.listen(port, '127.0.0.1')
  await once(stub, 'listening')
  t.after(() => stub.close())

  const reply = await initializeAdapter({ DECEMBER_URL: `http://localhost:${port}` })
  assert.equal(reply.result.instructions, 'Be a good guest.')
  assert.equal(reply.result.serverInfo.name, 'december')
})

test('a December that is not running still yields a usable handshake', async () => {
  const port = await freePort() // nothing is listening here
  const reply = await initializeAdapter({ DECEMBER_URL: `http://localhost:${port}` })
  assert.equal(reply.result.serverInfo.name, 'december')
  assert.equal(reply.result.protocolVersion, '2025-06-18')
  assert.ok(!('instructions' in reply.result), 'absent manners must not become an empty instruction')
})

test('empty manners are omitted rather than sent as a blank instruction', async (t) => {
  const port = await freePort()
  const stub = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ manners: '', version: '0.0.0' }))
  })
  stub.listen(port, '127.0.0.1')
  await once(stub, 'listening')
  t.after(() => stub.close())

  const reply = await initializeAdapter({ DECEMBER_URL: `http://localhost:${port}` })
  assert.ok(!('instructions' in reply.result))
})

// --------------------------------------------------------------- the schema

test('an ask requires only its question, so a typed answer can omit options', () => {
  const ask = TOOLS.find((t) => t.name === 'december_ask')
  assert.deepEqual(ask.inputSchema.required, ['question'])
  assert.ok(ask.inputSchema.properties.options, 'options stay available for a choice')
})
