// December — client. No framework, no build step.
// You type; text lands instantly. The settle pass runs behind you and the
// page settles: spaces appear, blocks tick, captures fold away. Space
// cards re-render surgically (only when their updatedAt moves), so the
// page never feels like it refreshed.

const $ = (sel) => document.querySelector(sel)
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

let state = null
let prev = null // previous projection, for celebration diffs
let booting = true // the first paint stages itself; every one after is live
document.documentElement.classList.add('booting')
const spaceEls = new Map() // id -> {el, updatedAt}
let pollTimer = null
// Captures still waiting, held here rather than as a row each on screen.
// The stage used to read your own sentence back to you for the whole pass;
// what you wrote is the one thing you already know.
const pending = new Set()
let flying = 0 // motes in the air — the stage waits for them to land

// ------------------------------------------------------------- utilities

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const fmtAmount = (n, unit) => {
  const v = Number(n) || 0
  const s = Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100)
  return unit === '$' ? `$${s}` : `${s}${unit ? ` ${unit}` : ''}`
}

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('show'), 2600)
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'request failed')
  return data
}

// --------------------------------------------------------- celebration
// The commit celebration, per Design repo §1.12. One shot, then gone.

function celebrate(anchorEl) {
  if (reduced || !anchorEl) return
  const r = anchorEl.getBoundingClientRect()
  if (!(r.bottom > 0 && r.top < innerHeight)) return // offscreen joy is wasted work
  const layer = document.createElement('div')
  layer.className = 'spark'
  layer.style.left = `${r.left + Math.min(r.width / 2, 20)}px`
  layer.style.top = `${r.top + r.height / 2}px`
  const ring = document.createElement('span')
  ring.className = 'ring'
  layer.appendChild(ring)
  const colors = ['var(--accent)', 'var(--gold)', 'var(--hue-ok)']
  for (let i = 0; i < 8; i++) {
    const dot = document.createElement('i')
    const angle = (Math.PI * 2 * i) / 8 - Math.PI / 2
    const dist = 24 + Math.random() * 12
    dot.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
    dot.style.setProperty('--dy', `${Math.sin(angle) * dist}px`)
    dot.style.background = colors[i % colors.length]
    dot.style.animationDelay = `${i * 14}ms`
    layer.appendChild(dot)
  }
  document.body.appendChild(layer)
  setTimeout(() => layer.remove(), 1000)
}

function pop(el) {
  if (reduced || !el) return
  el.classList.remove('pop')
  void el.offsetWidth
  el.classList.add('pop')
}

/** Say what a number did, right where it happened, then let it go. */
function markChange(el, label) {
  if (reduced || !el || !label) return
  const tag = document.createElement('span')
  tag.className = 'delta'
  tag.textContent = label
  el.appendChild(tag)
  setTimeout(() => tag.classList.add('out'), 1400)
  setTimeout(() => tag.remove(), 2000)
}

/** Reworded text glows once so the change is seen, not discovered later. */
function markEdited(el) {
  if (!el) return
  el.classList.remove('edited')
  void el.offsetWidth
  el.classList.add('edited')
  clearTimeout(el._editT)
  el._editT = setTimeout(() => el.classList.remove('edited'), 1800)
}

/** Replay the small status-swap on an element whose value just changed. */
function bump(el) {
  if (reduced || !el) return
  el.classList.remove('bump')
  void el.offsetWidth
  el.classList.add('bump')
}

// ---------------------------------------------------------------- blocks

/** A due time said the way a person would say it. */
/** A clock time the way a person says it: 17:30 -> 5:30pm, 18:00 -> 6pm. */
function clockOf(at) {
  if (!/^\d{2}:\d{2}$/.test(at || '')) return ''
  const [h, m] = at.split(':').map(Number)
  const d = new Date()
  d.setHours(h, m, 0, 0)
  // "5:30 pm" -> "5:30pm", "6:00 pm" -> "6pm": the page writes times the
  // terse way a person does
  return d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(':00', '').replace(/\s/g, '')
}

function whenPhrase(b, now = new Date()) {
  if (!b.when) return null
  const today = localDay(now)
  const tomorrow = localDay(new Date(now.getTime() + 86400000))
  if (b.when < today) return { text: 'overdue', urgent: true }
  if (b.when === today) {
    if (!b.at) return { text: 'today', urgent: false }
    const [h, m] = b.at.split(':').map(Number)
    const due = new Date(now)
    due.setHours(h, m, 0, 0)
    const mins = Math.round((due - now) / 60000)
    const clock = clockOf(b.at)
    if (mins < -5) return { text: `${clock}, passed`, urgent: true }
    if (mins <= 1) return { text: 'now', urgent: true }
    if (mins < 60) return { text: `in ${mins} min`, urgent: true }
    if (mins < 180) return { text: `in ${Math.round(mins / 60)} hours`, urgent: true }
    return { text: clock, urgent: false }
  }
  if (b.when === tomorrow) return { text: b.at ? `tomorrow ${clockOf(b.at)}` : 'tomorrow', urgent: false }
  // a time answered for a date further out was being dropped here: the
  // person told the page when it was and the page never said it back
  const day = new Date(`${b.when}T12:00:00`).toLocaleString('en', { month: 'short', day: 'numeric' }).toLowerCase()
  return { text: b.at ? `${day}, ${clockOf(b.at)}` : day, urgent: false }
}

// links in card content become quiet hyperlinks: host + path as the label,
// raw urls never shown
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
function linkify(raw) {
  let out = ''
  let last = 0
  for (const m of String(raw).matchAll(URL_RE)) {
    out += esc(raw.slice(last, m.index))
    const url = m[0].replace(/[.,;:!?]+$/, '')
    const trail = m[0].slice(url.length)
    let label
    try {
      const u = new URL(url)
      label = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '')
    } catch {
      label = url
    }
    if (label.length > 32) label = `${label.slice(0, 29)}…`
    out += `<a class="card-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>${esc(trail)}`
    last = m.index + m[0].length
  }
  return out + esc(raw.slice(last))
}

// provenance: a change can show the words it came from
const srcTitle = (src) => {
  const t = src && state.sources?.[src]
  return t ? ` title="from: ${esc(t)}"` : ''
}

const rowMarkup = (b, i) => `
      <button class="row ${i.done ? 'done no-anim' : ''}" data-block="${b.id}" data-item="${i.id}"
        role="checkbox" aria-checked="${i.done}" aria-label="${esc(i.text)}"${srcTitle(i.src)}>
        <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
        <span class="row-text">${linkify(i.text)}</span>
      </button>`

const ledgerEntryMarkup = (b, e) =>
  `<div class="ledger-entry" data-item="${e.id}"${srcTitle(e.src)}><span class="ledger-label">${linkify(e.label)}</span><span>${fmtAmount(e.amount, b.unit)}</span></div>`

// ---------------------------------------------------------- the opened card
// A focused space is not the same card with more room: each type gains the
// resolution its small form cannot carry. Dots become a year, a total
// becomes months, a count becomes pace.

/** Counts read as people write them: 0.4166 -> 0.4, 139 -> 139. */
const num = (n) => {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Longest and current run of consecutive marked days. */
function streakRuns(dates) {
  const set = new Set(dates)
  let longest = 0
  for (const d of set) {
    const prev = localDay(new Date(new Date(`${d}T12:00`).getTime() - 86400000))
    if (set.has(prev)) continue // only count from the start of a run
    let n = 0
    let cur = d
    while (set.has(cur)) {
      n++
      cur = localDay(new Date(new Date(`${cur}T12:00`).getTime() + 86400000))
    }
    longest = Math.max(longest, n)
  }
  let current = 0
  let cur = localDay()
  if (!set.has(cur)) cur = localDay(new Date(Date.now() - 86400000)) // today still open
  while (set.has(cur)) {
    current++
    cur = localDay(new Date(new Date(`${cur}T12:00`).getTime() - 86400000))
  }
  return { longest, current }
}

const FULL = {
  // a year of days, so keeping-it-up is visible rather than counted
  streak: (b, _full, hero) => {
    const set = new Set(b.dates)
    const today = localDay()
    const year = Number(today.slice(0, 4))
    // the page is a year, so the map is that year: jan 1 through dec 31
    const first = new Date(year, 0, 1)
    const gridStart = new Date(first)
    gridStart.setDate(gridStart.getDate() - first.getDay()) // back to sunday
    const weeks = []
    const labels = []
    let lastMonth = ''
    for (let w = 0; w < 53; w++) {
      const col = []
      let colMonth = null
      for (let d = 0; d < 7; d++) {
        const day = new Date(gridStart)
        day.setDate(day.getDate() + w * 7 + d)
        if (day.getFullYear() !== year) {
          col.push('<i class="pad"></i>') // days outside the year hold the shape
          continue
        }
        if (colMonth === null) colMonth = day.getMonth()
        const iso = localDay(day)
        col.push(`<i class="${set.has(iso) ? 'on' : iso > today ? 'future' : ''}" title="${iso}"></i>`)
      }
      if (colMonth !== null && MONTHS[colMonth] !== lastMonth) {
        lastMonth = MONTHS[colMonth]
        labels.push(`<span style="--w:${w}">${lastMonth}</span>`)
      }
      weeks.push(`<div class="hm-week">${col.join('')}</div>`)
    }
    const { longest, current } = streakRuns(b.dates)
    const inYear = b.dates.filter((d) => d.startsWith(String(year))).length
    return `
    ${hero ? '' : `<div class="block-title">${esc(b.title)}</div>`}
    <div class="hm-months">${labels.join('')}</div>
    <div class="heatmap">${weeks.join('')}</div>
    <div class="hm-legend">
      <span><b>${current}</b> day${current === 1 ? '' : 's'} running</span>
      <span><b>${longest}</b> best</span>
      <span><b>${inYear}</b> in ${year}</span>
    </div>`
  },

  // where the money went, month by month, instead of a flat recent list
  ledger: (b, _full, hero) => {
    const byMonth = new Map()
    for (const e of b.entries) {
      const m = (e.at || '').slice(0, 7)
      if (!m) continue
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m).push(e)
    }
    const months = [...byMonth.entries()].sort((x, y) => y[0].localeCompare(x[0]))
    const sums = months.map(([, es]) => es.reduce((n, e) => n + (Number(e.amount) || 0), 0))
    const peak = Math.max(1, ...sums.map(Math.abs))
    const rows = months
      .map(([m, es], i) => {
        const sum = sums[i]
        const pct = Math.round((Math.abs(sum) / peak) * 100)
        const name = `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`
        return `
        <div class="lm">
          <div class="lm-head">
            <span class="lm-name">${name}</span>
            <span class="lm-sum">${fmtAmount(sum, b.unit)}</span>
          </div>
          <div class="lm-bar"><span style="width:${pct}%"></span></div>
          ${es
            .slice()
            .reverse()
            .map((e) => ledgerEntryMarkup(b, e))
            .join('')}
        </div>`
      })
      .join('')
    return `
    ${b.title && !hero ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="ledger-total">${fmtAmount(b.total, b.unit)}</div>
    ${rows}`
  },

  // a yearly target answers "am I ahead or behind", not just "how many"
  tracker: (b, _full, hero) => {
    const base = RENDER.tracker(b, false, hero)
    // pace assumes an even accumulation. Below a handful of units, or before
    // anything has happened, or once it is met, the claim is noise.
    if (b.period !== 'year' || b.target < 8 || b.current <= 0 || b.current >= b.target) return base
    const now = new Date()
    const start = new Date(now.getFullYear(), 0, 1)
    const end = new Date(now.getFullYear() + 1, 0, 1)
    const through = (now - start) / (end - start)
    const expected = b.target * through
    const diff = Math.round((b.current - expected) * 10) / 10
    const word =
      Math.abs(diff) < 0.5
        ? 'on pace'
        : diff > 0
          ? `${Math.abs(diff)} ahead of pace`
          : `${Math.abs(diff)} behind pace`
    return `${base}
    <div class="pace ${diff < -0.5 ? 'behind' : ''}">${word} · ${Math.round(through * 100)}% through the year</div>`
  },

  // the done pile folds away so the open work is the page
  list: (b) => {
    const open = b.items.filter((i) => !i.done)
    const done = b.items.filter((i) => i.done).sort((a, z) => (z.doneAt || '').localeCompare(a.doneAt || ''))
    return `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    ${open.map((i) => rowMarkup(b, i)).join('')}
    ${open.length === 0 ? '<div class="done-more">nothing open</div>' : ''}
    ${
      done.length
        ? `<details class="done-fold"><summary>${done.length} done</summary>${done.map((i) => rowMarkup(b, i)).join('')}</details>`
        : ''
    }`
  },
}

const RENDER = {
  // Open items in full; the done pile compresses to its two most recent.
  // The focused view shows the whole year.
  list: (b, full) => {
    const open = b.items.filter((i) => !i.done)
    const done = b.items.filter((i) => i.done).sort((a, z) => (z.doneAt || '').localeCompare(a.doneAt || ''))
    const shown = [...open, ...(full ? done : done.slice(0, 2))]
    const more = !full && done.length > 2 ? `<div class="done-more">${done.length - 2} more done</div>` : ''
    return `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    ${shown.map((i) => rowMarkup(b, i)).join('')}${more}`
  },

  tracker: (b, full_, hero) => {
    const pct = Math.min(100, Math.round((b.current / b.target) * 100))
    const full = b.current >= b.target
    // A small whole target counts better than it fills: twelve dots say
    // "none yet" where a bar at 0% just looks broken.
    const countable =
      Number.isInteger(b.current) && Number.isInteger(b.target) && b.target <= 24 && b.target > 1
    const pips = countable
      ? `<div class="pips ${full ? 'full' : ''}" role="img" aria-label="${b.current} of ${b.target}${b.unit ? ` ${b.unit}` : ''}">${Array.from(
          { length: b.target },
          (_, i) => `<i class="${i < b.current ? 'on' : ''}" style="--i:${i}"></i>`
        ).join('')}</div>`
      : ''
    // the hero drops its title: the space name and the number already say it
    const title = hero ? '' : `<span class="block-title" style="margin:0">${esc(b.title)}</span>`
    return `
    <div class="tracker-line">
      ${title}
      <span class="tracker-count ${full ? 'full' : ''}"><b>${num(b.current)}</b> of ${num(b.target)}${b.unit ? ` <span class="tracker-unit">${esc(b.unit)}</span>` : ''}</span>
    </div>
    ${pips || `<div class="meter ${full ? 'full' : ''}" data-meter="${b.id}"><span style="width:${pct}%"></span></div>`}`
  },

  ledger: (b, full, hero) => {
    const month = localDay().slice(0, 7)
    const monthSum = b.entries.filter((e) => (e.at || '').startsWith(month)).reduce((n, e) => n + (Number(e.amount) || 0), 0)
    const monthLine =
      monthSum && monthSum !== b.total
        ? `<div class="ledger-month">${new Date().toLocaleString('en', { month: 'short' }).toLowerCase()} ${fmtAmount(monthSum, b.unit)}</div>`
        : ''
    return `
    ${b.title && !hero ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="ledger-total">${fmtAmount(b.total, b.unit)}</div>
    ${monthLine}
    ${b.entries
      .slice(full ? -24 : -3)
      .reverse()
      .map((e) => ledgerEntryMarkup(b, e))
      .join('')}`
  },

  streak: (b, full, hero) => {
    const days = []
    for (let i = 13; i >= 0; i--) {
      const d = localDay(new Date(Date.now() - i * 86400000))
      const on = b.dates.includes(d)
      const today = i === 0 && !on
      days.push(`<i class="${on ? 'on' : ''}${today ? 'today' : ''}" style="--i:${13 - i}"></i>`)
    }
    // A hero tracker can drop its title because its number carries a unit
    // ("139 of 200 miles"). A streak's number carries nothing, so dropping
    // the title left the card reading as a space name and a bare 1.
    return `
    <div class="tracker-line">
      ${b.title ? `<span class="block-title" style="margin:0">${esc(b.title)}</span>` : ''}
      <span class="streak-count">${b.dates.length} <span class="tracker-unit">day${b.dates.length === 1 ? '' : 's'}</span></span>
    </div>
    <div class="streak-line"><span class="streak-dots">${days.join('')}</span></div>`
  },

  note: (b, full) => `
    ${b.title && !/^notes?$/i.test(b.title.trim()) ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="note-text ${!full && b.text.length > 280 ? 'clamp' : ''}">${linkify(b.text)}</div>`,

  reminder: (b) => {
    const w = whenPhrase(b)
    const place = b.entities?.find((entity) => entity.type === 'place')
    const placeChip = place ? `<span class="place-chip">${esc(place.name)}</span>` : ''
    const when = w
      ? `<span class="when-sub ${w.urgent ? 'urgent' : ''}">${esc(w.text)}${b.repeat ? ` · ${b.repeat}` : ''}</span>`
      : b.repeat
        ? `<span class="when-sub">${b.repeat}</span>`
        : ''
    return `
    <button class="row reminder ${b.done ? 'done no-anim' : ''}" data-block="${b.id}"
      role="checkbox" aria-checked="${b.done}" aria-label="${esc(b.text)}">
      <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
      <span class="row-text">${linkify(b.text)}</span>${placeChip}${when}
    </button>`
  },
}

// compact one-line variants for a card's secondary instruments
const COMPACT = {
  tracker: (b) => `
    <div class="c-line"${srcTitle(b.src)}><span class="c-title">${esc(b.title)}</span>
      <span class="mini-meter"><i style="width:${Math.min(100, Math.round((b.current / b.target) * 100))}%"></i></span>
      <span class="c-val">${b.current}/${b.target}</span></div>`,
  ledger: (b) => `
    <div class="c-line"><span class="c-title">${esc(b.title)}</span>
      <span class="c-val">${fmtAmount(b.total, b.unit)}</span></div>`,
  streak: (b) => {
    const last7 = []
    for (let i = 6; i >= 0; i--) {
      const d = localDay(new Date(Date.now() - i * 86400000))
      last7.push(`<i class="${b.dates.includes(d) ? 'on' : ''}"></i>`)
    }
    return `
    <div class="c-line"><span class="c-title">${esc(b.title)}</span>
      <span class="streak-dots mini">${last7.join('')}</span>
      <span class="c-val">${b.dates.length}</span></div>`
  },
}

/** Every space leads with its heartbeat: one hero instrument, the rest quiet. */
function heroId(space) {
  const order = ['tracker-year', 'tracker', 'ledger', 'streak']
  for (const want of order) {
    const hit = space.blocks.find((b) =>
      want === 'tracker-year' ? b.type === 'tracker' && b.period === 'year' : b.type === want
    )
    if (hit) return hit.id
  }
  return null
}

// A space holding one short thing does not need a heading, a checkbox, and
// a line that all say the same thing. The thing becomes the card.
const STOP = new Set(['a','an','the','my','your','with','from','for','to','at','on','in','of','and','is','was'])
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => !STOP.has(w)) || [])

function soloOf(space) {
  if (space.blocks.length !== 1) return null
  const b = space.blocks[0]
  const solo = b.type === 'reminder'
    ? b
    : b.type === 'note' && !b.title && b.text.length <= 140 && !b.text.includes('\n')
      ? b
      : null
  if (!solo) return null
  // the space name earns its place only when it says something the line does
  // not — matched by stem, so "Plumbing" stays quiet next to "plumber"
  const inText = [...words(solo.text || '')]
  const covered = (w) => inText.some((t) => t.startsWith(w.slice(0, 4)) || w.startsWith(t.slice(0, 4)))
  const extra = [...words(space.name)].filter((w) => !covered(w))
  return { block: solo, label: extra.length ? space.name : '' }
}

function touchedPhrase(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000)
  if (days <= 0) return 'touched today'
  if (days === 1) return 'touched yesterday'
  if (days < 30) return `touched ${days} days ago`
  return `touched ${new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' })}`
}

function spaceInner(space, full = false) {
  // reminders that are open float to the top of the card
  const blocks = [...space.blocks].sort((a, b) => {
    const w = (x) => (x.type === 'reminder' && !x.done ? 0 : 1)
    return w(a) - w(b)
  })
  const hero = full ? null : heroId(space)
  const corner = `<div class="card-tools">
        <button class="card-tool ${space.complete ? 'ready' : ''}" data-finish="${space.id}" aria-label="${space.finished ? 'Reopen this space' : 'Close this space out'}" title="${space.finished ? 'reopen' : 'close out'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 6.5"/></svg>
        </button>
        <button class="card-tool ${space.pinned ? 'on' : ''}" data-pin="${space.id}" aria-label="${space.pinned ? 'Unpin' : 'Pin'}" title="${space.pinned ? 'unpin' : 'pin'}">
          <svg viewBox="0 0 24 24" fill="${space.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 4v2h-5v5h-2v-5H6v-2l4-4-1-6Z"/></svg>
        </button>
      </div>`
  const solo = full ? null : soloOf(space)
  if (solo) {
    const b = solo.block
    const w = b.type === 'reminder' ? whenPhrase(b) : null
    const bits = [
      w ? `<span class="${w.urgent ? 'urgent' : ''}">${esc(w.text)}</span>` : '',
      b.repeat || '',
      solo.label ? esc(solo.label) : '',
    ].filter(Boolean)
    const checkable = b.type === 'reminder'
    return `
      ${corner}
      <${checkable ? 'button' : 'div'} class="solo ${b.done ? 'done' : ''}"
        ${checkable ? `data-block="${b.id}" role="checkbox" aria-checked="${b.done}" aria-label="${esc(b.text)}"` : ''}>
        <span class="solo-text">${linkify(b.text)}</span>
      </${checkable ? 'button' : 'div'}>
      ${bits.length ? `<div class="solo-sub">${bits.join(' · ')}</div>` : ''}`
  }
  const meta = full
    ? [space.area, space.pinned ? 'pinned' : '', touchedPhrase(space.updatedAt)].filter(Boolean).join(' · ')
    : ''
  return `
    ${corner}
    <h2 class="space-name">${esc(space.name)}</h2>
    ${meta ? `<div class="focus-meta">${esc(meta)}</div>` : ''}
    ${blocks
      .map((b) => {
        const isHero = b.id === hero
        const compact = !full && !isHero && COMPACT[b.type]
        const draw = full && FULL[b.type] ? FULL[b.type] : RENDER[b.type]
        const body = compact ? COMPACT[b.type](b) : draw ? draw(b, full, isHero) : ''
        return `<div class="block${isHero ? ' hero' : ''}" data-bid="${b.id}">${body}</div>`
      })
      .join('')}`
}

// ------------------------------------------------------------ focus view

let focusId = null

function buildFocus() {
  const wrap = $('#focus')
  const space = focusId && state.spaces.find((s) => s.id === focusId)
  if (!space) {
    focusId = null
    wrap.innerHTML = ''
    return
  }
  // a re-render (the agent touched this space) must never eat a draft
  // mid-sentence, drop the caret, or jump the scroll
  const oldField = wrap.querySelector('.focus-capture')
  const draft = oldField?.value || ''
  const hadFocus = document.activeElement === oldField
  const caret = oldField?.selectionStart ?? draft.length
  const scrollTop = wrap.querySelector('.focus-card')?.scrollTop || 0

  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" data-sid="${space.id}">
        ${spaceInner(space, true)}
        <textarea class="capture focus-capture" rows="1" placeholder="Add to ${esc(space.name)}…" spellcheck="false"></textarea>
      </article>
    </div>`
  wrap.dataset.u = space.updatedAt
  const fieldEl = wrap.querySelector('.focus-capture')
  if (fieldEl) {
    fieldEl.value = draft
    // the add-to field sits at the foot of the card: focusing it normally
    // scrolls it into view, which opened every long card at its bottom
    if (hadFocus || !draft) fieldEl.focus({ preventScroll: true })
    if (draft) fieldEl.setSelectionRange(caret, caret)
  }
  const card = wrap.querySelector('.focus-card')
  // a card opens at its top; only a re-render keeps where you were
  card?.scrollTo({ top: scrollTop, behavior: 'auto' })
  document.documentElement.classList.add('modal-open')
}

function closeFocus() {
  document.documentElement.classList.remove('modal-open')
  $('#focus').dataset.confirm = ''
  focusId = null
  yearOpen = false
  yearShown = null
  $('#focus').innerHTML = ''
  $('#focus').dataset.u = ''
  $('#focus').dataset.help = ''
}

// ---------------------------------------------------------------- render

/** The date, and how far the year still has to go. The page is named for
    where it is heading and never said so on the page itself — the count
    only existed inside the year view, on the December row. */
function renderYearline() {
  const now = new Date()
  const days = (to) => Math.ceil((to - now) / 86400000)
  const plural = (n) => `${n} day${n === 1 ? '' : 's'}`
  const til =
    now.getMonth() === 11
      ? (() => {
          const left = days(new Date(now.getFullYear() + 1, 0, 1))
          return left <= 1 ? 'last day' : `${plural(left)} left`
        })()
      : `${plural(days(new Date(now.getFullYear(), 11, 1)))} to December`
  const el = $('#dateline')
  const date = `${now.toLocaleString('en', { month: 'long' })} ${now.getDate()}`
  const key = `${date}|${til}`
  // only rebuilt when the day or the count actually turns, so the greeting
  // below fires once on load and not on every ten-second poll
  if (el.dataset.key === key) return
  const first = !el.dataset.key
  el.dataset.key = key
  el.innerHTML = `${esc(date)}<span class="til">${esc(til)}</span>`
  if (first) {
    // it says how far the year has to go once, when you arrive, and then
    // gets out of the way — it is there to be glanced at, not read
    const t = el.querySelector('.til')
    t.classList.add('greet')
    t.addEventListener('animationend', () => t.classList.remove('greet'), { once: true })
  }
}

/** The filing moment: a mote of light leaves your sentence and dissolves
    into the space it landed in. A bright core, a soft halo, and echoes that
    lag a beat behind it — blurred while it is moving fast, sharp as it
    arrives. The page holds still while it flies. */
const inViewport = (r) => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth

function travelDot(fromRect, toEl, then, hue) {
  if (reduced || !toEl) return then?.()
  const to = toEl.getBoundingClientRect()
  // a flight nobody can see is just latency: skip when either end is offscreen
  if (!inViewport(fromRect) || !inViewport(to)) return then?.()

  const x0 = fromRect.left
  const y0 = fromRect.top + fromRect.height / 2
  const dx = to.left + 22 - x0
  const dy = to.top + 22 - y0

  // one arc, walked by every part; blur tracks speed, so it smears through
  // the fast middle and resolves at both ends
  const arc = (blur) => [
    { transform: 'translate(0, 0) scale(0.45)', opacity: 0, filter: `blur(${blur * 0.6}px)`, offset: 0 },
    { transform: `translate(${dx * 0.16}px, ${dy * 0.16 - 26}px) scale(1.18)`, opacity: 1, filter: `blur(${blur * 1.6}px)`, offset: 0.26 },
    { transform: `translate(${dx * 0.62}px, ${dy * 0.62 - 30}px) scale(1)`, opacity: 1, filter: `blur(${blur}px)`, offset: 0.66 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0, filter: `blur(${blur * 0.4}px)`, offset: 1 },
  ]

  const parts = [
    { cls: 'mote-halo', blur: 7, delay: 0 },
    { cls: 'mote-core', blur: 1.2, delay: 0 },
    { cls: 'mote-echo', blur: 2.4, delay: 80 },
    { cls: 'mote-echo', blur: 2.4, delay: 145 },
    { cls: 'mote-echo', blur: 2.4, delay: 200 },
  ]

  let lead = null
  for (const p of parts) {
    const el = document.createElement('div')
    el.className = `mote ${p.cls}`
    if (hue) el.style.setProperty('--mote', hue)
    el.style.left = `${x0}px`
    el.style.top = `${y0}px`
    document.body.appendChild(el)
    const anim = el.animate(arc(p.blur), {
      duration: 840,
      delay: p.delay,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'forwards',
    })
    anim.addEventListener('finish', () => el.remove())
    if (p.cls === 'mote-core') lead = anim
  }

  lead.addEventListener('finish', () => {
    bloom(x0 + dx, y0 + dy)
    then?.()
  })
}

/** Where the mote lands: a breath of light that swells and dissolves,
    handing off to the card's own sheen. */
function bloom(x, y) {
  if (reduced) return
  const glow = document.createElement('div')
  glow.className = 'landing'
  glow.style.left = `${x}px`
  glow.style.top = `${y}px`
  document.body.appendChild(glow)
  setTimeout(() => glow.remove(), 760)
}

function washCard(el) {
  if (!el) return
  el.classList.remove('washed')
  void el.offsetWidth
  el.classList.add('washed')
  clearTimeout(el._washT)
  el._washT = setTimeout(() => el.classList.remove('washed'), 1000)
}

/** FLIP: when the grid changes shape, cards glide to their new places
    instead of teleporting. */
function withFlip(fn) {
  if (reduced) return fn()
  const before = new Map()
  // everything the header can shove: the cards, the rail beside them, and
  // the quiet spaces below. Measuring only the grid left the rest snapping.
  for (const el of document.querySelectorAll('#spaces .space, #rail, #resting')) {
    before.set(el, el.getBoundingClientRect())
  }
  fn()
  const moves = []
  for (const [el, a] of before) {
    if (!el.isConnected) continue
    // a card still mid-entrance owns its transform; leave it be
    if (el.classList.contains('fresh') && !el.classList.contains('settled')) continue
    const b = el.getBoundingClientRect()
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moves.push([el, dx, dy])
  }
  if (!moves.length) return
  // Settling reads as a settling, not a snap: the page resolves from the
  // top down, and how far a card travels decides how long it takes. One
  // duration for every card made a 6px nudge look as laborious as a
  // full-column move, and every card starting on the same frame made the
  // whole grid move like one object.
  const plan = moves
    .map(([el, dx, dy]) => ({ el, dx, dy, top: el.getBoundingClientRect().top, dist: Math.hypot(dx, dy) }))
    .sort((p, q) => p.top - q.top)
  for (const m of plan) {
    m.el.style.transition = 'none'
    m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)`
  }
  void document.body.offsetHeight
  let longest = 0
  plan.forEach((m, i) => {
    const dur = Math.round(Math.min(460, 250 + m.dist * 0.55))
    const delay = Math.min(i * 14, 110)
    longest = Math.max(longest, dur + delay)
    m.el.style.transition = `transform ${dur}ms var(--ease-settle) ${delay}ms`
    m.el.style.transform = ''
  })
  setTimeout(() => {
    for (const m of plan) m.el.style.transition = ''
  }, longest + 60)
}

/** Data reveal: bars draw to their mark instead of appearing at it. */
function drawMeters(root) {
  if (reduced) return
  for (const span of root.querySelectorAll('.meter span')) {
    const target = span.style.width
    span.style.transition = 'none'
    span.style.width = '0%'
    void span.offsetWidth
    span.style.transition = ''
    requestAnimationFrame(() => (span.style.width = target))
  }
}

/** Which space element each just-filed capture should fly to. */
function travelTargets() {
  const targets = new Map()
  const ids = new Set(state.captures.map((c) => c.id))
  for (const a of state.activity) {
    if (!pending.has(a.captureId) || ids.has(a.captureId)) continue
    const space = state.spaces.find((s) => s.name === a.space)
    if (space) targets.set(a.captureId, space.id)
  }
  return targets
}

/** Spaces that appeared while something is still settling. The agent
    creates a space BEFORE it files the capture, so without this the card
    materializes whole on one poll and the mote arrives on the next — the
    card beating its own animation. Held cards stay a hollow frame until
    the mote lands on them. */
function heldSpaces() {
  if (!state.captures.length || !prev) return []
  const before = new Set(prev.spaces.map((s) => s.id))
  return state.spaces.filter((s) => !before.has(s.id)).map((s) => s.id)
}

/** Pinning does not change a space's content, so its updatedAt does not
    move and the card's markup is never rebuilt. The tools have to be synced
    on their own or an unpinned card keeps a solid pin forever. */
function syncTools(el, space) {
  if (!el) return
  el.classList.toggle('pinned', !!space.pinned)
  const pin = el.querySelector('[data-pin]')
  if (pin) {
    pin.classList.toggle('on', !!space.pinned)
    pin.setAttribute('aria-label', space.pinned ? 'Unpin' : 'Pin')
    pin.setAttribute('title', space.pinned ? 'unpin' : 'pin')
    pin.querySelector('svg')?.setAttribute('fill', space.pinned ? 'currentColor' : 'none')
  }
  el.querySelector('[data-finish]')?.classList.toggle('ready', !!space.complete)
}

// The building moment: a card under construction is a hollow dashed frame
// with its content still forming; when the mote lands, it inks in.
function unbuild(el) {
  if (!el?.classList.contains('building')) return
  el.classList.remove('building')
  el.classList.add('forming')
  setTimeout(() => el.classList.remove('forming'), 700)
  drawMeters(el)
}

/** Nothing left settling: release any frame still waiting on a mote that
    is never coming (a failed pass, a capture filed to nothing). */
function releaseHeld(targets) {
  if (state.captures.length) return
  const landing = new Set(targets.values())
  for (const el of document.querySelectorAll('.space.building')) {
    if (!landing.has(el.dataset.sid)) unbuild(el)
  }
}

/** While the agent works the stage says one word, not your own sentence.
    The words you just wrote were echoed back for the whole pass — thirty
    to sixty seconds of reading what you already knew — and everything then
    resolved in about a second. The one line stays put while each settled
    capture flies out of it into its card, so the filing motion still reads
    as your sentence travelling somewhere. */
function renderInbox(targets = new Map()) {
  const box = $('#inbox')
  const failed = !state.settle.running && state.settle.lastError
  const captureOnly = state.settle.captureOnly
  const ids = new Set(state.captures.map((c) => c.id))

  // anything that left the inbox since the last pass flies to its card;
  // a batch launches as a stream, not a swarm
  const origin = box.querySelector('.working')?.getBoundingClientRect()
  let launch = 0
  for (const cid of [...pending]) {
    if (ids.has(cid)) continue
    pending.delete(cid)
    const targetEl = spaceEls.get(targets.get(cid))?.el
    if (!targetEl || !origin) continue
    flying++
    setTimeout(() => {
      travelDot(origin, targetEl, () => {
        unbuild(targetEl)
        washCard(targetEl)
        flying = Math.max(0, flying - 1)
        renderStage() // the stage was holding open for this
      })
    }, launch++ * 160)
  }
  for (const c of state.captures) pending.add(c.id)

  const word = captureOnly ? 'saved · capture only' : failed ? "couldn't settle" : 'working'
  const kind = captureOnly ? 'capture-only' : failed ? 'failed' : ''
  // the queue: what you said, greyed, in order, until it lands on a card
  const queue = [...queuedTexts, ...state.captures.map((c) => c.text)]
  const show = queue.length > 0 || pending.size > 0 || state.settle.running || flying > 0
  const key = show ? `${kind}|${word}|${queue.join('¦')}` : ''
  if (box.dataset.key === key) return
  box.dataset.key = key
  const dots = kind === '' ? '<span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : ''
  box.innerHTML = show
    ? queue.map((t) => `<div class="queue-row">${esc(t)}</div>`).join('') +
      `<div class="working ${kind}"><span class="working-word">${esc(word)}</span>${dots}${
        failed ? '<button class="retry">retry</button>' : ''
      }</div>`
    : ''
}

/** The card's own sheen already said what happened. All the top keeps is
    a small mark that undo is available, and only for a moment. */
function renderActivity() {
  const el = $('#activity')
  const acts = state.activity || []
  const key = acts.length ? `${acts[0].at}|${state.canUndo}` : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  if (!acts.length || !state.canUndo) {
    el.innerHTML = ''
    return
  }
  el.classList.remove('faded')
  el.innerHTML =
    `<span class="sr-only">${esc(acts[0].space)}: ${esc(acts[0].summary)}</span>` +
    `<button class="undo" id="undo-btn" title="${esc(acts[0].space)} · ${esc(acts[0].summary)}">undo</button>`
  clearTimeout(renderActivity._t)
  renderActivity._t = setTimeout(() => el.classList.add('faded'), 8000)
}

/** Closing something out is always a question, and an honest one: it
    names what will be left unfinished. */
function askToFinish(space) {
  const open = openThings(space)
  const wrap = $('#focus')
  wrap.dataset.confirm = space.id
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card co-card" role="dialog" aria-modal="true" aria-labelledby="co-title">
        <h2 class="space-name" id="co-title">Close out ${esc(space.name)}?</h2>
        <p class="co-read">${
          open.length
            ? `<b>${open.length}</b> thing${open.length === 1 ? '' : 's'} still unfinished.`
            : 'Nothing here is unfinished.'
        } You can reopen it anytime.</p>
        <div class="confirm-list">${open.slice(0, 6).map((t) => `<div class="confirm-item">${esc(t)}</div>`).join('')}${open.length > 6 ? `<div class="confirm-item more">and ${open.length - 6} more</div>` : ''}</div>
        <div class="co-actions">
          <button class="btn-solid" data-confirm-finish="${space.id}">Close it out</button>
          <button class="btn-quiet" data-close>Keep it open</button>
        </div>
      </article>
    </div>`
}

/** The actual things still waiting, in the person's own words. */
function openThings(space) {
  const out = []
  for (const b of space?.blocks || []) {
    if (b.type === 'list') for (const i of b.items) if (!i.done) out.push(i.text)
    if (b.type === 'reminder' && !b.done) out.push(b.text)
    if (b.type === 'tracker' && b.current < b.target) out.push(`${b.title || 'goal'}: ${b.current} of ${b.target}`)
  }
  return out
}

// ---------------------------------------------------------- the layout
// CSS multi-column rebalances the whole flow whenever any card changes
// height, so cards leap between columns and nothing can be animated. We
// own the columns instead: a card is assigned one and keeps it, so growth
// only ever pushes what is directly below it.

const colCount = () => (innerWidth <= 720 ? 1 : 2)

function ensureColumns(box) {
  const want = colCount()
  if (box.children.length === want && box.firstElementChild?.classList.contains('col')) return
  const cards = [...box.querySelectorAll('.space')]
  box.innerHTML = ''
  for (let i = 0; i < want; i++) {
    const col = document.createElement('div')
    col.className = 'col'
    box.appendChild(col)
  }
  for (const c of cards) box.firstElementChild.appendChild(c)
}

/** Place cards in order, each into the currently shortest column. Cards
    already in the right place are left alone entirely. */
function placeCards(box, ordered) {
  const cols = [...box.querySelectorAll('.col')]
  if (!cols.length) return
  const heights = cols.map(() => 0)
  const want = cols.map(() => [])
  const STICK = 140 // px of imbalance a card tolerates to stay put
  for (const el of ordered) {
    let target = 0
    for (let i = 1; i < cols.length; i++) if (heights[i] < heights[target]) target = i
    // a card that already lives somewhere stays there unless the shortest
    // column is genuinely shorter: re-balancing on every small height change
    // is what makes the page churn
    const cur = cols.indexOf(el.parentElement)
    if (cur !== -1 && heights[cur] <= heights[target] + STICK) target = cur
    want[target].push(el)
    heights[target] += el.offsetHeight + 14
  }
  // touch the DOM only where it actually differs: re-appending a node
  // restarts its animations, so a needless move replays the sheen
  cols.forEach((col, i) => {
    const have = [...col.children]
    const need = want[i]
    if (have.length === need.length && have.every((el, n) => el === need[n])) return
    for (const el of need) col.appendChild(el)
  })
}

/** A card that changed content grows or shrinks into its new size. */
function animateHeight(el, from) {
  if (reduced) return
  const to = el.offsetHeight
  if (from === to || !from) return
  el.style.height = `${from}px`
  el.style.overflow = 'hidden'
  void el.offsetHeight
  el.style.transition = 'height var(--m-struct) var(--ease-expo)'
  el.style.height = `${to}px`
  const done = () => {
    el.style.height = ''
    el.style.overflow = ''
    el.style.transition = ''
    el.removeEventListener('transitionend', done)
  }
  el.addEventListener('transitionend', done)
  setTimeout(done, 500)
}

const DORMANT_MS = 30 * 86400000
const awake = new Set() // dormant spaces the user woke this session

/** Quietly re-render one card (done items resort to the tail) with a FLIP
    glide and no agent-touch sheen: this was the person's own hand. */
function resortCard(sid) {
  const known = spaceEls.get(sid)
  if (!known) return
  known.updatedAt = ''
  known.quiet = true
  withFlip(() => renderSpaces())
}

function renderSpaces(delayWash = new Set()) {
  const box = $('#spaces')
  const seen = new Set()
  const now = Date.now()
  const live = state.spaces.filter((s) => !s.finished)
  const finished = state.spaces.filter((s) => s.finished)
  const active = live.filter((s) => now - new Date(s.updatedAt) < DORMANT_MS || awake.has(s.id))
  const resting = live.filter((s) => !active.includes(s))

  ensureColumns(box)
  active.forEach((space, i) => {
    seen.add(space.id)
    // whatever branch runs below, the tools reflect the space afterwards
    queueMicrotask(() => syncTools(spaceEls.get(space.id)?.el, space))
    const known = spaceEls.get(space.id)
    if (!known) {
      const el = document.createElement('article')
      // a card born from a settling capture arrives as a hollow frame and
      // inks in when the dot lands; anything else materializes whole
      const building = delayWash.has(space.id) && !reduced
      el.className = building ? 'space fresh building' : 'space fresh'
      el.tabIndex = 0
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', `${space.name}, open`)
      // on the first paint the cards follow the header in, a beat apart and
      // for longer; afterwards a new card arrives on its own immediately
      el.style.animationDelay = booting
        ? `${260 + Math.min(i * 55, 660)}ms`
        : `${Math.min(i * 45, 270)}ms`
      el.dataset.sid = space.id
      el.innerHTML = spaceInner(space)
      el.classList.toggle('pinned', !!space.pinned)
      // once the entrance ends, stop its fill so FLIP transforms can act
      el.addEventListener('animationend', () => el.classList.add('settled'), { once: true })
      ;(box.querySelector('.col') || box).appendChild(el)
      spaceEls.set(space.id, { el, updatedAt: space.updatedAt })
      if (!building) drawMeters(el)
    } else if (known.updatedAt !== space.updatedAt) {
      const prevSpace = prev?.spaces.find((s) => s.id === space.id)
      const heightBefore = known.el.offsetHeight
      known.el.innerHTML = spaceInner(space)
      animateHeight(known.el, heightBefore)
      known.el.classList.toggle('pinned', !!space.pinned)
      known.el.style.animationDelay = '0ms'
      known.el.classList.remove('fresh')
      // blocks the agent just added rise in individually
      const before = new Set((prevSpace?.blocks || []).map((b) => b.id))
      let n = 0
      for (const bel of known.el.querySelectorAll('[data-bid]')) {
        if (!before.has(bel.dataset.bid)) {
          bel.classList.add('arrive')
          bel.style.setProperty('--d', `${Math.min(n++, 4) * 45}ms`)
        }
      }
      // reworded text is not a flicker: it says it changed
      const prevText = new Map()
      for (const pb of prevSpace?.blocks || []) {
        if (pb.type === 'list') for (const i of pb.items) prevText.set(i.id, i.text)
        if (pb.type === 'note' || pb.type === 'reminder') prevText.set(pb.id, pb.text)
      }
      for (const b of space.blocks) {
        const bel0 = known.el.querySelector(`[data-bid="${b.id}"]`)
        if (!bel0) continue
        if (b.type === 'list') {
          for (const i of b.items) {
            if (prevText.has(i.id) && prevText.get(i.id) !== i.text) {
              markEdited(bel0.querySelector(`[data-item="${i.id}"] .row-text`))
            }
          }
        } else if ((b.type === 'note' || b.type === 'reminder') && prevText.has(b.id) && prevText.get(b.id) !== b.text) {
          markEdited(bel0.querySelector('.note-text, .row-text'))
        }
      }
      // changed numbers beat; changed meters glide from where they were
      for (const b of space.blocks) {
        const pb = prevSpace?.blocks.find((x) => x.id === b.id)
        if (!pb) continue
        const bel = known.el.querySelector(`[data-bid="${b.id}"]`)
        if (!bel) continue
        if (b.type === 'tracker' && pb.current !== b.current) {
          bump(bel.querySelector('.tracker-count'))
          markChange(bel.querySelector('.tracker-count'), `${b.current > pb.current ? '+' : ''}${b.current - pb.current}`)
          const span = bel.querySelector('.meter span')
          if (span && !reduced) {
            const target = span.style.width
            span.style.transition = 'none'
            span.style.width = `${Math.min(100, Math.round((pb.current / pb.target) * 100))}%`
            void span.offsetWidth
            span.style.transition = ''
            requestAnimationFrame(() => (span.style.width = target))
          }
        }
        if (b.type === 'ledger' && (pb.total ?? 0) !== (b.total ?? 0)) {
          bump(bel.querySelector('.ledger-total'))
          markChange(bel.querySelector('.ledger-total'), `+${fmtAmount((b.total ?? 0) - (pb.total ?? 0), b.unit)}`)
          bel.querySelector('.ledger-entry')?.classList.add('entry-in')
        }
        if (b.type === 'streak' && b.dates.length > (pb.dates?.length ?? 0)) {
          const dots = bel.querySelectorAll('.streak-dots i.on')
          dots[dots.length - 1]?.classList.add('just-marked')
        }
      }
      // cards receiving a travel dot wash when the dot lands, not before;
      // quiet re-sorts (the person's own hand) get no sheen at all
      if (!delayWash.has(space.id) && !known.quiet) washCard(known.el)
      known.quiet = false
      known.updatedAt = space.updatedAt
    }
  })
  for (const [id, { el }] of spaceEls) {
    if (!seen.has(id)) {
      el.remove()
      spaceEls.delete(id)
    }
  }

  // ordering is a placement decision, made once, for all columns
  placeCards(box, active.map((s) => spaceEls.get(s.id)?.el).filter(Boolean))

  renderResting(finished, resting)
}

// ------------------------------------------------- the foot of the page
// Everything you are done with used to sit here as one full-width row per
// space, at the same weight as live work: twenty rows and 809px on a page
// of 3587, printing "done in june" three times because the month was a
// grouping signal rendered once per row. It only ever grew. It is a count
// now, and opening one gives the month grouping the rows were spelling out.

let restOpen = '' // which group is unfolded, if any

const GROUPS = {
  finished: { verb: 'data-reopen', dateOf: (s) => s.finishedAt || s.updatedAt },
  resting: { verb: 'data-wake', dateOf: (s) => s.updatedAt },
  retired: { verb: 'data-restore', dateOf: () => '' },
}

/** Newest month first, each month naming its spaces once. */
function byMonth(list, dateOf) {
  const out = new Map()
  for (const s of [...list].sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))))) {
    const at = dateOf(s)
    const label = at ? new Date(at).toLocaleString('en', { month: 'long' }).toLowerCase() : ''
    if (!out.has(label)) out.set(label, [])
    out.get(label).push(s)
  }
  return [...out.entries()]
}

function renderResting(finished, resting) {
  const rest = $('#resting')
  const sets = { finished, resting, retired: state.retired || [] }
  if (!sets[restOpen]?.length) restOpen = '' // the group emptied under us
  const counts = Object.entries(sets).filter(([, v]) => v.length)
  if (!counts.length) {
    rest.innerHTML = ''
    return
  }
  // The shell is built once and kept. Replacing the whole section on every
  // render would hand the panel its content and its open state in the same
  // frame, and a transition with no starting state does not run — it snaps.
  if (!rest.querySelector('.rest-open')) {
    rest.innerHTML = '<div class="rest-fold"></div><div class="rest-open"><div></div></div>'
  }
  const fold = rest.querySelector('.rest-fold')
  const panel = rest.querySelector('.rest-open')
  const inner = panel.firstElementChild

  const lineKey = counts.map(([k, v]) => `${k}${v.length}`).join('|') + `|${restOpen}`
  if (fold.dataset.key !== lineKey) {
    fold.dataset.key = lineKey
    fold.innerHTML = counts
      .map(
        ([name, v]) =>
          `<button class="rest-grp ${restOpen === name ? 'on' : ''}" data-grp="${name}" aria-expanded="${restOpen === name}">${name} <span class="rest-n">${v.length}</span></button>`
      )
      .join('')
  }

  const contentKey = restOpen ? restOpen + sets[restOpen].map((s) => s.id).join() : ''
  if (panel.dataset.key === contentKey) return
  panel.dataset.key = contentKey
  if (!restOpen) {
    // let it close before it empties, so it collapses rather than vanishes
    panel.classList.remove('on')
    setTimeout(() => {
      if (!panel.dataset.key) inner.innerHTML = ''
    }, 420)
    return
  }
  const { verb, dateOf } = GROUPS[restOpen]
  inner.innerHTML = byMonth(sets[restOpen], dateOf)
    .map(
      ([month, list]) => `
      <div class="rest-month">
        <span class="rest-mlabel">${esc(month)}</span>
        <span class="rest-names">${list
          .map((s) => `<button class="rest-name" ${verb}="${s.id}">${esc(s.name)}</button>`)
          .join('')}</span>
      </div>`
    )
    .join('')
  // a frame between the content arriving and the row opening, so there is a
  // height to grow from
  requestAnimationFrame(() => panel.classList.add('on'))
}

/** A rotation should become the new layout immediately, not after the next
    ten-second state poll. Only rebuild the column shells when the breakpoint
    actually changes; CSS handles all fluid resizing within a layout. */
function resizeLayout() {
  clearTimeout(resizeLayout._t)
  resizeLayout._t = setTimeout(() => {
    if (!state) return
    const box = $('#spaces')
    if (box.children.length !== colCount()) withFlip(() => renderSpaces())

    if ($('#capture')?.value) fitCapture()
  }, 120)
}
window.addEventListener('resize', resizeLayout)

/** Trackers that just reached their target get the full §1.12 moment. */
/** Closing a space out is the one moment December is allowed to be glad,
    so it gets its own gesture rather than the small confetti a finished
    tracker gets. It is sized to the card and made of light: a breath of
    colour, and a few motes that rise and let go. */
function celebrateSpace(cardEl) {
  if (reduced || !cardEl) return
  const r = cardEl.getBoundingClientRect()
  if (!(r.bottom > 0 && r.top < innerHeight)) return
  const size = Math.min(Math.max(r.width, 240), 420)
  const layer = document.createElement('div')
  layer.className = 'seal'
  layer.style.left = `${r.left + r.width / 2}px`
  layer.style.top = `${r.top + Math.min(r.height / 2, 150)}px`
  layer.style.setProperty('--size', `${size}px`)

  const bloom = document.createElement('span')
  bloom.className = 'seal-bloom'
  layer.appendChild(bloom)

  for (let i = 0; i < 7; i++) {
    const mote = document.createElement('i')
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.7 // upward, loosely
    const dist = size * (0.26 + Math.random() * 0.3)
    mote.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
    mote.style.setProperty('--dy', `${Math.sin(angle) * dist}px`)
    mote.style.animationDelay = `${70 + i * 50}ms`
    layer.appendChild(mote)
  }

  document.body.appendChild(layer)
  setTimeout(() => layer.remove(), 1600)
}

function celebrateDiffs() {
  if (!prev) return
  const prevBlocks = new Map()
  for (const s of prev.spaces) for (const b of s.blocks) prevBlocks.set(b.id, b)
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type !== 'tracker') continue
      const was = prevBlocks.get(b.id)
      if (was && was.current < was.target && b.current >= b.target) {
        const meter = document.querySelector(`[data-meter="${b.id}"]`)
        pop(meter)
        celebrate(meter)
      }
    }
  }
}

function renderRail() {
  const rail = $('#rail')
  const on = state.spaces.filter((s) => !s.finished).length >= 6
  rail.classList.toggle('on', on)
  if (!on) return
  const key = state.spaces.map((s) => s.id + s.name + s.finished).join()
  if (rail.dataset.key === key) return
  rail.dataset.key = key
  // A flat list of pointers, nothing more. Areas still exist on the cards;
  // the rail's one job is taking your eye to a card.
  const live = state.spaces.filter((s) => !s.finished)
  rail.innerHTML = live.map((s) => `<a href="#" data-jump="${s.id}">${esc(s.name)}</a>`).join('')
}

let attentionCount = 0

/** Suggestions are an answer to a question you only ask with an empty,
    focused field. At rest they do not exist. */
function renderSuggestions() {
  const box = $('#suggest')
  // ask the DOM, never a flag: any render self-corrects. Autofocus on load
  // does not count as asking; you have to reach for the field yourself.
  const show = reachedFor && document.activeElement === field && !field.value.trim() && !state.captures.length
  const list = show ? (state.suggestions || []).slice(0, attentionCount >= 3 ? 2 : 3) : []
  const key = `${show}|${list.join('|')}`
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.classList.remove('retired')
  box.innerHTML = list
    .map((s, i) => `<button class="chip-btn chip-in" data-suggest="${esc(s)}" style="--d:${i * 70}ms">${esc(s)}</button>`)
    .join('')
}

/** The question already says what shape the answer takes, so the field can
    show it: "type it" tells nobody anything. */
function askHint(q) {
  const t = String(q).toLowerCase()
  if (t.includes('what time') || t.includes('which time')) return 'like 7pm'
  if (t.includes('how much') || t.includes('how many')) return 'like 20'
  if (t.includes('what day') || t.includes('which day') || t.startsWith('when')) return 'like friday'
  if (t.includes('how long')) return 'like 45 min'
  if (t.includes('where')) return 'type it'
  return 'type it'
}

function renderAsk() {
  const box = $('#ask')
  if (!state.ask) {
    if (box.dataset.aid) {
      box.dataset.aid = ''
      const card = box.querySelector('.ask')
      if (card) {
        card.classList.add('out')
        setTimeout(() => (box.innerHTML = ''), 240)
      }
    }
    return
  }
  if (box.dataset.aid === state.ask.id) return
  box.dataset.aid = state.ask.id
  const opts = state.ask.options || []
  // The guesses are guesses. Every question keeps a way to answer it in your
  // own words — offering three wrong options and no way past them is worse
  // than asking nothing at all.
  box.innerHTML = `
    <div class="ask">
      <div class="ask-q">${esc(state.ask.question)}</div>
      ${
        opts.length
          ? `<div class="chips">${opts
              .map((o, i) => `<button class="chip-btn" data-answer="${esc(o)}" style="--d:${i * 45}ms">${esc(o)}</button>`)
              .join('')}</div>`
          : ''
      }
      <div class="ask-reply" style="--d:${opts.length ? opts.length * 45 + 40 : 60}ms">
        <input class="ask-input" placeholder="${opts.length ? 'or say it your way' : askHint(state.ask.question)}"
          autocomplete="off" spellcheck="false" aria-label="Your answer" />
        <button class="skip" data-dismiss>skip</button>
      </div>
    </div>`
  // The caret lands in the answer, which says "this is for you" better than
  // any label could — but never while you are mid-sentence somewhere else.
  const busy = document.activeElement === field || field.value.trim()
  if (!busy && !reduced) {
    setTimeout(() => box.querySelector('.ask-input')?.focus({ preventScroll: true }), 260)
  }
}

/** The page faces the day: what has become relevant rises to the top —
    due and tomorrow's reminders, evening-open streaks, and whatever the
    surfacing sense pinned, each with its reason. */
/** A day the way you would say it inside a week: "fri 14". */
function weekdayOf(iso) {
  const dt = new Date(`${iso}T12:00:00`)
  return `${dt.toLocaleString('en', { weekday: 'short' }).toLowerCase()} ${dt.getDate()}`
}

/** What needs you, in two bands: what is due now, and what is coming.
    The horizon used to stop at tomorrow, so a page holding eight dated
    things could tell you about none of them — everything you had written
    down stayed invisible until the night before, and the only reason
    anything further out ever appeared was that the agent happened to
    guess it was worth surfacing. Dates the page already holds are not a
    matter of judgment. */
function renderToday() {
  const box = $('#today')
  const today = localDay()
  const horizon = localDay(new Date(Date.now() + 7 * 86400000))
  const now = [] // due today, or already past
  const week = [] // dated, ahead of today, inside the next seven days
  const seen = new Set()
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type !== 'reminder' || b.done || !b.when || b.when > horizon) continue
      const w = whenPhrase(b)
      const base = { bid: b.id, sid: s.id, label: b.text, when: `${b.when} ${b.at || '99:99'}` }
      if (b.when <= today) {
        // under a band that already says today, a bare "today" says nothing
        now.push({ ...base, kind: 'reminder', sub: w && w.text !== 'today' ? w.text : '', urgent: !!w?.urgent })
      } else {
        // the day rides where every card row already puts its date — on the
        // right. Putting it in a left column of its own knocked the week's
        // text out of line with today's, which reads as two lists rather
        // than two bands of one.
        week.push({ ...base, kind: 'ahead', sub: b.at ? `${weekdayOf(b.when)}, ${clockOf(b.at)}` : weekdayOf(b.when) })
      }
      seen.add(`${s.id}|${b.text.toLowerCase()}`)
    }
  }
  const items = now
  // the page must not say the same thing twice: an open ask already puts
  // this question on screen, so surfacing it again reads as a flicker where
  // one replaces the other
  const askWords = state.ask ? words(state.ask.question) : null
  const echoesAsk = (label) => {
    if (!askWords || !askWords.size) return false
    const mine = words(label)
    if (!mine.size) return false
    let hit = 0
    for (const w of mine) if (askWords.has(w)) hit++
    return hit / mine.size >= 0.5
  }
  for (const su of state.surfaced || []) {
    if (seen.has(`${su.spaceId}|${su.label.toLowerCase()}`)) continue
    if (echoesAsk(su.label)) continue
    items.push({ kind: 'surfaced', sid: su.spaceId, label: su.label, sub: su.reason })
  }
  // soonest first, so each band reads like a morning
  const bySoonest = (a, x) => (a.when || '').localeCompare(x.when || '')
  now.sort(bySoonest)
  week.sort(bySoonest)
  attentionCount = now.length + week.length
  maybeNotify(now)
  const all = [...now, ...week]
  const key = all.map((i) => i.kind + (i.bid || i.sid) + i.label + i.sub).join()
  if (box.dataset.key === key) return
  // rows animate in only on the strip's first appearance; later reshuffles
  // must not replay entrances
  if (box.dataset.key !== undefined) box.classList.add('norise')
  box.dataset.key = key

  // Today is where you act: it keeps the tick. The week ahead is a look
  // forward, so a row there carries its day instead and opens the card.
  const rowFor = (i) => {
    const sub = i.sub ? `<span class="today-sub ${i.urgent ? 'overdue' : ''}">${esc(i.sub)}</span>` : ''
    if (i.kind === 'ahead') {
      return `<button class="today-row ahead" aria-label="${esc(i.label)}, ${esc(i.sub)}">
          <span class="tick-slot"></span>
          <span class="row-text">${esc(i.label)}</span>${sub}</button>`
    }
    if (i.kind === 'surfaced') {
      return `<button class="today-row plain">
          <span class="tick-slot"></span>
          <span class="row-text">${esc(i.label)}</span>${sub}</button>`
    }
    return `<button class="row today-row" data-block="${i.bid}" role="checkbox" aria-checked="false" aria-label="${esc(i.label)}${i.sub ? `, ${esc(i.sub)}` : ''}">
        <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
        <span class="row-text">${esc(i.label)}</span>${sub}</button>`
  }
  // The overflow count rides on the right of the last row rather than
  // taking a line to itself. A line of its own cost 24px in a region that
  // has none spare, and pushed everything else down for six characters.
  const band = (label, rows, tail) =>
    rows.length
      ? `<div class="band"><span class="band-label">${label}</span><div class="band-body">${rows
          .map(
            (i, n) =>
              `<div class="today-item" data-sid="${i.sid || ''}">${rowFor(i)}${
                tail && n === rows.length - 1 ? `<span class="today-more">${tail}</span>` : ''
              }</div>`
          )
          .join('')}</div></div>`
      : ''

  // How much fits is a question about pixels, and pixels are something the
  // page can measure. Three times now this was a hand-picked number that
  // was right until a font or a margin moved and then quietly clipped the
  // last line. Paint what there is, then drop from the end until it truly
  // fits, counting whatever came off. The stage cannot scroll, so nothing
  // may be left hanging past its edge.
  const paint = (nCount, wCount) => {
    const a = now.slice(0, nCount)
    const b = week.slice(0, wCount)
    const left = now.length - a.length + (week.length - b.length)
    const tail = left > 0 ? `+${left} more` : ''
    box.innerHTML =
      band('today', a, b.length ? '' : tail) + band('this week', b, tail)
  }
  const floor = () => document.querySelector('.moment')?.getBoundingClientRect().bottom ?? 0
  const overflows = () => {
    const edge = floor()
    if (!edge) return false // nothing laid out yet; nothing to measure against
    return [...box.children].some((el) => el.getBoundingClientRect().bottom > edge + 1)
  }

  let nCount = now.length
  let wCount = week.length
  paint(nCount, wCount)
  while (overflows() && nCount + wCount > 0) {
    if (wCount) wCount--
    else nCount--
    paint(nCount, wCount)
  }
}

// ------------------------------------------------------------- year view

let yearOpen = false
let yearShown = null // null = this year; otherwise an archived year object

async function openPastYear(y) {
  try {
    yearShown = await api(`/api/year/${y}`)
    buildYear()
  } catch (err) {
    toast(err.message)
  }
}

function buildYear() {
  const y = yearShown || state.year
  if (!y) return
  const wrap = $('#focus')
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  // Seven rows each reading "quiet" is not information, it is the same
  // word seven times. Empty months that sit together collapse into one
  // band, so the months that actually held something are the page.
  const peak = Math.max(1, ...y.months.map((d) => d.events))
  const openable = !yearShown // an archived year is a reading, not a place
  const rows = []
  let run = []
  const flushQuiet = () => {
    if (!run.length) return
    // a band of several months uses short names so it stays on one line
    const short = (i) => names[i].slice(0, 3)
    const span = run.length === 1 ? names[run[0]] : `${short(run[0])} – ${short(run[run.length - 1])}`
    rows.push(`<div class="ym quiet-band"><div class="ym-name">${span}</div><div class="ym-body"><span class="ym-quiet">quiet</span></div></div>`)
    run = []
  }
  names.forEach((name, m) => {
    const data = y.months[m]
    const future = !yearShown && m > state.year.month
    if (!data.events) {
      if (!future) run.push(m)
      else {
        flushQuiet()
        const last = m === 11 ? `<span class="ym-quiet">in ${Math.ceil((new Date(y.year, 11, 1) - Date.now()) / 86400000)} days</span>` : ''
        rows.push(`<div class="ym future"><div class="ym-name">${name}</div><div class="ym-body">${last}</div></div>`)
      }
      return
    }
    flushQuiet()
    // one honest magnitude instead of up to 28 identical dots
    const pct = Math.max(6, Math.round((data.events / peak) * 100))
    const hl = data.highlights[0] ? `<div class="ym-hl">${esc(trim(data.highlights[0], 74))}</div>` : ''
    rows.push(`
      <${openable ? 'button' : 'div'} class="ym has ${m === y.month ? 'now' : ''}"${openable ? ` data-month="${y.year}-${String(m + 1).padStart(2, '0')}"` : ''}>
        <div class="ym-name">${name}</div>
        <div class="ym-body">
          <div class="ym-bar"><span style="width:${pct}%"></span></div>
          <div class="ym-count">${data.events} moment${data.events === 1 ? '' : 's'}</div>
          ${hl}
        </div>
      </${openable ? 'button' : 'div'}>`)
  })
  flushQuiet()
  const rowsHtml = rows.join('')
  const past = !!yearShown
  const years = state.archivedYears || []
  const nav = [...years, state.year.year]
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
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card year-card">
        <h2 class="space-name">${y.year}</h2>
        ${years.length ? `<div class="year-nav">${nav}</div>` : ''}
        ${rowsHtml}
        ${held}
        ${past ? '' : `<a class="retire-link" href="/api/export.md" download>download the year</a>`}
      </article>
    </div>`
  yearOpen = true
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
  const peak = Math.max(1, ...m.weeks.map((w) => w.count))
  const bars = m.weeks
    .map((w) => `<i style="--h:${Math.max(8, Math.round((w.count / peak) * 100))}%" title="${w.from}–${w.to}: ${w.count}"></i>`)
    .join('')
  const day = (d) => Number(d.slice(8, 10))
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
          ${s.lines
            .map(
              (l) =>
                `<div class="mo-line"><span class="mo-day">${day(l.day)}</span><span class="mo-text">${esc(l.text)}</span>${
                  l.amount != null ? `<span class="mo-amt">${esc(fmtAmount(l.amount, l.unit))}</span>` : ''
                }</div>`
            )
            .join('')}
        </div>`
        )
        .join('')
    : '<div class="ym-quiet">nothing was written down this month</div>'
  $('#focus').innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card month-card">
        <button class="mo-back" data-back-to-year>‹ ${esc(m.month.slice(0, 4))}</button>
        <h2 class="space-name">${esc(m.label)}</h2>
        <div class="mo-weeks" aria-hidden="true">${bars}</div>
        <div class="mo-total">${m.total} moment${m.total === 1 ? '' : 's'}</div>
        ${body}
      </article>
    </div>`
  yearOpen = true
}

// Clean Slate: every year is a new page. The old one is read aloud,
// then each open thread gets its own card and its own yes or no.
// Nothing is forced: it can be parked, revisited, and every answer changed.

let coIndex = 0
const coAnswered = new Map() // id -> kept?  (the dots remember AND navigate)
let coParked = false

const coCount = () => state.carryover?.items.length || 0

function renderCarryover() {
  const co = state.carryover
  const wrap = $('#focus')
  if (!co || coParked) {
    if (wrap.dataset.co) {
      wrap.dataset.co = ''
      wrap.innerHTML = ''
    }
    return
  }
  const key = `${co.fromYear}:${coIndex}`
  if (wrap.dataset.co === key) return
  wrap.dataset.co = key
  const f = co.finished
  const kinds = { list: 'list', tracker: 'goal', reminder: 'reminder', streak: 'habit' }
  const n = co.items.length
  let card

  if (coIndex === 0) {
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
    const it = co.items[coIndex - 1]
    const answered = coAnswered.get(it.id)
    const dots = co.items
      .map((x, i) => {
        const cls = i === coIndex - 1 ? 'now' : coAnswered.has(x.id) ? (coAnswered.get(x.id) ? 'kept' : 'left') : ''
        return `<button class="co-dot ${cls}" data-co-goto="${i + 1}" aria-label="thread ${i + 1}"></button>`
      })
      .join('')
    // past card five, offer the way out
    const bulk =
      n > 5 && coIndex >= 5
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
  const co = state.carryover
  const it = co?.items[coIndex - 1]
  if (!it) return
  coAnswered.set(it.id, yes)
  if (yes && el) {
    pop(el)
    const r = el.getBoundingClientRect()
    bloom(r.left + r.width / 2, r.top + r.height / 2)
  }
  const cardEl = document.querySelector('.co-card')
  cardEl?.classList.add(yes ? 'co-exit-kept' : 'co-exit-left')
  const after = reduced ? 0 : 260
  // move to the next thread that still has no answer
  const nextUnanswered = co.items.findIndex((x, i) => i >= coIndex && !coAnswered.has(x.id))
  setTimeout(() => {
    if (nextUnanswered === -1) coCommit()
    else {
      coIndex = nextUnanswered + 1
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
    state = await api('/api/carryover', ids.length ? { ids } : { dismiss: true })
    coIndex = 0
    coAnswered.clear()
    coParked = false
    setTimeout(() => {
      wrap.dataset.co = ''
      wrap.innerHTML = ''
      spaceEls.forEach(({ el }) => el.remove())
      spaceEls.clear()
      render()
    }, reduced ? 0 : 1600)
  } catch (err) {
    toast(err.message)
  }
}

/** Parked: the page works normally, one quiet line holds the moment. */
function renderCarryoverNudge() {
  const el = $('#co-nudge')
  const show = state.carryover && coParked
  const key = show ? `${state.carryover.fromYear}:${coCount()}` : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  el.innerHTML = show
    ? `<button class="co-nudge-btn" data-co-resume>clean slate waiting · ${coCount()} thread${coCount() === 1 ? '' : 's'} from ${state.carryover.fromYear}</button>`
    : ''
}

// The empty page used to carry a line reading "Write anything. It organizes
// itself." It sat 48px under the writing line and 52px above the cards,
// aligned to neither — a sentence marooned in the gap. The first-run moment
// demonstrates the same claim without spending a word on it.

/** The stage has one job at a time, in this order: what you are writing
    beats a question, a question beats what is settling, and what is
    settling beats the day. Panes cross-fade in place — nothing below the
    stage ever moves, because the stage never changes height. */
function renderStage() {
  const stage = $('#stage')
  if (!stage) return
  const composing = !!field.value.trim()
  const mode = composing
    ? 'composing'
    : state.ask
      ? 'asking'
      : // a mote still in the air keeps the stage open: it flies out of the
        // working line, so the line has to outlive the last capture — and a
        // queued line not yet acknowledged holds it open the same way
        state.captures.length || queuedTexts.length || state.settle.running || flying > 0
        ? 'settling'
        : 'idle'
  if (stage.dataset.mode !== mode) stage.dataset.mode = mode
  const show = { ask: mode === 'asking', settling: mode === 'settling', idle: mode === 'idle' }
  for (const [name, on] of Object.entries(show)) {
    stage.querySelector(`.pane-${name}`)?.classList.toggle('off', !on)
  }
}

function render() {
  renderYearline()
  $('#shell').classList.toggle('settling', state.captures.length > 0)
  const targets = travelTargets()
  const held = new Set([...targets.values(), ...heldSpaces()])
  // one FLIP around the whole pass: anything that grows above the grid
  // (the strip, an ask, chips, activity) glides the cards down instead of
  // snapping them. Measuring around the grid alone missed every one of them.
  withFlip(() => {
    renderSpaces(held)
    renderInbox(targets)
    renderActivity()
    renderToday()
    renderCarryover()
    renderCarryoverNudge()
    renderSuggestions()
    renderAsk()
    renderRail()
  })
  releaseHeld(targets)
  renderStage()
  celebrateDiffs()
  // keep an open focus view current with what the agent changes
  if (focusId) {
    const space = state.spaces.find((s) => s.id === focusId)
    if (!space) closeFocus()
    else if ($('#focus').dataset.u !== space.updatedAt) buildFocus()
  }
  if (booting) {
    // long enough for the last staged card to land, then never again
    setTimeout(() => document.documentElement.classList.remove('booting'), 1400)
    booting = false
  }
  prev = state
}

// ------------------------------------------------------------------ poll

function schedulePoll() {
  clearTimeout(pollTimer)
  const busy = state && (state.captures.length || state.settle.running)
  pollTimer = setTimeout(poll, busy ? 1500 : 10000)
}

async function poll() {
  try {
    state = await api('/api/state')
    render()
  } catch {
    /* transient */
  }
  schedulePoll()
}

// --------------------------------------------------------------- actions

// a question ends in '?' or opens like one: answered, never filed
const QUESTION_RE = /^(how|what|when|where|which|who|why|do i|did i|am i|is there|are there|can i|have i|show me|list )\b/i
const looksLikeQuestion = (t) => t.endsWith('?') || QUESTION_RE.test(t.trim())

/** Questions belong with finding, not with writing: the answer appears in
    the search results, and leaves when the search does. */
async function askThePage(question) {
  const box = $('#search-results')
  box.classList.add('on')
  box.innerHTML = `<div class="search-answer thinking">thinking<span class="a-dots"><i>.</i><i>.</i><i>.</i></span></div>`
  try {
    const { answer } = await api('/api/query', { question })
    box.innerHTML = `<div class="search-answer">${esc(answer)}</div>`
  } catch (err) {
    box.innerHTML = `<div class="search-answer">couldn't answer: ${esc(err.message)}</div>`
  }
}

// Lines the server has not acknowledged yet. They render immediately as
// greyed queue rows, so the beat between Enter and the response never
// shows an empty stage.
const queuedTexts = []

async function submitCapture() {
  const field = $('#capture')
  const text = field.value.trim()
  if (!text) return
  queuedTexts.push(text)
  field.value = ''
  field.style.height = 'auto'
  document.documentElement.style.setProperty('--capture-h', `${field.offsetHeight}px`)
  enterHint.classList.remove('on')
  $('#shell').classList.remove('composing')
  const cw = field.closest('.cwrap')
  cw.classList.remove('big')
  cw.dataset.hint = ''
  localStorage.setItem('dec-files', String(Number(localStorage.getItem('dec-files') || 0) + 1))
  if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('dec-notif-asked')) {
    localStorage.setItem('dec-notif-asked', '1')
    Notification.requestPermission().catch(() => {})
  }
  nextPrompt()
  render() // the queued line appears the same instant the field clears
  try {
    state = await api('/api/capture', { text })
    queuedTexts.splice(queuedTexts.indexOf(text), 1)
    render()
    schedulePoll()
  } catch (e) {
    queuedTexts.splice(queuedTexts.indexOf(text), 1)
    field.value = text
    $('#shell').classList.add('composing') // the draft is back; keep the page quiet
    toast(e.message)
    render()
  }
}

const field = $('#capture')

// The page greets you like a person, not a form — and it knows what time
// it is. Mornings ask about the day ahead; nights ask what got done.
const PROMPTS = {
  morning: ['What do you need to do today?', "What's on your mind?", "What's up?", 'Anything to remember?'],
  day: ["What's up?", "What's new?", "What's on your mind?", 'What are you tracking?', 'Anything to remember?'],
  evening: ['What did you get done?', 'What happened today?', "What's on your mind?", 'Anything to remember?'],
}
function nextPrompt() {
  const h = new Date().getHours()
  const pool = PROMPTS[h < 12 ? 'morning' : h < 17 ? 'day' : 'evening']
  let p
  do {
    p = pool[Math.floor(Math.random() * pool.length)]
  } while (p === field.placeholder && pool.length > 1)
  field.placeholder = p
}
nextPrompt()

field.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitCapture()
  }
})

// answering an open ask: a time, an amount, a date, typed
document.addEventListener('keydown', async (e) => {
  const ai = e.target.closest?.('.ask-input')
  if (!ai || e.key !== 'Enter') return
  e.preventDefault()
  const choice = ai.value.trim()
  if (!choice) return
  ai.disabled = true
  try {
    state = await api('/api/answer', { choice, typed: true })
    render()
    schedulePoll()
  } catch (err) {
    ai.disabled = false
    toast(err.message)
  }
})

// talking to a space from inside its focus view
document.addEventListener('keydown', async (e) => {
  const fc = e.target.closest?.('.focus-capture')
  if (!fc || e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  const text = fc.value.trim()
  if (!text) return
  const hint = state.spaces.find((s) => s.id === focusId)?.name
  fc.value = ''
  try {
    state = await api('/api/capture', { text, hint })
    render()
    schedulePoll()
    toast(`settling into ${hint}`)
  } catch (err) {
    toast(err.message)
  }
})
// what you can say, once, when you want it
const CAN_DO = [
  ['just write it', 'paid rent 2300 · ran 3 miles · call the landlord thursday'],
  ['ask for a shape', "I'd like a progress bar for rent this year"],
  ['ask a question', 'how much have I spent on the car?'],
  ['correct it', 'groceries go under Food, not Housing — it remembers'],
  ['dump everything', 'paste many lines at once; each finds its own home'],
  ['talk to one space', 'open a card and write inside it'],
]
/** The reference, reachable from the gear whenever you want it — rather
    than thrown at a brand new page once and then gone forever. The old
    footer promised "? for this", which was never wired: the writing line
    holds the caret from the moment the page opens, so a bare ? has nowhere
    to land. It lists the keys that actually work now. */
function showIntro() {
  const wrap = $('#focus')
  wrap.dataset.help = '1'
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" role="dialog" aria-modal="true" aria-label="What December can do">
        <h2 class="space-name">What you can say</h2>
        ${CAN_DO.map(([k, v]) => `<div class="can-row"><div class="can-k">${esc(k)}</div><div class="can-v">${esc(v)}</div></div>`).join('')}
        <div class="can-keys">/ to find · ⌘Z to undo · esc to close</div>
      </article>
    </div>`
}

// the page opens quiet; chips answer only once you reach for the field
let reachedFor = false
for (const ev of ['pointerdown', 'keydown']) {
  document.addEventListener(ev, (e) => {
    if (reachedFor) return
    if (e.type === 'pointerdown' && !e.target.closest?.('.capture')) return
    reachedFor = true
    setTimeout(renderSuggestions, 0)
  })
}
field.addEventListener('focus', renderSuggestions)
// let a chip click land before the row goes
field.addEventListener('blur', () => setTimeout(renderSuggestions, 160))

const enterHint = $('#enter-hint')
const hintEligible = () => Number(localStorage.getItem('dec-files') || 0) < 5

const CAPTURE_BASE = 17 // px, the size a short line is written at
const CAPTURE_FLOOR = 14 // it never shrinks past this; past here it scrolls

/** Fit the field to what is in it: grow, then shrink the text to a floor,
    then scroll. Everything is measured at CAPTURE_BASE, never at whatever
    size is currently applied — the old code switched to a smaller font at a
    height threshold, which lowered the height, which switched it back. */
function fitCapture() {
  // it may grow into the space above the grid — which is blank while you
  // compose — but never past it, because the cards do not move
  const gridTop = document.querySelector('.body-grid')?.getBoundingClientRect().top ?? 0
  const fieldTop = field.getBoundingClientRect().top
  const room = Math.max(60, Math.round(gridTop - fieldTop - 28))
  const max = Math.min(room, Math.round(innerHeight * 0.4), 220)
  field.style.fontSize = ''
  field.style.height = 'auto'
  const natural = field.scrollHeight // always at the base size
  let size = CAPTURE_BASE
  if (natural > max) {
    // a linear guess is only an estimate — smaller text also rewraps into
    // fewer lines. Guess high, then step down to the first size that really
    // fits, so no stray scrollbar appears and then disappears again.
    size = Math.max(CAPTURE_FLOOR, Math.ceil(CAPTURE_BASE * (max / natural) * 2) / 2)
    field.style.fontSize = `${size}px`
    field.style.height = 'auto'
    while (size > CAPTURE_FLOOR && field.scrollHeight > max) {
      size = Math.max(CAPTURE_FLOOR, size - 0.5)
      field.style.fontSize = `${size}px`
      field.style.height = 'auto'
    }
  }
  field.style.fontSize = size >= CAPTURE_BASE ? '' : `${size}px`
  // The box is sized from the content measured at the BASE size, never from
  // what it looks like after shrinking. Sizing it from the shrunk text made
  // the field collapse the moment the font stepped down, then grow, then
  // collapse again — the big/small/big wobble.
  const boxH = Math.min(natural, max)
  field.style.height = `${boxH}px`
  field.style.overflowY = field.scrollHeight > boxH + 1 ? 'auto' : 'hidden'
  document.documentElement.style.setProperty('--capture-h', `${field.offsetHeight}px`)
  return natural
}

field.addEventListener('input', () => {
  const natural = fitCapture()
  enterHint.classList.toggle('on', !!field.value.trim() && hintEligible())
  $('#shell').classList.toggle('composing', !!field.value.trim())
  renderStage()
  renderSuggestions()
  // a dump is an object, not a floating wall: contain it past two lines
  // on a phone the field is fixed to the bottom edge: the page must always
  // be able to scroll clear of whatever height it grows to
  const cwrap = field.closest('.cwrap')
  // hysteresis: it becomes a block at 72 and stops being one at 52, so a
  // single character near the boundary cannot toggle the treatment
  const big = cwrap.classList.contains('big') ? natural > 52 : natural > 72
  cwrap.classList.toggle('big', big)
  // Every line files separately, so say so the moment there IS a second
  // line. Tying the notice to the block treatment meant a two-line thought
  // — the most ordinary case there is — was split in two with no warning.
  const n = field.value.split('\n').filter((l) => l.trim()).length
  cwrap.dataset.hint = n > 1 ? `${n} lines · enter files each one` : ''
})

// The page is the input: start typing anywhere and it lands in the capture.
// Space alone still scrolls; with the focus view open, typing lands there.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (e.key.length !== 1) return
  if (e.key === ' ') return
  if (e.key === '/') {
    e.preventDefault()
    searchEl.focus()
    return
  }
  const target = focusId ? document.querySelector('.focus-capture') : field
  target?.focus()
})

document.addEventListener('click', async (e) => {
  // a link in a card is a link: let the browser have it
  if (e.target.closest('a.card-link')) return

  // a long note unfolds
  const note = e.target.closest('.note-text.clamp')
  if (note) {
    note.classList.toggle('open')
    return
  }

  const confirmFin = e.target.closest('[data-confirm-finish]')
  if (confirmFin) {
    const id = confirmFin.dataset.confirmFinish
    $('#focus').dataset.confirm = ''
    $('#focus').innerHTML = ''
    const btn = document.querySelector(`.space[data-sid="${id}"] [data-finish]`)
    if (btn) {
      btn.dataset.confirmed = '1'
      btn.click()
      btn.dataset.confirmed = ''
    }
    return
  }

  const pinBtn = e.target.closest('[data-pin]')
  if (pinBtn) {
    const sp = state.spaces.find((x) => x.id === pinBtn.dataset.pin)
    try {
      const out = await api('/api/pin', { spaceId: pinBtn.dataset.pin, pinned: !sp?.pinned })
      state = out.state
      withFlip(() => render())
      if (focusId) buildFocus()
      toast(out.pinned ? `${out.name} pinned` : `${out.name} unpinned`)
    } catch (err) {
      toast(err.message)
    }
    return
  }
  const finBtn = e.target.closest('[data-finish]')
  if (finBtn) {
    const sp = state.spaces.find((x) => x.id === finBtn.dataset.finish)
    // done work closes instantly; unfinished work has to be looked at first
    if (!sp?.finished && !sp?.complete && !finBtn.dataset.confirmed) {
      askToFinish(sp)
      return
    }
    const el = document.querySelector(`.space[data-sid="${finBtn.dataset.finish}"]`)
    if (!sp?.finished && el && !reduced) celebrateSpace(el)
    try {
      const out = await api('/api/finish', { spaceId: finBtn.dataset.finish, finished: !sp?.finished })
      state = out.state
      if (out.finished) {
        const leaving = spaceEls.get(finBtn.dataset.finish)?.el
        spaceEls.delete(finBtn.dataset.finish)
        closeFocus()
        if (leaving && !reduced) {
          // Pin it where it already is and lift it out of the flow, so the
          // cards behind start closing the gap on the same frame it begins
          // to go. Collapsing it first and reflowing after read as two
          // separate events for something that is one.
          const r = leaving.getBoundingClientRect()
          Object.assign(leaving.style, {
            position: 'fixed',
            left: `${r.left}px`,
            top: `${r.top}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
            margin: '0',
            zIndex: '5',
          })
          document.body.appendChild(leaving) // out of its column entirely
          void leaving.offsetHeight
          leaving.classList.add('leaving')
          withFlip(() => render())
          setTimeout(() => leaving.remove(), 460)
        } else {
          leaving?.remove()
          render()
        }
        return
      }
      render()
      toast(out.finished ? `${out.name} finished` : `${out.name} reopened`)
    } catch (err) {
      toast(err.message)
    }
    return
  }
  const reopen = e.target.closest('[data-reopen]')
  if (reopen) {
    try {
      const out = await api('/api/finish', { spaceId: reopen.dataset.reopen, finished: false })
      state = out.state
      withFlip(() => render())
      toast(`${out.name} reopened`)
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // restoring a space set aside before closing out replaced retiring
  const rest = e.target.closest('[data-restore]')
  if (rest) {
    try {
      const out = await api('/api/restore', { spaceId: rest.dataset.restore })
      state = out.state
      withFlip(() => render())
      toast(`${out.name} is back`)
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // the foot of the page: open one group, which closes any other
  const grp = e.target.closest('[data-grp]')
  if (grp) {
    restOpen = restOpen === grp.dataset.grp ? '' : grp.dataset.grp
    render()
    return
  }

  // wake a resting space
  const wake = e.target.closest('[data-wake]')
  if (wake) {
    awake.add(wake.dataset.wake)
    render()
    return
  }

  // suggestion chip: the sentence files as if typed; the set retires with it
  const sug = e.target.closest('[data-suggest]')
  if (sug) {
    sug.classList.add('picked')
    const text = sug.dataset.suggest
    setTimeout(async () => {
      try {
        state = await api('/api/capture', { text })
        state.suggestions = []
        render()
        schedulePoll()
        api('/api/tool', { name: 'december_suggest', arguments: { suggestions: [] } }).catch(() => {})
      } catch (err) {
        toast(err.message)
      }
    }, 200)
    return
  }

  // answering the ask: the chosen sentence files as if typed
  const ans = e.target.closest('[data-answer]')
  if (ans) {
    ans.classList.add('picked')
    setTimeout(async () => {
      try {
        state = await api('/api/answer', { choice: ans.dataset.answer })
        render()
        schedulePoll()
      } catch (err) {
        toast(err.message)
      }
    }, 240)
    return
  }
  if (e.target.closest('[data-dismiss]')) {
    try {
      state = await api('/api/answer', {})
      render()
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // rail: jump to a space — navigation gets the light touch (border only),
  // never the full agent-touched sheen
  const jump = e.target.closest('[data-jump]')
  if (jump) {
    e.preventDefault()
    jumpToSpace(jump.dataset.jump)
    return
  }

  // closing the focus view: backdrop or wrapper, never the card itself
  if (e.target.dataset?.close !== undefined) {
    closeFocus()
    return
  }

  // a month on the year opens; the month walks back to it
  const mo = e.target.closest('[data-month]')
  if (mo) {
    openMonth(mo.dataset.month)
    return
  }
  if (e.target.closest('[data-back-to-year]')) {
    yearShown = null
    buildYear()
    return
  }

  const yj = e.target.closest('.year-jump')
  if (yj) {
    const yy = Number(yj.dataset.year)
    if (yy === state.year.year) {
      yearShown = null
      buildYear()
    } else openPastYear(yy)
    return
  }

  // Clean Slate: park it, resume it, look back, navigate, answer, bulk out
  if (e.target.closest('[data-co-park]')) {
    coParked = true
    renderCarryover()
    renderCarryoverNudge()
    return
  }
  if (e.target.closest('[data-co-resume]')) {
    coParked = false
    renderCarryover()
    renderCarryoverNudge()
    return
  }
  if (e.target.closest('[data-co-look]')) {
    coParked = true
    renderCarryover()
    renderCarryoverNudge()
    openPastYear(state.carryover.fromYear)
    return
  }
  const goto = e.target.closest('[data-co-goto]')
  if (goto) {
    coIndex = Number(goto.dataset.coGoto)
    renderCarryover()
    return
  }
  if (e.target.closest('[data-co-next]')) {
    if (!coCount()) return coCommit()
    coIndex = 1
    renderCarryover()
    return
  }
  const bulk = e.target.closest('[data-co-all]')
  if (bulk) {
    const keep = bulk.dataset.coAll === 'yes'
    for (const it of state.carryover.items) if (!coAnswered.has(it.id)) coAnswered.set(it.id, keep)
    coCommit()
    return
  }
  if (e.target.closest('[data-co-yes]') || e.target.closest('[data-co-no]')) {
    coAnswer(!!e.target.closest('[data-co-yes]'), e.target.closest('.chip-btn'))
    return
  }

  // An attention row points at a card. Clicking it goes there — it used to
  // unfold chips and a text field in place, which made the strip a second
  // place to work instead of a way into the one that already exists.
  // (The tick still checks the thing off without leaving.)
  const tRow = e.target.closest('#today .today-row')
  if (tRow && !e.target.closest('.tick')) {
    const sid = tRow.closest('.today-item')?.dataset.sid
    if (sid) jumpToSpace(sid)
    return
  }

  // manual check on a list item or reminder — instant, no model.
  // One click, one request: taps during the round trip are ignored.
  // A solo card IS its reminder: the whole card is the checkbox, markup and
  // aria and all. It was left out of this selector, so the most common card
  // on the page could not be ticked off by clicking it — and because it is a
  // button, the open-the-card handler below skipped it too. It did nothing.
  const row = e.target.closest('.row[data-block], .solo[data-block]')
  if (row) {
    if (row.dataset.busy) return
    row.dataset.busy = '1'
    setTimeout(() => delete row.dataset.busy, 600)
    const done = !row.classList.contains('done')
    // the same row may exist in the grid card and the focus card: keep both true
    const item = row.dataset.item ? `[data-item="${row.dataset.item}"]` : ''
    const twins = document.querySelectorAll(
      `.row[data-block="${row.dataset.block}"]${item}, .solo[data-block="${row.dataset.block}"]${item}`
    )
    for (const twin of twins) {
      twin.classList.remove('no-anim')
      twin.classList.toggle('done', done)
      twin.setAttribute('aria-checked', String(done))
    }
    if (done) {
      // a solo card has no tick of its own; the card is the mark
      const mark = row.querySelector('.tick') || row
      pop(mark)
      celebrate(mark)
      // finishing the whole list earns the card a wash
      const blockEl = row.closest('[data-bid]')
      if (blockEl && ![...blockEl.querySelectorAll('.row')].some((r) => !r.classList.contains('done'))) {
        setTimeout(() => washCard(row.closest('.space')), 300)
      }
    }

    // the check counts: a space with exactly one tracker ticks it live —
    // the number beats, the bar glides, and completion earns the moment
    const host = row.closest('.space, .focus-card')
    const sid = host?.dataset.sid
    const isListItem = !!row.dataset.item
    // Checking a repeating reminder does not finish it — the server rolls
    // its clock to the next occurrence. The tick was left painted on, so
    // the page said "handled" and then quietly un-ticked itself later.
    const before = !isListItem && state.spaces.find((s) => s.id === sid)?.blocks.find((b) => b.id === row.dataset.block)
    const rolls = done && before?.type === 'reminder' && !!before.repeat && !!before.when
    if (isListItem && sid) {
      const sp = state.spaces.find((s) => s.id === sid)
      // the same rule the server applies, so the page never paints a number
      // the server is about to disagree with
      const t = trackerCounting(sp, sp?.blocks.find((b) => b.id === row.dataset.block))
      if (t) {
        const prevC = t.current
        t.current = Math.max(0, prevC + (done ? 1 : -1))
        const completedNow = done && prevC < t.target && t.current >= t.target
        for (const bel of document.querySelectorAll(`[data-bid="${t.id}"]`)) {
          const countEl = bel.querySelector('.tracker-count')
          const b = countEl?.querySelector('b')
          if (b) {
            b.textContent = t.current
            bump(countEl)
          }
          const meterBox = bel.querySelector('.meter')
          const span = meterBox?.querySelector('span')
          if (span) span.style.width = `${Math.min(100, Math.round((t.current / t.target) * 100))}%`
          meterBox?.classList.toggle('full', t.current >= t.target)
          countEl?.classList.toggle('full', t.current >= t.target)
          if (completedNow) {
            pop(meterBox)
            celebrate(meterBox)
          }
        }
        if (completedNow) setTimeout(() => washCard(spaceEls.get(sid)?.el), 250)
      }
    }

    try {
      state = await api('/api/check', { blockId: row.dataset.block, itemId: row.dataset.item, done })
      const known = sid && spaceEls.get(sid)
      if (rolls) {
        // say what actually happened: it came round again, on this date
        const now = state.spaces.find((s) => s.id === sid)?.blocks.find((b) => b.id === row.dataset.block)
        prev = state
        resortCard(sid)
        if (focusId === sid) buildFocus()
        const w = now && whenPhrase(now)
        toast(w ? `done · back ${w.text}` : 'done')
        return
      }
      // adopt silently; the row is already painted
      if (known) known.updatedAt = state.spaces.find((s) => s.id === sid)?.updatedAt
      prev = state
      // after the moment, the finished item rests: the card re-sorts it
      // into the done tail with a glide (no sheen; this was your hand)
      if (isListItem && sid) {
        setTimeout(() => {
          resortCard(sid)
          if (focusId === sid) buildFocus()
        }, done ? 900 : 400)
      }
    } catch (err) {
      toast(err.message)
    }
    return
  }

  if (e.target.closest('#undo-btn')) {
    const btn = e.target.closest('#undo-btn')
    if (btn.disabled) return
    btn.disabled = true
    try {
      state = await api('/api/undo', {})
      spaceEls.forEach(({ el }) => el.remove())
      spaceEls.clear()
      render()
      toast('undone')
    } catch (err) {
      toast(err.message)
    }
    return
  }

  if (e.target.closest('.retry')) {
    try {
      await api('/api/settle', {})
      state.settle.lastError = null
      render()
      toast('settling')
      schedulePoll()
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // anywhere quiet on a grid card: open the focused view — but selecting
  // text to copy is reading, not clicking
  const card = e.target.closest('#spaces .space')
  if (card && card.dataset.sid && !e.target.closest('button, a') && !window.getSelection()?.toString()) {
    focusId = card.dataset.sid
    buildFocus()
  }
})

// a focused card or the dateline opens with Enter or Space
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const card = e.target.closest?.('#spaces .space')
  if (card?.dataset.sid) {
    e.preventDefault()
    focusId = card.dataset.sid
    buildFocus()
    return
  }
  if (e.target === $('#dateline')) {
    e.preventDefault()
    yearOpen ? closeFocus() : buildYear()
  }
})

document.addEventListener('keydown', async (e) => {
  // the receipt is gone; undo lives on the keyboard
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && (state?.canUndoManual || state?.canUndo) && !e.target.closest?.('textarea, input, [contenteditable="true"]')) {
    e.preventDefault()
    try {
      // your own last action first; the agent's batch only when you have none
      const out = await api(state.canUndoManual ? '/api/undo-mine' : '/api/undo', {})
      state = out.state || out
      spaceEls.forEach(({ el }) => el.remove())
      spaceEls.clear()
      render()
      toast('undone')
    } catch (err) {
      toast(err.message)
    }
    return
  }
  // Escape closes whatever is over the page — a focused card, the year, the
  // intro, the close-out question. It used to answer only to a focused card,
  // so the one dialog that asks you something was the one you could not
  // dismiss with the key everyone reaches for. Clean Slate keeps its own.
  const carryoverUp = !!(state?.carryover && !coParked && document.querySelector('.co-card'))
  if (e.key === 'Escape' && !carryoverUp && $('#focus').innerHTML && !document.querySelector('[contenteditable="true"]')) {
    closeFocus()
  }
  // the ceremony answers to the keyboard, and never traps you
  if (state?.carryover && !coParked && document.querySelector('.co-card')) {
    if (e.key === 'Escape') {
      coParked = true
      renderCarryover()
      renderCarryoverNudge()
    }
    if (coIndex > 0 && (e.key === 'y' || e.key === 'n')) {
      coAnswer(e.key === 'y', document.querySelector(e.key === 'y' ? '[data-co-yes]' : '[data-co-no]'))
    }
  }
})

// ---------------------------------------------------- fix it yourself
// Double-click any words you own and change them in place. Enter or a
// click away saves; Esc walks away.

document.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.row-text, .note-text, .space-name, .block-title, .ledger-label')
  if (!el || el.closest('.year-card, .demo-card, .ghost, #today')) return
  if (el.isContentEditable) return
  const row = el.closest('.row[data-block]')
  const card = el.closest('.space, .focus-card')
  const payload = el.classList.contains('space-name')
    ? { spaceId: card?.dataset.sid }
    : el.classList.contains('block-title')
      ? { blockId: el.closest('[data-bid]')?.dataset.bid, field: 'title' }
      : el.classList.contains('ledger-label')
        ? { blockId: el.closest('[data-bid]')?.dataset.bid, itemId: el.closest('.ledger-entry')?.dataset.item, field: 'ledger_label' }
    : el.classList.contains('note-text')
      ? { blockId: el.closest('[data-bid]')?.dataset.bid }
      : { blockId: row?.dataset.block, itemId: row?.dataset.item || undefined }
  if (!payload.spaceId && !payload.blockId) return
  const original = el.textContent
  el.contentEditable = 'true'
  el.classList.add('editing')
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)

  const finish = async (save) => {
    el.contentEditable = 'false'
    el.classList.remove('editing')
    el.removeEventListener('keydown', onKey)
    el.removeEventListener('blur', onBlur)
    const text = el.textContent.trim()
    if (!save || !text || text === original.trim()) {
      el.textContent = original
      return
    }
    try {
      state = await api('/api/edit', { ...payload, text })
      markEdited(el)
      const sid = card?.dataset.sid
      const known = sid && spaceEls.get(sid)
      if (known) known.updatedAt = state.spaces.find((s) => s.id === sid)?.updatedAt || known.updatedAt
      prev = state
    } catch (err) {
      el.textContent = original
      toast(err.message)
    }
  }
  const onKey = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      finish(true)
    }
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      finish(false)
    }
  }
  const onBlur = () => finish(true)
  el.addEventListener('keydown', onKey)
  el.addEventListener('blur', onBlur)
})

/** The page's copy of the server's rule (lib/core.mjs trackerCounting): a
    tracker moves with a list only when it is counting that exact list. */
function trackerCounting(space, block) {
  if (!space || !block || block.type !== 'list') return null
  const trackers = space.blocks.filter((b) => b.type === 'tracker')
  const lists = space.blocks.filter((b) => b.type === 'list')
  if (trackers.length !== 1 || lists.length !== 1 || lists[0].id !== block.id) return null
  return trackers[0].target === block.items.length ? trackers[0] : null
}

function jumpToSpace(sid) {
  let el = document.querySelector(`.space[data-sid="${sid}"]`)
  if (!el) {
    // a resting space wakes when something points at it
    awake.add(sid)
    render()
    el = document.querySelector(`.space[data-sid="${sid}"]`)
  }
  if (el) {
    // Smooth scrolling is not guaranteed to do anything. In some browsers
    // and embeddings it is simply a no-op, and then the card lights up
    // while the page never moves — the jump reads as broken. Ask for it,
    // then check, and land it plainly if nothing happened.
    const from = window.scrollY
    const want = Math.max(0, from + el.getBoundingClientRect().top - 24)
    window.scrollTo({ top: want, behavior: reduced ? 'auto' : 'smooth' })
    if (!reduced) {
      setTimeout(() => {
        if (Math.abs(window.scrollY - from) < 4 && Math.abs(want - from) > 8) {
          window.scrollTo({ top: want, behavior: 'auto' })
        }
      }, 260)
    }
    el.classList.remove('noted')
    void el.offsetWidth
    el.classList.add('noted')
    setTimeout(() => el.classList.remove('noted'), 1400)
  }
}

// ------------------------------------------------------------- the search
// One quiet field in the header: a few letters, everything answers.

const searchEl = $('#search')
const resultsEl = $('#search-results')

function searchEverything(q) {
  q = q.toLowerCase()
  const out = []
  const add = (label, space, sid) => {
    if (out.length < 8 && label.toLowerCase().includes(q)) out.push({ label, space, sid })
  }
  for (const s of state.spaces) {
    add(s.name, '', s.id)
    for (const b of s.blocks) {
      if (b.title) add(b.title, s.name, s.id)
      if (b.type === 'list') for (const i of b.items) add(i.text, s.name, s.id)
      if (b.type === 'reminder') add(b.text, s.name, s.id)
      if (b.type === 'note') {
        const at = b.text.toLowerCase().indexOf(q)
        if (at >= 0 && out.length < 8) out.push({ label: `…${b.text.slice(Math.max(0, at - 12), at + 28)}…`, space: s.name, sid: s.id })
      }
      if (b.type === 'ledger') for (const en of b.entries) add(en.label, s.name, s.id)
    }
  }
  return out
}

function closeSearch() {
  resultsEl.innerHTML = ''
  resultsEl.classList.remove('on')
}

searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim()
  if (q.length < 2) return closeSearch()
  if (resultsEl.querySelector('.search-answer')) resultsEl.innerHTML = ''
  const hits = searchEverything(q)
  resultsEl.innerHTML = hits.length
    ? hits
        .map((h, i) => `<button class="search-hit" data-hit="${h.sid}" style="--d:${Math.min(i * 28, 140)}ms"><span class="sh-label">${esc(h.label.slice(0, 44))}</span>${h.space ? `<span class="sh-space">${esc(h.space)}</span>` : ''}</button>`)
        .join('')
    : '<div class="search-none">nothing found</div>'
  resultsEl.classList.add('on')
})

searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchEl.value = ''
    closeSearch()
    searchEl.blur()
  }
  if (e.key === 'Enter') {
    const q = searchEl.value.trim()
    // a question is asked; a word is looked up
    if (looksLikeQuestion(q) && q.length > 6) {
      askThePage(q)
      searchEl.value = ''
      return
    }
    const first = resultsEl.querySelector('.search-hit')
    if (first) {
      jumpToSpace(first.dataset.hit)
      searchEl.value = ''
      closeSearch()
      searchEl.blur()
    }
  }
})

document.addEventListener('click', (e) => {
  const hit = e.target.closest('.search-hit')
  if (hit) {
    jumpToSpace(hit.dataset.hit)
    searchEl.value = ''
    closeSearch()
    return
  }
  if (!e.target.closest('.search-wrap')) closeSearch()
})

// --------------------------------------------------------- notifications
// A due date only matters if it reaches you. Quiet, deduped per day.

function maybeNotify(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const today = localDay()
  let seen
  try {
    seen = JSON.parse(localStorage.getItem('dec-notified') || '{}')
  } catch {
    seen = {}
  }
  if (seen.date !== today) seen = { date: today, keys: [] }
  for (const i of items) {
    const key = `${i.label}|${i.sub}`
    if (seen.keys.includes(key)) continue
    seen.keys.push(key)
    try {
      new Notification('December', { body: i.sub ? `${i.label} · ${i.sub}` : i.label, silent: true, tag: key })
    } catch {}
  }
  localStorage.setItem('dec-notified', JSON.stringify(seen))
}

// ------------------------------------------------------------- the gear
// Engine + model live server-side (data/settings.json): they belong to
// the settle pass, not this browser.

const settingsPop = $('#settings-pop')
const settingsBackdrop = $('#settings-backdrop')
let currentSettings = null
let currentConnections = null

const connectionClients = [
  { key: 'claude-code', label: 'Claude Code', logo: 'claude-code.png', guidance: 'Install Claude Code and sign in once.' },
  { key: 'claude-desktop', label: 'Claude Desktop', logo: 'claude.png', guidance: 'Open Claude Desktop once so its local config exists.' },
  { key: 'codex', label: 'Codex', logo: 'codex.png', guidance: 'Install Codex and finish its sign-in flow.' },
  { key: 'cursor', label: 'Cursor', logo: 'cursor.png', guidance: 'Open Cursor once so its local config exists.' },
]

function connectionCopy(status) {
  if (!status) return { line: 'checking this machine', action: '', disabled: true }
  if (status.state === 'connected') return { line: 'connected to this December', action: 'reconnect', disabled: false }
  if (status.state === 'available') return { line: 'available on this machine', action: 'connect', disabled: false }
  if (status.state === 'error') return { line: status.detail || 'connection needs attention', action: 'reconnect', disabled: false }
  return { line: 'not installed', action: '', disabled: true }
}

function providerMark(client) {
  return `<img class="provider-logo" src="/providers/${client.logo}" alt="" />`
}

function renderConnectionSettings() {
  const target = $('#connection-list')
  target.innerHTML = connectionClients.map((client) => {
    const status = currentConnections?.[client.key]
    const copy = connectionCopy(status)
    const guidance = status?.state === 'not-installed' ? client.guidance : copy.line
    return `<div class="connection-row ${status?.state || 'checking'}">
      ${providerMark(client)}
      <span class="connection-name"><b>${client.label}</b><small>${esc(guidance)}</small></span>
      ${copy.action ? `<button type="button" data-connect-client="${client.key}">${copy.action}</button>` : '<span class="connection-state">' + (status?.state === 'connected' ? '&#10003;' : '') + '</span>'}
    </div>`
  }).join('') + `<div class="connection-row unavailable">
    ${providerMark({ logo: 'chatgpt.png' })}
    <span class="connection-name"><b>ChatGPT</b><small>needs a remote connection — arrives with sync</small></span>
    <button type="button" disabled>later</button>
  </div>`
}

async function loadConnections() {
  try {
    currentConnections = (await api('/api/connect')).clients
    renderConnectionSettings()
    renderOnboarding()
  } catch (error) {
    currentConnections = null
    renderConnectionSettings()
    if (!onboarding.hidden) $('#onboarding-note').textContent = error.message
  }
}

async function connectClient(client, button) {
  if (button) {
    button.disabled = true
    button.textContent = 'connecting…'
  }
  try {
    const result = await api('/api/connect', { client })
    const label = connectionClients.find((item) => item.key === client)?.label || client
    toast(result.status?.state === 'connected' ? `${label} connected` : (result.status?.detail || `${label} needs attention`))
  } catch (error) {
    toast(error.message)
  } finally {
    await loadConnections()
  }
}

const settingsFocusables = () =>
  [...settingsPop.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]

function closeSettings(restoreFocus = true) {
  if (settingsPop.hidden) return
  settingsPop.hidden = true
  settingsBackdrop.hidden = true
  document.documentElement.classList.remove('modal-open')
  const trigger = $('#gear-toggle')
  trigger.setAttribute('aria-expanded', 'false')
  if (restoreFocus) trigger.focus()
}

function renderSettings(s) {
  currentSettings = s
  $('#about-version').textContent = s.version ? `v${s.version}` : ''
  const seg = $('#engine-seg')
  seg.innerHTML = ''
  for (const [key, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.role = 'radio'
    b.textContent = label
    b.setAttribute('aria-checked', String(s.engine === key))
    b.disabled = !s.engines[key]
    b.title = s.engines[key] ? '' : `${label} CLI not found on this machine`
    b.addEventListener('click', () => saveSettings({ engine: key }))
    seg.appendChild(b)
  }
  const input = $('#model-input')
  if (document.activeElement !== input) input.value = s.model || ''
  for (const key of ['claude', 'codex']) {
    const pathInput = $(`#${key}-path`)
    if (document.activeElement !== pathInput) pathInput.value = s.enginePaths?.[key] || ''
    pathInput.placeholder = s.resolvedEngines?.[key] || 'auto-detect'
    pathInput.title = s.resolvedEngines?.[key] || ''
  }
  renderConnectionSettings()
  renderOnboarding()
}

async function saveSettings(patch) {
  try {
    renderSettings(await api('/api/settings', patch))
    toast('settings saved')
  } catch (e) {
    toast(e.message)
  }
}

$('#gear-toggle').addEventListener('click', async () => {
  const open = settingsPop.hidden
  if (!open) return closeSettings()
  settingsBackdrop.hidden = false
  settingsPop.hidden = false
  document.documentElement.classList.add('modal-open')
  $('#gear-toggle').setAttribute('aria-expanded', 'true')
  try {
    renderSettings(await api('/api/settings'))
    await loadConnections()
  } catch (e) {
    toast(e.message)
  }
  const first = settingsPop.querySelector('#theme-seg button[aria-checked="true"]') || settingsFocusables()[0]
  first?.focus()
})

// the reference has a permanent home now, instead of one appearance on a
// page you had not written anything on yet
$('#open-can').addEventListener('click', () => {
  closeSettings(false)
  showIntro()
})

$('#model-input').addEventListener('change', (e) => saveSettings({ model: e.target.value }))
$('#model-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur()
})

for (const key of ['claude', 'codex']) {
  const input = $(`#${key}-path`)
  input.addEventListener('change', (e) => saveSettings({ enginePaths: { [key]: e.target.value } }))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur()
  })
}

$('#connection-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-connect-client]')
  if (button) connectClient(button.dataset.connectClient, button)
})

document.addEventListener('mousedown', (e) => {
  if (!settingsPop.hidden && e.target === settingsBackdrop) closeSettings()
})

document.addEventListener('keydown', (e) => {
  if (settingsPop.hidden) return
  if (e.key === 'Escape') return closeSettings()
  if (e.key !== 'Tab') return
  const items = settingsFocusables()
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
})

// --------------------------------------------------------- drag and drop
// A dropped document becomes a capture pointing at the saved file; the
// settle agent reads it like anything else you wrote.

const dropzone = $('#dropzone')
let dragDepth = 0

document.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return
  e.preventDefault()
  dragDepth++
  dropzone.hidden = false
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('dragleave', (e) => {
  e.preventDefault()
  if (--dragDepth <= 0) {
    dragDepth = 0
    dropzone.hidden = true
  }
})
document.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  dropzone.hidden = true
  const files = [...e.dataTransfer.files].slice(0, 5)
  for (const file of files) {
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'upload failed')
      state = data
      render()
      toast(`reading ${file.name}`)
    } catch (err) {
      toast(err.message)
    }
  }
})

/** Appearance lives in settings now, as a choice rather than a toggle: the
    corner stays for finding things. */
function markTheme() {
  const now = document.documentElement.dataset.theme || 'light'
  for (const b of $('#theme-seg').querySelectorAll('[data-theme-set]')) {
    b.setAttribute('aria-checked', String(b.dataset.themeSet === now))
  }
}

$('#theme-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-set]')
  if (!btn) return
  const root = document.documentElement
  const next = btn.dataset.themeSet
  if (root.dataset.theme === next) return
  root.classList.add('theming')
  root.dataset.theme = next
  localStorage.setItem('dec-theme', next)
  markTheme()
  setTimeout(() => root.classList.remove('theming'), 320)
})
markTheme()

// ------------------------------------------------------------------ boot

$('#dateline').addEventListener('click', () => (yearOpen ? closeFocus() : buildYear()))

const launchParams = new URLSearchParams(location.search)
const shouldOnboard = launchParams.has('firstrun') || (launchParams.has('desktop') && !localStorage.getItem('dec-onboarding'))
const onboarding = $('#onboarding')

function renderOnboarding() {
  if (onboarding.hidden) return
  $('#onboarding-engines').innerHTML = connectionClients.map((client) => {
    const status = currentConnections?.[client.key]
    const copy = connectionCopy(status)
    const guidance = status?.state === 'not-installed' ? client.guidance : copy.line
    const connected = status?.state === 'connected'
    return `<button class="onboarding-engine ${connected ? 'connected' : ''}" data-connect-client="${copy.action ? client.key : ''}" ${copy.disabled || connected ? 'disabled' : ''}>
      ${providerMark(client)}
      <span class="provider-copy"><b>${client.label}</b><small>${esc(guidance)}</small></span>
      <span class="provider-action">${connected ? '&#10003;' : copy.action}</span>
    </button>`
  }).join('') + `<button class="onboarding-engine unavailable" disabled>
    ${providerMark({ logo: 'chatgpt.png' })}
    <span class="provider-copy"><b>ChatGPT</b><small>needs a remote connection — arrives with sync</small></span>
    <span class="provider-action">later</span>
  </button>`
  const connected = Object.values(currentConnections || {}).filter((status) => status.state === 'connected').length
  $('#onboarding-note').textContent = connected
    ? `${connected} assistant${connected === 1 ? '' : 's'} connected. You can reconnect any time from the gear.`
    : 'You can keep writing without a connection. December saves every capture locally.'
}

$('#onboarding-engines').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-connect-client]')
  if (button?.dataset.connectClient) await connectClient(button.dataset.connectClient, button)
})

$('#onboarding-close').addEventListener('click', () => {
  onboarding.hidden = true
  localStorage.setItem('dec-onboarding', '1')
  launchParams.delete('firstrun')
  history.replaceState(null, '', `${location.pathname}${launchParams.size ? `?${launchParams}` : ''}`)
  $('#capture').focus()
})

// ----------------------------------------------------- the first-run demo
// Once, on a truly empty page: the page performs its own pitch, then
// hands you the pen. Any key or click skips it.

async function firstRunDemo() {
  // neither an onboarding run nor a year with carryover waiting gets the demo
  if (shouldOnboard || localStorage.getItem('dec-demo') || state.spaces.length || state.captures.length || state.carryover) return
  localStorage.setItem('dec-demo', '1') // once, ever — even if it is cut short
  let alive = true
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // the field is driven the way a person drives it, so the stage clears
  // itself while the sentence is being written, exactly as it will for you
  const put = (v) => {
    field.value = v
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const stop = () => {
    if (!alive) return
    alive = false
    put('')
    document.querySelector('.demo-card')?.remove()
    field.focus()
  }
  window.addEventListener('keydown', stop, { once: true })
  window.addEventListener('mousedown', stop, { once: true })

  await wait(600)
  if (!alive) return
  for (const ch of 'paid rent this month, $2300') {
    if (!alive) return
    put(field.value + ch)
    await wait(38)
  }
  await wait(480)
  if (!alive) return

  // the sentence becomes the card: it lands in the column a real one would,
  // and rises with the same entrance every real card uses
  put('')
  const card = document.createElement('article')
  card.className = 'space fresh demo-card'
  card.innerHTML = `
    <h2 class="space-name">Housing</h2>
    <div class="block hero">
      <div class="block-title">Rent</div>
      <div class="ledger-total">$2,300</div>
      <div class="ledger-entry"><span>This month's rent</span><span>$2,300</span></div>
    </div>`
  ;($('#spaces .col') || $('#spaces')).appendChild(card)
  await wait(2100)
  if (!alive) return
  card.classList.add('ghost-out')
  await wait(380)
  card.remove()
  alive = false
  field.focus()
}

// the day moves even when nothing happens: re-read the clock each minute
setInterval(() => {
  if (state && !document.hidden) render()
}, 60000)

// coming back to the tab: refresh immediately (the date may have rolled,
// the agent may have worked) instead of waiting out a throttled poll
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    clearTimeout(pollTimer)
    poll()
  }
})

async function boot() {
  try {
    state = await api('/api/state')
    render()
    if (shouldOnboard) {
      onboarding.hidden = false
      renderSettings(await api('/api/settings'))
      await loadConnections()
    }
    if (launchParams.has('capture')) $('#capture').focus()
    schedulePoll()
    // A brand new page is not told what this is — it is shown, once. The
    // page writes a real sentence, the sentence becomes a card, both clear,
    // and the pen is yours. It used to open with a modal listing six things
    // you could say, then perform the demo on the NEXT visit: two first
    // impressions, the wordier one first. Motion is the whole argument
    // here, so a reader who has asked for none gets the list instead.
    if (!state.spaces.length && !state.captures.length && !state.carryover) {
      if (!reduced) firstRunDemo()
      else if (!localStorage.getItem('dec-intro')) {
        localStorage.setItem('dec-intro', '1')
        setTimeout(showIntro, 400)
      }
    }
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:40px;font-family:monospace">could not load: ${e.message}</pre>`
  }
}

boot()
