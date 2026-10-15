import { $, page, esc } from './session.js'
import { windMark, stopWind } from './working-mark.js'
// Board mode: a coding agent's own December. The page reads the same. The
// dateline names the repo and branch and keeps the session's clock; the line
// across the top is the session itself (board-timeline.js); the stage says
// what the agent is on, where the person is needed, and how far along it is.
// The line takes notes to the agent; a note waits at its end until the
// agent files it, and a pen rule is drawn under it as it lets go.
// The server sends `board` on /api/state only, so the last one seen is kept.

let board = null
const isBoard = () => document.documentElement.dataset.mode === 'board'
const time = (iso) => new Date(iso).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
const span = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const stateOf = (i) => i.state || (i.done ? 'done' : 'queued')
const rows = () => page.state.spaces.filter((s) => !s.finished).flatMap((s) => s.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items.map((item) => ({ space: s, block: b, item }))))
const agents = () => new Set((board?.sessions || []).map((s) => s.tag)).size

// the two sheets are their own modules, loaded when first opened
let sheet = null
const sheets = () => import('./board-edition.js').then((m) => (sheet = m))
let timeline = null

/** Called first on every paint. False on a person's page. */
export function paintBoard() {
  board = page.state?.board || board
  if (!board) return false
  const root = document.documentElement
  if (root.dataset.mode !== 'board') {
    root.dataset.mode = 'board'
    page.field.placeholder = 'Anything for the agent?'
    page.field.setAttribute('aria-label', 'Note to the agent')
    $('#dateline').setAttribute('aria-label', 'Open this session’s edition')
    mountBoardChrome()
  }
  paintDateline()
  paintTab()
  return true
}

/** The repo and branch, and the session's clock beside them. */
function paintDateline() {
  const s = board.session
  const clock = !s ? '' : s.live
    ? `started ${time(s.startedAt)} · ${span(Date.now() - Date.parse(s.startedAt))}`
    : `${time(s.startedAt)} to ${time(s.endedAt || s.lastActivityAt)}`
  const el = $('#dateline')
  const key = `board|${board.repo}|${board.branch}|${clock}`
  if (el.dataset.key === key) return
  el.dataset.key = key
  // repo and branch each hold together, so a narrow screen breaks between them
  el.innerHTML = `<span class="board-part">${esc(board.repo)}<span class="board-sep"> ·</span></span> <span class="board-part">${esc(board.branch)}</span>${clock ? `<span class="til board-clock">${esc(clock)}</span>` : ''}`
}

/** Something waits on the person: the tab says so, in words. */
function paintTab() {
  const waiting = !!page.state.ask || rows().some((r) => stateOf(r.item) === 'waiting')
  const title = `${waiting ? 'Needs you · ' : ''}${board.repo} · ${board.branch}`
  if (document.title !== title) document.title = title
}

/** Once, on entering board mode: the timeline's host, the boards door, the dateline's door. */
function mountBoardChrome() {
  const host = document.createElement('div')
  host.className = 'board-timeline'
  $('#dateline').before(host)
  import('./board-timeline.js').then((m) => { timeline = m.drawTimeline; paintBoardMoment() }).catch(() => {})
  const boards = document.createElement('button')
  boards.type = 'button'
  boards.className = 'board-boards'
  boards.textContent = 'boards'
  boards.hidden = true
  boards.addEventListener('click', () => sheets().then((m) => m.openBoards()))
  // in the find field's empty left side, beside its placeholder
  $('.search-wrap')?.append(boards)
  // the dateline opens the session's edition here, not the year
  const open = (e) => {
    if (!isBoard() || !e.target.closest?.('#dateline')) return
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopImmediatePropagation()
    sheets().then((m) => m.openEdition())
  }
  document.addEventListener('click', open, true)
  document.addEventListener('keydown', open, true)
}

/** The stage at rest: the task in hand, the doors, and three figures. Runs
    inside the paint, in place of the day's line and the goals. */
export function paintBoardMoment() {
  if (!board || !isBoard()) return
  const all = rows()
  const doing = all.find((r) => stateOf(r.item) === 'doing')
  const counted = all.filter((r) => stateOf(r.item) !== 'cancelled')
  const done = counted.filter((r) => stateOf(r.item) === 'done')
  const waiting = all.filter((r) => stateOf(r.item) === 'waiting').length + (page.state.ask ? 1 : 0)
  const open = counted.length - done.length
  const next = !doing && all.find((r) => ['queued', 'blocked'].includes(stateOf(r.item)))
  const s = board.session

  const today = $('#today')
  const lead = doing
    ? `<div class="today-item board-now"><span class="board-yarn" aria-hidden="true"></span><span class="board-task">${esc(doing.item.text)}</span>${agents() > 1 && doing.item.session ? `<span class="space-tag">${esc(doing.item.session)}</span>` : ''}<span class="sr-only">, in progress</span></div>`
    : next ? `<div class="today-item board-now"><span class="next-when">next</span><span class="board-task quiet">${esc(next.item.text)}</span></div>` : ''
  const doors = counted.length ? `<div class="shape">${waiting ? `<button type="button" class="shape-part board-needs" data-board-door="waiting">${waiting} waiting on you</button>` : ''}<span class="shape-part quiet">${open} open</span><span class="shape-part quiet">${done.length} done</span>${s ? `<span class="shape-part stamp quiet">changed ${time(s.lastActivityAt)}</span>` : ''}</div>` : ''
  const key = `${lead}|${doors}`
  if (today.dataset.board !== key) {
    for (const w of today.querySelectorAll('.wind')) stopWind(w)
    today.dataset.board = key
    today.classList.add('norise')
    today.innerHTML = lead + doors
    today.querySelector('.board-yarn')?.appendChild(windMark())
  }

  const goals = $('#goals')
  const tests = latestTests(done)
  const files = board.files?.length || 0
  const outside = board.drift?.length || 0
  const pct = counted.length ? Math.round((done.length / counted.length) * 100) : 0
  const figs = counted.length ? `
    <a class="goal board-fig"><span class="goal-name">tasks</span><span class="goal-count"><b>${done.length}</b><small>of ${counted.length}</small></span><span class="goal-meter"><b style="width:${pct}%"></b></span></a>
    ${tests ? `<a class="goal board-fig"><span class="goal-name">tests passing</span><span class="goal-count"><b>${tests}</b></span></a>` : ''}
    <a class="goal board-fig"><span class="goal-name">files changed</span><span class="goal-count"><b>${files}</b></span>${outside ? `<span class="goal-pace board-outside">${outside} outside scope</span>` : ''}</a>` : ''
  if (goals.dataset.board !== figs) {
    goals.dataset.board = figs
    goals.innerHTML = figs
    goals.hidden = !figs
  }

  paintAskFacts()
  paintNote()
  mountRowYarn()
  if (timeline) timeline($('.board-timeline'), { board, spaces: page.state.spaces, now: Date.now() })
  // an open sheet keeps up with answers given anywhere else
  sheet?.refreshSheet()
  const door = document.querySelector('.board-boards')
  if (door) door.hidden = !(board.boards > 1)
}

/** The latest test count a closed task offered: "430 pass" reads 430. */
function latestTests(done) {
  const withTests = done.filter((r) => r.item.proof?.tests).sort((a, b) => String(b.item.doneAt || '').localeCompare(String(a.item.doneAt || '')))
  const m = withTests[0]?.item.proof.tests.match(/(\d[\d,]*)\s*(?:pass|passing|ok)/i)
  return m ? m[1] : ''
}

/** An approval reads with what it would move: the branch, how far ahead, how much changed. */
function paintAskFacts() {
  const ask = document.querySelector('#ask .ask')
  if (!ask || ask.querySelector('.board-ask-facts')) return
  const bits = [board.branch && board.base ? `${board.branch} → ${board.base}` : board.branch, board.ahead ? `${board.ahead} ${board.ahead === 1 ? 'commit' : 'commits'} ahead` : '', board.files?.length ? `${board.files.length} files` : ''].filter(Boolean)
  if (bits.length) ask.querySelector('.ask-q')?.insertAdjacentHTML('afterend', `<div class="board-ask-facts">${esc(bits.join(' · '))}</div>`)
}

/** Doing rows on the cards wear the yarn where their tick would be. */
function mountRowYarn() {
  for (const slot of document.querySelectorAll('.row .tick-wind:not(:has(.wind))')) slot.appendChild(windMark())
}

// ------------------------------------------------------------- notes
// The newest note waits at the line's end. When the agent files it, a pen
// rule is drawn under it and it lets go; the next unread one takes its place.
let shown = null // { id, text, el }
function paintNote() {
  const wrap = page.field.closest('.cwrap')
  const inbox = page.state.captures.map((c) => ({ id: c.id, text: c.text }))
  const queued = (page.queuedTexts || []).map((text, n) => ({ id: `queued:${n}:${text}`, text, queued: true }))
  const notes = [...inbox, ...queued]
  // a queued note becomes a capture with the same words: keep the one on screen
  if (shown && shown.queued && inbox.some((c) => c.text === shown.text)) {
    shown.id = inbox.find((c) => c.text === shown.text).id
    shown.queued = false
  }
  const latest = notes.at(-1)
  if (shown && !shown.reading && !notes.some((n) => n.id === shown.id) && !shown.queued) return letGo(wrap)
  if (shown?.reading) return
  if (!latest) return
  if (shown && shown.id === latest.id) return
  shown?.el.remove()
  const el = document.createElement('span')
  el.className = 'board-echo'
  el.innerHTML = `<span class="board-echo-words">${esc(latest.text)}</span><span class="board-ack" aria-hidden="true"></span>`
  el.setAttribute('role', 'status')
  wrap.append(el)
  wrap.classList.add('has-echo')
  wrap.style.setProperty('--echo-w', `${Math.min(el.offsetWidth + 16, wrap.offsetWidth * 0.42)}px`)
  shown = { ...latest, el }
}
function letGo(wrap) {
  const note = shown
  note.reading = true
  note.el.classList.add('read')
  note.el.setAttribute('aria-label', `${note.text}, read`)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  setTimeout(() => {
    note.el.classList.add('out')
    setTimeout(() => {
      note.el.remove()
      if (shown === note) shown = null
      if (!wrap.querySelector('.board-echo')) wrap.classList.remove('has-echo')
      paintNote()
    }, reduced ? 0 : 240)
  }, reduced ? 900 : 1500)
}

// the waiting door takes you to the row that waits
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('[data-board-door="waiting"]')) return
  const row = document.querySelector('#spaces .row.is-waiting') || document.querySelector('#ask .ask')
  row?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  row?.focus?.({ preventScroll: true })
})
