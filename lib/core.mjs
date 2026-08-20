// December core — ONE writer. State lives in this process's memory and
// persists to disk after each mutation. Every client (the page, the settle
// agent, your own Claude) reaches it through the web server's interface;
// nothing else touches data/state.json.

import { readFileSync, existsSync, mkdirSync, readdirSync, createReadStream, renameSync } from 'node:fs'
import { appendFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { uid, makeBlock, updateBlock as applyBlockPatch, projectBlock, goalMeasure, goalOf, setBlockGoal, GOAL_TYPES, recurrenceAnchorOf } from './blocks.mjs'

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
  about: { markdown: '', updatedAt: null }, // reserved profile, not a space
  activity: [], // {at, captureId, space, summary}
  ask: null, // MGUI selection moment: {id, question, options[], at} — one slot, ever
  suggestions: [], // MGUI chips: up to three sentences the person might say next
  surfaced: [], // the surfacing sense: up to three things relevant right now
  retired: [], // spaces set aside by hand; kept whole, restorable
  yearOf: new Date().getFullYear(), // the year this page belongs to
  carryover: null, // the January moment: last year's open threads, awaiting choice
  rolloverProvenance: null, // explicit recovery link for an untouched page created by rollover
  updatedAt: null,
  revision: 0, // monotonic durable write stamp; unlike timestamps, never collides
})

const ABOUT_CAP = 8000
const KEEP_TYPES = new Set(['note', 'ledger'])

function normalizeAbout(raw) {
  if (!raw || typeof raw !== 'object') return { markdown: '', updatedAt: null }
  return {
    markdown: String(raw.markdown || ''),
    updatedAt: raw.updatedAt || null,
  }
}

/** First ATX heading, else the first non-empty line. */
export function aboutName(markdown = '') {
  const text = String(markdown || '')
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^#+\s*/, '').trim()
    if (cleaned) return cleaned
  }
  return ''
}

export function aboutInitial(markdown = '') {
  const name = aboutName(markdown)
  const ch = [...name].find((c) => /\p{L}|\p{N}/u.test(c))
  return ch ? ch.toLocaleUpperCase() : 'D'
}

export function projectAbout(about = state.about) {
  const markdown = normalizeAbout(about).markdown
  return {
    markdown,
    name: aboutName(markdown),
    initial: aboutInitial(markdown),
    updatedAt: normalizeAbout(about).updatedAt,
  }
}

/** keep = reference that stays on the dashboard; do = eligible to leave when complete. */
export function spaceRole(space) {
  if (space?.role === 'keep' || space?.role === 'do') return space.role
  return (space?.blocks || []).some((b) => KEEP_TYPES.has(b.type)) ? 'keep' : 'do'
}

function maybeArchiveComplete(space) {
  if (!space || space.finished) return false
  if (spaceRole(space) !== 'do') return false
  if (!isComplete(space)) return false
  space.finished = true
  space.finishedAt = new Date().toISOString()
  space.pinned = false
  return true
}

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
state.about = normalizeAbout(state.about)
state.revision = Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0
// Agent undo is deliberately session-local. Legacy snapshots are discarded
// at startup rather than offering an undo whose surrounding process context
// no longer exists.
delete state.previous
delete state.previousAt
let previousSnap = null
let lastAgentWriteAt = 0

// Your own actions deserve an undo too. Snapshots live in memory only:
// undo is a within-session affordance, not something to bloat the file.
const manualStack = []
function remember(label) {
  const snap = { spaces: state.spaces, captures: state.captures }
  if (label === 'about') snap.about = state.about
  manualStack.push({ label, snap: JSON.stringify(snap) })
  if (manualStack.length > 15) manualStack.shift()
}
export async function undoManual() {
  const top = manualStack.pop()
  if (!top) throw new Error('nothing of yours to undo')
  const prev = JSON.parse(top.snap)
  state.spaces = prev.spaces
  state.captures = prev.captures
  if (Object.hasOwn(prev, 'about')) state.about = normalizeAbout(prev.about)
  await persistEvent({ kind: 'undo_manual', summary: top.label })
  return { label: top.label }
}
export const canUndoManual = () => manualStack.length > 0

// One write at a time, and never a half-written file: the year is written
// beside itself and moved into place in a single step. Writing straight to
// state.json meant a crash mid-write, or two mutations overlapping, could
// leave the file torn — and a torn file is a lost year.
let writing = Promise.resolve()
const persistObservers = new Set()

/** Subscribe to completed durable page writes. Observers run after the
    atomic state replacement and cannot reject the local mutation. The
    returned function removes the observer. */
export function observePersists(observer) {
  if (typeof observer !== 'function') throw new Error('persist observer must be a function')
  persistObservers.add(observer)
  return () => persistObservers.delete(observer)
}

function persist({ rolloverMutation = true } = {}) {
  // Protect a page at the durable-write boundary so no mutation path can
  // bypass rollover recovery provenance by writing without an event helper.
  if (rolloverMutation && state.rolloverProvenance) state.rolloverProvenance.mutated = true
  state.updatedAt = new Date().toISOString()
  state.revision++
  // The live file is rewritten on every mutation, so keep it compact. Year
  // archives remain pretty-printed at rollover for human readability.
  const snapshot = JSON.stringify(state)
  const done = writing.then(async () => {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const tmp = `${STATE_PATH}.writing`
    await writeFile(tmp, snapshot)
    await rename(tmp, STATE_PATH) // atomic on every platform we run on
    const results = await Promise.allSettled([...persistObservers].map((observer) => observer()))
    for (const result of results) {
      if (result.status === 'rejected') console.log('persist observer failed:', String(result.reason?.message || result.reason).slice(0, 200))
    }
  })
  writing = done.catch(() => {}) // a failed write must not wedge the queue
  return done
}

// A page rescued from a backup is only actually rescued once it is written
// back. Until then state.json does not exist, so a restart before the first
// edit would open a blank year on top of a recovery that had already worked.
if (recoveredFrom) {
  persist({ rolloverMutation: false }).then(
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
  const rolloverMutation = event.kind !== 'rollover' && event.kind !== 'rollover_recovered'
  await persist({ rolloverMutation })
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

/** Goals remember when they last moved, so a goal nobody has fed in weeks
    looks like something instead of looking like zero. Snapshot a space's
    goal measures before a change; stamp whichever ones moved after. */
const goalMeasures = (space) => new Map(space.blocks.filter((b) => b.goal).map((b) => [b.id, goalMeasure(b)]))
function stampGoalMoves(space, before) {
  for (const b of space.blocks) {
    if (!b.goal) continue
    const was = before.get(b.id)
    if (was !== undefined && goalMeasure(b) !== was) b.goal.movedAt = new Date().toISOString()
  }
}

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
      if (b.repeat) continue // a rhythm is never complete; it rolls forward
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
  const nextDay = new Date(now)
  nextDay.setDate(nextDay.getDate() + 1)
  const tomorrow = localDay(nextDay)
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
      .map((s) => ({ ...s, urgency: urgencyOf(s), complete: isComplete(s), role: spaceRole(s) }))
      // time first, then what you said matters, then what you touched last
      .sort(
        (a, b) =>
          b.urgency - a.urgency ||
          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
          new Date(b.updatedAt) - new Date(a.updatedAt)
      )
      .map((s) => {
        const blocks = s.blocks.map(projectBlock)
        const hero = goalHeroId(s)
        for (let i = 0; i < s.blocks.length; i++) {
          const source = s.blocks[i]
          const projected = blocks[i]
          // countedBy is a server verdict, never durable block data. Delete a
          // legacy/stale value before stamping the current unambiguous match.
          delete projected.countedBy
          if (source.type === 'list') {
            const counting = trackerCounting(s, source)
            if (counting) projected.countedBy = counting.id
          }
          if (projected.goal) projected.goal.label = goalLabel(s, source, hero)
        }
        return { ...s, blocks }
      }),
    lessons: state.lessons,
    about: projectAbout(),
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
    revision: state.revision,
  }
}

/** Every goal on an open space, with where it stands today. */
export function liveGoals(now = new Date()) {
  const out = []
  for (const s of state.spaces) {
    if (s.finished) continue
    for (const b of s.blocks) {
      if (!b.goal) continue
      const g = goalOf(b, now)
      // goalOf owns the pace and quiet readings used by every projection.
      out.push({
        spaceId: s.id, space: s.name, blockId: b.id, blockType: b.type, title: b.title,
        current: g.current, target: g.target, unit: g.unit, by: g.by,
        label: goalLabel(s, b), pace: g.pace, quietDays: g.quietDays,
      })
    }
  }
  return out
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
    // The year's standing goals, first and short, however many spaces there
    // are. A goal is a target over a block: progress goes into THAT block.
    goals: liveGoals(),
    spaces: state.spaces
      .filter((s) => !s.finished) // closed spaces are not filing targets
      .map((s) => ({
        id: s.id,
        name: s.name,
        area: s.area || '',
        pinned: !!s.pinned,
        complete: isComplete(s),
        role: spaceRole(s),
        updatedAt: s.updatedAt,
        blocks: s.blocks.map(lean),
      })),
    finishedSpaces: state.spaces.filter((s) => s.finished).map((s) => ({ id: s.id, name: s.name })),
    areas: [...new Set(state.spaces.filter((s) => !s.finished).map((s) => s.area).filter(Boolean))],
    lessons: state.lessons,
    about: projectAbout(),
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
    previousSnap = {
      json: JSON.stringify({
        spaces: state.spaces,
        captures: state.captures,
        lessons: state.lessons,
        about: state.about,
      }),
      at: now,
    }
  }
  lastAgentWriteAt = now
}

// Undo is for the moment after, not for an hour later: an old snapshot
// stops being offered. Restarting also clears it by design.
const UNDO_WINDOW_MS = 10 * 60 * 1000
export const undoIsFresh = () => !!previousSnap && Date.now() - previousSnap.at < UNDO_WINDOW_MS

export async function undo() {
  if (!undoIsFresh()) throw new Error('nothing recent to undo')
  const prev = JSON.parse(previousSnap.json)
  state.spaces = prev.spaces
  state.captures = prev.captures
  state.lessons = prev.lessons
  if (prev.about) state.about = normalizeAbout(prev.about)
  previousSnap = null
  await persistEvent({ kind: 'undo' })
}

// ---------------------------------------------------------- mutations

function trimCaptureInbox() {
  let excess = state.captures.filter((capture) => capture.status === 'inbox').length - 200
  if (excess <= 0) return
  state.captures = state.captures.filter((capture) => {
    if (capture.status !== 'inbox' || excess <= 0) return true
    excess--
    return false
  })
}

/** Shared non-persisting intake keeps single and batch capture behavior
    identical. Source ids win first; recent identical inbox text is an echo. */
function intakeCapture(text, hint, source = {}) {
  const suppliedId = String(source.id || '').trim()
  if (suppliedId) {
    const existing = state.captures.find((capture) => capture.id === suppliedId)
    if (existing) return { capture: existing, duplicate: true }
  }
  const capture = {
    id: suppliedId || uid(),
    text: String(text).trim().slice(0, 8000),
    at: source.at ? new Date(source.at).toISOString() : new Date().toISOString(),
    status: 'inbox',
  }
  // A double-click's echo, not a second thought: the identical sentence,
  // still unfiled, said again within a few seconds is one capture. Saying
  // it again MINUTES later is real (two coffees) and stays two.
  const echo = state.captures.find((c) => {
    const elapsed = new Date(capture.at) - new Date(c.at)
    return c.status === 'inbox' && c.text === capture.text && elapsed >= 0 && elapsed < 5000
  })
  if (echo) return { capture: echo, duplicate: true }
  if (hint) capture.hint = String(hint).slice(0, 60)
  state.captures.push(capture)
  // Only the unfiled inbox is bounded. Filed captures are the year's
  // receipts and may share ids in legacy state, so trim by position rather
  // than by id (an id set could delete filed provenance too).
  trimCaptureInbox()
  return { capture, duplicate: false }
}

export async function addCapture(text, hint, source = {}) {
  const { capture, duplicate } = intakeCapture(text, hint, source)
  if (duplicate) return { ...capture, duplicate: true }
  await persistEvent({ kind: 'capture', itemId: capture.id, summary: capture.text.slice(0, 200) })
  return capture
}

/** Persist a brain dump once while retaining one ordered event per unique
    line. Kept captures are returned in input order; duplicates produce
    neither state writes nor events. */
export async function addCaptureBatch(texts, hint) {
  const kept = []
  for (const text of texts) {
    const result = intakeCapture(text, hint)
    if (!result.duplicate) kept.push(result.capture)
  }
  if (kept.length) {
    await persist()
    for (const capture of kept) {
      await appendEvent({ kind: 'capture', itemId: capture.id, summary: capture.text.slice(0, 200) })
    }
  }
  return kept
}

/** The year, month by month: how much happened and a few words of what. */
function yearSummary() {
  const y = new Date().getFullYear()
  const months = Array.from({ length: 12 }, () => ({ events: 0, highlights: [] }))
  // the year's rhythm, week by week: what happened, and what is scheduled
  const weeks = Array.from({ length: 52 }, () => 0)
  const sweeks = Array.from({ length: 52 }, () => 0)
  const weekOf = (d) => Math.min(51, Math.max(0, Math.floor((d - new Date(y, 0, 1)) / (7 * 86400000))))
  const push = (iso, hl, counts = true) => {
    if (!iso) return
    const d = new Date(iso)
    if (d.getFullYear() !== y) return
    const m = months[d.getMonth()]
    if (counts) {
      m.events++
      weeks[weekOf(d)]++
    }
    if (hl && m.highlights.length < 2) m.highlights.push(String(hl).slice(0, 90))
  }
  // A filed capture and the ledger entry it became are ONE thing that
  // happened, and this counted both — so a month claimed 12 moments and
  // opening it showed 7. The count is dated events; a capture's summary
  // still supplies the month's headline, it just no longer counts twice.
  for (const c of state.captures) if (c.status === 'filed') push(c.at, c.summary, false)
  // the year also knows what is coming: open dated reminders and goal
  // horizons give future months a count of their own
  const scheduled = Array.from({ length: 12 }, () => 0)
  const aheadOf = (iso) => {
    if (!iso) return
    const d = new Date(`${iso}T12:00:00`)
    if (d.getFullYear() !== y) return
    scheduled[d.getMonth()]++
    sweeks[weekOf(d)]++
  }
  for (const s of state.spaces) {
    if (s.finished) continue
    for (const b of s.blocks) {
      if (b.type === 'reminder' && !b.done && b.when && b.when >= localDay()) aheadOf(b.when)
      if (b.goal && !(goalOf(b)?.met) && b.goal.by) aheadOf(b.goal.by)
    }
  }
  for (const s of [...state.spaces, ...(state.retired || [])]) {
    for (const b of s.blocks) {
      if (b.type === 'list') for (const i of b.items) if (i.doneAt) push(i.doneAt)
      if (b.type === 'ledger') for (const e of b.entries) push(e.at)
      if (b.type === 'reminder' && b.done && b.when) push(`${b.when}T12:00:00`)
      if (b.type === 'streak') for (const d of b.dates) push(`${d}T12:00:00`)
    }
  }
  months.forEach((m, i) => (m.scheduled = scheduled[i]))
  return { year: y, month: new Date().getMonth(), months, weeks, sweeks }
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
  const measures = goalMeasures(hit.space)
  applyBlockPatch(hit.block, patch)
  stampGoalMoves(hit.space, measures)
  touch(hit.space)
  const archived = maybeArchiveComplete(hit.space)
  await persistEvent({ kind, ...blockEvent(hit, { src: patch.source || undefined }) })
  if (archived) await persistEvent({ kind: 'finish', spaceId: hit.space.id, summary: 'finished' })
  return { ok: true, blockId, finished: !!hit.space.finished }
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

/** Reserved profile markdown. Append never overwrites; set replaces. */
export async function writeAbout(text, mode = 'set', { manual = false } = {}) {
  if (mode !== 'set' && mode !== 'append') throw new Error('mode must be set or append')
  const incoming = String(text ?? '')
  if (mode === 'append' && !incoming.trim()) return projectAbout()
  if (manual) remember('about')
  else agentBatchGuard()
  let next
  if (mode === 'append') {
    const cur = state.about?.markdown || ''
    next = cur ? `${cur.replace(/\s+$/, '')}\n\n${incoming.trim()}` : incoming.trim()
  } else {
    next = incoming
  }
  state.about = { markdown: next.slice(0, ABOUT_CAP), updatedAt: new Date().toISOString() }
  await persistEvent({ kind: 'write_about', summary: mode === 'append' ? 'appended' : 'set' })
  return projectAbout()
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

/** A goal: a target laid over a block that already exists. With no block
    named, the space's best candidate carries it: a tracker, then a ledger,
    then a streak, then a list. target 0 lifts the goal. */
export async function setGoal({ space: ref, blockId, target, unit, by } = {}) {
  agentBatchGuard()
  let hit = blockId ? findBlock(blockId) : null
  if (blockId && !hit) throw new Error('unknown blockId')
  if (!hit) {
    const sp = resolveSpace(ref, false)
    if (!sp) throw new Error('unknown space')
    const order = ['tracker', 'ledger', 'streak', 'list']
    const block = sp.blocks.find((b) => b.goal) || order.map((t) => sp.blocks.find((b) => b.type === t)).find(Boolean)
    if (!block) throw new Error(`${sp.name} has nothing a goal can count: add a tracker, ledger, streak, or list first`)
    hit = { space: sp, block }
  }
  const goal = setBlockGoal(hit.block, { target, unit, by })
  touch(hit.space)
  await persistEvent({
    kind: 'set_goal',
    ...blockEvent(hit, { summary: goal ? `goal ${goal.target}${goal.unit ? ` ${goal.unit}` : ''} by ${goal.by}` : 'goal lifted' }),
  })
  return { ok: true, space: hit.space.name, blockId: hit.block.id, goal: goal ? goalOf(hit.block) : null }
}

/** The conversion motion: a goal changes how it is counted, not what it
    is. "200 miles" starts as a bare tracker; the person starts logging
    individual runs; the goal moves onto the ledger. One invariant: moving
    a goal never changes where it stands — progress the old carrier held
    that the new one does not is kept on the goal as `carried`. A plain
    tracker that only mirrored the goal is absorbed: its current becomes
    carried, its target and unit already live in the goal, and its title
    passes to the new block — nothing it held is lost. Carriers that hold
    the person's own words (entries, items, dates) always stay. */
export async function moveGoal({ space: ref, blockId, toBlockId } = {}) {
  const sp = resolveSpace(ref, false)
  if (!sp) throw new Error('unknown space')
  const carrying = sp.blocks.filter((b) => b.goal)
  const src = blockId ? sp.blocks.find((b) => b.id === blockId) : carrying.length === 1 ? carrying[0] : null
  if (!src?.goal) {
    throw new Error(
      carrying.length > 1 ? 'several goals here: name the blockId to move' : `${sp.name} has no goal to move`
    )
  }
  const to = findBlock(toBlockId)
  if (!to) throw new Error('unknown toBlockId')
  if (to.space !== sp) throw new Error(`that block lives in ${to.space.name}; a goal moves within its own space`)
  if (!GOAL_TYPES.includes(to.block.type)) throw new Error(`a ${to.block.type} cannot carry a goal`)
  if (to.block.id === src.id) throw new Error('that block already carries this goal')
  if (to.block.goal) throw new Error(`${sp.name} already has a goal on that block`)

  // Validation must not alter undo state or durable history. A rejected move
  // is observationally identical to no call at all.
  agentBatchGuard()

  const standing = goalOf(src).current
  const goal = { ...src.goal }
  // whatever the new carrier does not already count rides along as carried
  const carried = Math.round(Math.max(0, standing - goalMeasure(to.block)) * 10) / 10
  if (carried) goal.carried = carried
  else delete goal.carried
  to.block.goal = goal
  if (to.block.type === 'tracker') to.block.target = goal.target

  // a tracker is the goal's own shape: everything it holds transfers, so it
  // is absorbed rather than left as a second counter of the same thing
  let absorbed = false
  if (src.type === 'tracker') {
    if (src.title && !to.block.title) to.block.title = src.title
    sp.blocks.splice(sp.blocks.indexOf(src), 1)
    absorbed = true
  } else {
    delete src.goal
  }

  touch(sp)
  await persistEvent({
    kind: 'move_goal',
    spaceId: sp.id,
    blockId: to.block.id,
    summary: `goal moved to ${to.block.type}${absorbed ? ', tracker absorbed' : ''}`,
    entities: [],
  })
  return { ok: true, space: sp.name, blockId: to.block.id, absorbed, goal: goalOf(to.block) }
}

/** A tracker counts a list only when it is plainly counting THAT list: one
    tracker, one list, and a target that matches the list's length (12 rent
    payments, 12 months). A second candidate of either kind makes the rule
    ambiguous and withdraws the projected countedBy stamp. */
export function trackerCounting(space, block) {
  if (!block || block.type !== 'list') return null
  const trackers = space.blocks.filter((b) => b.type === 'tracker')
  const lists = space.blocks.filter((b) => b.type === 'list')
  if (trackers.length !== 1 || lists.length !== 1 || lists[0].id !== block.id) return null
  return trackers[0].target === block.items.length ? trackers[0] : null
}

/** The same heartbeat choice used by the compact card. Kept server-side so
    goal labels in the band, year view, and agent view cannot drift. */
function goalHeroId(space) {
  const order = ['tracker-year', 'tracker', 'ledger', 'streak']
  for (const want of order) {
    const hit = space.blocks.find((b) =>
      want === 'tracker-year' ? b.type === 'tracker' && b.period === 'year' : b.type === want
    )
    if (hit) return hit.id
  }
  return null
}

export function goalLabel(space, block, hero = goalHeroId(space)) {
  return block.id === hero || !block.title ? space.name : block.title
}

/** Manual, instant check from the page — no model, no snapshot. */
export async function check(blockId, itemId, done) {
  const hit = findBlock(blockId)
  if (!hit) throw new Error('unknown block')
  remember('check')
  const measures = goalMeasures(hit.space)
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
      const repeatAnchor = b.repeatAnchor || recurrenceAnchorOf(b.when)
      const next = nextWhen(b.when, b.repeat, localDay(), repeatAnchor)
      b.repeatAnchor = repeatAnchor
      b.when = next // a rhythm rolls forward, it never dies
    } else {
      b.done = done !== false
      b.doneAt = b.done ? new Date().toISOString() : null
    }
  } else {
    throw new Error('not checkable')
  }
  stampGoalMoves(hit.space, measures)
  touch(hit.space)
  const archived = maybeArchiveComplete(hit.space)
  await persistEvent({ kind: 'check', ...blockEvent(hit, { itemId: itemId || undefined, summary: done === false ? 'unchecked' : 'checked' }) })
  if (archived) await persistEvent({ kind: 'finish', spaceId: hit.space.id, summary: 'finished' })
}

export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function parseLocalDay(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) throw new Error(`invalid ${label}`)
  const [, year, month, day] = match.map(Number)
  const date = new Date(year, month - 1, day, 12)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new Error(`invalid ${label}`)
  return date
}

const daysInMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0, 12).getDate()
const anchoredDate = (year, monthIndex, day) => new Date(year, monthIndex, Math.min(day, daysInMonth(year, monthIndex)), 12)
const dayOrdinal = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000

/** First occurrence strictly after today (or after a future due date).
    Calendar rhythms keep the original month/day anchor across clamps. */
export function nextWhen(when, repeat, today = localDay(), anchor = '') {
  const due = parseLocalDay(when, 'reminder date')
  const current = parseLocalDay(today, 'current date')
  const threshold = due > current ? due : current
  const stable = /^(\d{2})-(\d{2})$/.exec(anchor || recurrenceAnchorOf(when))
  if (!stable) throw new Error('invalid recurrence anchor')
  const anchorMonth = Number(stable[1]) - 1
  const anchorDay = Number(stable[2])
  if (anchorMonth < 0 || anchorMonth > 11 || anchorDay < 1 || anchorDay > daysInMonth(2000, anchorMonth)) {
    throw new Error('invalid recurrence anchor')
  }

  let next
  if (repeat === 'daily' || repeat === 'weekly') {
    const step = repeat === 'daily' ? 1 : 7
    next = new Date(due)
    if (next <= threshold) {
      // Calendar-day distance is independent of 23/25-hour DST days.
      const elapsed = dayOrdinal(threshold) - dayOrdinal(next)
      next.setDate(next.getDate() + (Math.floor(elapsed / step) + 1) * step)
    } else {
      next.setDate(next.getDate() + step)
    }
  } else if (repeat === 'monthly') {
    next = anchoredDate(threshold.getFullYear(), threshold.getMonth(), anchorDay)
    if (next <= threshold) next = anchoredDate(threshold.getFullYear(), threshold.getMonth() + 1, anchorDay)
  } else if (repeat === 'yearly') {
    next = anchoredDate(threshold.getFullYear(), anchorMonth, anchorDay)
    if (next <= threshold) next = anchoredDate(threshold.getFullYear() + 1, anchorMonth, anchorDay)
  } else {
    throw new Error('invalid recurrence')
  }
  return localDay(next)
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

const ROLLOVER_CONFIRM_MS = 5 * 60 * 1000
let rolloverPending = null

/** Restore only through an explicit chain of untouched rollover pages.
    Content shape is never evidence: a page with only profile text, lessons,
    or notes is still writing and is never replaced. */
async function recoverSpuriousRollover(targetYear) {
  let candidate = state
  let restored = null
  while (Number(candidate.yearOf) > targetYear) {
    const provenance = candidate.rolloverProvenance
    if (
      !provenance ||
      provenance.mutated ||
      Number(provenance.toYear) !== Number(candidate.yearOf) ||
      !Number.isInteger(Number(provenance.fromYear)) ||
      Number(provenance.fromYear) >= Number(provenance.toYear)
    ) return null
    const file = join(DATA_DIR, 'years', `${provenance.fromYear}.json`)
    if (!existsSync(file)) return null
    let archived
    try {
      archived = readState(file)
    } catch {
      return null
    }
    if (Number(archived.yearOf) !== Number(provenance.fromYear)) return null
    candidate = archived
    restored = archived
  }
  if (!restored || Number(candidate.yearOf) !== targetYear) return null

  const latestRevision = state.revision
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, restored)
  state.about = normalizeAbout(state.about)
  state.revision = Math.max(latestRevision, Number.isSafeInteger(state.revision) ? state.revision : 0)
  previousSnap = null
  lastAgentWriteAt = 0
  manualStack.length = 0
  await persistEvent({ kind: 'rollover_recovered', summary: `restored ${targetYear} after the clock returned` }, targetYear)
  return targetYear
}

export async function rolloverIfNeeded(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('invalid rollover date')
  const y = now.getFullYear()
  if (!state.yearOf) state.yearOf = y
  if (state.yearOf > y) {
    rolloverPending = null
    return recoverSpuriousRollover(y)
  }
  if (state.yearOf === y) {
    rolloverPending = null
    return null
  }
  // A leap of several years can be a bad system clock. It must remain in
  // place for two observations at least five minutes apart before rollover.
  if (y > state.yearOf + 1) {
    if (rolloverPending?.year !== y) {
      rolloverPending = { year: y, at: now.getTime() }
      return null
    }
    if (now.getTime() - rolloverPending.at < ROLLOVER_CONFIRM_MS) return null
  }
  rolloverPending = null
  const old = Number(state.yearOf)

  const yearsDir = join(DATA_DIR, 'years')
  mkdirSync(yearsDir, { recursive: true })
  await writeFile(join(yearsDir, `${old}.json`), JSON.stringify(state, null, 2))

  // the reading: what the year added up to
  let done = 0
  let met = 0
  for (const s of [...state.spaces, ...(state.retired || [])]) {
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
        items.push({
          id: `co${n++}`,
          space: s.name,
          kind: 'reminder',
          text: b.text,
          when: b.when || '',
          repeat: b.repeat || '',
          repeatAnchor: b.repeatAnchor || recurrenceAnchorOf(b.when),
          note: b.when ? `was due ${b.when}` : '',
        })
      }
      if (b.type === 'streak' && b.dates.length >= 10) {
        items.push({ id: `co${n++}`, space: s.name, kind: 'streak', title: b.title, note: `${b.dates.length} days in ${old}` })
      }
    }
  }

  const lessons = state.lessons // taste persists across years
  const about = normalizeAbout(state.about) // the person persists across years
  const fresh = emptyState()
  fresh.lessons = lessons
  fresh.about = about
  fresh.yearOf = y
  fresh.revision = state.revision
  fresh.carryover = { fromYear: old, finished: { done, met, moments, highlights }, items }
  fresh.rolloverProvenance = { fromYear: old, toYear: y, at: now.toISOString(), mutated: false }
  for (const k of Object.keys(state)) delete state[k]
  Object.assign(state, fresh)
  previousSnap = null
  lastAgentWriteAt = 0
  manualStack.length = 0
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
    if (it.kind === 'reminder') {
      block = makeBlock({ type: 'reminder', title: '', text: it.text, when: it.when, repeat: it.repeat })
      if (block && it.repeatAnchor) block.repeatAnchor = it.repeatAnchor
    }
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
  const spaces = [
    ...(old.spaces || []).map((space) => ({ space, retired: false })),
    ...(old.retired || []).map((space) => ({ space, retired: true })),
  ].map(({ space: s, retired }) => ({
    name: s.name,
    ...(retired ? { retired: true } : {}),
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

/** What a month actually held, grouped by the space it happened in.
    yearSummary() keeps a count and two summary strings and throws the
    events themselves away, so a month row on the year had nothing behind
    it to open. This reads the same state properly: every dated thing, in
    the words it was written in, with the shape of the month's weeks. */
export function readMonth(ym) {
  const m = String(ym || '').slice(0, 7)
  // \d{2} alone let 2026-13 through and quietly answered with an empty month
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error('not a month')
  const inMonth = (iso) => String(iso || '').startsWith(m)
  const perDay = new Map()
  const mark = (day) => day && perDay.set(day, (perDay.get(day) || 0) + 1)

  const spaces = []
  const roster = [
    ...state.spaces.map((space) => ({ space, retired: false })),
    ...(state.retired || []).map((space) => ({ space, retired: true })),
  ]
  for (const { space: s, retired } of roster) {
    const lines = []
    let money = 0
    let unit = ''
    let entries = 0
    let done = 0
    let marks = 0
    let ahead = 0
    for (const b of s.blocks) {
      if (b.type === 'ledger') {
        for (const e of b.entries) {
          if (!inMonth(e.at)) continue
          const day = e.at.slice(0, 10)
          lines.push({ day, text: e.label, amount: Number(e.amount) || 0, unit: b.unit || '' })
          money += Number(e.amount) || 0
          unit = b.unit || unit
          entries++
          mark(day)
        }
      }
      if (b.type === 'list') {
        for (const i of b.items) {
          if (!inMonth(i.doneAt)) continue
          const day = i.doneAt.slice(0, 10)
          lines.push({ day, text: i.text })
          done++
          mark(day)
        }
      }
      // an undated reminder that got done still happened on a day
      if (b.type === 'reminder' && b.done) {
        const day = inMonth(b.when) ? b.when : inMonth(b.doneAt) && !b.when ? b.doneAt.slice(0, 10) : ''
        if (day) {
          lines.push({ day, text: b.text })
          done++
          mark(day)
        }
      }
      if (b.type === 'streak') {
        for (const d of b.dates) {
          if (!d.startsWith(m)) continue
          marks++
          mark(d)
        }
      }
      // the month faces forward too: what is scheduled to happen in it —
      // open dated reminders, and goals whose horizon lands here. An
      // archived space schedules nothing; its record above still counts.
      if (s.finished || retired) continue
      if (b.type === 'reminder' && !b.done && inMonth(b.when) && b.when >= localDay()) {
        lines.push({ day: b.when, text: b.text, ahead: true, ...(b.at ? { at: b.at } : {}), ...(b.repeat ? { repeat: b.repeat } : {}) })
        ahead++
        mark(b.when)
      }
      if (b.goal && b.goal.by && inMonth(b.goal.by)) {
        const g = goalOf(b)
        if (g && !g.met) {
          lines.push({ day: b.goal.by, text: `${b.title || s.name} — ${fmtGoal(g)}`, ahead: true, goal: true })
          ahead++
          mark(b.goal.by)
        }
      }
    }
    if (!lines.length && !marks) continue
    // the money is handed over as a number, not a string: the page has one
    // formatter and it is the one that puts the comma in $2,300
    const bits = []
    if (entries > 1) bits.push(`${entries} entries`)
    if (done) bits.push(`${done} thing${done === 1 ? '' : 's'} done`)
    if (marks) bits.push(`${marks} day${marks === 1 ? '' : 's'}`)
    if (ahead) bits.push(`${ahead} due`)
    lines.sort((a, b) => a.day.localeCompare(b.day))
    spaces.push({
      name: s.name,
      area: s.area || '',
      ...(retired ? { retired: true } : {}),
      ...(entries ? { total: Math.round(money * 100) / 100, unit } : {}),
      headline: bits.join(' · '),
      lines: lines.slice(0, 40),
    })
  }

  // the month's own rhythm: which of its weeks carried anything
  const [yy, mm] = m.split('-').map(Number)
  const lastDay = new Date(yy, mm, 0).getDate()
  const weeks = []
  for (let d = 1; d <= lastDay; d += 7) {
    const to = Math.min(d + 6, lastDay)
    let count = 0
    for (let x = d; x <= to; x++) count += perDay.get(`${m}-${String(x).padStart(2, '0')}`) || 0
    weeks.push({ from: d, to, count })
  }
  const total = [...perDay.values()].reduce((n, x) => n + x, 0)
  const aheadTotal = spaces.reduce((n, sp) => n + sp.lines.filter((l) => l.ahead).length, 0)
  const label = new Date(yy, mm - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' })
  spaces.sort((a, b) => b.lines.length - a.lines.length)
  return { month: m, label, total, ahead: aheadTotal, weeks, spaces }
}

/** A goal named in a month's forward view, in the words the band uses. */
function fmtGoal(g) {
  const v = (n) => (g.unit === '$' ? `$${Math.round(n).toLocaleString('en-US')}` : `${n}${g.unit ? ` ${g.unit}` : ''}`)
  return `goal: ${v(g.target)} (at ${v(g.current)})`
}

export function listYears() {
  const dir = join(DATA_DIR, 'years')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((f) => Number(f.replace('.json', ''))).filter(Boolean).sort()
}

function yearSummaryOf(st) {
  const months = Array.from({ length: 12 }, () => ({ events: 0, highlights: [] }))
  const push = (iso, hl, counts = true) => {
    if (!iso) return
    const m = months[new Date(iso).getMonth()]
    if (counts) m.events++
    if (hl && m.highlights.length < 2) m.highlights.push(String(hl).slice(0, 90))
  }
  // Match the current-year summary: a filed capture supplies provenance and
  // a highlight, while the dated block change counts the event itself.
  for (const c of st.captures || []) if (c.status === 'filed') push(c.at, c.summary, false)
  for (const s of [...(st.spaces || []), ...(st.retired || [])]) {
    for (const b of s.blocks) {
      if (b.type === 'list') for (const i of b.items) if (i.doneAt) push(i.doneAt)
      if (b.type === 'ledger') for (const e of b.entries) push(e.at)
      if (b.type === 'reminder' && b.done && b.when) push(`${b.when}T12:00:00`)
      if (b.type === 'streak') for (const d of b.dates) push(`${d}T12:00:00`)
    }
  }
  return months
}

export const hasInbox = () => state.captures.some((c) => c.status === 'inbox')
export const stateRevision = () => state.revision

/** Cheap poll identity for everything whose projection can change without a
    write. The durable revision handles same-millisecond mutations; the
    remaining fields cross local calendar, reminder, expiry, and undo
    thresholds exactly when their rendered value changes. */
export function stateFingerprint(now = new Date()) {
  const day = localDay(now)
  const month = day.slice(0, 7)
  const urgency = state.spaces.map((space) => urgencyOf(space, now)).join(',')
  const goals = state.spaces.flatMap((space) => {
    if (space.finished) return []
    return space.blocks.filter((block) => block.goal).map((block) => {
      const goal = goalOf(block, now)
      // Match the browser's visible tick precision and include the server
      // verdicts that can change while durable goal data stays untouched.
      return [
        block.id,
        Math.round(goal.through * 1000),
        goal.paceText,
        goal.behind ? 1 : 0,
        goal.quietDays,
        goal.quietText,
      ].join(':')
    })
  }).join(',')
  const ask = state.ask && now - new Date(state.ask.at) < 48 * 3600000 ? state.ask.id : ''
  const surfaced = (state.surfaced || [])
    .filter((item) => surfacedIsLive(item, day))
    .map((item) => item.id || `${item.spaceId || ''}:${item.label || item.text || ''}`)
    .join(',')
  return `${state.revision}|${day}|${month}|${urgency}|${goals}|${ask}|${surfaced}|${undoIsFresh() ? 1 : 0}`
}

/** Debounce writes while keeping a newer task behind an in-flight one.
    Failures are contained and retained as pending work, so a later schedule
    or an explicit drain can retry without an unhandled rejection. */
export function createLatestWorkQueue(worker, { delayMs = 500, onError = () => {} } = {}) {
  if (typeof worker !== 'function') throw new Error('worker must be a function')
  let sequence = 0
  let pending = null
  let inFlight = null
  let timer = null
  let failedRevision = null
  let lastError = null

  const status = () => ({
    pendingRevision: pending?.revision ?? null,
    inFlightRevision: inFlight?.revision ?? null,
    lastError,
  })

  const arm = () => {
    if (!pending || inFlight || timer || pending.revision === failedRevision) return
    timer = setTimeout(() => {
      timer = null
      start()
    }, delayMs)
    timer.unref?.()
  }

  const start = () => {
    if (inFlight || !pending) return
    const task = pending
    pending = null
    const promise = Promise.resolve()
      .then(() => worker(task.value, task.revision))
      .then(() => {
        failedRevision = null
        lastError = null
      })
      .catch((error) => {
        failedRevision = task.revision
        lastError = String(error?.message || error).slice(0, 200)
        if (!pending || pending.revision < task.revision) pending = task
        try { onError(error) } catch {}
      })
      .finally(() => {
        inFlight = null
        arm()
      })
    inFlight = { revision: task.revision, promise }
  }

  const schedule = (value, revision) => {
    const supplied = Number.isSafeInteger(revision) && revision >= 0
    const next = supplied ? revision : sequence + 1
    if (supplied && next < sequence) return next
    sequence = Math.max(sequence, next)
    const activeRevision = Math.max(pending?.revision ?? -1, inFlight?.revision ?? -1)
    if (next < activeRevision) return next
    pending = { value, revision: next }
    if (failedRevision === next) failedRevision = null
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    arm()
    return next
  }

  const drain = async () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    while (pending || inFlight) {
      if (!inFlight) start()
      const current = inFlight
      if (!current) break
      await current.promise
      if (pending?.revision === failedRevision) break
    }
    return status()
  }

  return { schedule, drain, status }
}
