#!/usr/bin/env node
// Claude Code PostToolUse hook: mirror the session's todo list onto the
// repo's December board as one card, "Session plan". It never starts a board
// (the MCP adapter does that) and exits 0 silently whenever there is none.
// Install: see docs/BOARD.md.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectMode, boardsDir } from '../lib/board-mode.mjs'
import { answersAs } from '../lib/board-host.mjs'

export const CARD = 'Session plan'

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null)

const STATE = { completed: 'done', in_progress: 'doing' }

/** The plan the hook input describes, as [{ key, text, state }], merged into
    what earlier calls recorded (TaskCreate/TaskUpdate arrive one at a time). */
export function planFrom(input, tasks = {}) {
  const next = { ...tasks }
  const tool = input?.tool_name
  const args = input?.tool_input || {}
  if (tool === 'TodoWrite') {
    // a todo list is rewritten whole each call; other sessions' lists stay
    const mine = `todo:${input.session_id || ''}:`
    for (const key of Object.keys(next)) if (key.startsWith(mine)) delete next[key]
    for (const todo of args.todos || []) {
      const text = String(todo.content || '').trim()
      if (text) next[mine + text] = { text, state: STATE[todo.status] || 'queued' }
    }
  } else if (tool === 'TaskCreate') {
    const out = input.tool_response || {}
    const id = out.task?.id ?? out.id ?? out.taskId
    const text = String(args.subject || '').trim()
    if (id != null && text) next[`task:${id}`] = { text, state: 'queued' }
  } else if (tool === 'TaskUpdate') {
    const key = `task:${args.taskId}`
    const text = String(args.subject || next[key]?.text || '').trim()
    if (args.status === 'deleted') delete next[key]
    else if (text) next[key] = { text, state: args.status ? STATE[args.status] || 'queued' : next[key]?.state || 'queued' }
  } else return null
  return next
}

async function tool(base, name, args) {
  const res = await fetch(`${base}/api/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-december-client': 'claude-code' },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(3000),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || name)
  return body.result
}

/** Make the card match the plan through the board's own tool: add what is
    new, then move each task to its state. A todo list carries no proof, so a
    task it closes keeps a held tick. Rows the plan dropped stay. */
export async function mirror(base, plan) {
  const wanted = Object.values(plan)
  if (!wanted.length) return null
  await tool(base, 'december_task', { card: CARD, action: 'add', tasks: [...new Set(wanted.map((t) => t.text))].slice(0, 20) })
  const card = (await tool(base, 'december_view', {})).cards.find((c) => c.name === CARD)
  for (const t of wanted) {
    const row = card?.tasks.find((r) => r.text === t.text)
    if (!row || row.state === t.state) continue
    await tool(base, 'december_task', { card: CARD, action: { done: 'done', doing: 'start', queued: 'queue' }[t.state], task: row.id })
  }
  return card?.listId || null
}

async function main() {
  let input
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    input = JSON.parse(raw)
  } catch {
    return
  }
  const info = detectMode({ cwd: input.cwd || process.cwd() })
  if (info.mode !== 'board') return
  const dir = join(boardsDir(), info.slug)
  const server = await readJson(join(dir, 'server.json'))
  if (!server?.port || !(await answersAs(server.port, dir))) return
  const ledgerFile = join(dir, 'session-plan.json')
  const ledger = (await readJson(ledgerFile)) || {}
  const plan = planFrom(input, ledger.tasks)
  if (!plan) return
  const blockId = await mirror(`http://localhost:${server.port}`, plan)
  await writeFile(ledgerFile, JSON.stringify({ blockId, tasks: plan }, null, 2) + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(() => {}).finally(() => process.exit(0))
}
