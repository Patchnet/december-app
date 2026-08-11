// December core — ONE writer. State lives in this process's memory and
// persists to disk after each mutation. Every client (the page, the settle
// agent, your own Claude) reaches it through the web server's interface;
// nothing else touches data/state.json.

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uid, makeBlock, updateBlock as applyBlockPatch, projectBlock } from './blocks.mjs'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const STATE_PATH = join(ROOT, 'data', 'state.json')

const emptyState = () => ({
  captures: [], // {id, text, at, status: 'inbox'|'filed', spaceId, summary}
  spaces: [], // {id, name, createdAt, updatedAt, blocks: []}
  lessons: [], // corrections the person taught the engine
  activity: [], // {at, captureId, space, summary}
  ask: null, // MGUI selection moment: {id, question, options[], at} — one slot, ever
  suggestions: [], // MGUI chips: up to three sentences the person might say next
  previous: null, // snapshot for one-level undo of the last agent batch
  updatedAt: null,
})

function load() {
  if (!existsSync(STATE_PATH)) return emptyState()
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) }
  } catch {
    return emptyState()
  }
}

const state = load()
let lastAgentWriteAt = 0

async function persist() {
  state.updatedAt = new Date().toISOString()
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2))
}

const touch = (s) => (s.updatedAt = new Date().toISOString())

// ------------------------------------------------------------- reading

/** What clients render. Ledger totals etc. are derived, never stored. */
export function project(settleStatus = {}) {
  return {
    captures: state.captures.filter((c) => c.status === 'inbox'),
    // Liveness is the order: what you touched most recently leads the page.
    spaces: [...state.spaces]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map((s) => ({ ...s, blocks: s.blocks.map(projectBlock) })),
    lessons: state.lessons,
    activity: state.activity.slice(-6).reverse(),
    ask: state.ask,
    suggestions: state.suggestions,
    canUndo: !!state.previous,
    settle: settleStatus,
    updatedAt: state.updatedAt,
  }
}

function resolveSpace(ref, create = true) {
  if (!ref) return null
  const byId = state.spaces.find((s) => s.id === ref)
  if (byId) return byId
  const byName = state.spaces.find((s) => s.name.toLowerCase() === String(ref).toLowerCase())
  if (byName) return byName
  if (!create) return null
  const now = new Date().toISOString()
  const space = { id: uid(), name: String(ref).slice(0, 60), createdAt: now, updatedAt: now, blocks: [] }
  state.spaces.push(space)
  return space
}

function findBlock(blockId) {
  for (const s of state.spaces) {
    const b = s.blocks.find((b) => b.id === blockId)
    if (b) return { space: s, block: b }
  }
  return null
}

// -------------------------------------------------- undo (agent batches)

/** A new agent write burst (>60s since the last) opens the undo snapshot —
    uniformly for the settle pass AND a connected assistant, since both
    arrive through the same tool interface. Manual page writes never do. */
function agentBatchGuard() {
  const now = Date.now()
  if (now - lastAgentWriteAt > 60000) {
    state.previous = JSON.stringify({ spaces: state.spaces, captures: state.captures, lessons: state.lessons })
  }
  lastAgentWriteAt = now
}

export async function undo() {
  if (!state.previous) throw new Error('nothing to undo')
  const prev = JSON.parse(state.previous)
  state.spaces = prev.spaces
  state.captures = prev.captures
  state.lessons = prev.lessons
  state.previous = null
  await persist()
}

// ---------------------------------------------------------- mutations

export async function addCapture(text) {
  const capture = { id: uid(), text: String(text).trim().slice(0, 2000), at: new Date().toISOString(), status: 'inbox' }
  state.captures.push(capture)
  state.captures = state.captures.slice(-200)
  await persist()
  return capture
}

export async function createSpace(name) {
  agentBatchGuard()
  const space = resolveSpace(name)
  await persist()
  return { id: space.id, name: space.name }
}

export async function createBlock(spaceRef, spec) {
  agentBatchGuard()
  const space = resolveSpace(spaceRef)
  const block = makeBlock(spec)
  if (!block) throw new Error(`invalid block type: ${spec?.type}`)
  space.blocks.push(block)
  touch(space)
  await persist()
  return { spaceId: space.id, blockId: block.id }
}

export async function updateBlock(blockId, patch) {
  agentBatchGuard()
  const hit = findBlock(blockId)
  if (!hit) throw new Error('unknown blockId')
  applyBlockPatch(hit.block, patch)
  touch(hit.space)
  await persist()
  return { ok: true, blockId }
}

export async function fileCapture(captureId, spaceRef, summary) {
  agentBatchGuard()
  const c = state.captures.find((c) => c.id === captureId)
  if (!c) throw new Error('unknown captureId')
  const space = resolveSpace(spaceRef)
  c.status = 'filed'
  c.spaceId = space.id
  c.summary = String(summary || '').slice(0, 200)
  state.activity = state.activity.concat({ at: new Date().toISOString(), captureId, space: space.name, summary: c.summary }).slice(-30)
  await persist()
  return { ok: true, space: space.name }
}

export async function addLesson(text) {
  agentBatchGuard()
  state.lessons = state.lessons.concat(String(text).slice(0, 300)).slice(-50)
  await persist()
  return { ok: true }
}

/** MGUI selection moment. One slot: a new ask replaces the old. Options are
    complete standalone sentences, so a tap files as if the person typed it. */
export async function setAsk(question, options) {
  const opts = (options || []).slice(0, 4).map((o) => String(o).slice(0, 120))
  if (!question || opts.length < 2) throw new Error('an ask needs a question and 2-4 options')
  state.ask = { id: uid(), question: String(question).slice(0, 160), options: opts, at: new Date().toISOString() }
  await persist()
  return { ok: true }
}

export async function clearAsk() {
  state.ask = null
  await persist()
  return { ok: true }
}

/** MGUI chips: at most three sentences the person might say next. */
export async function setSuggestions(list) {
  state.suggestions = (list || []).slice(0, 3).map((s) => String(s).slice(0, 100))
  await persist()
  return { ok: true }
}

/** Manual, instant check from the page — no model, no snapshot. */
export async function check(blockId, itemId, done) {
  const hit = findBlock(blockId)
  if (!hit) throw new Error('unknown block')
  if (hit.block.type === 'list') {
    const it = hit.block.items.find((i) => i.id === itemId)
    if (!it) throw new Error('unknown item')
    it.done = done !== false
    it.doneAt = it.done ? new Date().toISOString() : null
  } else if (hit.block.type === 'reminder') {
    hit.block.done = done !== false
  } else {
    throw new Error('not checkable')
  }
  touch(hit.space)
  await persist()
}

export const hasInbox = () => state.captures.some((c) => c.status === 'inbox')
