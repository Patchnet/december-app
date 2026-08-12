// December core — ONE writer. State lives in this process's memory and
// persists to disk after each mutation. Every client (the page, the settle
// agent, your own Claude) reaches it through the web server's interface;
// nothing else touches data/state.json.

import { readFileSync, existsSync, mkdirSync, readdirSync, createReadStream, renameSync } from 'node:fs'
import { appendFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { uid, makeBlock, updateBlock as applyBlockPatch, projectBlock } from './blocks.mjs'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Resolve runtime data without changing the standalone server default. */
export function resolveDataDir(root = ROOT, env = process.env) {
  const configured = String(env.DECEMBER_DATA_DIR || '').trim()
  return configured ? resolve(configured) : join(root, 'data')
}

export const DATA_DIR = resolveDataDir()
const STATE_PATH = join(DATA_DIR, 'state.json')

const emptyState = () => ({
  captures: [], // {id, text, at, status: 'inbox'|'filed', spaceId, summary}
  spaces: [], // {id, name, createdAt, updatedAt, blocks: []}
  lessons: [], // corrections the person taught the engine
  activity: [], // {at, captureId, space, summary}
  ask: null, // MGUI selection moment: {id, question, options[], at} — one slot, ever
  suggestions: [], // MGUI chips: up to three sentences the person might say next
  surfaced: [], // the surfacing sense: up to three things relevant right now
  retired: [], // spaces set aside by hand; kept whole, restorable
  yearOf: new Date().getFullYear(), // the year this page belongs to
  carryover: null, // the January moment: last year's open threads, awaiting choice
  previous: null, // snapshot for one-level undo of the last agent batch
  updatedAt: null,
})

const readState = (file) => ({ ...emptyState(), ...JSON.parse(readFileSync(file, 'utf8')) })

/** A page that cannot be read is NOT an empty page. A write interrupted
    partway (a crash, a pulled plug) left a torn file, which parsed as
    nothing, which drew a blank year — and the next thing typed saved that
    blankness over the only copy. Writes are atomic now so a tear cannot
    happen; if one ever does, the newest readable backup is used and the
    damaged file is kept beside it. If nothing anywhere can be read, this
    refuses to start rather than show an empty page over a full one. */
let recoveredFrom = null

function load() {
  if (!existsSync(STATE_PATH)) return emptyState()
  let firstError
  try {
    return readState(STATE_PATH)
  } catch (err) {
    firstError = err
  }
  const dir = join(DATA_DIR, 'backups')
  const backups = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith('state-')).sort().reverse()
    : []
  for (const f of backups) {
    let recovered
    try {
      recovered = readState(join(dir, f))
    } catch {
      continue // that backup is damaged too; keep walking back
    }
    try {
      renameSync(STATE_PATH, `${STATE_PATH}.damaged`)
    } catch {}
    console.error(`december: ${STATE_PATH} was unreadable (${firstError.message}); recovered from backups/${f}`)
    recoveredFrom = f
    return recovered
  }
  throw new Error(
    `december: ${STATE_PATH} is unreadable (${firstError.message}) and no backup could be read. ` +
      'Nothing has been overwritten. Restore a copy from data/backups/ and start again.'
  )
}

const state = load()
let lastAgentWriteAt = 0

// Your own actions deserve an undo too. Snapshots live in memory only:
// undo is a within-session affordance, not something to bloat the file.
const manualStack = []
function remember(label) {
  manualStack.push({ label, snap: JSON.stringify({ spaces: state.spaces, captures: state.captures }) })
  if (manualStack.length > 15) manualStack.shift()
}
export async function undoManual() {
  const top = manualStack.pop()
  if (!top) throw new Error('nothing of yours to undo')
  const prev = JSON.parse(top.snap)
  state.spaces = prev.spaces
  state.captures = prev.captures
  await persistEvent({ kind: 'undo_manual', summary: top.label })
  return { label: top.label }
}
export const canUndoManual = () => manualStack.length > 0

// One write at a time, and never a half-written file: the year is written
// beside itself and moved into place in a single step. Writing straight to
// state.json meant a crash mid-write, or two mutations overlapping, could
// leave the file torn — and a torn file is a lost year.
let writing = Promise.resolve()

function persist() {
  state.updatedAt = new Date().toISOString()
  const snapshot = JSON.stringify(state, null, 2)
  const done = writing.then(async () => {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const tmp = `${STATE_PATH}.writing`
    await writeFile(tmp, snapshot)
    await rename(tmp, STATE_PATH) // atomic on every platform we run on
  })
  writing = done.catch(() => {}) // a failed write must not wedge the queue
  return done
}

// A page rescued from a backup is only actually rescued once it is written
// back. Until then state.json does not exist, so a restart before the first
// edit would open a blank year on top of a recovery that had already worked.
if (recoveredFrom) {
  persist().then(
    () => console.error(`december: the recovered page has been written back to ${STATE_PATH}`),
    (err) => console.error(`december: could not write the recovered page back: ${err.message}`)
  )
}

const eventYear = () => Number(state.yearOf) || new Date().getFullYear()

/** Events are a derived, append-only history. Losing one must never undo or
    reject the page mutation that already succeeded. */
export async function appendEvent(event, year = eventYear()) {
  try {
    const y = Number(year)
    if (!Number.isInteger(y) || y < 1000 || y > 9999) throw new Error('invalid event year')
    mkdirSync(DATA_DIR, { recursive: true })
    const line = { ...event, at: event.at || new Date().toISOString() }
    await appendFile(join(DATA_DIR, `events-${y}.jsonl`), `${JSON.stringify(line)}\n`)
  } catch (err) {
    console.log('event append failed:', String(err.message || err).slice(0, 200))
  }
}

async function persistEvent(event, year) {
  await persist()
  await appendEvent(event, year)
}

/** Parse a year's JSONL incrementally so future derived views do not need to
    load the whole history as one string. Malformed lines are skipped. */
export async function readEvents(year) {
  const y = Number(year)
  if (!Number.isInteger(y) || y < 1000 || y > 9999) throw new Error('invalid event year')
  const path = join(DATA_DIR, `events-${y}.jsonl`)
  if (!existsSync(path)) return []
  const events = []
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (err) {
      console.log('event read skipped malformed line:', String(err.message || err).slice(0, 120))
    }
  }
  return events
}

const blockEvent = (hit, extra = {}) => ({
  spaceId: hit.space.id,
  blockId: hit.block.id,
  ...extra,
  entities: Array.isArray(hit.block.entities) ? hit.block.entities : [],
})

const touch = (s) => (s.updatedAt = new Date().toISOString())

// ------------------------------------------------------------- reading

/** A space is complete when everything in it is: every list item checked,
    every reminder done, every tracker at its target. Notes and ledgers are
    reference, never "unfinished". A space with nothing checkable isn't. */
export function isComplete(space) {
  let checkable = 0
  for (const b of space.blocks) {
    if (b.type === 'list') {
      checkable += b.items.length
      if (b.items.some((i) => !i.done)) return false
    }
    if (b.type === 'reminder') {
      checkable++
      if (!b.done) return false
    }
    if (b.type === 'tracker') {
      checkable++
      if (b.current < b.target) return false
    }
  }
  return checkable > 0
}

/** How close a space is to needing you, right now.
    0 = nothing pending. Higher = sooner. Overdue outranks everything, then
    the next few hours, then today, then tomorrow. Once handled it drops
    back and liveness takes over again. */
export function urgencyOf(space, now = new Date()) {
  const today = localDay(now)
  const tomorrow = localDay(new Date(now.getTime() + 86400000))
  let best = 0
  for (const b of space.blocks) {
    if (b.type !== 'reminder' || b.done || !b.when) continue
    if (b.when < today) {
      best = Math.max(best, 100) // overdue: nothing outranks this
      continue
    }
    if (b.when === today) {
      if (b.at) {
        const [h, m] = b.at.split(':').map(Number)
        const due = new Date(now)
        due.setHours(h, m, 0, 0)
        const mins = (due - now) / 60000
        if (mins < 0) best = Math.max(best, 95) // the hour has passed
        else if (mins <= 60) best = Math.max(best, 90) // within the hour
        else if (mins <= 180) best = Math.max(best, 80) // within three
        else best = Math.max(best, 60) // later today, with a clock
      } else {
        best = Math.max(best, 50) // today, no clock
      }
      continue
    }
    if (b.when === tomorrow) {
      // tomorrow matters in the evening, barely matters in the morning
      best = Math.max(best, now.getHours() >= 17 ? 40 : 20)
    }
  }
  return best
}

/** What clients render. Ledger totals etc. are derived, never stored. */
export function project(settleStatus = {}) {
  return {
    captures: state.captures.filter((c) => c.status === 'inbox'),
    // What is about to happen to you outranks what you were just doing.
    spaces: [...state.spaces]
      .map((s) => ({ ...s, urgency: urgencyOf(s), complete: isComplete(s) }))
      // time first, then what you said matters, then what you touched last
      .sort(
        (a, b) =>
          b.urgency - a.urgency ||
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
          new Date(b.updatedAt) - new Date(a.updatedAt)
      )
      .map((s) => ({ ...s, blocks: s.blocks.map(projectBlock) })),
    lessons: state.lessons,
    activity: state.activity.slice(-6).reverse(),
    // a question nobody answered in two days is stale, not pending
    ask: state.ask && Date.now() - new Date(state.ask.at) < 48 * 3600000 ? state.ask : null,
    suggestions: state.suggestions,
    surfaced: (state.surfaced || []).filter((s) => surfacedIsLive(s)),
    retired: (state.retired || []).map(({ id, name }) => ({ id, name })),
    carryover: state.carryover || null,
    archivedYears: listYears(),
    canUndo: undoIsFresh(),
    canUndoManual: canUndoManual(),
    settle: settleStatus,
    year: yearSummary(),
    // provenance: capture text by id, so changes can show their receipts
    sources: Object.fromEntries(state.captures.filter((c) => c.status === 'filed').map((c) => [c.id, c.text.slice(0, 160)])),
    updatedAt: state.updatedAt,
  }
}

/** What the ORGANIZING AGENT reads: everything it needs to file, nothing
    it doesn't. Long content truncated, histories capped — every token here
    is latency on every settle turn. */
export function agentView() {
  const lean = (b) => {
    const entities = Array.isArray(b.entities) ? b.entities : []
    if (b.type === 'list') {
      const open = b.items.filter((i) => !i.done)
      const done = b.items.filter((i) => i.done)
      const shownDone = done.slice(-8)
      return {
        id: b.id, type: b.type, title: b.title, entities,
        items: [...open, ...shownDone].map(({ id, text, done }) => ({ id, text, done })),
        ...(done.length > shownDone.length ? { moreDone: done.length - shownDone.length } : {}),
      }
    }
    if (b.type === 'ledger') {
      const total = b.entries.reduce((n, e) => n + (Number(e.amount) || 0), 0)
      return {
        id: b.id, type: b.type, title: b.title, unit: b.unit, total, entities,
        recentEntries: b.entries.slice(-8).map(({ label, amount, at }) => ({ label, amount, at: at?.slice(0, 10) })),
        ...(b.entries.length > 8 ? { moreEntries: b.entries.length - 8 } : {}),
      }
    }
    if (b.type === 'streak') {
      return { id: b.id, type: b.type, title: b.title, count: b.dates.length, last14: b.dates.slice(-14), entities }
    }
    if (b.type === 'note') {
      return {
        id: b.id, type: b.type, title: b.title, entities,
        text: b.text.slice(0, 1200),
        ...(b.text.length > 1200 ? { textTruncated: true } : {}),
      }
    }
    return { ...b, entities }
  }
  return {
    captures: state.captures.filter((c) => c.status === 'inbox'),
    spaces: state.spaces
      .filter((s) => !s.finished) // closed spaces are not filing targets
      .map((s) => ({
        id: s.id,
        name: s.name,
        area: s.area || '',
        pinned: !!s.pinned,
        complete: isComplete(s),
        updatedAt: s.updatedAt,
        blocks: s.blocks.map(lean),
      })),
    finishedSpaces: state.spaces.filter((s) => s.finished).map((s) => ({ id: s.id, name: s.name })),
    areas: [...new Set(state.spaces.filter((s) => !s.finished).map((s) => s.area).filter(Boolean))],
    lessons: state.lessons,
    ask: state.ask,
    suggestions: state.suggestions,
    // what is currently under the input, so a pass can re-affirm what
    // still stands instead of reasoning from scratch and wiping it
    surfaced: (state.surfaced || []).filter((x) => surfacedIsLive(x)),
  }
}

function resolveSpace(ref, create = true) {
  if (!ref) return null
  const byId = state.spaces.find((s) => s.id === ref)
  if (byId) return byId
  const byName = state.spaces.find((s) => s.name.toLowerCase() === String(ref).toLowerCase())
  if (byName) {
    // Writing about something you closed out brings it back. Filing into a
    // finished space put the words somewhere nobody can see them: the card
    // sits in the finished list at the foot of the page, and what you just
    // wrote is gone as far as you can tell.
    if (create && byName.finished) {
      byName.finished = false
      byName.finishedAt = null
    }
    return byName
  }
  if (!create) return null
  const now = new Date().toISOString()
  const space = { id: uid(), name: String(ref).slice(0, 60), createdAt: now, updatedAt: now, blocks: [], area: '', pinned: false, finished: false }
  state.spaces.push(space)
  return space
}

/** The drill-down: one block, complete and untruncated. */
export function readBlock(blockId) {
  const hit = findBlock(blockId)
  if (!hit) throw new Error('unknown blockId')
  return { space: hit.space.name, block: hit.block }
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
    state.previousAt = new Date().toISOString()
  }
  lastAgentWriteAt = now
}

// Undo is for the moment after, not for an hour later: an old snapshot
// stops being offered (it stays on disk, it just isn't a live button).
const UNDO_WINDOW_MS = 10 * 60 * 1000
const undoIsFresh = () =>
  !!state.previous && Date.now() - new Date(state.previousAt || 0).getTime() < UNDO_WINDOW_MS

export async function undo() {
  if (!undoIsFresh()) throw new Error('nothing recent to undo')
  const prev = JSON.parse(state.previous)
  state.spaces = prev.spaces
  state.captures = prev.captures
  state.lessons = prev.lessons
  state.previous = null
  await persistEvent({ kind: 'undo' })
}

// ---------------------------------------------------------- mutations

export async function addCapture(text, hint) {
  const capture = { id: uid(), text: String(text).trim().slice(0, 8000), at: new Date().toISOString(), status: 'inbox' }
  if (hint) capture.hint = String(hint).slice(0, 60)
  state.captures.push(capture)
  state.captures = state.captures.slice(-200)
  await persistEvent({ kind: 'capture', itemId: capture.id, summary: capture.text.slice(0, 200) })
  return capture
}

/** The year, month by month: how much happened and a few words of what. */
function yearSummary() {
  const y = new Date().getFullYear()
  const months = Array.from({ length: 12 }, () => ({ events: 0, highlights: [] }))
  const push = (iso, hl) => {
    if (!iso) return
    const d = new Date(iso)
    if (d.getFullYear() !== y) return
    const m = months[d.getMonth()]
    m.events++
    if (hl && m.highlights.length < 2) m.highlights.push(String(hl).slice(0, 90))
  }
  for (const c of state.captures) if (c.status === 'filed') push(c.at, c.summary)
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type === 'list') for (const i of b.items) if (i.doneAt) push(i.doneAt)
      if (b.type === 'ledger') for (const e of b.entries) push(e.at)
      if (b.type === 'streak') for (const d of b.dates) push(`${d}T12:00:00`)
    }
  }
  return { year: y, month: new Date().getMonth(), months }
}

export async function createSpace(name) {
  agentBatchGuard()
  const space = resolveSpace(name)
  await persistEvent({ kind: 'create_space', spaceId: space.id, summary: space.name })
  return { id: space.id, name: space.name }
}

export async function createBlock(spaceRef, spec) {
  // validate BEFORE creating anything: a failed block must not leave a
  // stray empty space behind
  const block = makeBlock(spec)
  if (!block) throw new Error(`invalid block type: ${spec?.type}`)
  agentBatchGuard()
  const space = resolveSpace(spaceRef)
  space.blocks.push(block)
  touch(space)
  await persistEvent({
    kind: 'create_block',
    spaceId: space.id,
    blockId: block.id,
    src: spec.source || undefined,
    summary: block.title || block.type,
    entities: block.entities,
  })
  return { spaceId: space.id, blockId: block.id }
}

export async function updateBlock(blockId, patch, expectType, kind = 'update_block') {
  agentBatchGuard()
  const hit = findBlock(blockId)
  if (!hit) throw new Error('unknown blockId')
  if (expectType && hit.block.type !== expectType) {
    throw new Error(`that block is a ${hit.block.type}, not a ${expectType}`)
  }
  applyBlockPatch(hit.block, patch)
  touch(hit.space)
  await persistEvent({ kind, ...blockEvent(hit, { src: patch.source || undefined }) })
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
  await persistEvent({ kind: 'file_capture', spaceId: space.id, itemId: captureId, src: captureId, summary: c.summary })
  return { ok: true, space: space.name }
}

export async function addLesson(text) {
  agentBatchGuard()
  state.lessons = state.lessons.concat(String(text).slice(0, 300)).slice(-50)
  await persistEvent({ kind: 'learn', summary: String(text).slice(0, 200) })
  return { ok: true }
}

/** MGUI selection moment. One slot: a new ask replaces the old. Options are
    complete standalone sentences, so a tap files as if the person typed it. */
export async function setAsk(question, options) {
  const opts = (options || []).slice(0, 4).map((o) => String(o).slice(0, 120))
  if (!question) throw new Error('an ask needs a question')
  // no options = an open question, answered by typing (a time, an amount)
  if (opts.length === 1) throw new Error('an ask needs either no options or 2-4 of them')
  state.ask = { id: uid(), question: String(question).slice(0, 160), options: opts, at: new Date().toISOString() }
  await persistEvent({ kind: 'ask', summary: state.ask.question })
  return { ok: true }
}

export async function clearAsk() {
  state.ask = null
  await persistEvent({ kind: 'clear_ask' })
  return { ok: true }
}

/** The surfacing sense: at most three things relevant right now, each with
    a reason and an expiry. A new set replaces the old; empty clears. */
const SURFACE_STOP = new Set(['a', 'an', 'the', 'my', 'your', 'with', 'from', 'for', 'to', 'at', 'on', 'in', 'of', 'and', 'back', 'about'])
const surfaceWords = (t) =>
  new Set(String(t).toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => !SURFACE_STOP.has(w)) || [])

/** Tie a surfaced line to the thing it is about, so completing that thing
    clears the line instead of leaving it stale until the next agent pass. */
function matchTarget(space, label) {
  if (!space) return {}
  const want = surfaceWords(label)
  if (!want.size) return {}
  const score = (text) => {
    const have = surfaceWords(text)
    let hit = 0
    for (const w of want) if (have.has(w)) hit++
    return hit / want.size
  }
  let best = { score: 0.5 } // below this it is not the same thing
  for (const blk of space.blocks) {
    if (blk.type === 'reminder' && !blk.done) {
      const sc = score(blk.text)
      if (sc > best.score) best = { score: sc, blockId: blk.id }
    }
    if (blk.type === 'list') {
      for (const it of blk.items) {
        if (it.done) continue
        const sc = score(it.text)
        if (sc > best.score) best = { score: sc, blockId: blk.id, itemId: it.id }
      }
    }
  }
  return best.blockId ? { blockId: best.blockId, itemId: best.itemId || '' } : {}
}

/** Is a surfaced line still true? Checked live, so the strip and the cards
    never disagree about what is outstanding. */
export function surfacedIsLive(s, now = localDay()) {
  if (s.until && s.until < now) return false
  const space = s.spaceId ? state.spaces.find((x) => x.id === s.spaceId) : null
  if (s.spaceId && !space) return false // the space went away
  if (space?.finished) return false // closed out
  if (!s.blockId) return true
  const blk = space?.blocks.find((x) => x.id === s.blockId)
  if (!blk) return false
  if (blk.type === 'reminder') return !blk.done
  if (blk.type === 'list' && s.itemId) {
    const it = blk.items.find((i) => i.id === s.itemId)
    return !!it && !it.done
  }
  return true
}

export async function setSurfaced(items) {
  state.surfaced = (items || []).slice(0, 3).map((s) => {
    const space = resolveSpace(s.space, false)
    const label = String(s.label || '').slice(0, 90)
    return {
      label,
      reason: String(s.reason || '').slice(0, 60),
      spaceId: space?.id || null,
      ...matchTarget(space, label),
      until: s.until ? String(s.until).slice(0, 10) : '',
      at: new Date().toISOString(),
    }
  }).filter((s) => s.label)
  await persistEvent({ kind: 'surface', summary: `${state.surfaced.length} surfaced` })
  return { ok: true, count: state.surfaced.length }
}

/** MGUI chips: at most three sentences the person might say next. */
export async function setSuggestions(list) {
  state.suggestions = (list || []).slice(0, 3).map((s) => String(s).slice(0, 100))
  await persistEvent({ kind: 'suggest', summary: `${state.suggestions.length} suggestions` })
  return { ok: true }
}

/** What matters this year: a pin outranks liveness, never urgency. */
export async function setPinned(id, pinned) {
  const sp = state.spaces.find((s) => s.id === id)
  if (!sp) throw new Error('unknown space')
  remember('pin')
  sp.pinned = !!pinned
  await persistEvent({ kind: 'pin', spaceId: sp.id, summary: sp.pinned ? 'pinned' : 'unpinned' })
  return { ok: true, name: sp.name, pinned: sp.pinned }
}

/** Finishing something is not the same as abandoning it. */
export async function setFinished(id, finished) {
  const sp = state.spaces.find((s) => s.id === id)
  if (!sp) throw new Error('unknown space')
  remember('finish')
  sp.finished = !!finished
  sp.finishedAt = finished ? new Date().toISOString() : null
  if (finished) sp.pinned = false
  await persistEvent({ kind: 'finish', spaceId: sp.id, summary: sp.finished ? 'finished' : 'reopened' })
  return { ok: true, name: sp.name, finished: sp.finished }
}

/** Name-or-id versions for the agent, which thinks in names. */
export async function setPinnedByRef(ref, pinned) {
  const sp = resolveSpace(ref, false)
  if (!sp) throw new Error('unknown space')
  return setPinned(sp.id, pinned)
}
export async function setFinishedByRef(ref, finished) {
  const sp = resolveSpace(ref, false)
  if (!sp) throw new Error('unknown space')
  return setFinished(sp.id, finished)
}

/** December organizes captures into spaces; areas let it organize spaces. */
export async function setArea(ref, area) {
  const sp = resolveSpace(ref, false)
  if (!sp) throw new Error('unknown space')
  sp.area = String(area || '').slice(0, 30)
  await persistEvent({ kind: 'set_area', spaceId: sp.id, summary: sp.area })
  return { ok: true, name: sp.name, area: sp.area }
}

/** A tracker counts a list only when it is plainly counting THAT list: one
    tracker, one list, and a target that matches the list's length (12 rent
    payments, 12 months). Any single tracker used to move on any check, so
    a space holding "run 100 miles" and a shopping list counted a mile
    every time something was bought. Exported so the page can mirror the
    same rule and never paint a number the server won't agree with. */
export function trackerCounting(space, block) {
  if (!block || block.type !== 'list') return null
  const trackers = space.blocks.filter((b) => b.type === 'tracker')
  const lists = space.blocks.filter((b) => b.type === 'list')
  if (trackers.length !== 1 || lists.length !== 1 || lists[0].id !== block.id) return null
  return trackers[0].target === block.items.length ? trackers[0] : null
}

/** Manual, instant check from the page — no model, no snapshot. */
export async function check(blockId, itemId, done) {
  const hit = findBlock(blockId)
  if (!hit) throw new Error('unknown block')
  remember('check')
  if (hit.block.type === 'list') {
    const it = hit.block.items.find((i) => i.id === itemId)
    if (!it) throw new Error('unknown item')
    it.done = done !== false
    it.doneAt = it.done ? new Date().toISOString() : null
    // a tracker that is counting this very list ticks with it
    const counting = trackerCounting(hit.space, hit.block)
    if (counting) counting.current = Math.max(0, counting.current + (it.done ? 1 : -1))
  } else if (hit.block.type === 'reminder') {
    const b = hit.block
    if (done !== false && b.repeat && b.when) {
      b.when = nextWhen(b.when, b.repeat) // a rhythm rolls forward, it never dies
    } else {
      b.done = done !== false
    }
  } else {
    throw new Error('not checkable')
  }
  touch(hit.space)
  await persistEvent({ kind: 'check', ...blockEvent(hit, { itemId: itemId || undefined, summary: done === false ? 'unchecked' : 'checked' }) })
}

export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function nextWhen(when, repeat) {
  const today = localDay()
  const d = new Date(`${when > today ? when : today}T12:00:00`)
  if (repeat === 'daily') d.setDate(d.getDate() + 1)
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7)
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1)
  else if (repeat === 'yearly') d.setFullYear(d.getFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

/** Direct manipulation: small fixes by the person's own hand, instantly. */
export async function editText({ spaceId, blockId, itemId, field, text }, kind = 'edit') {
  text = String(text || '').trim()
  if (!text) throw new Error('empty')
  remember('edit')
  if (spaceId) {
    const sp = state.spaces.find((s) => s.id === spaceId)
    if (!sp) throw new Error('unknown space')
    sp.name = text.slice(0, 60)
    touch(sp)
    await persistEvent({ kind, spaceId, summary: 'space name' })
  } else {
    const hit = findBlock(blockId)
    if (!hit) throw new Error('unknown block')
    const b = hit.block
    if (field === 'ledger_label') {
      if (b.type !== 'ledger') throw new Error('not a ledger')
      const entry = b.entries.find((e) => e.id === itemId)
      if (!entry) throw new Error('unknown entry')
      entry.label = text.slice(0, 80)
    } else if (field === 'title') {
      b.title = text.slice(0, 80)
    } else if (itemId) {
      const it = b.items?.find((i) => i.id === itemId)
      if (!it) throw new Error('unknown item')
      it.text = text.slice(0, 200)
    } else if (b.type === 'note') b.text = text.slice(0, 4000)
    else if (b.type === 'reminder') b.text = text.slice(0, 200)
    else b.title = text.slice(0, 80)
    touch(hit.space)
    await persistEvent({ kind, ...blockEvent(hit, { itemId: itemId || undefined, summary: field || 'text' }) })
  }
  return { ok: true }
}

/** Retire, never delete: the space steps aside whole, restorable. */
export async function retireSpace(id) {
  const i = state.spaces.findIndex((s) => s.id === id)
  if (i < 0) throw new Error('unknown space')
  remember('retire')
  const [sp] = state.spaces.splice(i, 1)
  state.retired = (state.retired || []).concat(sp)
  await persistEvent({ kind: 'retire', spaceId: sp.id, summary: sp.name })
  return { ok: true, name: sp.name }
}

export async function restoreSpace(id) {
  const i = (state.retired || []).findIndex((s) => s.id === id)
  if (i < 0) throw new Error('unknown space')
  const [sp] = state.retired.splice(i, 1)
  touch(sp)
  state.spaces.push(sp)
  await persistEvent({ kind: 'restore', spaceId: sp.id, summary: sp.name })
  return { ok: true, name: sp.name }
}

// ------------------------------------------------ the turn of the year
// A year that ends by vanishing breaks the thesis. It archives whole,
// its finished work gets read aloud, and its open threads await a choice.

/** Midnight on December 31 must not wait for a restart. */
export function watchForNewYear(onRolled) {
  setInterval(async () => {
    const rolled = await rolloverIfNeeded()
    if (rolled) onRolled?.(rolled)
  }, 10 * 60 * 1000)
}

export async function rolloverIfNeeded(now = new Date()) {
  const y = now.getFullYear()
  if (!state.yearOf) state.yearOf = y
  if (state.yearOf >= y) return null
  const old = state.yearOf

  const yearsDir = join(DATA_DIR, 'years')
  mkdirSync(yearsDir, { recursive: true })
  await writeFile(join(yearsDir, `${old}.json`), JSON.stringify(state, null, 2))

  // the reading: what the year added up to
  let done = 0
  let met = 0
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type === 'list') done += b.items.filter((i) => i.done).length
      if (b.type === 'reminder' && b.done) done++
      if (b.type === 'tracker' && b.current >= b.target) met++
    }
  }
  const moments = state.captures.filter((c) => c.status === 'filed').length
  // the year's own words: a few things it said about itself
  const highlights = (state.activity || [])
    .slice(-40)
    .map((a) => a.summary)
    .filter(Boolean)
    .reverse()
    .slice(0, 3)

  // the open threads, each awaiting an explicit yes
  const items = []
  let n = 0
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type === 'list') {
        const open = b.items.filter((i) => !i.done)
        if (open.length) items.push({ id: `co${n++}`, space: s.name, kind: 'list', title: b.title, texts: open.map((i) => i.text) })
      }
      if (b.type === 'tracker' && b.current < b.target) {
        items.push({ id: `co${n++}`, space: s.name, kind: 'tracker', title: b.title, target: b.target, unit: b.unit, note: `reached ${b.current} of ${b.target}` })
      }
      if (b.type === 'reminder' && !b.done) {
        items.push({ id: `co${n++}`, space: s.name, kind: 'reminder', text: b.text, repeat: b.repeat || '', note: b.when ? `was due ${b.when}` : '' })
      }
      if (b.type === 'streak' && b.dates.length >= 10) {
        items.push({ id: `co${n++}`, space: s.name, kind: 'streak', title: b.title, note: `${b.dates.length} days in ${old}` })
      }
    }
  }

  const lessons = state.lessons // taste persists across years
  const fresh = emptyState()
  fresh.lessons = lessons
  fresh.yearOf = y
  fresh.carryover = { fromYear: old, finished: { done, met, moments, highlights }, items }
  for (const k of Object.keys(state)) delete state[k]
  Object.assign(state, fresh)
  await persistEvent({ at: now.toISOString(), kind: 'rollover', summary: `archived ${old}` }, y)
  return old
}

/** The chosen threads come in fresh: targets kept, counts reset. */
export async function applyCarryover(ids) {
  const co = state.carryover
  if (!co) throw new Error('nothing to carry')
  const chosen = co.items.filter((i) => ids.includes(i.id))
  for (const it of chosen) {
    const space = resolveSpace(it.space)
    let block = null
    if (it.kind === 'list') block = makeBlock({ type: 'list', title: it.title, items: it.texts })
    if (it.kind === 'tracker') block = makeBlock({ type: 'tracker', title: it.title, target: it.target, unit: it.unit, current: 0, period: 'year' })
    if (it.kind === 'reminder') block = makeBlock({ type: 'reminder', title: '', text: it.text, repeat: it.repeat })
    if (it.kind === 'streak') block = makeBlock({ type: 'streak', title: it.title })
    if (block) space.blocks.push(block)
    space.updatedAt = new Date().toISOString()
  }
  state.carryover = null
  await persistEvent({ kind: 'carryover', summary: `${chosen.length} carried` })
  return { carried: chosen.length }
}

export async function dismissCarryover() {
  state.carryover = null
  await persistEvent({ kind: 'dismiss_carryover' })
  return { ok: true }
}

/** A past year, read-only: its months and what its spaces held. */
export function readYear(y) {
  const file = join(DATA_DIR, 'years', `${String(y).replace(/\D/g, '')}.json`)
  if (!existsSync(file)) throw new Error('no such year')
  const old = JSON.parse(readFileSync(file, 'utf8'))
  const spaces = (old.spaces || []).map((s) => ({
    name: s.name,
    stats: s.blocks
      .map((b) => {
        if (b.type === 'tracker') return `${b.title || 'goal'}: ${b.current} of ${b.target}${b.unit ? ` ${b.unit}` : ''}`
        if (b.type === 'ledger') return `${b.title || 'total'}: ${b.entries.reduce((n2, e) => n2 + (Number(e.amount) || 0), 0)}`
        if (b.type === 'list') return `${b.items.filter((i) => i.done).length} of ${b.items.length} done`
        if (b.type === 'streak') return `${b.title}: ${b.dates.length} days`
        return null
      })
      .filter(Boolean),
  }))
  return { year: Number(String(y).replace(/\D/g, '')), months: yearSummaryOf(old), spaces }
}

export function listYears() {
  const dir = join(DATA_DIR, 'years')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((f) => Number(f.replace('.json', ''))).filter(Boolean).sort()
}

function yearSummaryOf(st) {
  const months = Array.from({ length: 12 }, () => ({ events: 0, highlights: [] }))
  const push = (iso, hl) => {
    if (!iso) return
    const m = months[new Date(iso).getMonth()]
    m.events++
    if (hl && m.highlights.length < 2) m.highlights.push(String(hl).slice(0, 90))
  }
  for (const c of st.captures || []) if (c.status === 'filed') push(c.at, c.summary)
  for (const s of st.spaces || []) {
    for (const b of s.blocks) {
      if (b.type === 'list') for (const i of b.items) if (i.doneAt) push(i.doneAt)
      if (b.type === 'ledger') for (const e of b.entries) push(e.at)
      if (b.type === 'streak') for (const d of b.dates) push(`${d}T12:00:00`)
    }
  }
  return months
}

export const hasInbox = () => state.captures.some((c) => c.status === 'inbox')
