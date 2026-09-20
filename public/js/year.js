import { yearCalendars, monthCalendar, mountMonthCalendar } from './year-calendar.js'
import { $, esc, reduced, fmtAmount, toast, api, page, hooks, adoptState } from './session.js'
import { pop, bloom } from './motion.js'
import { mountSurface } from './card-surface.js'
import { beginYearRequest, invalidateYearRequest, currentYearRequest, yearPosition, showYearSurface } from './year-navigation.js'
import { clockOf } from './blocks.js'
import { weekCaret } from './year-week-caret.js'
import { liveGoals, paceWords, goalLabel, goalClass } from './goals.js'
import { yearHead } from './year-head.js'

// Which register the year's head wears. The options live side by side on the
// gallery at /year; this is the one the app uses.
const YEAR_CHROME = 'figures'

// ------------------------------------------------------------- year view


async function openPastYear(y) {
  const ticket = beginYearRequest()
  try {
    const result = await api(`/api/year/${y}`)
    if (!currentYearRequest(ticket)) return
    page.yearShown = result
    buildYear()
  } catch (err) {
    if (currentYearRequest(ticket)) toast(err.message)
  }
}

function buildYear() {
  invalidateYearRequest()
  const returnMonth = page.monthShown
  page.monthShown = null
  const y = page.yearShown || page.state.year
  if (!y) return
  const wrap = $('#focus')
  wrap.removeAttribute('aria-busy')
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const past = !!page.yearShown

  // ---- the year's rhythm: one strip, week by week — what happened in
  // ink, what is scheduled in outline. One graphic instead of a ladder
  // of bars; the texture is the information.
  const now = new Date()
  const position = yearPosition(y.year, now)
  const through = past ? 1 : position.through
  const daysLeft = position.daysToDecember
  const thisWeek = Math.max(0, Math.min((y.weeks?.length || 52) - 1, Math.floor((now - new Date(y.year, 0, 1)) / (7 * 86400000))))
  const moments = y.months.reduce((n, m) => n + m.events, 0)
  const head = yearHead({
    year: y.year,
    moments,
    tail: past ? 'An archived chapter' : daysLeft ? `${daysLeft} days to December` : `${position.daysLeft} days left in the year`,
    through,
    weeks: y.weeks,
    sweeks: y.sweeks,
    thisWeek,
    past,
  }, { chrome: YEAR_CHROME, rhythm: true, caret: past || returnMonth ? '' : weekCaret() })

  // ---- the goals, as numbers: the band on the page already draws their
  // meters, so here they get the serif and a word — the weigh-in reads
  // like a ledger of the year, not another row of bars.
  const goals = past ? [] : liveGoals(page.state)
  const goalRows = goals
    .map(({ space, block, goal: g }) => {
      const label = goalLabel(space, block)
      const cls = goalClass(g)
      const cur = g.unit === '$' ? fmtAmount(g.current, '$') : fmtAmount(g.current, '')
      return `<button class="yr-goal ${cls}" data-goal-open="${space.id}">
        <span class="yr-goal-name">${esc(label)}</span>
        <span class="yr-goal-dots" aria-hidden="true"></span>
        <span class="yr-goal-fig"><b>${esc(cur)}</b> of ${esc(fmtAmount(g.target, g.unit))}</span>
        <span class="yr-goal-pace">${esc(paceWords(g))}</span>
      </button>`
    })
    .join('')

  // ---- the months, as a journal: a spread each, the month's name on the
  // left with its counts, and on the right what it held — the engine's
  // paragraph when there is one, the figures, and the dated things as
  // rows. Empty stretches fold to one line. Every month stays a door.
  const journal = page.journal?.year === y.year ? page.journal : null
  const spreads = journalSpreads(y, journal, names, past)

  const years = page.state.archivedYears || []
  const nav = [...years, page.state.year.year]
    .map((yy) =>
      yy === y.year
        ? `<span class="year-now">${yy}</span>`
        : `<button class="year-jump" data-year="${yy}">${yy}</button>`
    )
    .join('')
  const held = past && y.spaces?.length
    ? `<div class="rest-head" style="margin-top:20px">what the year held</div>` +
      y.spaces.map((s) => `<div class="ym-hl"><b>${esc(s.name)}</b>${s.stats.length ? ` · ${esc(s.stats.join(' · '))}` : ''}</div>`).join('')
    : ''
  showYearSurface(wrap, `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card year-card">
        <div class="year-toolbar"><span>${past ? 'From the archive' : 'Your year'}</span><button type="button" class="surface-close" data-close aria-label="Close year">Close</button></div>
        ${head}
        ${years.length ? `<div class="year-nav">${nav}</div>` : ''}
        <p class="yr-line" id="yr-line"${journal?.line ? '' : ' hidden'}>${esc(journal?.line?.text || '')}</p>
        ${goalRows ? `<div class="yr-goals">${goalRows}</div>` : ''}
        ${yearCalendars(y)}
        <details class="year-journal" open><summary>Read the year’s story</summary><div class="jr-months" id="jr-months">${spreads}</div></details>
        ${held}
        <div class="jr-letter" id="jr-letter">${letterHTML(journal, past)}</div>
        <div class="year-footer"><span>Open a month to read it in full.</span><a class="retire-link" href="${past ? `/api/export/${y.year}.md` : '/api/export.md'}" download>Download the year ↗</a></div>
      </article>
    </div>`, -1)
  page.yearOpen = true
  page.focusId = null
  mountSurface(wrap.querySelector('.focus-card'), true)
  if (returnMonth) wrap.querySelector(`[data-month="${returnMonth}"]`)?.focus({preventScroll:true})
  void loadJournal(y.year, names, past)
}

/** The journal arrives after the year is on screen and settles into it in
    place, so the year never repaints twice. While the engine still has
    months to write, the page asks again, a few times, quietly. */
async function loadJournal(year, names, past, tries = 0) {
  const ticket = currentYearRequest.__journal = (currentYearRequest.__journal || 0) + 1
  let j
  try {
    j = await api(`/api/journal/${year}`)
  } catch {
    return
  }
  if (ticket !== currentYearRequest.__journal || !page.yearOpen) return
  const shown = page.yearShown || page.state.year
  if (!shown || shown.year !== year) return
  page.journal = j
  const months = $('#jr-months')
  if (months) {
    const before = new Set([...months.querySelectorAll('.jr-p')].map((p) => p.textContent))
    months.innerHTML = journalSpreads(shown, j, names, past)
    // words that were not on the page a moment ago come up out of a blur
    for (const p of months.querySelectorAll('.jr-p')) if (!before.has(p.textContent)) p.classList.add('arrived')
  }
  const line = $('#yr-line')
  if (line) {
    line.textContent = j.line?.text || ''
    line.hidden = !j.line?.text
  }
  const letter = $('#jr-letter')
  if (letter) letter.innerHTML = letterHTML(j, past)
  if (j.pending && tries < 6) setTimeout(() => loadJournal(year, names, past, tries + 1), 9000)
}

/** A month's spread, or the folded run that empty months share. */
function journalSpreads(y, journal, names, past) {
  const nowM = past ? -1 : y.month
  const rows = []
  let run = []
  const flush = () => {
    if (!run.length) return
    const first = names[run[0]], last = names[run.at(-1)]
    rows.push(`<div class="jr-mo quiet"><div class="jr-mo-name"><span class="jr-run">${run
      .map((m) => `<button class="yr-mo quiet" data-month="${monthId(y.year, m)}" aria-label="${esc(`${names[m]} ${y.year}, nothing recorded`)}">${names[m].slice(0, 3)}</button>`)
      .join('')}</span></div><div class="jr-body"><span class="jr-q">${run.length > 1 ? `${first} – ${last}` : first}: nothing recorded${
      run[0] > nowM && nowM >= 0 ? ', nothing planned' : ''
    }.</span></div></div>`)
    run = []
  }
  for (let m = 0; m < 12; m++) {
    const summary = y.months[m] || { events: 0 }
    const jm = journal?.months?.[m]
    const has = (jm ? jm.recorded || jm.ahead || jm.overdue || jm.done : summary.events || summary.overdue || summary.scheduled) || m === nowM
    if (!has) {
      run.push(m)
      continue
    }
    flush()
    rows.push(monthSpread(y, m, names[m], jm, summary, m === nowM, past))
  }
  flush()
  return rows.join('')
}

const monthId = (year, m) => `${year}-${String(m + 1).padStart(2, '0')}`

function monthSpread(y, m, name, jm, summary, nowM, past) {
  const id = monthId(y.year, m)
  const recorded = jm ? jm.recorded : summary.events || 0
  const overdue = jm ? jm.overdue : summary.overdue || 0
  const ahead = jm ? jm.ahead : summary.scheduled || 0
  const counts = [
    recorded ? `${recorded} recorded` : '',
    overdue ? `<span class="overdue">${overdue} overdue</span>` : '',
    ahead ? `${ahead} scheduled` : '',
  ].filter(Boolean).join('<br>')
  const plain = `${name} ${y.year}${nowM ? ', current month' : ''}, ${recorded} recorded, ${ahead} scheduled${overdue ? `, ${overdue} overdue` : ''}`
  // a month still ahead has nothing to count yet; its rows say what is planned
  const figs = jm && !(jm.month > (past ? '9999' : monthId(y.year, y.month)))
    ? [
        jm.done ? `<div class="jr-f"><b>${jm.done}</b><span>done</span></div>` : '',
        jm.money != null ? `<div class="jr-f"><b>${esc(fmtAmount(jm.money, jm.unit))}</b><span>${jm.entries} ${jm.entries === 1 ? 'entry' : 'entries'}</span></div>` : '',
        jm.spaces?.length ? `<div class="jr-f"><b>${jm.spaces.length}</b><span>${jm.spaces.length === 1 ? 'card' : 'cards'} touched</span></div>` : '',
      ].filter(Boolean).join('')
    : ''
  const day = (d) => String(Number(d.slice(8, 10)))
  const line = (l) =>
    `<div class="jr-row${l.overdue ? ' overdue' : ''}${l.ahead ? ' ahead' : ''}"><span class="d">${day(l.day)}</span><span class="t">${esc(l.text)}</span>${
      l.amount != null ? `<span class="w">${esc(fmtAmount(l.amount, l.unit))}</span>` : l.overdue ? '<span class="w od">overdue</span>' : l.at ? `<span class="w">${esc(clockOf(l.at))}</span>` : l.repeat ? `<span class="w">${esc(l.repeat)}</span>` : ''
    }</div>`
  const coming = jm?.coming?.length ? `<div class="jr-rows">${jm.coming.map(line).join('')}</div>` : ''
  const happened = jm?.happened?.length && !jm.text ? `<div class="jr-rows jr-past">${jm.happened.map(line).join('')}</div>` : ''
  // the paragraph is the engine's, in the person's words; a stale one is
  // shown a shade quieter until the fresh one lands
  const text = jm?.text ? `<p class="jr-p${jm.stale ? ' stale' : ''}">${esc(jm.text)}</p>` : ''
  const hl = !jm && summary.highlights?.[0] ? `<p class="jr-p quiet">${esc(trim(summary.highlights[0], 120))}</p>` : ''
  return `<div class="jr-mo${nowM ? ' now' : ''}" style="--month-delay:${m * 18}ms">
    <div class="jr-mo-name">
      <button class="yr-mo ${nowM ? 'now' : ''}" data-month="${id}" aria-label="${esc(plain)}"${nowM ? ' aria-current="date"' : ''}>${name}${nowM ? '<span class="jr-now">now</span>' : ''}</button>
      <div class="jr-k">${counts}</div>
    </div>
    <div class="jr-body">${text || hl}${figs ? `<div class="jr-figs">${figs}</div>` : ''}${coming}${happened}</div>
  </div>`
}

/** The December letter: the one place the page writes in sentences, and
    only because they are the person's. Until it exists, a line says when. */
function letterHTML(journal, past) {
  if (journal?.letter?.text) return `<span class="k">The December letter</span><p>${esc(journal.letter.text)}</p>`
  if (past) return ''
  return `<span class="k">The December letter</span><p class="quiet">On the last day of the year the page writes the year back to you, in your own words — what you recorded, what you finished, what you let go.</p>`
}

/** Cut a line at a word, not mid-syllable. The year view was slicing
    summaries at 90 characters and leaving "(trucking pi" on screen. */
function trim(s, n) {
  const t = String(s)
  if (t.length <= n) return t
  const cut = t.slice(0, n)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 14)).trimEnd()}…`
}

/** A month, opened: what it actually held, grouped by the space it
    happened in, with the shape of its weeks above. The year row used to
    be a dead end — a count and a truncated sentence with nothing behind
    it. This is the same state, read properly. */
async function openMonth(ym) {
  const ticket = beginYearRequest()
  const fromMonth = page.monthShown
  const wrap = $('#focus')
  wrap.setAttribute('aria-busy','true')
  let m
  try {
    m = await api(`/api/month/${ym}`)
    if (!currentYearRequest(ticket)) return
  } catch (err) {
    if (currentYearRequest(ticket)) toast(err.message)
    return
  } finally {
    if (currentYearRequest(ticket)) wrap.removeAttribute('aria-busy')
  }
  const future = ym > `${page.state.year.year}-${String(page.state.year.month + 1).padStart(2, '0')}`
  const peak = Math.max(1, ...m.weeks.map((w) => w.count))
  const bars = m.weeks
    .map((w) => `<i style="--h:${Math.max(8, Math.round((w.count / peak) * 100))}%" title="${w.from}–${w.to}: ${w.count}"></i>`)
    .join('')
  const day = (d) => Number(d.slice(8, 10))
  const line = (l) =>
    `<div class="mo-line${l.ahead ? ' ahead' : ''}${l.overdue ? ' overdue' : ''}"><span class="mo-day">${day(l.day)}</span><span class="mo-text">${esc(l.text)}</span>${
      l.at ? `<span class="mo-at">${esc(clockOf(l.at))}</span>` : ''
    }${l.repeat ? `<span class="mo-at">${esc(l.repeat)}</span>` : ''}${
      l.amount != null ? `<span class="mo-amt">${esc(fmtAmount(l.amount, l.unit))}</span>` : ''
    }${l.overdue ? '<span class="mo-status">overdue</span>' : ''}</div>`
  const body = m.spaces.length
    ? m.spaces
        .map(
          (s, i) => `
        <div class="mo-space" style="--d:${Math.min(i * 40, 200)}ms">
          <div class="mo-head">
            <span class="mo-name">${esc(s.name)}</span>
            <span class="mo-sum">${esc(
              [s.total != null ? fmtAmount(s.total, s.unit) : '', s.headline].filter(Boolean).join(' · ')
            )}</span>
          </div>
          ${s.lines.map(line).join('')}
        </div>`
        )
        .join('')
    : `<div class="month-empty"><p>${future ? 'A little room for what comes next.' : 'A quiet chapter.'}</p><span>${future ? 'Nothing is scheduled here yet. Plans you add to December will appear here.' : 'Nothing was recorded this month. Your other months are still a page away.'}</span></div>`
  // one honest count: what happened, what is coming, or both
  const recorded = m.total - m.ahead - m.overdue
  const counts = [
    recorded ? `${recorded} recorded` : '',
    m.overdue ? `${m.overdue} overdue` : '',
    m.ahead ? `${m.ahead} scheduled` : '',
  ].filter(Boolean).join(' · ') || (future ? 'open' : '0 moments')
  // the month walks: one stepper pair, top right, January to December.
  // Two lone ‹ glyphs — the stepper and the back-to-year link — stacked in
  // the same corner read as the same control; the pair reads as a stepper.
  const [yy, mm] = m.month.split('-').map(Number)
  const pad = (n) => `${yy}-${String(n).padStart(2, '0')}`
  const step = (n, glyph, label) =>
    n >= 1 && n <= 12
      ? `<button class="mo-step" data-month="${pad(n)}" aria-label="${label}">${glyph}</button>`
      : `<button class="mo-step" disabled aria-hidden="true">${glyph}</button>`
  showYearSurface(wrap, `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card month-card">
        <div class="month-toolbar"><button class="mo-back" data-back-to-year>‹ All of ${esc(m.month.slice(0, 4))}</button><div class="mo-steps">${step(mm - 1, '‹', 'previous month')}${step(mm + 1, '›', 'next month')}<button type="button" class="surface-close" data-close aria-label="Close month">Close</button></div></div>
        <h2 class="space-name">${esc(m.label)}</h2>
        <div class="mo-weeks" aria-hidden="true" hidden>${bars}</div>
        <div class="mo-total">${counts}</div>
        ${monthCalendar()}
        <details class="month-story"><summary>Browse by topic</summary>${body}</details>
        <div class="month-footer"><span>← → to move between months</span><button class="mo-back" data-back-to-year>Back to the year</button></div>
      </article>
    </div>`, fromMonth && ym < fromMonth ? -1 : 1, card => mountMonthCalendar(card.querySelector('.month-calendar'), m))
  page.yearOpen = true
  page.focusId = null
  page.monthShown = m.month
  mountSurface($('#focus .focus-card'), true)
}

document.addEventListener('keydown', (e) => {
  const tile = e.target.closest?.('.yr-mo[data-month]')
  if (!tile || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) return
  const grid = tile.closest('.jr-months') || tile.parentElement, tiles = [...grid.querySelectorAll('.yr-mo')]
  const columns = 1
  const at = tiles.indexOf(tile)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? 11 : at + ({ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[e.key])
  e.preventDefault()
  tiles[Math.max(0,Math.min(11,next))]?.focus()
})

// with a month open, the year walks under the arrow keys
document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
  if (!document.querySelector('.month-card') || !page.monthShown || e.target.closest?.('.calendar-days')) return
  const tag = document.activeElement?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  const [yy, mm] = page.monthShown.split('-').map(Number)
  const to = e.key === 'ArrowLeft' ? mm - 1 : mm + 1
  if (to < 1 || to > 12) return
  e.preventDefault()
  openMonth(`${yy}-${String(to).padStart(2, '0')}`)
})

// Clean Slate: every year is a new page. The old one is read aloud,
// then each open thread gets its own card and its own yes or no.
// Nothing is forced: it can be parked, revisited, and every answer changed.


const coCount = () => page.state.carryover?.items.length || 0
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
let carryoverReturn = null

function carryoverDialog() {
  return document.querySelector('.co-card[role="dialog"]')
}

function setCarryoverModal(open) {
  document.documentElement.classList.toggle('modal-open', open)
  const shell = $('#shell')
  if (shell) shell.inert = open
}

function activateCarryoverDialog() {
  const wrap = $('#focus')
  const dialog = carryoverDialog()
  if (!dialog) return
  if (!carryoverReturn || !carryoverReturn.isConnected) {
    const active = document.activeElement
    carryoverReturn = active && !wrap.contains(active) ? active : page.field
  }
  setCarryoverModal(true)
  const target = dialog.querySelector('[data-co-next], [data-co-yes], [data-co-no], [data-co-park]') || dialog.querySelector(FOCUSABLE) || dialog
  target.focus({ preventScroll: true })
}

function deactivateCarryoverDialog({ restore = true } = {}) {
  setCarryoverModal(false)
  const target = carryoverReturn?.isConnected ? carryoverReturn : page.field
  carryoverReturn = null
  if (restore) target?.focus?.({ preventScroll: true })
}

function parkCarryover({ restore = true } = {}) {
  page.coParked = true
  renderCarryover({ restore })
  renderCarryoverNudge()
}

function trapCarryoverFocus(e) {
  const dialog = carryoverDialog()
  if (!dialog || e.key !== 'Tab') return false
  const controls = [...dialog.querySelectorAll(FOCUSABLE)]
  if (!controls.length) {
    e.preventDefault()
    dialog.focus({ preventScroll: true })
    return true
  }
  const first = controls[0]
  const last = controls[controls.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || !dialog.contains(active))) {
    e.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
    e.preventDefault()
    first.focus({ preventScroll: true })
  }
  return true
}

function handleCarryoverKeydown(e) {
  if (!page.state?.carryover || page.coParked || !carryoverDialog()) return false
  if (e.key === 'Tab') return trapCarryoverFocus(e)
  if (e.key === 'Escape') {
    e.preventDefault()
    parkCarryover()
    return true
  }
  if (page.coIndex > 0 && (e.key === 'y' || e.key === 'n')) {
    e.preventDefault()
    coAnswer(e.key === 'y', document.querySelector(e.key === 'y' ? '[data-co-yes]' : '[data-co-no]'))
    return true
  }
  return false
}

function renderCarryover({ restore = true } = {}) {
  const co = page.state.carryover
  const wrap = $('#focus')
  if (!co || page.coParked) {
    if (wrap.dataset.co) {
      wrap.dataset.co = ''
      wrap.innerHTML = ''
      deactivateCarryoverDialog({ restore })
    }
    return
  }
  const key = `${co.fromYear}:${page.coIndex}`
  if (wrap.dataset.co === key) return
  wrap.dataset.co = key
  const f = co.finished
  const kinds = { list: 'list', tracker: 'goal', reminder: 'reminder', streak: 'habit' }
  const n = co.items.length
  let card

  if (page.coIndex === 0) {
    const words = (f.highlights || []).length
      ? `<div class="co-words">${f.highlights.map((h) => `<div class="co-word">${esc(h)}</div>`).join('')}</div>`
      : ''
    card = `
      <h2 class="space-name" id="co-title">Clean slate.</h2>
      <p class="co-read" id="co-description">${co.fromYear} is a full page now: <b>${f.done}</b> thing${f.done === 1 ? '' : 's'} finished, <b>${f.met}</b> goal${f.met === 1 ? '' : 's'} met, <b>${f.moments}</b> moment${f.moments === 1 ? '' : 's'} written.</p>
      ${words}
      <p class="co-read">It stays whole. <button class="co-link" data-co-look>Look through ${co.fromYear}</button> anytime.</p>
      ${n ? `<p class="co-read"><b>${n}</b> thread${n === 1 ? ' was' : 's were'} still open when the page turned. One at a time: keep it, or leave it.</p>` : '<p class="co-read">Nothing was left open. The new page is yours.</p>'}
      <div class="chips" style="margin-top:14px">
        <button class="chip-btn" data-co-next>${n ? 'turn the page' : 'begin the year'}</button>
        ${n ? '<button class="co-link" data-co-park>later</button>' : ''}
      </div>`
  } else {
    const it = co.items[page.coIndex - 1]
    const answered = page.coAnswered.get(it.id)
    const itemName = it.title || it.text || `${kinds[it.kind] || 'thread'} from ${it.space}`
    const dots = co.items
      .map((x, i) => {
        const cls = i === page.coIndex - 1 ? 'now' : page.coAnswered.has(x.id) ? (page.coAnswered.get(x.id) ? 'kept' : 'left') : ''
        return `<button class="co-dot ${cls}" data-co-goto="${i + 1}" aria-label="thread ${i + 1}"></button>`
      })
      .join('')
    // past card five, offer the way out
    const bulk =
      n > 5 && page.coIndex >= 5
        ? `<div class="co-bulk">
             <button class="co-link" data-co-all="yes">keep everything else</button>
             <button class="co-link" data-co-all="no">leave everything else</button>
           </div>`
        : ''
    card = `
      <div class="co-ghost" aria-hidden="true">${co.fromYear}</div>
      <div class="co-dots">${dots}</div>
      <h2 class="co-item-label" id="co-title">${esc(itemName)}</h2>
      <div class="when-sub" id="co-description" style="margin:0 0 18px">${esc(it.space)} · ${kinds[it.kind]}${it.note ? ` · ${esc(it.note)}` : ''}</div>
      <div class="chips">
        <button class="chip-btn ${answered === true ? 'chosen' : ''}" data-co-yes>bring it in</button>
        <button class="chip-btn ${answered === false ? 'chosen' : ''}" data-co-no>leave it with ${co.fromYear}</button>
      </div>
      ${bulk}`
  }

  wrap.innerHTML = `
    <div class="focus-backdrop"></div>
    <div class="focus-wrap">
      <article class="focus-card co-card" role="dialog" aria-modal="true" aria-labelledby="co-title" aria-describedby="co-description" tabindex="-1">${card}</article>
    </div>`
  activateCarryoverDialog()
}

/** Answer the current card; when every thread has an answer, commit. */
function coAnswer(yes, el) {
  const co = page.state.carryover
  const it = co?.items[page.coIndex - 1]
  if (!it) return
  page.coAnswered.set(it.id, yes)
  if (yes && el) {
    pop(el)
    const r = el.getBoundingClientRect()
    bloom(r.left + r.width / 2, r.top + r.height / 2)
  }
  const cardEl = document.querySelector('.co-card')
  cardEl?.classList.add(yes ? 'co-exit-kept' : 'co-exit-left')
  const after = reduced ? 0 : 260
  // move to the next thread that still has no answer
  const nextUnanswered = co.items.findIndex((x, i) => i >= page.coIndex && !page.coAnswered.has(x.id))
  setTimeout(() => {
    if (nextUnanswered === -1) coCommit()
    else {
      page.coIndex = nextUnanswered + 1
      renderCarryover()
    }
  }, after)
}

async function coCommit() {
  const ids = [...page.coAnswered.entries()].filter(([, keep]) => keep).map(([id]) => id)
  const wrap = $('#focus')
  wrap.dataset.co = 'closing'
  wrap.innerHTML = `
    <div class="focus-backdrop"></div>
    <div class="focus-wrap">
      <article class="focus-card co-card" role="dialog" aria-modal="true" aria-labelledby="co-title" aria-describedby="co-description" tabindex="-1">
        <h2 class="space-name" id="co-title">The new page is yours.</h2>
        ${ids.length ? `<p class="co-read" id="co-description">${ids.length} thread${ids.length === 1 ? '' : 's'} carried over. The rest stays with the old year.</p>` : '<p class="co-read" id="co-description">Nothing carried. All of it stays with the old year.</p>'}
      </article>
    </div>`
  activateCarryoverDialog()
  try {
    adoptState(await api('/api/carryover', ids.length ? { ids } : { dismiss: true }))
    page.coIndex = 0
    page.coAnswered.clear()
    page.coParked = false
    setTimeout(() => {
      wrap.dataset.co = ''
      wrap.innerHTML = ''
      deactivateCarryoverDialog()
      page.spaceEls.forEach(({ el }) => el.remove())
      page.spaceEls.clear()
      hooks.render()
    }, reduced ? 0 : 1600)
  } catch (err) {
    toast(err.message)
  }
}

/** Parked: the page works normally, one quiet line holds the moment. */
function renderCarryoverNudge() {
  const el = $('#co-nudge')
  const show = page.state.carryover && page.coParked
  const key = show ? `${page.state.carryover.fromYear}:${coCount()}` : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  el.innerHTML = show
    ? `<button class="co-nudge-btn" data-co-resume>clean slate waiting · ${coCount()} thread${coCount() === 1 ? '' : 's'} from ${page.state.carryover.fromYear}</button>`
    : ''
}
document.addEventListener('keydown', handleCarryoverKeydown)

export {
  openPastYear, buildYear, openMonth, renderCarryover, renderCarryoverNudge,
  coAnswer, coCommit, coCount, parkCarryover, trapCarryoverFocus,
  activateCarryoverDialog, deactivateCarryoverDialog, handleCarryoverKeydown,
}
