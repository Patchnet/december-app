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

/** The plan the hook input describes, as [{ key, text, done }], merged into
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
      if (text) next[mine + text] = { text, done: todo.status === 'completed' }
    }
  } else if (tool === 'TaskCreate') {
    const out = input.tool_response || {}
    const id = out.task?.id ?? out.id ?? out.taskId
    const text = String(args.subject || '').trim()
    if (id != null && text) next[`task:${id}`] = { text, done: false }
  } else if (tool === 'TaskUpdate') {
    const key = `task:${args.taskId}`
    const text = String(args.subject || next[key]?.text || '').trim()
    if (args.status === 'deleted') delete next[key]
    else if (text) next[key] = { text, done: args.status ? args.status === 'completed' : !!next[key]?.done }
  } else return null
  return next
}

async function tool(base, name, args) {
  const res = await fetch(`${base}/api/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(3000),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || name)
  return body.result
}

/** Make the card's list match the plan: add what is new, check and uncheck
    to match. Rows the plan dropped stay, because December never deletes. */
export async function mirror(base, plan, blockId) {
  const wanted = Object.values(plan)
  let block = blockId ? await tool(base, 'december_read_block', { blockId }).then((r) => r.block, () => null) : null
  if (!block) {
    if (!wanted.length) return null
    const made = await tool(base, 'december_create_block', { space: CARD, type: 'list', title: '', items: wanted.map((t) => t.text) })
    block = (await tool(base, 'december_read_block', { blockId: made.blockId })).block
  }
  const add = [...new Set(wanted.filter((t) => !block.items.some((i) => i.text === t.text)).map((t) => t.text))]
  if (add.length) {
    const out = await tool(base, 'december_add_or_check', { blockId: block.id, add })
    if (out.finished && wanted.some((t) => !t.done)) await tool(base, 'december_finish', { space: CARD, finished: false })
    block = (await tool(base, 'december_read_block', { blockId: block.id })).block
  }
  const row = (text) => block.items.find((i) => i.text === text)
  const check = wanted.filter((t) => t.done && row(t.text) && !row(t.text).done).map((t) => row(t.text).id)
  const uncheck = wanted.filter((t) => !t.done && row(t.text)?.done).map((t) => row(t.text).id)
  if (check.length || uncheck.length) await tool(base, 'december_add_or_check', { blockId: block.id, check, uncheck })
  return block.id
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
  const blockId = await mirror(`http://localhost:${server.port}`, plan, ledger.blockId)
  await writeFile(ledgerFile, JSON.stringify({ blockId, tasks: plan }, null, 2) + '\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(() => {}).finally(() => process.exit(0))
}
