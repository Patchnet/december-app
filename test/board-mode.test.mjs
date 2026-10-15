import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import { detectMode, boardSlug, boardsDir, boardFromEnv, BOARD_MANNERS } from '../lib/board-mode.mjs'
import { ensureBoard } from '../lib/board-host.mjs'
import { planFrom, mirror, CARD } from '../scripts/board-hook.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `december-board-${name}-`)))

function gitRepo(name = 'december-app', branch = 'feat/agent-board') {
  const dir = join(temp('repo'), name)
  mkdirSync(dir)
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir })
  return dir
}

async function freePort() {
  const probe = createNetServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  probe.close()
  await once(probe, 'close')
  return port
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${url} never answered`)
}

// ------------------------------------------------------------- detection

test('inside a git repo the connection is a board keyed by the git root', () => {
  const repo = gitRepo()
  mkdirSync(join(repo, 'lib'))
  const info = detectMode({ cwd: join(repo, 'lib'), clientName: 'claude-code', env: {} })
  assert.equal(info.mode, 'board')
  assert.equal(info.root, repo)
  assert.equal(info.repo, 'december-app')
  assert.equal(info.branch, 'feat/agent-board', 'a repo with no commits still names its branch')
  assert.equal(info.slug, boardSlug(repo))
  assert.equal(info.client, 'claude-code', 'the client name is kept as a hint')
})

test('outside a repo the connection keeps the person\'s page', () => {
  const info = detectMode({ cwd: temp('plain'), clientName: 'claude-desktop', env: {} })
  assert.deepEqual(info, { mode: 'page', client: 'claude-desktop' })
})

test('DECEMBER_MODE overrides, and December\'s own organizer always gets the page', () => {
  const repo = gitRepo()
  assert.equal(detectMode({ cwd: repo, env: { DECEMBER_MODE: 'page' } }).mode, 'page')
  assert.equal(detectMode({ cwd: repo, env: { DECEMBER_ACCESS: 'organizer' } }).mode, 'page')
  assert.equal(detectMode({ cwd: repo, env: { DECEMBER_ACCESS: 'read' } }).mode, 'page')
  const plain = temp('forced')
  const forced = detectMode({ cwd: plain, env: { DECEMBER_MODE: 'board' } })
  assert.equal(forced.mode, 'board')
  assert.equal(forced.root, plain)
})

test('a board slug is stable for one checkout and distinct across checkouts', () => {
  const a = gitRepo()
  const b = gitRepo()
  assert.equal(boardSlug(a), boardSlug(a))
  assert.notEqual(boardSlug(a), boardSlug(b), 'two checkouts of december-app never share a board')
  assert.match(boardSlug(a), /^december-app-[0-9a-f]{8}$/)
  assert.match(boardSlug('/x/My Repo!'), /^my-repo-[0-9a-f]{8}$/)
})

test('boards live beside the December data folder unless DECEMBER_BOARDS_DIR says otherwise', () => {
  assert.equal(boardsDir({ DECEMBER_BOARDS_DIR: '/tmp/b' }), resolve('/tmp/b'))
  assert.equal(boardsDir({ DECEMBER_DATA_DIR: '/x/December/data' }), resolve('/x/December/boards'))
  assert.equal(boardsDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/December/boards')
  assert.equal(boardFromEnv({}), null)
  assert.deepEqual(boardFromEnv({ DECEMBER_MODE: 'board', DECEMBER_BOARD_REPO: 'r', DECEMBER_BOARD_BRANCH: 'b', DECEMBER_BOARD_ROOT: '/r' }), { repo: 'r', branch: 'b', root: '/r' })
})

// ------------------------------------------------------------- hosting

test('ensureBoard starts one server per board and reuses it while it answers', async (t) => {
  const boards = temp('boards')
  const servers = []
  t.after(() => servers.forEach((s) => s.close()))
  let spawned = 0
  const spawnServer = ({ dir, port }) => {
    spawned++
    const s = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url === '/api/health' ? { ok: true, port, board: { dir } } : {}))
    }).listen(port, '127.0.0.1')
    servers.push(s)
    return { pid: 4242, exitCode: null, signalCode: null }
  }
  const info = { mode: 'board', root: '/code/december-app', repo: 'december-app', branch: 'feat/agent-board', slug: 'december-app-0000beef' }
  const firstPort = await freePort()
  const first = await ensureBoard(info, { root: boards, spawnServer, firstPort })
  assert.equal(first.reused, false)
  assert.equal(first.url, `http://localhost:${first.port}/`)
  assert.equal(first.dir, join(boards, info.slug))
  const meta = JSON.parse(readFileSync(join(first.dir, 'board.json'), 'utf8'))
  assert.equal(meta.kind, 'board')
  assert.equal(meta.repo, 'december-app')
  assert.equal(meta.branch, 'feat/agent-board')
  assert.equal(JSON.parse(readFileSync(join(first.dir, 'server.json'), 'utf8')).port, first.port)

  const second = await ensureBoard({ ...info, branch: 'main' }, { root: boards, spawnServer, firstPort })
  assert.equal(second.reused, true)
  assert.equal(second.port, first.port)
  assert.equal(spawned, 1)
  const kept = JSON.parse(readFileSync(join(first.dir, 'board.json'), 'utf8'))
  assert.equal(kept.createdAt, meta.createdAt, 'a board keeps its birth date')
  assert.equal(kept.branch, 'main')

  // a server.json whose port no longer answers as this board starts a new one
  servers.pop().close()
  writeFileSync(join(first.dir, 'server.json'), JSON.stringify({ port: first.port, pid: 1 }))
  const third = await ensureBoard(info, { root: boards, spawnServer, firstPort })
  assert.equal(third.reused, false)
  assert.equal(spawned, 2)
})

// ------------------------------------------------------------- the server

async function startServer(t, env) {
  const port = await freePort()
  const data = temp('data')
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DECEMBER_DATA_DIR: data, DECEMBER_CLAUDE: join(data, 'none'), DECEMBER_CODEX: join(data, 'none'), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    await rm(data, { recursive: true, force: true })
  })
  const base = `http://localhost:${port}`
  await waitFor(`${base}/api/health`)
  return { base, data }
}

const get = (url) => fetch(url).then((r) => r.json())
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const call = (base, name, args = {}) => post(`${base}/api/tool`, { name, arguments: args }).then((r) => r.result)

test('a board server names its board, serves board manners, and leaves notes for the agent', async (t) => {
  const repo = gitRepo()
  const { base, data } = await startServer(t, { DECEMBER_MODE: 'board', DECEMBER_BOARD_REPO: 'december-app', DECEMBER_BOARD_ROOT: repo, DECEMBER_BOARD_BRANCH: 'feat/agent-board' })
  const health = await get(`${base}/api/health`)
  assert.equal(health.board.dir, data)
  const state = await get(`${base}/api/state`)
  assert.deepEqual(state.board, { repo: 'december-app', branch: 'feat/agent-board', root: repo })
  assert.equal((await get(`${base}/api/manners`)).manners, BOARD_MANNERS)
  assert.equal((await fetch(`${base}/api/pocket`)).status, 404, 'a board has no phone')
  assert.ok(!existsSync(join(ROOT, `mcp.${new URL(base).port}.json`)), 'no organizer config is written for a board')

  // what the person types stays in the inbox, visible to the agent
  await post(`${base}/api/capture`, { text: 'Keep the README line short' })
  await new Promise((r) => setTimeout(r, 300))
  const after = await get(`${base}/api/state`)
  assert.equal(after.captures.length, 1)
  assert.equal(after.settle.captureOnly, true)
  assert.equal(after.settle.running, false)
  const view = await call(base, 'december_view')
  assert.deepEqual(view.captures.map((c) => c.text), ['Keep the README line short'])

  // an answer travels with its question
  await call(base, 'december_ask', { question: 'Push feat/agent-board to origin?', options: ['Push', 'Not yet'] })
  const asked = await get(`${base}/api/state`)
  await post(`${base}/api/answer`, { askId: asked.ask.id, choice: 'Push' })
  const answered = await call(base, 'december_view')
  assert.ok(answered.captures.some((c) => c.text === 'Push feat/agent-board to origin? Push'))
})

test('the hook mirrors a todo list onto one card and keeps it in step', async (t) => {
  const repo = gitRepo()
  const { base } = await startServer(t, { DECEMBER_MODE: 'board', DECEMBER_BOARD_REPO: 'december-app', DECEMBER_BOARD_ROOT: repo, DECEMBER_BOARD_BRANCH: 'feat/agent-board' })
  const todos = (statuses) => ({ tool_name: 'TodoWrite', session_id: 's1', tool_input: { todos: [
    { content: 'Read the git root', status: statuses[0] },
    { content: 'Start one board server per repo', status: statuses[1] },
  ] } })
  let plan = planFrom(todos(['completed', 'in_progress']))
  const blockId = await mirror(base, plan, null)
  plan = planFrom(todos(['completed', 'completed']), plan)
  assert.equal(await mirror(base, plan, blockId), blockId, 'the same card, not a second one')
  const { block, space } = await call(base, 'december_read_block', { blockId })
  assert.equal(space, CARD)
  assert.deepEqual(block.items.map((i) => [i.text, i.done]), [['Read the git root', true], ['Start one board server per repo', true]])

  assert.equal(planFrom({ tool_name: 'Bash' }), null)
  const created = planFrom({ tool_name: 'TaskCreate', tool_input: { subject: 'Write docs' }, tool_response: { task: { id: '7' } } })
  assert.deepEqual(created, { 'task:7': { text: 'Write docs', done: false } })
  assert.deepEqual(planFrom({ tool_name: 'TaskUpdate', tool_input: { taskId: '7', status: 'completed' } }, created), { 'task:7': { text: 'Write docs', done: true } })
})

test('the page server stays exactly the page: no board in health or state', async (t) => {
  const { base } = await startServer(t, {})
  const health = await get(`${base}/api/health`)
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'port'])
  assert.ok(!('board' in (await get(`${base}/api/state`))))
})

// ------------------------------------------------------------- the adapter

test('initialize inside a repo starts the board and leads with its address', async (t) => {
  const repo = gitRepo()
  const boards = temp('adapter-boards')
  const child = spawn(process.execPath, [join(ROOT, 'mcp-server.mjs')], {
    cwd: repo,
    env: { ...process.env, DECEMBER_MODE: '', DECEMBER_BOARDS_DIR: boards, DECEMBER_URL: 'http://localhost:9' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout })
  const replies = new Map()
  lines.on('line', (line) => { const m = JSON.parse(line); replies.get(m.id)?.(m) })
  const rpc = (id, method, params) => new Promise((done) => { replies.set(id, done); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const dir = join(boards, boardSlug(repo))
  t.after(async () => {
    child.kill('SIGTERM')
    try { process.kill(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')).pid, 'SIGTERM') } catch {}
    await new Promise((r) => setTimeout(r, 300))
    await rm(boards, { recursive: true, force: true })
  })

  const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })
  const text = init.result.instructions
  const url = /^December board for december-app · feat\/agent-board: (http:\/\/localhost:(\d+)\/)/.exec(text)
  assert.ok(url, text)
  assert.ok(Number(url[2]) >= 3031)
  assert.match(text, /Open http:\/\/localhost:\d+\/ in your browser now/)
  assert.match(text, /You own this board/)

  const made = await rpc(2, 'tools/call', { name: 'december_create_space', arguments: { name: 'Mode detection' } })
  assert.ok(!made.result.isError, made.result.content[0].text)
  const state = await get(`${url[1]}api/state`)
  assert.deepEqual(state.spaces.map((s) => s.name), ['Mode detection'])
  assert.equal(state.board.root, repo)
})
