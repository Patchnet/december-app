// One December server per board. The MCP adapter calls ensureBoard at
// initialize: the board's server is reused when it answers as that board,
// otherwise a detached one is started on the first free port from 3031.
// No imports from core.mjs here: the adapter must never load a page.

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boardsDir } from './board-mode.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIRST_PORT = 3031
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Does a December server answer on this port, as the board kept in dir? */
export async function answersAs(port, dir, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    return !!body.ok && !!body.board?.dir && resolve(body.board.dir) === resolve(dir)
  } catch {
    return false
  }
}

const portFree = (port) => new Promise((done) => {
  const probe = createServer()
  probe.once('error', () => done(false))
  probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
})

export async function firstFreePort(from = FIRST_PORT) {
  for (let port = from; port < from + 200; port++) if (await portFree(port)) return port
  throw new Error(`no free port from ${from}`)
}

/** Start server.mjs for one board, detached so it outlives the session. */
export function startServer({ dir, port, board, env = process.env }) {
  const log = openSync(join(dir, 'server.log'), 'a')
  const childEnv = { ...env, PORT: String(port), DECEMBER_DATA_DIR: dir, DECEMBER_MODE: 'board',
    DECEMBER_BOARD_REPO: board.repo, DECEMBER_BOARD_ROOT: board.root, DECEMBER_BOARD_BRANCH: board.branch }
  delete childEnv.DECEMBER_ACCESS
  delete childEnv.DECEMBER_ORGANIZER_TOKEN
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: ROOT, env: childEnv, detached: true, stdio: ['ignore', log, log] })
  closeSync(log)
  child.unref()
  return child
}

// Two sessions opening the same repo at once must not start two servers.
async function takeLock(file, timeoutMs) {
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      closeSync(openSync(file, 'wx'))
      return () => unlink(file).catch(() => {})
    } catch {
      const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (age > 30_000) await unlink(file).catch(() => {})
      else if (Date.now() > until) throw new Error('another session is still starting this board')
      else await sleep(150)
    }
  }
}

/**
 * Make sure a board exists and its server answers. `info` is detectMode's
 * board result. Returns { url, port, dir, reused }.
 */
export async function ensureBoard(info, { env = process.env, root = boardsDir(env), spawnServer = startServer, fetchImpl = fetch, firstPort = FIRST_PORT, timeoutMs = 8_000 } = {}) {
  const dir = join(root, info.slug)
  mkdirSync(dir, { recursive: true })
  const metaFile = join(dir, 'board.json')
  const meta = await readJson(metaFile)
  const board = { kind: 'board', repo: info.repo, root: info.root, branch: info.branch, createdAt: meta?.createdAt || new Date().toISOString() }
  await writeFile(metaFile, JSON.stringify(board, null, 2) + '\n')

  const release = await takeLock(join(dir, 'server.lock'), timeoutMs)
  try {
    const known = await readJson(join(dir, 'server.json'))
    if (known?.port && await answersAs(known.port, dir, fetchImpl)) {
      return { url: `http://localhost:${known.port}/`, port: known.port, dir, reused: true }
    }
    let port = firstPort
    for (let attempt = 0; attempt < 3; attempt++) {
      port = await firstFreePort(port)
      const child = spawnServer({ dir, port, board, env })
      await writeFile(join(dir, 'server.json'), JSON.stringify({ port, pid: child.pid, startedAt: new Date().toISOString() }, null, 2) + '\n')
      const alive = () => child.exitCode == null && child.signalCode == null
      const until = Date.now() + timeoutMs
      while (Date.now() < until && alive()) {
        if (await answersAs(port, dir, fetchImpl)) return { url: `http://localhost:${port}/`, port, dir, reused: false }
        await sleep(150)
      }
      if (alive()) throw new Error(`the board server on ${port} never answered`)
      port++ // lost the port to another server between the probe and the listen
    }
    throw new Error('the board server would not start; see server.log in the board folder')
  } finally {
    await release()
  }
}
