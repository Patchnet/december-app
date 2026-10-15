// The board's own tools, against a real board server: the plan, proof the
// board checks itself, drift, notes, sessions, editions and the boards sheet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = (name) => realpathSync.native(mkdtempSync(join(tmpdir(), `december-tools-${name}-`)))
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8' }).trim()
const write = (root, path, text = 'x\n') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }

function repo() {
  const dir = join(temp('repo'), 'december-app')
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, 'README.md')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  git(dir, 'checkout', '-q', '-b', 'feat/agent-board')
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

/** A board server on a scratch store, its folder inside a scratch boards root. */
async function board(t, root, env = {}) {
  const port = await freePort()
  const boards = temp('boards')
  const data = join(boards, 'december-app-test')
  mkdirSync(data)
  writeFileSync(join(data, 'board.json'), JSON.stringify({ kind: 'board', repo: 'december-app', root, branch: 'feat/agent-board' }))
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DECEMBER_DATA_DIR: data, DECEMBER_MODE: 'board', DECEMBER_BOARD_REPO: 'december-app', DECEMBER_BOARD_ROOT: root, DECEMBER_BOARD_BRANCH: 'feat/agent-board', DECEMBER_CLAUDE: join(data, 'none'), DECEMBER_CODEX: join(data, 'none'), DECEMBER_BOARD_OPEN: 'never', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    await rm(boards, { recursive: true, force: true })
  })
  const base = `http://localhost:${port}`
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  const get = (path) => fetch(base + path).then((r) => r.json())
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }))
  const as = (client) => async (name, args = {}) => {
    const out = await post('/api/tool', { name, arguments: args }, { 'x-december-client': client })
    if (out.status !== 200) throw new Error(out.error)
    return out.result
  }
  return { base, data, boards, get, post, claude: as('claude-code'), codex: as('codex-mcp-client') }
}

const rowsOf = (state, card) => state.spaces.find((s) => s.name === card).blocks.find((b) => b.type === 'list').items

test('a plan is cards of tasks in order; one task in hand per agent; the tick inks only on proof the board checked', async (t) => {
  const root = repo()
  const b = await board(t, root)
  const added = await b.claude('december_task', { card: 'Mode detection', action: 'add', tasks: ['Read the git root', 'Start one server per repo', 'Hand back the URL'] })
  assert.deepEqual(added.tasks.map((x) => [x.text, x.state]), [['Read the git root', 'queued'], ['Start one server per repo', 'queued'], ['Hand back the URL', 'queued']])
  assert.deepEqual(added.card, { id: added.card.id, name: 'Mode detection', done: 0, total: 3 })
  // adding the same words again never doubles a task
  assert.equal((await b.claude('december_task', { card: 'Mode detection', action: 'add', tasks: ['read the git root'] })).card.total, 3)

  await b.claude('december_task', { card: 'Mode detection', action: 'start', task: 'Read the git root' })
  await b.claude('december_task', { card: 'Mode detection', action: 'start', task: 'Start one' })
  await b.codex('december_task', { card: 'Board stage', action: 'start', task: 'Show the dateline' })
  let state = await b.get('/api/state')
  assert.deepEqual(rowsOf(state, 'Mode detection').map((r) => r.state), ['queued', 'doing', 'queued'], 'starting a task puts the last one back in the plan')
  assert.equal(rowsOf(state, 'Board stage')[0].state, 'doing', "another agent's task in hand is its own")
  assert.equal(rowsOf(state, 'Board stage')[0].session, 'codex')

  write(root, 'lib/board-a.mjs')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'board: a')
  const sha = git(root, 'rev-parse', '--short', 'HEAD')
  const proven = await b.claude('december_task', { card: 'Mode detection', action: 'done', task: 'Start one', proof: { tests: '14 pass', commit: sha } })
  assert.deepEqual(proven.task.proof, { tests: '14 pass', commit: sha, ok: true })
  assert.equal(proven.note, undefined)

  const held = await b.claude('december_task', { card: 'Mode detection', action: 'done', task: 'Read the git root', proof: { tests: '8 pass' } })
  assert.equal(held.task.proof.ok, false)
  assert.match(held.note, /held/i)
  const wrong = await b.claude('december_task', { card: 'Mode detection', action: 'done', task: 'Hand back', proof: { commit: 'deadbee' } })
  assert.equal(wrong.task.proof.ok, false)
  assert.match(wrong.note, /No commit deadbee/)
  const file = await b.claude('december_task', { card: 'Mode detection', action: 'queue', task: 'Hand back' })
  assert.equal(file.task.state, 'queued')
  assert.equal((await b.claude('december_task', { card: 'Mode detection', action: 'done', task: 'Hand back', proof: { file: 'lib/board-a.mjs' } })).task.proof.ok, true)

  await b.claude('december_task', { card: 'Hooks', action: 'add', tasks: ['Poll the todo file', "Mirror Codex's plan"] })
  assert.equal((await b.claude('december_task', { card: 'Hooks', action: 'cancel', task: 'Poll', reason: 'replaced by the hook' })).task.state, 'cancelled')
  await b.claude('december_task', { card: 'Hooks', action: 'block', task: 'Codex', reason: 'Codex hooks unconfirmed' })
  state = await b.get('/api/state')
  assert.deepEqual(rowsOf(state, 'Hooks').map((r) => [r.state, r.reason]), [['cancelled', 'replaced by the hook'], ['blocked', 'Codex hooks unconfirmed']])

  // a finished workstream stays on the board: no auto-archive here
  assert.equal(state.spaces.find((s) => s.name === 'Mode detection').finished, false)
  await assert.rejects(b.claude('december_task', { card: 'Mode detection', action: 'done', task: 'Something else entirely' }).then(() => b.claude('december_task', { card: 'Nope', action: 'block', task: 'x' })), /no card named Nope/)
  await assert.rejects(b.claude('december_task', { card: 'Hooks', action: 'start', task: '' }), /no task/)
})

test('scope turns stray files into drift; the person\'s notes and ticks reach the agent', async (t) => {
  const root = repo()
  const b = await board(t, root)
  await b.claude('december_task', { card: 'Mode detection', action: 'add', tasks: ['Read the git root'] })
  // git is read a few seconds at a time; a board write reads it fresh
  write(root, 'lib/board-a.mjs')
  write(root, 'package-lock.json')
  const scoped = await b.claude('december_scope', { card: 'Mode detection', paths: ['lib/board-*.mjs'] })
  assert.deepEqual(scoped.scope, ['lib/board-*.mjs'])
  assert.deepEqual(scoped.drift, ['package-lock.json'])
  const state = await b.get('/api/state')
  assert.deepEqual(state.board.files.map((f) => [f.path, !!f.card, f.outside]), [['lib/board-a.mjs', true, false], ['package-lock.json', false, true]])
  assert.deepEqual(state.board.drift.map((d) => d.path), ['package-lock.json'])
  assert.equal(state.board.base, 'main')

  await b.post('/api/capture', { text: 'Keep the hook install to one line' })
  const out = await b.claude('december_task', { card: 'Mode detection', action: 'start', task: 'Read the git root' })
  assert.deepEqual(out.unread.map((n) => n.text), ['Keep the hook install to one line'])
  assert.deepEqual(out.drift, ['package-lock.json'])
  await b.claude('december_file_capture', { captureId: out.unread[0].id, space: 'Mode detection', summary: 'noted' })
  assert.deepEqual((await b.claude('december_view')).notes, [])

  // the person's own tick is proof: they looked
  const row = rowsOf(await b.get('/api/state'), 'Mode detection')[0]
  const list = (await b.get('/api/state')).spaces[0].blocks[0]
  await b.post('/api/check', { blockId: list.id, itemId: row.id, done: true })
  const ticked = rowsOf(await b.get('/api/state'), 'Mode detection')[0]
  assert.equal(ticked.state, 'done')
  assert.deepEqual(ticked.proof, { by: 'you', ok: true })
})

test('a hand-off composes the edition, and the next session opens with it', async (t) => {
  const root = repo()
  const b = await board(t, root)
  const first = await b.post('/api/board/hello', { client: 'claude-code' })
  assert.equal(first.session, 1)
  assert.equal(first.latest, null)
  await b.claude('december_task', { card: 'Mode detection', action: 'add', tasks: ['Read the git root', 'Start one server'] })
  await b.claude('december_task', { card: 'Mode detection', action: 'done', task: 'Read the git root', proof: { file: 'README.md' } })
  await b.claude('december_ask', { question: 'Push feat/agent-board to origin?', options: ['Push', 'Not yet'] })

  const live = await b.get('/api/board/edition')
  assert.equal(live.live.no, 1)
  assert.equal(live.live.endedAt, null)
  assert.deepEqual(live.live.figures, { done: 1, total: 2, proven: 1, commits: 0, files: 0, outside: 0 })
  assert.equal(live.live.headline, 'One task done on Mode detection')
  assert.deepEqual(live.live.waiting.map((w) => w.question), ['Push feat/agent-board to origin?'])
  assert.deepEqual(live.live.next, ['Start one server'])
  assert.equal((await b.get('/api/state')).board.waits.length, 1, 'the ask is a wait in this session')

  const handed = await b.claude('december_handoff', { summary: 'Mode detection reads the repo root', next: ['Start one server per repo'] })
  assert.equal(handed.edition, 1)
  const kept = await b.get('/api/board/edition?no=1')
  assert.equal(kept.edition.headline, 'Mode detection reads the repo root')
  assert.equal(kept.edition.auto, false)
  assert.ok(kept.edition.endedAt)
  assert.equal((await fetch(`${b.base}/api/board/edition?no=9`)).status, 404)

  const second = await b.post('/api/board/hello', { client: 'claude-code' })
  assert.equal(second.session, 2)
  assert.deepEqual(second.latest, { no: 1, headline: 'Mode detection reads the repo root', next: ['Start one server per repo'], endedAt: kept.edition.endedAt })
  const editions = await b.get('/api/board/edition')
  assert.equal(editions.live.no, 2)
  assert.deepEqual(editions.past.map((p) => [p.no, p.headline]), [[1, 'Mode detection reads the repo root']])
  const state = await b.get('/api/state')
  assert.equal(state.board.session.no, 2)
  assert.deepEqual(state.board.sessions.map((s) => [s.tag, s.client]), [['claude', 'claude-code']])
  assert.equal(state.board.editions, 1)
})

test('a board offers the plan\'s tools and not the person\'s; the boards sheet lists this board', async (t) => {
  const root = repo()
  const b = await board(t, root)
  const names = (await b.get('/api/tools')).tools.map((x) => x.name)
  for (const name of ['december_task', 'december_scope', 'december_handoff', 'december_view', 'december_ask']) assert.ok(names.includes(name), name)
  for (const name of ['december_write_about', 'december_learn', 'december_set_goal', 'december_capture', 'december_suggest']) assert.ok(!names.includes(name), name)
  const summary = await b.get('/api/board/summary')
  assert.equal(summary.repo, 'december-app')
  assert.equal(summary.state, 'idle')
  await b.claude('december_task', { card: 'Mode detection', action: 'start', task: 'Read the git root' })
  assert.equal((await b.get('/api/board/summary')).state, 'working')
  assert.equal((await b.get('/api/board/summary')).task, 'Read the git root')
  // a second board's folder, with no server: listed idle from its own files
  mkdirSync(join(b.boards, 'other-abc'))
  writeFileSync(join(b.boards, 'other-abc', 'board.json'), JSON.stringify({ repo: 'other', branch: 'main' }))
  const { boards } = await b.get('/api/boards')
  assert.deepEqual(boards.map((x) => [x.repo, x.state, x.here]), [['december-app', 'working', true], ['other', 'idle', false]])
  assert.equal((await b.get('/api/health')).viewers, 0)
})

test('the board tools need a board: on the person\'s page they refuse', async (t) => {
  const port = await freePort()
  const data = temp('page')
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DECEMBER_DATA_DIR: data, DECEMBER_MODE: '', DECEMBER_CLAUDE: join(data, 'none'), DECEMBER_CODEX: join(data, 'none') }, stdio: 'ignore' })
  t.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); await rm(data, { recursive: true, force: true }) })
  const base = `http://localhost:${port}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 100)) }
  const names = (await fetch(`${base}/api/tools`).then((r) => r.json())).tools.map((x) => x.name)
  assert.ok(!names.includes('december_task'))
  assert.ok(names.includes('december_write_about'))
  const res = await fetch(`${base}/api/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'december_task', arguments: { card: 'x', action: 'add', tasks: ['y'] } }) })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /works on a board/)
  assert.equal((await fetch(`${base}/api/board/edition`)).status, 404)
})
