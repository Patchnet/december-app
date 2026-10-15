// Board runtime: the tools a coding agent keeps its board with, the sessions
// it works in, and the editions that hand one session to the next. Loaded by
// tools.mjs in every server, but it only wakes on a board (DECEMBER_MODE=board).
//
// A card is a workstream. Its first list holds the tasks in plan order, and
// each row carries a state (queued, doing, waiting, blocked, done, cancelled),
// the session that holds it, and the proof it was closed with. `proof.ok` is
// set only when the board itself checked something: the commit exists, the
// file exists. The person's own tick counts as proof (core.applyCheckMutation).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as core from './core.mjs'
import { boardFromEnv } from './board-mode.mjs'
import { createBoardFacts } from './board-facts.mjs'

/** A session ends after this long with no agent call; the next call opens a new one. */
export const SESSION_GAP_MS = 45 * 60_000
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'] // a headline's counts
const TASK_STATES = ['queued', 'doing', 'waiting', 'blocked', 'done', 'cancelled']
const ACTIONS = ['add', 'start', 'done', 'block', 'wait', 'cancel', 'queue']

/** Which agent: claude-code → claude, codex-mcp-client → codex, anything else → agent. */
export const tagOf = (client = '') => /claude/i.test(client) ? 'claude' : /codex/i.test(client) ? 'codex' : 'agent'

// ------------------------------------------------------------- tool surface

export const BOARD_TOOL_DEFS = [
  {
    name: 'december_task',
    description: 'Your plan on the board, which the person watches. One card per workstream; its rows are tasks in the order you will do them, named as names ("Read the git root", not a sentence). '
      + 'action: add (tasks, in plan order; creates the card), start (the task you are on now; one per session, so the last one goes back to the plan), '
      + 'done (with proof: tests "430 pass", the commit sha, a file it produced; the board checks the commit and the file and only then inks the tick), '
      + 'block (reason), wait (reason: it needs the person; then ask with december_ask), cancel (reason), queue (back to the plan). '
      + 'Name a task by its id or its words. Every result carries the person\'s unread notes and any drift: act on both.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', description: 'The workstream: a card name or id. Short, sentence case.' },
        action: { type: 'string', enum: ACTIONS },
        task: { type: 'string', description: 'One task: its id or its words.' },
        tasks: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'add: several tasks, in plan order.' },
        reason: { type: 'string', description: 'block, wait, cancel: a few words on why.' },
        proof: {
          type: 'object',
          properties: {
            tests: { type: 'string', description: 'The test run, e.g. "430 pass".' },
            commit: { type: 'string', description: 'A commit sha that holds the work.' },
            file: { type: 'string', description: 'A file the task produced, from the repo root.' },
            shot: { type: 'string', description: 'A screenshot path, from the repo root.' },
          },
          additionalProperties: false,
        },
      },
      required: ['card', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_scope',
    description: 'The paths a workstream may touch, as globs from the repo root ("lib/board-*.mjs", "public/css/"). Set it when you open a card. Files changed outside any card\'s scope show on the board as drift, which the person sees.',
    inputSchema: {
      type: 'object',
      properties: { card: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: 12 } },
      required: ['card', 'paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_handoff',
    description: 'Close your session with a hand-off. summary is one line on what got done; it becomes the headline of the session\'s edition, which the person reads like a front page. next lists what the next session should read or do first. The next session starts from it.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' }, next: { type: 'array', items: { type: 'string' }, maxItems: 6 } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
]
export const BOARD_TOOL_NAMES = new Set(BOARD_TOOL_DEFS.map((t) => t.name))
// The page tools a board keeps. The rest (About Me, lessons, goals,
// suggestions, the person's own line) belong to a person's page.
export const BOARD_PAGE_TOOLS = new Set(['december_view', 'december_read_block', 'december_read_space', 'december_ask',
  'december_create_block', 'december_write_note', 'december_file_capture', 'december_rename', 'december_finish', 'december_undo'])

// ------------------------------------------------------------------- files

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback } catch { return fallback }
}
async function writeJson(file, value) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
  await rename(tmp, file)
}

// ---------------------------------------------------------------- runtime

/**
 * One board's runtime. `info` is { repo, branch, root }; `dataDir` is the
 * board's store. `viewers` reports how many pages watch the board live.
 */
export function createBoardRuntime({ info, dataDir, facts = createBoardFacts({ root: info.root, dataDir }), now = () => Date.now(), url = '' }) {
  const sessionsFile = join(dataDir, 'board-sessions.json')
  const editionsFile = join(dataDir, 'board-editions.json')
  const store = readJson(sessionsFile, { sessions: [] })
  let editions = readJson(editionsFile, [])
  let saving = Promise.resolve()
  const save = () => (saving = saving.then(() => writeJson(sessionsFile, store)).catch(() => {}))
  const saveEditions = () => writeJson(editionsFile, editions).catch(() => {})
  const iso = (t = now()) => new Date(t).toISOString()
  const page = () => core.boardPage()

  // ---- sessions
  const last = () => store.sessions.at(-1) || null
  /** The session being watched: the last one, unless it ended or went quiet. */
  function current() {
    const s = last()
    if (!s || s.endedAt) return null
    return now() - Date.parse(s.lastActivityAt) < SESSION_GAP_MS ? s : null
  }
  async function open(tag, client) {
    let s = current()
    if (!s) {
      const prev = last()
      if (prev && !editions.some((e) => e.no === prev.no) && worked(prev)) await composeAndKeep(prev, { auto: true })
      s = { no: (prev?.no || 0) + 1, startedAt: iso(), lastActivityAt: iso(), endedAt: null, participants: [], waits: [] }
      store.sessions.push(s)
      if (store.sessions.length > 200) store.sessions.splice(0, store.sessions.length - 200)
    }
    const p = s.participants.find((x) => x.tag === tag)
    if (p) { p.lastSeenAt = iso(); if (client) p.client = client }
    else s.participants.push({ tag, client: client || '', startedAt: iso(), lastSeenAt: iso() })
    s.lastActivityAt = iso()
    trackWaits(s)
    save()
    return s
  }
  /** A session that moved anything: a row it touched, a wait it raised. */
  const worked = (s) => s.waits?.length || rowsOf().some((r) => r.row.session && inSession(r.row, s))
  const inSession = (row, s) => {
    const t = Date.parse(row.doneAt || row.startedAt || row.addedAt || '')
    return t >= Date.parse(s.startedAt) && (!s.endedAt || t <= Date.parse(s.endedAt) + 1000)
  }

  /** The asks raised this session, opened and closed as the page's own ask changes. */
  function trackWaits(s) {
    if (!s) return
    const ask = page().ask
    let changed = false
    for (const w of s.waits) if (!w.until && w.askId !== ask?.id) { w.until = iso(); changed = true }
    if (ask && !s.waits.some((w) => w.askId === ask.id) && Date.parse(ask.at) >= Date.parse(s.startedAt) - 1000) {
      s.waits.push({ askId: ask.id, at: ask.at, until: null, question: ask.question })
      changed = true
    }
    if (changed) save()
  }

  // ---- cards and rows
  const cards = () => page().spaces.filter((s) => !s.finished)
  const listOf = (space) => space.blocks.find((b) => b.type === 'list')
  function rowsOf(spaces = cards()) {
    return spaces.flatMap((space) => (listOf(space)?.items || []).map((row) => ({ space, row })))
  }
  const counted = (rows) => rows.filter((r) => r.state !== 'cancelled')
  const isDone = (r) => r.done || r.state === 'done'
  function findTask(items, ref) {
    const want = String(ref || '').trim()
    if (!want) return null
    const byId = items.find((i) => i.id === want)
    if (byId) return byId
    const low = want.toLowerCase()
    const exact = items.find((i) => i.text.toLowerCase() === low)
    if (exact) return exact
    const starts = items.filter((i) => i.text.toLowerCase().startsWith(low))
    if (starts.length === 1) return starts[0]
    const has = items.filter((i) => i.text.toLowerCase().includes(low))
    return has.length === 1 ? has[0] : null
  }
  const cardOf = (space) => {
    const rows = counted(listOf(space)?.items || [])
    return { id: space.id, name: space.name, done: rows.filter(isDone).length, total: rows.length }
  }
  const taskOf = (row) => row && { id: row.id, text: row.text, state: row.state || (row.done ? 'done' : 'queued'), ...(row.proof ? { proof: row.proof } : {}) }

  /** What every board tool hands back besides its own result. */
  async function context() {
    const unread = page().captures.filter((c) => c.status === 'inbox').map((c) => ({ id: c.id, text: c.text }))
    const f = await facts.read(cards())
    return { unread, drift: f.drift.map((d) => d.path) }
  }

  // ---- tools
  async function task(args = {}, tag = 'agent') {
    const action = String(args.action || '')
    if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`)
    if (!args.card || !String(args.card).trim()) throw new Error('name the card (the workstream)')
    const s = await open(tag)
    // proof is checked against git before anything is written
    let proof = null, proofNote = ''
    if (action === 'done') {
      const p = args.proof || {}
      const commit = p.commit ? await facts.commit(p.commit) : null
      const file = p.file ? facts.file(p.file) : null
      const shot = p.shot ? facts.file(p.shot) : null
      proof = {
        ...(p.tests ? { tests: String(p.tests).slice(0, 60) } : {}),
        ...(p.commit ? { commit: commit?.sha || String(p.commit).slice(0, 12) } : {}),
        ...(p.file ? { file: file || String(p.file).slice(0, 200) } : {}),
        ...(p.shot ? { shot: shot || String(p.shot).slice(0, 200) } : {}),
        ok: !!(commit || file || shot),
      }
      if (p.commit && !commit) proofNote = `No commit ${p.commit} in this repo, so the tick stays held.`
      else if ((p.file && !file) || (p.shot && !shot)) proofNote = 'That file is not in the work tree, so the tick stays held.'
      else if (!proof.ok) proofNote = 'Held tick: name the commit or a file it produced to ink it.'
      if (!Object.keys(proof).some((k) => k !== 'ok')) proof = null
    }
    const result = await core.boardWrite(({ resolveSpace, makeBlock, touch, uid }) => {
      const create = action === 'add' || action === 'start' || action === 'done'
      const space = resolveSpace(String(args.card).trim(), create)
      if (!space) throw new Error(`no card named ${args.card}; add tasks to open it`)
      space.role = 'do'
      space.session ||= tag
      let list = listOf(space)
      if (!list) { list = makeBlock({ type: 'list', title: space.name, items: [] }); space.blocks.push(list) }
      const stamp = iso()
      const addRow = (text) => {
        const clean = String(text || '').trim().slice(0, 200)
        if (!clean) return null
        const have = list.items.find((i) => i.text.toLowerCase() === clean.toLowerCase())
        if (have) return have
        const row = { id: uid(), text: clean, done: false, src: '', state: 'queued', session: tag, addedAt: stamp }
        list.items.push(row)
        return row
      }
      let rows = []
      if (action === 'add') {
        rows = (args.tasks?.length ? args.tasks : [args.task]).map(addRow).filter(Boolean)
        if (!rows.length) throw new Error('add needs tasks')
      } else {
        const row = findTask(list.items, args.task) || (create && args.task && !list.items.some((i) => i.id === args.task) ? addRow(args.task) : null)
        if (!row) throw new Error(`no task "${args.task}" on ${space.name}; its tasks are: ${list.items.map((i) => i.text).join(' · ') || 'none yet'}`)
        rows = [row]
        if (action === 'start') {
          // one task in hand per session: the last one goes back to the plan
          for (const { row: other } of rowsOf()) if (other !== row && other.state === 'doing' && (other.session || tag) === tag) other.state = 'queued'
          Object.assign(row, { state: 'doing', session: tag, startedAt: stamp, done: false, doneAt: null, reason: null })
        } else if (action === 'done') {
          Object.assign(row, { state: 'done', session: tag, done: true, doneAt: stamp, proof, reason: null })
          row.startedAt ||= stamp
        } else if (action === 'queue') {
          Object.assign(row, { state: 'queued', done: false, doneAt: null, reason: null })
        } else {
          const state = { block: 'blocked', wait: 'waiting', cancel: 'cancelled' }[action]
          Object.assign(row, { state, session: tag, done: false, doneAt: null, reason: args.reason ? String(args.reason).slice(0, 120) : null })
        }
      }
      touch(space)
      return {
        event: { kind: `board_${action}`, spaceId: space.id, blockId: list.id, summary: rows.map((r) => r.text).join(' · ').slice(0, 200) },
        result: { ok: true, card: cardOf(space), ...(rows.length === 1 ? { task: taskOf(rows[0]) } : { tasks: rows.map(taskOf) }) },
      }
    })
    s.lastActivityAt = iso()
    save()
    facts.invalidate()
    return { ...result, ...(proofNote ? { note: proofNote } : {}), ...(await context()) }
  }

  async function scope(args = {}, tag = 'agent') {
    await open(tag)
    const paths = (args.paths || []).map((p) => String(p).trim().slice(0, 120)).filter(Boolean).slice(0, 12)
    const result = await core.boardWrite(({ resolveSpace, touch }) => {
      const space = resolveSpace(String(args.card || '').trim(), true)
      if (!space) throw new Error('name the card')
      space.role = 'do'
      space.session ||= tag
      space.scope = paths
      touch(space)
      return { event: { kind: 'board_scope', spaceId: space.id, summary: paths.join(' · ') }, result: { ok: true, card: cardOf(space), scope: paths } }
    })
    facts.invalidate()
    return { ...result, ...(await context()) }
  }

  async function handoff(args = {}, tag = 'agent') {
    const s = await open(tag)
    s.endedAt = iso()
    const edition = await composeAndKeep(s, { auto: false, headline: args.summary, next: args.next })
    save()
    return { ok: true, edition: edition.no, headline: edition.headline, ...(await context()) }
  }

  /** The board-shaped view: cards with their tasks, the notes, what waits. */
  async function view() {
    const s = current()
    const f = await facts.read(cards())
    const latest = editions.at(-1)
    return {
      board: { repo: info.repo, branch: currentBranchName(), url, session: s?.no || null, base: f.base, ahead: f.ahead, files: f.files.length },
      cards: cards().map((space) => ({
        id: space.id, name: space.name, scope: space.scope || [], session: space.session || null,
        listId: listOf(space)?.id || null,
        tasks: (listOf(space)?.items || []).map(taskOf),
        notes: space.blocks.filter((b) => b.type === 'note').map((b) => ({ id: b.id, title: b.title, text: b.text.slice(0, 600) })),
      })),
      notes: page().captures.filter((c) => c.status === 'inbox').map((c) => ({ id: c.id, text: c.text, at: c.at })),
      ask: page().ask,
      drift: f.drift,
      ...(latest ? { lastHandoff: { no: latest.no, headline: latest.headline, next: latest.next } } : {}),
    }
  }

  // ---- editions
  function compose(s, { auto = true, headline = '', next = null } = {}, f) {
    const all = cards()
    const live = all.filter((space) => listOf(space)?.items?.length)
    const cardRows = live.map((space) => {
      const items = counted(listOf(space).items)
      return {
        id: space.id, name: space.name, session: space.session || null,
        done: items.filter(isDone).length, total: items.length, proven: items.filter((r) => isDone(r) && r.proof?.ok).length,
        rows: listOf(space).items.map((r) => ({ text: r.text, state: r.state || (r.done ? 'done' : 'queued'), proof: r.proof || null, ...(r.reason ? { reason: r.reason } : {}), ...(r.session ? { session: r.session } : {}) })),
      }
    })
    const rows = live.flatMap((space) => counted(listOf(space).items))
    const from = Date.parse(s.startedAt), to = s.endedAt ? Date.parse(s.endedAt) : Infinity
    const commits = f.commits.filter((c) => { const t = Date.parse(c.at); return t >= from - 60_000 && t <= to + 60_000 })
    const doneHere = rowsOf(live).filter(({ row }) => isDone(row) && row.doneAt && Date.parse(row.doneAt) >= from && Date.parse(row.doneAt) <= to)
    const touched = [...new Set(doneHere.map(({ space }) => space.name))]
    // a headline, not a log line: "Two tasks done on Mode detection and Hooks"
    const count = WORDS[doneHere.length] || String(doneHere.length)
    const composed = touched.length
      ? `${count} ${doneHere.length === 1 ? 'task' : 'tasks'} done on ${touched.slice(0, 2).join(' and ')}${touched.length > 2 ? ` and ${touched.length - 2} more` : ''}`
      : live.length ? `Planned ${live.slice(0, 2).map((c) => c.name).join(' and ')}${live.length > 2 ? ` and ${live.length - 2} more` : ''}` : 'Nothing on the board yet'
    const open = rowsOf(live).filter(({ row }) => !isDone(row) && row.state !== 'cancelled')
    const ask = page().ask
    return {
      no: s.no, repo: info.repo, branch: currentBranchName(),
      startedAt: s.startedAt, endedAt: s.endedAt || null, composedAt: iso(), auto,
      headline: String(headline || '').trim().slice(0, 140) || composed,
      figures: { done: rows.filter(isDone).length, total: rows.length, proven: rows.filter((r) => isDone(r) && r.proof?.ok).length, commits: commits.length, files: f.files.length, outside: f.drift.length },
      cards: cardRows,
      waiting: ask ? [{ question: ask.question, options: ask.options || [], askId: ask.id }] : [],
      next: (next?.length ? next : [...open.filter(({ row }) => row.state === 'doing'), ...open.filter(({ row }) => row.state !== 'doing')].slice(0, 3).map(({ row }) => row.text))
        .map((x) => String(x).slice(0, 160)).slice(0, 6),
      drift: f.drift.map((d) => d.path),
    }
  }
  async function composeAndKeep(s, opts) {
    const edition = compose(s, opts, await facts.read(cards()))
    editions = editions.filter((e) => e.no !== s.no).concat(edition).sort((a, b) => a.no - b.no).slice(-100)
    await saveEditions()
    return edition
  }
  async function editionLive() {
    const s = current() || last()
    const f = await facts.read(cards())
    const kept = s && editions.find((e) => e.no === s.no)
    const live = s ? (s.endedAt && kept ? kept : compose(s, { auto: true }, f)) : null
    const past = editions.filter((e) => e.no !== live?.no).reverse().map(({ no, startedAt, endedAt, headline }) => ({ no, startedAt, endedAt, headline }))
    return { live, past }
  }
  const editionByNo = (no) => editions.find((e) => e.no === Number(no)) || null

  // ---- what the page and the other boards read
  let branchAt = 0, branch = info.branch
  function currentBranchName() {
    if (now() - branchAt > 5000) {
      branchAt = now()
      try {
        const head = readFileSync(join(gitDir(info.root), 'HEAD'), 'utf8').trim()
        branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : `detached ${head.slice(0, 7)}`
      } catch {}
    }
    return branch
  }

  async function state() {
    const s = current()
    trackWaits(s)
    const f = await facts.read(cards())
    const shown = s || last()
    return {
      repo: info.repo, branch: currentBranchName(), root: info.root,
      base: f.base, ahead: f.ahead, files: f.files, drift: f.drift,
      commits: shown ? f.commits.filter((c) => Date.parse(c.at) >= Date.parse(shown.startedAt) - 60_000) : [],
      session: shown ? { no: shown.no, startedAt: shown.startedAt, lastActivityAt: shown.lastActivityAt, endedAt: shown.endedAt || null, live: !!s } : null,
      sessions: shown?.participants || [],
      waits: shown?.waits || [],
      editions: editions.length,
      boards: countBoards(dirname(dataDir)),
    }
  }

  /** One line about this board, for the boards sheet on any board. */
  function summary() {
    const s = current()
    const ask = page().ask
    const doing = rowsOf().find(({ row }) => row.state === 'doing')
    const waitingRow = rowsOf().find(({ row }) => row.state === 'waiting')
    const working = !!(s && doing && now() - Date.parse(s.lastActivityAt) < 10 * 60_000)
    return {
      repo: info.repo, branch: currentBranchName(), slug: basename(dataDir), url,
      state: ask || waitingRow ? 'waiting' : working ? 'working' : 'idle',
      waiting: ask?.question || waitingRow?.row.text || null,
      task: doing?.row.text || null,
      headline: editions.at(-1)?.headline || null,
      updatedAt: page().updatedAt || s?.lastActivityAt || null,
    }
  }

  /** At initialize: open (or join) the session and say where the last one left off. */
  async function hello(client = '') {
    const s = await open(tagOf(client), client)
    const latest = [...editions].reverse().find((e) => e.no !== s.no) || null
    const open_ = rowsOf().filter(({ row }) => ['doing', 'waiting', 'blocked'].includes(row.state))
      .map(({ space, row }) => ({ card: space.name, task: row.text, state: row.state }))
    return { session: s.no, latest: latest && { no: latest.no, headline: latest.headline, next: latest.next, endedAt: latest.endedAt }, open: open_.slice(0, 6) }
  }

  /** Any agent call counts as activity in the session. */
  const activity = (tag) => open(tag)

  return { task, scope, handoff, view, hello, activity, state, summary, editionLive, editionByNo, current, facts }
}

/** The .git directory of a work tree (a worktree's .git is a file that points at it). */
function gitDir(root) {
  const dot = join(root, '.git')
  try {
    if (statSync(dot).isFile()) {
      const to = readFileSync(dot, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim()
      if (to) return to.startsWith('/') ? to : join(root, to)
    }
  } catch {}
  return dot
}

function countBoards(root) {
  try { return readdirSync(root).filter((d) => existsSync(join(root, d, 'board.json'))).length } catch { return 1 }
}

/** Every board on this machine, read from the boards folder and their servers. */
export async function listBoards({ root, here, hereSummary, fetchImpl = fetch }) {
  let dirs = []
  try { dirs = readdirSync(root).filter((d) => existsSync(join(root, d, 'board.json'))) } catch {}
  const boards = await Promise.all(dirs.map(async (slug) => {
    const dir = join(root, slug)
    if (dir === here) return { ...hereSummary, here: true }
    const meta = readJson(join(dir, 'board.json'), {})
    const port = readJson(join(dir, 'server.json'), {})?.port
    if (port) {
      try {
        const res = await fetchImpl(`http://localhost:${port}/api/board/summary`, { signal: AbortSignal.timeout(700) })
        if (res.ok) return { ...(await res.json()), here: false }
      } catch {}
    }
    const editions = readJson(join(dir, 'board-editions.json'), [])
    let updatedAt = null
    try { updatedAt = statSync(join(dir, 'state.json')).mtime.toISOString() } catch {}
    return { repo: meta.repo || slug, branch: meta.branch || '', slug, url: null, state: 'idle', waiting: null, task: null, headline: editions.at(-1)?.headline || null, updatedAt, here: false }
  }))
  const rank = { waiting: 0, working: 1, idle: 2 }
  return boards.sort((a, b) => rank[a.state] - rank[b.state] || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

// ---------------------------------------------------------- the singleton

let runtime = null
/** This server's board runtime, or null on a person's page. */
export function boardRuntime() {
  if (runtime) return runtime
  const info = boardFromEnv()
  if (!info) return null
  runtime = createBoardRuntime({ info, dataDir: core.DATA_DIR, url: `http://localhost:${process.env.PORT || 3008}/` })
  return runtime
}

/** Dispatch one board tool. `tag` names the agent (claude, codex, agent). */
export async function dispatchBoardTool(name, args, tag) {
  const rt = boardRuntime()
  if (!rt) throw new Error(`${name} works on a board: start December's MCP connection inside a git repo`)
  if (name === 'december_task') return rt.task(args, tag)
  if (name === 'december_scope') return rt.scope(args, tag)
  if (name === 'december_handoff') return rt.handoff(args, tag)
  throw new Error(`unknown tool: ${name}`)
}
export { TASK_STATES }
