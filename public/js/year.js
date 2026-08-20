import { $, esc, reduced, fmtAmount, toast, api, page, hooks } from './session.js'
import { pop, bloom } from './motion.js'
import { clockOf, heroId } from './blocks.js'
import { liveGoals, paceWords } from './goals.js'

// ------------------------------------------------------------- year view


async function openPastYear(y) {
  try {
    page.yearShown = await api(`/api/year/${y}`)
    buildYear()
  } catch (err) {
    toast(err.message)
  }
}

function buildYear() {
  const y = page.yearShown || page.state.year
  if (!y) return
  const wrap = $('#focus')
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const past = !!page.yearShown
  const openable = !past

  // ---- the year's rhythm: one strip, week by week — what happened in
  // ink, what is scheduled in outline. One graphic instead of a ladder
  // of bars; the texture is the information.
  const now = new Date()
  const through = past ? 1 : Math.min(1, Math.max(0, (now - new Date(y.year, 0, 1)) / (new Date(y.year + 1, 0, 1) - new Date(y.year, 0, 1))))
  const daysLeft = Math.ceil((new Date(y.year, 11, 1) - now) / 86400000)
  const thisWeek = Math.min(51, Math.floor((now - new Date(y.year, 0, 1)) / (7 * 86400000)))
  const peakW = Math.max(1, ...(y.weeks || []))
  const strip = y.weeks
    ? `<div class="yr-weeks" aria-hidden="true">${y.weeks
        .map((c, i) => {
          const sched = (y.sweeks || [])[i] || 0
          if (c) return `<i class="w on${i === thisWeek && !past ? ' wnow' : ''}" style="--h:${Math.max(18, Math.round((c / peakW) * 100))}%"></i>`
          if (sched && i >= thisWeek) return `<i class="w sched"></i>`
          return `<i class="w${i === thisWeek && !past ? ' wnow' : ''}"></i>`
        })
        .join('')}</div>`
    : ''
  const moments = y.months.reduce((n, m) => n + m.events, 0)
  const stat = past
    ? `<div class="yr-sub">${moments} moment${moments === 1 ? '' : 's'}</div>`
    : `<div class="yr-sub">${Math.round(through * 100)}% through · ${moments} moment${moments === 1 ? '' : 's'} · ${daysLeft} days to December</div>`

  // ---- the goals, as numbers: the band on the page already draws their
  // meters, so here they get the serif and a word — the weigh-in reads
  // like a ledger of the year, not another row of bars.
  const goals = past ? [] : liveGoals(page.state)
  const goalRows = goals
    .map(({ space, block, goal: g }) => {
      const label = block.id === heroId(space) || !block.title ? space.name : block.title
      const cls = g.met ? 'met' : g.diff < -0.5 ? 'behind' : ''
      const cur = g.unit === '$' ? fmtAmount(g.current, '$') : fmtAmount(g.current, '')
      return `<button class="yr-goal ${cls}" data-goal-open="${space.id}">
        <span class="yr-goal-name">${esc(label)}</span>
        <span class="yr-goal-dots" aria-hidden="true"></span>
        <span class="yr-goal-fig"><b>${esc(cur)}</b> of ${esc(fmtAmount(g.target, g.unit))}</span>
        <span class="yr-goal-pace">${esc(paceWords(g))}</span>
      </button>`
    })
    .join('')

  // ---- the months, as a grid of doors: a place each, its count beneath,
  // the current month marked, the horizon in accent. No bars.
  const cells = names
    .map((name, m) => {
      const data = y.months[m]
      const future = !past && m > y.month
      const nowM = !past && m === y.month
      const bits = []
      if (data.events) bits.push(`${data.events}`)
      if (data.scheduled) bits.push(`<span class="ahead">${data.scheduled} ahead</span>`)
      const body = bits.length ? bits.join(' · ') : future || nowM ? (m === 11 ? `in ${daysLeft} days` : '') : ''
      const has = data.events || data.scheduled
      const cls = `yr-mo${nowM ? ' now' : ''}${future && !has ? ' quiet' : ''}`
      const inner = `<span class="yr-mo-name">${name.slice(0, 3)}</span><span class="yr-mo-n">${body || '·'}</span>`
      return openable && has
        ? `<button class="${cls} has" data-month="${y.year}-${String(m + 1).padStart(2, '0')}">${inner}</button>`
        : `<div class="${cls}">${inner}</div>`
    })
    .join('')

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
  // the freshest thing the year said about itself, one line, whole words
  const hl = [...y.months].reverse().find((m) => m.highlights?.length)?.highlights[0]
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card year-card">
        <h2 class="space-name">${y.year}</h2>
        ${strip}
        ${stat}
        ${years.length ? `<div class="year-nav">${nav}</div>` : ''}
        ${goalRows ? `<div class="yr-goals">${goalRows}</div>` : ''}
        <div class="yr-months">${cells}</div>
        ${hl && !past ? `<div class="yr-hl">${esc(trim(hl, 96))}</div>` : ''}
        ${held}
        ${past ? '' : `<a class="retire-link" href="/api/export.md" download>download the year</a>`}
      </article>
    </div>`
  page.yearOpen = true
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
  let m
  try {
    m = await api(`/api/month/${ym}`)
  } catch (err) {
    return toast(err.message)
  }
  const future = ym > `${page.state.year.year}-${String(page.state.year.month + 1).padStart(2, '0')}`
  const peak = Math.max(1, ...m.weeks.map((w) => w.count))
  const bars = m.weeks
    .map((w) => `<i style="--h:${Math.max(8, Math.round((w.count / peak) * 100))}%" title="${w.from}–${w.to}: ${w.count}"></i>`)
    .join('')
  const day = (d) => Number(d.slice(8, 10))
  const line = (l) =>
    `<div class="mo-line${l.ahead ? ' ahead' : ''}"><span class="mo-day">${day(l.day)}</span><span class="mo-text">${esc(l.text)}</span>${
      l.at ? `<span class="mo-at">${esc(clockOf(l.at))}</span>` : ''
    }${l.repeat ? `<span class="mo-at">${esc(l.repeat)}</span>` : ''}${
      l.amount != null ? `<span class="mo-amt">${esc(fmtAmount(l.amount, l.unit))}</span>` : ''
    }</div>`
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
    : `<div class="ym-quiet">${future ? 'nothing scheduled yet' : 'nothing was written down this month'}</div>`
  // one honest count: what happened, what is coming, or both
  const past = m.total - m.ahead
  const counts = [
    past ? `${past} moment${past === 1 ? '' : 's'}` : '',
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
  $('#focus').innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card month-card">
        <div class="mo-steps">${step(mm - 1, '‹', 'previous month')}${step(mm + 1, '›', 'next month')}</div>
        <button class="mo-back" data-back-to-year>‹ ${esc(m.month.slice(0, 4))}</button>
        <h2 class="space-name">${esc(m.label)}</h2>
        <div class="mo-weeks" aria-hidden="true">${bars}</div>
        <div class="mo-total">${counts}</div>
        ${body}
      </article>
    </div>`
  page.yearOpen = true
  page.monthShown = m.month
}

// with a month open, the year walks under the arrow keys
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (!document.querySelector('.month-card') || !page.monthShown) return
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

function renderCarryover() {
  const co = page.state.carryover
  const wrap = $('#focus')
  if (!co || page.coParked) {
    if (wrap.dataset.co) {
      wrap.dataset.co = ''
      wrap.innerHTML = ''
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
      <h2 class="space-name">Clean slate.</h2>
      <p class="co-read">${co.fromYear} is a full page now: <b>${f.done}</b> thing${f.done === 1 ? '' : 's'} finished, <b>${f.met}</b> goal${f.met === 1 ? '' : 's'} met, <b>${f.moments}</b> moment${f.moments === 1 ? '' : 's'} written.</p>
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
      <div class="co-item-label">${esc(it.title || it.text || '')}</div>
      <div class="when-sub" style="margin:0 0 18px">${esc(it.space)} · ${kinds[it.kind]}${it.note ? ` · ${esc(it.note)}` : ''}</div>
      <div class="chips">
        <button class="chip-btn ${answered === true ? 'chosen' : ''}" data-co-yes>bring it in</button>
        <button class="chip-btn ${answered === false ? 'chosen' : ''}" data-co-no>leave it with ${co.fromYear}</button>
      </div>
      ${bulk}`
  }

  wrap.innerHTML = `
    <div class="focus-backdrop"></div>
    <div class="focus-wrap">
      <article class="focus-card co-card" role="dialog" aria-modal="true" aria-label="Clean slate">${card}</article>
    </div>`
  if (!reduced) wrap.querySelector('.chip-btn')?.focus()
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
  const ids = [...coAnswered.entries()].filter(([, keep]) => keep).map(([id]) => id)
  const wrap = $('#focus')
  wrap.dataset.co = 'closing'
  wrap.innerHTML = `
    <div class="focus-backdrop"></div>
    <div class="focus-wrap">
      <article class="focus-card co-card" role="dialog" aria-modal="true">
        <h2 class="space-name">The new page is yours.</h2>
        ${ids.length ? `<p class="co-read">${ids.length} thread${ids.length === 1 ? '' : 's'} carried over. The rest stays with the old year.</p>` : '<p class="co-read">Nothing carried. All of it stays with the old year.</p>'}
      </article>
    </div>`
  try {
    page.state = await api('/api/carryover', ids.length ? { ids } : { dismiss: true })
    page.coIndex = 0
    page.coAnswered.clear()
    page.coParked = false
    setTimeout(() => {
      wrap.dataset.co = ''
      wrap.innerHTML = ''
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
export { openPastYear, buildYear, openMonth, renderCarryover, renderCarryoverNudge, coAnswer, coCommit, coCount }
