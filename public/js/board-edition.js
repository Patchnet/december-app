import { esc, reduced } from './session.js'
import { windMark, stopWind } from './working-mark.js'

// Board mode's two sheets.
//
// The hand-off edition is the front page of a coding session: the repo as the
// masthead, what got done as the headline, the workstreams as columns, what
// waits on the person answerable where it is read, and what the next session
// should read first. The boards sheet is every board on this machine, what
// waits on the person first.
//
// Both are December's own sheet, not a new one: the page's backdrop, the card
// arriving on the ladder, Escape closing at once (a key press does not play),
// a pointer close leaving on the 220ms rung, focus kept inside and handed back
// to whatever opened it. Nothing here exists until one of them opens, and every
// hook it leaves on the page is a be-* class or data-be-* attribute, so the
// page's own click and key handlers never mistake it for one of theirs.

const urls = { edition: '/api/board/edition', boards: '/api/boards', answer: '/api/answer' }
let send = (url, init) => fetch(url, init)

/** For the harness only: the scratchpad has no board server, so its fixtures
    stand in for the endpoints. The app never calls this. */
export function setEndpoints({ edition, boards, answer, fetch: fetcher } = {}) {
  if (edition) urls.edition = edition
  if (boards) urls.boards = boards
  if (answer) urls.answer = answer
  if (fetcher) send = fetcher
}

async function request(url, body) {
  const res = await send(url, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'request failed')
  return data
}
const withQuery = (url, key, value) => `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`

// A move the keyboard caused does not animate. The last input decides, so the
// dateline opened with Enter arrives at once and one clicked arrives moving.
// Loaded lazily by the first press, so that press is read off the focus ring.
let lastInput = (() => { try { return document.activeElement?.matches(':focus-visible') ? 'key' : 'pointer' } catch { return 'pointer' } })()
addEventListener('keydown', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) lastInput = 'key' }, true)
addEventListener('pointerdown', () => { lastInput = 'pointer' }, true)
const still = () => reduced || lastInput === 'key' || document.hidden
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------- the words

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const when = (iso) => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d : null
}
const sameDay = (a, b) => a.toDateString() === b.toDateString()
const pm = (d) => d.getHours() >= 12
const clock = (d, meridiem = true) =>
  `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${meridiem ? (pm(d) ? ' pm' : ' am') : ''}`
/** "oct 13" in the page's small register; a time when it is today. */
function shortDate(iso) {
  const d = when(iso)
  if (!d) return ''
  const now = new Date()
  if (sameDay(d, now)) return clock(d)
  const day = `${MONTHS[d.getMonth()].slice(0, 3).toLowerCase()} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`
}
/** "Wednesday, October 14 · 2:14 to 4:40 pm", or "2:14 pm to now" while live. */
function sessionSpan(startedAt, endedAt) {
  const a = when(startedAt), b = when(endedAt)
  if (!a) return ''
  const day = `${DAYS[a.getDay()]}, ${MONTHS[a.getMonth()]} ${a.getDate()}`
  if (!b) return `${day} · ${clock(a)} to now`
  const one = sameDay(a, b)
  return `${day} · ${clock(a, !(one && pm(a) === pm(b)))} to ${clock(b)}${one ? '' : ` ${DAYS[b.getDay()]}`}`
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const safeUrl = (url) => (/^https?:\/\//i.test(String(url || '')) ? String(url) : '')

const TICK = '<span class="tick" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2 6.2 L4.8 9 L10 3.4"/></svg></span>'
const close = (label) => `<button type="button" class="surface-close" data-be-close aria-label="${esc(label)}">Close</button>`

// ------------------------------------------------------- the edition

let past = []      // the list that came with the latest edition, kept for walking back through them
let latestNo = null

function editionView(ed, no) {
  const viewingPast = no != null && no !== latestNo
  const back = viewingPast ? '<button type="button" class="mo-back" data-be-latest>‹ Latest edition</button>' : '<span></span>'
  const toolbar = `<div class="be-toolbar">${back}${close('Close the edition')}</div>`
  if (!ed) {
    return { label: 'Edition', html: `${toolbar}<div class="be-body"><p class="be-none">No edition yet.</p></div>` }
  }
  const live = !ed.endedAt
  const cards = Array.isArray(ed.cards) ? ed.cards : []
  const sessions = [...new Set([...(ed.sessions || []).map((s) => s?.tag || s), ...cards.map((c) => c.session)].filter(Boolean))]
  const headline = String(ed.headline || '')
  const len = headline.length > 140 ? ' data-len="longer"' : headline.length > 70 ? ' data-len="long"' : ''
  const body = [
    `<header class="be-head">
      <h2 class="be-mast">${esc(ed.repo || '')}</h2>
      <span class="be-rule" aria-hidden="true"></span>
      <div class="be-line"><span>No. ${esc(ed.no ?? '')}</span><span>${esc(sessionSpan(ed.startedAt, ed.endedAt))}</span><span>${esc([ed.branch, sessions.join(', ')].filter(Boolean).join(' · '))}</span></div>
    </header>`,
    headline ? `<h3 class="be-hl" tabindex="-1"${len}>${esc(headline)}</h3>` : '',
    figuresHTML(ed.figures || {}),
    cards.length ? columnsHTML(cards, live) : '',
    footHTML(ed),
    endHTML(ed, live),
    pastHTML(viewingPast ? no : latestNo),
  ].join('')
  return { label: `Edition No. ${ed.no ?? ''}, ${ed.repo || 'this board'}`, html: `${toolbar}<div class="be-body">${body}</div>` }
}

function figuresHTML(f) {
  const figs = []
  if (f.total) figs.push([f.done ?? 0, 'tasks', f.total])
  if (f.total && f.proven != null) figs.push([f.proven, 'proven'])
  if (f.commits != null) figs.push([f.commits, f.commits === 1 ? 'commit' : 'commits'])
  if (f.files != null) figs.push([f.files, f.files === 1 ? 'file' : 'files'])
  if (!figs.length) return ''
  return `<div class="figs be-figs">${figs.map(([b, s, of]) => `<div class="fig"><b>${esc(b)}${of ? `<small> of ${esc(of)}</small>` : ''}</b><span>${esc(s)}</span></div>`).join('')}</div>`
}

// one column per workstream; five or six fall into rows of three
function columnsHTML(cards, live) {
  const cols = cards.length <= 4 ? cards.length : cards.length <= 6 ? 3 : 4
  return `<div class="be-cols" data-cols="${cols}">${cards.map((c) => columnHTML(c, live)).join('')}</div>`
}

function columnHTML(card, live) {
  const rows = Array.isArray(card.rows) ? card.rows : []
  const done = card.done ?? rows.filter((r) => r.state === 'done').length
  const total = card.total ?? rows.length
  const proven = card.proven ?? rows.filter((r) => r.proof?.ok).length
  const blocked = rows.filter((r) => r.state === 'blocked').length
  const waiting = rows.filter((r) => r.state === 'waiting').length
  const facts = [total ? `${done} of ${total} done` : 'no tasks']
  if (done && proven >= done) facts.push(done > 1 ? 'all proven' : 'proven')
  else if (proven) facts.push(`${proven} proven`)
  if (blocked) facts.push(`${blocked} blocked`)
  if (waiting) facts.push(`${waiting} waiting on you`)
  // who kept this workstream: a quiet word with its counts, never a mark
  if (card.session) facts.push(card.session)
  return `<section class="be-col">
    <h4 class="space-name">${esc(card.name || '')}</h4>
    <p class="be-colk">${esc(facts.join(' · '))}</p>
    <div class="be-rows">${rows.map((r) => rowHTML(r, live)).join('')}</div>
  </section>`
}

// In the record, done is the news: ticked and set in ink, never struck through.
function rowHTML(row, live) {
  const st = row.state || 'queued'
  const done = st === 'done'
  const mark = st === 'doing' && live ? '<span class="be-slot" data-be-yarn aria-hidden="true"></span>' : TICK
  const said = done ? 'done' : st === 'doing' ? 'in progress' : ''
  const sub = rowSub(row, live)
  // closed without proof the board could check: the dashed tick, as on the card
  const held = done && row.proof && !row.proof.ok
  return `<div class="row be-row${done ? ' done no-anim' : ''}${held ? ' held' : ''}" data-state="${esc(st)}">${mark}<span class="row-text">${said ? `<span class="sr-only">${said}: </span>` : ''}${esc(row.text || '')}</span></div>${sub ? `<div class="be-sub">${sub}</div>` : ''}`
}

/** The small line under a row: its proof, why it stopped, or who has it. */
function rowSub(row, live) {
  const quiet = (s) => `<span>${esc(s)}</span>`
  const why = row.reason ? ` ${quiet(`· ${row.reason}`)}` : ''
  switch (row.state) {
    case 'done': {
      const p = row.proof
      if (!p) return ''
      const name = (path) => String(path).split('/').pop()
      const bits = [p.tests, p.commit && String(p.commit).slice(0, 7), p.file && name(p.file), p.shot && name(p.shot)].filter(Boolean)
      if (!bits.length) return ''
      // ok is the board's own check (the commit exists, the file exists)
      return `${esc(bits.join(' · '))}${p.ok ? '' : ` ${quiet('· unconfirmed')}`}`
    }
    case 'doing': return live ? (row.session ? esc(row.session) : '') : `${row.session ? `${esc(row.session)} ` : ''}${quiet(row.session ? '· in progress' : 'in progress')}`
    case 'waiting': return quiet('waiting on you')
    case 'blocked': return `blocked${why}`
    case 'cancelled': return `dropped${why}`
    default: return ''
  }
}

function askHTML(ask, questionClass) {
  const options = Array.isArray(ask.options) ? ask.options : []
  return `<div class="be-ask" data-be-ask="${esc(ask.askId ?? '')}">
    <div class="${questionClass}">${esc(ask.question || '')}</div>
    ${options.length ? `<div class="chips">${options.map((o) => `<button type="button" class="chip-btn" data-be-choice="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
  </div>`
}

// "Read first" items are strings; "lib/mode.mjs: where board mode is decided"
// sets the thing to open apart from why.
function readHTML(item) {
  const text = String(item)
  const m = /^(.{1,60}?)(?::\s+| — )(.+)$/.exec(text)
  return m ? `<li><b>${esc(m[1])}</b><span>${esc(m[2])}</span></li>` : `<li><b>${esc(text)}</b></li>`
}

function footHTML(ed) {
  const waiting = Array.isArray(ed.waiting) ? ed.waiting : []
  const next = Array.isArray(ed.next) ? ed.next : []
  const parts = []
  if (waiting.length) {
    parts.push(`<section class="be-waiting" aria-labelledby="be-waiting-title">
      <h4 class="space-name be-needs" id="be-waiting-title">Waiting on you</h4>
      ${waiting.map((a) => askHTML(a, 'ask-q')).join('')}
    </section>`)
  }
  if (next.length) {
    parts.push(`<section class="be-read" aria-labelledby="be-read-title">
      <h4 class="space-name" id="be-read-title">Read first</h4>
      <ol class="be-readlist" role="list">${next.map(readHTML).join('')}</ol>
    </section>`)
  }
  return parts.length ? `<div class="be-foot">${parts.join('')}</div>` : ''
}

function endHTML(ed, live) {
  const drift = Array.isArray(ed.drift) ? ed.drift : []
  const outside = ed.figures?.outside ?? drift.length
  const at = when(ed.composedAt)
  const stamp = !at ? '' : live ? `as of ${clock(at)}` : ed.auto ? `composed ${clock(at)}, when the session ended` : `handed off ${clock(at)}`
  const driftLine = outside
    ? `<p class="be-drift">${esc(plural(outside, 'file', 'files'))} changed outside any card${drift.length ? ` <span>${esc(drift.join(' · '))}</span>` : ''}</p>`
    : ''
  if (!driftLine && !stamp) return ''
  return `<div class="be-end">${driftLine}${stamp ? `<p class="be-stamp">${esc(stamp)}</p>` : ''}</div>`
}

function pastHTML(current) {
  if (!past.length) return ''
  return `<section class="be-past" aria-labelledby="be-past-title">
    <div class="block-title" id="be-past-title">Past editions</div>
    ${past.map((p) => {
      const here = p.no === current
      return `<button type="button" class="today-row be-past-row" data-be-no="${esc(p.no)}"${here ? ' aria-current="true" aria-disabled="true"' : ''}>
        <span class="next-when">No. ${esc(p.no)}</span><span class="row-text">${esc(p.headline || '')}</span><span class="today-sub">${esc(shortDate(p.startedAt))}</span>
      </button>`
    }).join('')}
  </section>`
}

async function loadEdition(no) {
  if (no == null) {
    const data = await request(urls.edition)
    past = Array.isArray(data.past) ? data.past : []
    latestNo = data.live?.no ?? null
    return editionView(data.live, null)
  }
  const data = await request(withQuery(urls.edition, 'no', no))
  return editionView(data.edition, no)
}

/** The dateline opens the latest edition; `no` opens a past one. */
export function openEdition({ no } = {}) {
  const which = no == null || no === latestNo ? null : Number(no)
  return show('edition', () => loadEdition(which), which)
}

// --------------------------------------------------------- the boards

function boardsView(list, hereAsks) {
  const rank = { waiting: 0, working: 1, idle: 2 }
  const boards = [...list].sort((a, b) =>
    (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
  const waiting = boards.filter((b) => b.state === 'waiting')
  const working = boards.filter((b) => b.state === 'working')
  const idle = boards.filter((b) => b.state !== 'waiting' && b.state !== 'working')
  const today = new Date()
  const counts = [plural(boards.length, 'board', 'boards'), waiting.length ? `${waiting.length} waiting on you` : '', working.length ? `${working.length} working` : '']
    .filter(Boolean).map((s) => `<span class="shape-part quiet">${esc(s)}</span>`).join('')
  const entries = [...waiting, ...working].map((b) => entryHTML(b, hereAsks)).join('')
  const rest = idle.length ? `<div class="be-rest">${idle.map(idleHTML).join('')}</div>` : ''
  return {
    label: 'Boards',
    html: `<div class="be-toolbar"><span></span>${close('Close boards')}</div>
      <div class="be-body">
        <h2 class="be-bd-title">${MONTHS[today.getMonth()]} ${today.getDate()}</h2>
        <div class="shape be-bshape">${counts}</div>
        <div class="be-index">${entries}${rest}</div>
      </div>`,
  }
}

function nameHTML(b, url) {
  const tags = `${b.branch ? `<span class="be-tag">${esc(b.branch)}</span>` : ''}${b.here ? '<span class="be-tag">this board</span>' : ''}`
  const name = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(b.repo || b.slug || '')}</a>` : esc(b.repo || b.slug || '')
  return `<h3 class="be-entry-name">${name}${tags}</h3>`
}

// What waits comes first and is answerable in place. Another board's question
// is answered on that board (its server is another origin); this board's
// question takes its chips right here.
function entryHTML(b, hereAsks) {
  const url = b.here ? '' : safeUrl(b.url)
  const open = url ? ` data-be-open="${esc(url)}"` : ''
  if (b.state === 'waiting') {
    const asks = Array.isArray(b.asks) && b.asks.length ? b.asks : b.here ? hereAsks : []
    const body = b.here && asks.length
      ? asks.map((a) => askHTML(a, 'be-bq be-dot')).join('')
      : `<div class="be-bq be-dot">${esc(b.waiting || '')}</div>${url ? `<div class="chips"><a class="chip-btn be-chip-link" href="${esc(url)}" target="_blank" rel="noopener">Answer on its board ↗</a></div>` : ''}`
    return `<section class="be-entry" data-state="waiting"${open}>${nameHTML(b, url)}${body}</section>`
  }
  const stamp = shortDate(b.updatedAt)
  return `<section class="be-entry" data-state="working"${open}>${nameHTML(b, url)}
    ${b.task ? `<div class="be-doing"><span class="be-yarn" data-be-yarn aria-hidden="true"></span><span class="be-bline">${esc(b.task)}</span></div>` : ''}
    ${stamp ? `<div class="shape"><span class="shape-part quiet">changed ${esc(stamp)}</span></div>` : ''}
  </section>`
}

// an idle board folds to one line: repo and branch, its last headline, the day
function idleHTML(b) {
  const url = b.here ? '' : safeUrl(b.url)
  const inner = `<span class="row-text"><span class="be-idle-name">${esc(b.repo || b.slug || '')}</span>${b.branch ? `<span class="be-tag">${esc(b.branch)}</span>` : ''}${b.here ? '<span class="be-tag">this board</span>' : ''}</span>
    <span class="be-idle-hl">${esc(b.headline || '')}</span><span class="today-sub">${esc(shortDate(b.updatedAt))}</span>`
  return url
    ? `<a class="today-row be-idle" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`
    : `<div class="today-row be-idle" aria-current="page">${inner}</div>`
}

async function loadBoards() {
  const data = await request(urls.boards)
  const boards = Array.isArray(data.boards) ? data.boards : []
  // /api/boards names this board's question but not its choices; the live
  // edition carries them, with the askId an answer needs
  let hereAsks = []
  if (boards.some((b) => b.here && b.state === 'waiting' && !b.asks?.length)) {
    hereAsks = await request(urls.edition).then((d) => d.live?.waiting || [], () => [])
  }
  return boardsView(boards, hereAsks)
}

/** Every board on this machine, what waits on the person first. */
export function openBoards() {
  return show('boards', loadBoards, null)
}

// ---------------------------------------------------------- the sheet

let sheet = null
let ticket = 0   // a navigation: opening, another edition, retry, closing
let reread = 0   // a quiet refresh; any navigation outranks it

const failureView = (kind) => ({
  label: kind === 'boards' ? 'Boards' : 'Edition',
  html: `<div class="be-toolbar"><span></span>${close('Close')}</div>
    <div class="be-body"><p class="be-none">${kind === 'boards' ? 'The boards did not load.' : 'The edition did not load.'} <button type="button" class="be-retry" data-be-retry>retry</button></p></div>`,
})

async function show(kind, load, no) {
  const mine = ++ticket
  reread++
  const opener = sheet ? sheet.opener : document.activeElement
  const view = await load().catch(() => failureView(kind))
  if (mine !== ticket) return
  present({ kind, load, no, view, opener })
}

/** Whatever changed on the board, the open sheet says it now, in place.
    Safe to call on every paint: with no sheet open it does nothing, and a
    sheet whose contents did not change is left alone. */
export async function refreshSheet() {
  if (!sheet) return
  const s = sheet, load = s.load, nav = ticket, mine = ++reread
  const view = await load().catch(() => null)
  if (!view || sheet !== s || s.load !== load || nav !== ticket || mine !== reread) return
  present({ ...s, view, quiet: true })
}

function present({ kind, load, no, view, opener, quiet = false }) {
  const cold = !sheet
  if (cold) mount(opener)
  const s = sheet
  const { card } = s
  // a refresh that changes nothing touches nothing: the yarn keeps winding
  if (quiet && view.html === s.html) return
  const top = quiet ? card.scrollTop : 0
  const focusAt = quiet ? askIndex(document.activeElement) : -1
  const focusKey = quiet ? keyOf(document.activeElement) : null
  const animate = !still()
  stopYarns(card)
  card.innerHTML = view.html
  card.dataset.kind = kind
  card.setAttribute('aria-label', view.label)
  Object.assign(s, { kind, load, no, html: view.html })
  card.scrollTop = top
  for (const slot of card.querySelectorAll('[data-be-yarn]')) slot.append(windMark())

  if (cold) {
    s.root.classList.toggle('be-still', !animate)
    // the rule draws itself once, as the edition opens: 8 drawings at 12fps
    if (animate) card.querySelector('.be-rule')?.classList.add('be-drawing')
    card.querySelector('[data-be-close]')?.focus({ preventScroll: true })
    return
  }
  if (quiet) {
    if (card.contains(document.activeElement)) return
    // the same control if it is still there; if an answer took its question
    // away, the next question's first choice; else the sheet itself
    const same = focusKey && [...card.querySelectorAll('button, a[href]')].find((el) => keyOf(el) === focusKey)
    const asks = card.querySelectorAll('[data-be-ask]')
    const next = asks[Math.min(Math.max(focusAt, 0), asks.length - 1)]?.querySelector('.chip-btn')
    ;(same || next || card).focus({ preventScroll: true })
    return
  }
  // another edition, in place: only the reading content arrives
  const bodyEl = card.querySelector('.be-body')
  if (animate) bodyEl?.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' })
  ;(card.querySelector('[data-be-latest]') || card.querySelector('.be-hl') || card).focus({ preventScroll: true })
}

/** What a control is, independent of the element that drew it. */
const keyOf = (el) => {
  if (!el?.closest || !sheet?.card.contains(el) || el === sheet.card) return null
  const ask = el.closest('[data-be-ask]')
  return ask && el.dataset.beChoice != null ? `ask:${ask.dataset.beAsk}:${el.dataset.beChoice}`
    : el.dataset.beNo ? `no:${el.dataset.beNo}`
    : el.hasAttribute('data-be-close') ? 'close'
    : el.hasAttribute('data-be-latest') ? 'latest'
    : el.getAttribute('href') ? `href:${el.getAttribute('href')}:${el.className}` : null
}
const askIndex = (el) => {
  const ask = el?.closest?.('[data-be-ask]')
  return ask ? [...sheet.card.querySelectorAll('[data-be-ask]')].indexOf(ask) : -1
}
const stopYarns = (el) => { for (const svg of el.querySelectorAll('svg.wind')) stopWind(svg) }

function mount(opener) {
  const root = document.createElement('div')
  root.className = 'be-sheet'
  root.innerHTML = '<div class="focus-backdrop be-backdrop"></div><div class="focus-wrap be-wrap"><article class="focus-card be-card" role="dialog" aria-modal="true" tabindex="-1"></article></div>'
  const card = root.querySelector('.be-card')
  // while the sheet is up the page beneath holds still and out of reach
  const html = document.documentElement
  const hadModal = html.classList.contains('modal-open')
  html.classList.add('modal-open')
  const inerted = [...document.body.children].filter((el) => !el.inert && el.id !== 'toast' && !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
  for (const el of inerted) el.inert = true
  document.body.append(root)
  let downOutside = false
  root.addEventListener('pointerdown', (e) => { downOutside = !card.contains(e.target) })
  root.addEventListener('click', (e) => onClick(e, downOutside))
  addEventListener('keydown', onKey, true)
  sheet = { root, card, opener, inerted, hadModal, kind: null, load: null, no: null, html: '' }
}

function closeSheet({ instant = false } = {}) {
  if (!sheet) return
  const s = sheet
  sheet = null
  ticket++
  reread++
  removeEventListener('keydown', onKey, true)
  for (const el of s.inerted) el.inert = false
  if (!s.hadModal) document.documentElement.classList.remove('modal-open')
  stopYarns(s.root)
  // interaction comes back at once; only the picture of the sheet stays to leave
  s.root.inert = true
  const back = s.opener?.isConnected && s.opener !== document.body ? s.opener : document.getElementById('dateline')
  back?.focus?.({ preventScroll: true })
  if (instant || still()) return s.root.remove()
  s.root.classList.remove('be-still')
  s.root.classList.add('be-leaving')
  const gone = () => s.root.remove()
  s.card.addEventListener('animationend', (e) => { if (e.target === s.card) gone() })
  setTimeout(gone, 300)
}

function onKey(e) {
  if (!sheet) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeSheet({ instant: true })
    return
  }
  if (e.key !== 'Tab') return
  const { card } = sheet
  const items = [...card.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length)
  if (!items.length) { e.preventDefault(); card.focus(); return }
  const first = items[0], last = items[items.length - 1], active = document.activeElement
  if (e.shiftKey && (active === first || !card.contains(active) || active === card)) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (active === last || !card.contains(active))) { e.preventDefault(); first.focus() }
}

function onClick(e, downOutside) {
  const { card } = sheet || {}
  if (!card) return
  // a press that began and ended off the card puts it away
  if (!card.contains(e.target)) { if (downOutside) closeSheet({ instant: e.detail === 0 }); return }
  const t = e.target
  if (t.closest('[data-be-close]')) return closeSheet({ instant: e.detail === 0 })
  const chip = t.closest('[data-be-choice]')
  if (chip) return void answer(chip)
  if (t.closest('[data-be-latest]')) return void openEdition()
  const pastRow = t.closest('[data-be-no]')
  if (pastRow) {
    if (!pastRow.hasAttribute('aria-current')) void openEdition({ no: Number(pastRow.dataset.beNo) })
    return
  }
  if (t.closest('[data-be-retry]')) return void show(sheet.kind, sheet.load, sheet.no)
  // a board's entry opens that board, anywhere on it but its own links
  const entry = t.closest('[data-be-open]')
  if (entry && !t.closest('a, button')) window.open(entry.dataset.beOpen, '_blank', 'noopener')
}

// A chip is a choice: it takes the accent and the row is spent while the
// answer travels; once the board has it, the question leaves and the sheet
// reads the board again.
async function answer(chip) {
  const ask = chip.closest('[data-be-ask]')
  const chips = chip.closest('.chips')
  if (!ask || chips?.classList.contains('spent')) return
  const keyed = lastInput === 'key'
  chip.classList.add('picked')
  chips.classList.add('spent')
  ask.querySelector('.be-err')?.remove()
  try {
    await request(urls.answer, { askId: ask.dataset.beAsk, choice: chip.dataset.beChoice })
  } catch {
    chip.classList.remove('picked')
    chips.classList.remove('spent')
    chips.insertAdjacentHTML('afterend', '<p class="be-err" role="status">Not sent. Try again.</p>')
    return
  }
  if (!keyed && !reduced) {
    ask.classList.add('be-going')
    await wait(220)
  }
  await refreshSheet()
  // the board has the answer even if reading it back failed: the question still goes
  if (ask.isConnected) ask.remove()
}
