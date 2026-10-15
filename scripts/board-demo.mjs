#!/usr/bin/env node
// Board mode, end to end: a scratch git repo, the real MCP adapter spawned in
// it as a stdio child, and a short coding session played through tools/call.
// The board server is left running so you can watch it in a browser.
//
//   node scripts/board-demo.mjs [--dir <folder>]
//
// Everything lives under --dir (default: a folder in the OS temp dir):
// the repo at demo-repo/december-app and the boards at boards/, unless
// DECEMBER_BOARDS_DIR says otherwise. The person's own December is never used.

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { detectMode } from '../lib/board-mode.mjs'
import { answersAs } from '../lib/board-host.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const flag = process.argv.indexOf('--dir')
const BASE_DIR = resolve(flag > 0 ? process.argv[flag + 1] : join(tmpdir(), 'december-board-demo'))
const REPO = join(BASE_DIR, 'demo-repo', 'december-app')
const BOARDS = resolve(process.env.DECEMBER_BOARDS_DIR || join(BASE_DIR, 'boards'))
const BRANCH = 'feat/agent-board'
const started = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// --fast plays the session in a few seconds (tests, screenshots)
const PACE = process.argv.includes('--fast') ? 150 : 1000
const clock = () => { const s = Math.round((Date.now() - started) / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const say = (line) => console.log(`[${clock()}] ${line}`)

// ---------------------------------------------------------- a scratch repo

function freshRepo() {
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(join(REPO, 'lib'), { recursive: true })
  const git = (...args) => execFileSync('git', ['-c', 'user.name=December demo', '-c', 'user.email=demo@localhost', ...args], { cwd: REPO, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(REPO, 'README.md'), '# december-app (demo)\n')
  writeFileSync(join(REPO, 'mcp-server.mjs'), '// demo stand-in\n')
  git('add', '.')
  git('commit', '-q', '-m', 'demo: initial commit')
  git('checkout', '-q', '-b', BRANCH)
}

// A demo starts from an empty board: stop the last run's server, clear its store.
async function clearBoard(slug) {
  const dir = join(BOARDS, slug)
  try {
    const { port, pid } = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))
    if (await answersAs(port, dir)) {
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 40 && await answersAs(port, dir); i++) await sleep(100)
    }
  } catch {}
  rmSync(dir, { recursive: true, force: true })
}

// A second repo's board, idle since yesterday, so the boards door has
// somewhere to go. No server: the sheet reads it from its own files.
function idleBoard() {
  const dir = join(BOARDS, 'notes-sync-demo')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const day = new Date(Date.now() - 26 * 3600_000)
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ kind: 'board', repo: 'notes-sync', root: join(BASE_DIR, 'demo-repo', 'notes-sync'), branch: 'fix/offline-queue' }, null, 2) + '\n')
  writeFileSync(join(dir, 'board-editions.json'), JSON.stringify([{ no: 4, repo: 'notes-sync', branch: 'fix/offline-queue', startedAt: new Date(+day - 5400_000).toISOString(), endedAt: day.toISOString(), auto: false, headline: 'The offline queue drains in order', figures: { done: 5, total: 5, proven: 5, commits: 3, files: 6, outside: 0 }, cards: [], waiting: [], next: [], drift: [] }], null, 2) + '\n')
  writeFileSync(join(dir, 'state.json'), '{}\n')
  utimesSync(join(dir, 'state.json'), day, day)
}

// ---------------------------------------------------------- MCP over stdio

function connect() {
  const env = { ...process.env, DECEMBER_BOARDS_DIR: BOARDS, DECEMBER_DATA_DIR: join(BASE_DIR, 'page', 'data'), DECEMBER_URL: 'http://localhost:3999', DECEMBER_BOARD_OPEN: process.env.DECEMBER_BOARD_OPEN || 'never' }
  delete env.DECEMBER_MODE // the mode comes from the cwd, as it does for a real session
  delete env.DECEMBER_ACCESS
  const child = spawn(process.execPath, [join(ROOT, 'mcp-server.mjs')], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line)
    waiting.get(msg.id)?.(msg)
    waiting.delete(msg.id)
  })
  let id = 0
  const request = (method, params) => new Promise((done) => {
    waiting.set(++id, done)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  const call = async (name, args = {}) => {
    const reply = await request('tools/call', { name, arguments: args })
    const text = reply.result?.content?.[0]?.text || reply.error?.message || ''
    if (reply.error || reply.result?.isError) throw new Error(`${name}: ${text}`)
    return JSON.parse(text)
  }
  return { child, request, notify, call }
}

// ---------------------------------------------------------- the session

freshRepo()
const info = detectMode({ cwd: REPO, env: {} })
await clearBoard(info.slug)
idleBoard()
console.log('December board demo')
console.log(`  repo    ${REPO} (${info.branch})`)
console.log(`  boards  ${BOARDS}`)
console.log('')

const mcp = connect()
say('→ initialize  clientInfo { name: "claude-code" }')
const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'demo' } })
mcp.notify('notifications/initialized')
const instructions = init.result?.instructions || ''
say('← instructions:')
for (const line of instructions.split('\n')) console.log(`    │ ${line}`)
const url = /http:\/\/localhost:(\d+)\//.exec(instructions)
if (!url) {
  console.error('\nNo board URL came back at initialize.')
  mcp.child.kill()
  process.exit(1)
}
say(`board URL at initialize: ${url[0]}  (port ${url[1]})`)
const tools = (await mcp.request('tools/list')).result.tools
say(`← tools/list: ${tools.length} tools`)
await mcp.call('december_view')
await sleep(PACE)

// Two sessions. The first plans and hands off; the second picks up from the
// hand-off with a second agent beside it. Every proof is a real commit or
// file in the scratch repo, and one file strays outside any card's scope.
const gitc = (...args) => execFileSync('git', ['-c', 'user.name=December demo', '-c', 'user.email=demo@localhost', ...args], { cwd: REPO, encoding: 'utf8' }).trim()
const write = (path, text) => { mkdirSync(dirname(join(REPO, path)), { recursive: true }); writeFileSync(join(REPO, path), text) }
const commit = (paths, message) => { gitc('add', ...paths); gitc('commit', '-q', '-m', message); return gitc('rev-parse', '--short', 'HEAD') }
const task = async (agent, card, action, extra = {}) => {
  const out = await agent.call('december_task', { card, action, ...extra })
  say(`${agent.tag.padEnd(6)} ${action.padEnd(6)} ${card} · ${extra.task || (extra.tasks || []).join(', ')}${out.note ? `  (${out.note})` : ''}`)
  return out
}
const claude = Object.assign(mcp, { tag: 'claude' })

await task(claude, 'Mode detection', 'add', { tasks: ['Read the git root from the MCP cwd', 'Start one board server per repo', 'Hand the board URL back at initialize', 'Let DECEMBER_MODE override'] })
await claude.call('december_scope', { card: 'Mode detection', paths: ['lib/board-*.mjs', 'mcp-server.mjs'] })
await sleep(PACE * 2)
await task(claude, 'Hooks', 'add', { tasks: ["Mirror Claude Code's todo list onto the board", 'Poll the todo file every second', "Mirror Codex's plan", 'Write the hook install line into the README'] })
await claude.call('december_scope', { card: 'Hooks', paths: ['scripts/board-hook.mjs', 'README.md'] })
await sleep(PACE * 2)
await task(claude, 'Mode detection', 'start', { task: 'Read the git root' })
await sleep(PACE * 3)
write('lib/board-mode.mjs', '// reads the git root\nexport const root = () => process.cwd()\n')
const first = commit(['lib/board-mode.mjs'], 'board: read the git root from the MCP cwd')
await task(claude, 'Mode detection', 'done', { task: 'Read the git root', proof: { tests: '8 pass', commit: first } })
await sleep(PACE * 2)
await claude.call('december_handoff', { summary: 'Mode detection reads the repo root', next: ['Start one board server per repo', "Confirm Codex's hook payload before mirroring its plan"] })
say('claude handoff  No. 1')
claude.child.kill('SIGTERM')
await sleep(PACE * 2)

// the next session: the hand-off comes back in the instructions
const again = Object.assign(connect(), { tag: 'claude' })
const hello = await again.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'demo' } })
again.notify('notifications/initialized')
say('← the second session opens with:')
for (const line of (hello.result?.instructions || '').split('\n').slice(0, 6)) console.log(`    │ ${line}`)
await task(again, 'Mode detection', 'start', { task: 'Start one board server' })
await sleep(PACE * 3)
write('lib/board-host.mjs', '// one server per board\nexport const port = 3031\n')
const second = commit(['lib/board-host.mjs'], 'board: start one server per repo')
await task(again, 'Mode detection', 'done', { task: 'Start one board server', proof: { tests: '14 pass', commit: second } })
await sleep(PACE * 2)

const codex = Object.assign(connect(), { tag: 'codex' })
await codex.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: 'demo' } })
codex.notify('notifications/initialized')
await task(codex, 'Board stage', 'add', { tasks: ['Show repo and branch in the dateline', 'Turn the stage line into notes to the agent', 'Show the task in progress with the yarn'] })
await codex.call('december_scope', { card: 'Board stage', paths: ['public/js/board.js', 'public/css/board.css'] })
await task(codex, 'Board stage', 'start', { task: 'Show repo and branch' })
write('public/js/board.js', '// the dateline names the repo and branch\n')
await sleep(PACE * 3)

await task(again, 'Hooks', 'done', { task: "Mirror Claude Code's todo list", proof: { tests: '5 pass' } })
await task(again, 'Hooks', 'cancel', { task: 'Poll the todo file', reason: 'replaced by the hook' })
await task(again, 'Hooks', 'block', { task: "Mirror Codex's plan", reason: 'Codex hooks unconfirmed' })
await sleep(PACE * 2)
write('package-lock.json', '{ "lockfileVersion": 3 }\n')
say('stray  package-lock.json changed outside any card')

// the person writes on the line; the agent finds it in its next result
await fetch(`${url[0]}api/capture`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url[0].slice(0, -1) }, body: JSON.stringify({ text: 'Keep the hook install to one line' }) })
say('person note   Keep the hook install to one line')
await sleep(PACE * 3)
const picked = await task(again, 'Mode detection', 'start', { task: 'Hand the board URL back' })
for (const note of picked.unread) {
  await again.call('december_file_capture', { captureId: note.id, space: 'Hooks', summary: 'install stays one line' })
  say(`claude filed   ${note.text}`)
}
await sleep(PACE * 2)
await again.call('december_ask', { question: `Push ${BRANCH} to origin?`, options: ['Push', 'Not yet'] })
say(`ask    Push ${BRANCH} to origin?  [Push | Not yet]`)
await sleep(PACE)

const view = await again.call('december_view')
const rows = view.cards.flatMap((c) => c.tasks)
say(`board  ${view.cards.length} cards · ${rows.filter((r) => r.state === 'done').length} of ${rows.filter((r) => r.state !== 'cancelled').length} tasks done · drift: ${view.drift.map((d) => d.path).join(', ') || 'none'} · ask: ${view.ask?.question || 'none'}`)

for (const agent of [again, codex]) agent.child.kill('SIGTERM')
const server = JSON.parse(readFileSync(join(BOARDS, info.slug, 'server.json'), 'utf8'))

console.log('')
console.log(`Board left running: ${url[0]}  (pid ${server.pid}; store ${join(BOARDS, info.slug)})`)
console.log(`Stop it with: kill ${server.pid}`)
if (!existsSync(join(BOARDS, info.slug, 'board.json'))) process.exitCode = 1
