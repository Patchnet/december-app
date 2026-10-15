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
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

// ---------------------------------------------------------- MCP over stdio

function connect() {
  const env = { ...process.env, DECEMBER_BOARDS_DIR: BOARDS, DECEMBER_DATA_DIR: join(BASE_DIR, 'page', 'data'), DECEMBER_URL: 'http://localhost:3999' }
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
await sleep(2500)

const cards = {
  'Mode detection': ['Read the git root from the MCP cwd', 'Start one board server per repo', 'Hand the board URL back at initialize', 'Let DECEMBER_MODE override'],
  'Board stage': ['Show repo and branch in the dateline', 'Turn the stage line into notes to the agent', 'Show the task in progress with the yarn'],
  Hooks: ["Mirror Claude Code's todo list onto the board", "Mirror Codex's plan", 'Write the hook install line into the README'],
}
const lists = {}
for (const [space, items] of Object.entries(cards)) {
  const made = await mcp.call('december_create_block', { space, type: 'list', title: '', items })
  lists[space] = (await mcp.call('december_read_block', { blockId: made.blockId })).block
  say(`card   ${space}  +${items.length} tasks`)
  await sleep(5000)
}
const row = (space, text) => lists[space].items.find((i) => i.text === text).id
const check = async (space, text) => {
  await mcp.call('december_add_or_check', { blockId: lists[space].id, check: [row(space, text)] })
  say(`done   ${space} · ${text}`)
}

// proof comes from commands, never from the agent's say-so
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO, encoding: 'utf8' }).trim()
await check('Mode detection', 'Read the git root from the MCP cwd')
await mcp.call('december_create_block', { space: 'Mode detection', type: 'note', title: '', text: `git rev-parse --show-toplevel → ${gitRoot.replace(BASE_DIR, '…')}` })
say('note   Mode detection · git root proof')
await sleep(5000)

const server = JSON.parse(readFileSync(join(BOARDS, info.slug, 'server.json'), 'utf8'))
await check('Mode detection', 'Start one board server per repo')
const notes = (await mcp.call('december_view')).spaces.find((s) => s.name === 'Mode detection').blocks.find((b) => b.type === 'note')
await mcp.call('december_write_note', { blockId: notes.id, mode: 'append', text: `server.json → port ${server.port}, pid ${server.pid}` })
say('note   Mode detection · server.json proof')
await sleep(5000)

await check('Hooks', "Mirror Claude Code's todo list onto the board")
await sleep(4000)
await mcp.call('december_create_block', { space: 'Hooks', type: 'note', title: '', text: "Codex plan mirroring is blocked: Codex's hook surface is unconfirmed." })
say('note   Hooks · Codex blocked')
await sleep(5000)

await mcp.call('december_ask', { question: `Push ${BRANCH} to origin?`, options: ['Push', 'Not yet'] })
say(`ask    Push ${BRANCH} to origin?  [Push | Not yet]`)
await sleep(3000)

const view = await mcp.call('december_view')
const rows = view.spaces.flatMap((s) => s.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items))
say(`board  ${view.spaces.length} cards · ${rows.filter((r) => r.done).length} of ${rows.length} tasks done · ask waiting: ${view.ask?.question || 'none'}`)

mcp.child.kill('SIGTERM')
console.log('')
console.log(`Board left running: ${url[0]}  (pid ${server.pid}; store ${join(BOARDS, info.slug)})`)
console.log(`Stop it with: kill ${server.pid}`)
if (!existsSync(join(BOARDS, info.slug, 'board.json'))) process.exitCode = 1
