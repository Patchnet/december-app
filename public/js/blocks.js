import { esc, localDay, fmtAmount, page } from './session.js'
import { previewHTML, previewNoteText, weatherScene } from './preview-model.js'
import { mediaListMarkup } from './list-preview.js'

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

// provenance: a change can show the words it came from. data-src, not
// title — the OS tooltip is the one piece of chrome the page cannot
// dress; receipt.js draws this in the page's own hand instead.
const srcTitle = (src) => {
  const t = src && page.state.sources?.[src]
  return t ? ` data-src="${esc(t)}"` : ''
}

const rowMarkup = (b, i) => `
      <button class="row ${i.done ? 'done no-anim' : ''}" data-block="${b.id}" data-item="${i.id}"
        role="checkbox" aria-checked="${i.done}" aria-label="${esc(i.text)}"${srcTitle(i.src)}>
        <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
        <span class="row-text">${linkify(i.shown ?? i.text)}</span>
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
    const prevDay = localDay(new Date(new Date(`${d}T12:00`).getTime() - 86400000))
    if (set.has(prevDay)) continue // only count from the start of a run
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
    const rows = months
      .map(([m, es], i) => {
        const sum = sums[i]
        // "september", and the year only when it is not this one — "sep 26"
        // read as a date
        const thisYear = String(new Date().getFullYear())
        const name = `${new Date(`${m}-15T12:00:00`).toLocaleString('en', { month: 'long' }).toLowerCase()}${m.slice(0, 4) === thisYear ? '' : ` ${m.slice(0, 4)}`}`
        return `
        <div class="lm">
          <div class="lm-head">
            <span class="lm-name">${name}</span>
            <span class="lm-sum">${fmtAmount(sum, b.unit)}</span>
          </div>
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
    const whole = Number.isInteger(b.current) && Number.isInteger(b.target)
    const diff = whole ? Math.round(b.current - expected) : Math.round((b.current - expected) * 10) / 10
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
    ${open.length === 0 && done.length === 0 ? '<div class="done-more">No items yet</div>' : ''}
    ${
      done.length
        ? `<details class="done-fold"><summary>${done.length} done</summary>${done.map((i) => rowMarkup(b, i)).join('')}</details>`
        : ''
    }`
  },
}

// ------------------------------------------------------------- the fold
// A compact card past eight open rows shows six and says how many more:
// the card itself is the door to the rest. Heavy cards stop owning a
// column; the opened card is where the whole list lives.
const FOLD_AT = 8
const FOLD_TO = 6
const fold = { left: Infinity, hidden: 0 }
const openRowsOf = (blocks) => blocks.reduce((n, b) => n + (b.type === 'list' ? b.items.filter((i) => !i.done).length : b.type === 'reminder' && !b.done ? 1 : 0), 0)

const RENDER = {
  // Open work leads; completed rows can be inspected in place or in focus.
  list: (b, full, _hero, besideImage = false) => {
    const open = b.items.filter((i) => !i.done)
    const done = b.items.filter((i) => i.done).sort((a, z) => (z.doneAt || '').localeCompare(a.doneAt || ''))
    if (!full && open.length === 0) return ''
    let shown = [...open, ...(full ? done : [])]
    // a list beside an image keeps its own fold (it opens in place)
    if (!full && !besideImage && shown.length > fold.left) {
      fold.hidden += shown.length - Math.max(0, fold.left)
      shown = shown.slice(0, Math.max(0, fold.left))
      if (!shown.length && !done.length) return ''
    }
    if (!full && !besideImage) fold.left -= shown.length
    // The count is a door, not a dead label. Reuse native list disclosure
    // state so a repaint preserves the person's place without changing data.
    const completedKey = `completed:${b.id}`
    const pile = !full && done.length ? `<details class="list-preview completed-list" data-list-preview="${esc(completedKey)}"${page.expandedLists.has(completedKey) ? ' open' : ''}>
      <summary class="done-count"><span>${done.length} completed</span><span class="list-chevron" aria-hidden="true">⌄</span></summary>
      <div class="completed-rows">${done.map(i => rowMarkup(b, i)).join('')}</div>
    </details>` : ''
    return `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    ${!full && besideImage ? mediaListMarkup(shown.map(i => rowMarkup(b, i)), b.id, page.expandedLists.has(b.id)) : shown.map((i) => rowMarkup(b, i)).join('')}${pile}`
  },

  tracker: (b, full_, hero) => {
    const pct = Math.min(100, Math.round((b.current / b.target) * 100))
    const full = b.current >= b.target
    // A small whole target counts better than it fills: twelve dots say
    // "none yet" where a bar at 0% just looks broken.
    // past a dozen the dots stop being a count and become a chart
    const countable =
      Number.isInteger(b.current) && Number.isInteger(b.target) && b.target <= 12 && b.target > 1
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

  note: (b, full, _hero, _besideImage, weatherHeaderId) => {
    // a forecast's note that only names the place says nothing the reading
    // above it does not; the words stay in storage and in the opened card
    const placeOnly = !full && b.preview?.kind === 'weather' && /^(?:track (?:the )?)?weather( forecast)?( (?:for|in|at) .{0,60})?\.?$/i.test(b.text.trim())
    const text = placeOnly ? '' : previewNoteText(b.text, b.preview, full)
    return `
    ${previewHTML(b.preview, Date.now(), b.id === weatherHeaderId)}
    ${b.title && !/^notes?$/i.test(b.title.trim()) ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="note-text ${!full && b.text.length > 280 ? 'clamp' : ''}">${linkify(text)}</div>`
  },

  reminder: (b, full) => {
    if (!full && b.done && !b.repeat) return ''
    if (!full && !b.done && fold.left <= 0) { fold.hidden++; return '' }
    if (!full && !b.done) fold.left--
    const w = whenPhrase(b)
    // the facts that place the row — where, when, how often — sit together
    // on its right in the small size, the way the stage's rows carry theirs;
    // the text keeps the left and is never squeezed into a column of words
    const place = b.entities?.find((entity) => entity.type === 'place')
    const placeChip = place ? `<span class="place-chip">${esc(place.name)}</span>` : ''
    // a thing that is done is not overdue, whatever its date says
    // a row with no day keeps the slot its day would occupy, empty and silent
    // until the hand is over the row: clearing a date must not take away the
    // only way to give it another, and nothing may shift when it appears
    const when = w
      ? `<span class="when-sub ${w.urgent && !b.done ? 'urgent' : ''}" data-when="${esc(b.when || '')}" title="Change the day">${esc(w.text)}${b.repeat ? ` · ${b.repeat}` : ''}</span>`
      : b.repeat
        ? `<span class="when-sub">${b.repeat}</span>`
        : b.done ? '' : '<span class="when-sub when-none" data-when="">add a day</span>'
    const meta = placeChip || when ? `<span class="row-meta">${placeChip}${when}</span>` : ''
    return `
    <button class="row reminder ${b.done ? 'done no-anim' : ''}" data-block="${b.id}"
      role="checkbox" aria-checked="${b.done}" aria-label="${esc(b.text)}">
      <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
      <span class="row-text">${linkify(b.shown ?? b.text)}</span>${meta}
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

function archiveReady(space) {
  return !space.finished && space.role === 'do' && !!space.complete
}

function soloOf(space) {
  if (space.blocks.length !== 1 || space.blocks[0].preview) return null
  const b = space.blocks[0]
  const solo = b.type === 'reminder' && !(b.done && !b.repeat)
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


/** A row that opens with the card's own name says it twice: "PUP 4024 quiz
    due" under PUP 4024 is "Quiz due". The whole text stays in the label
    and in storage; only the line drops the repeat. */
function shortOfName(text, spaceName) {
  const t = String(text || '')
  const n = String(spaceName || '').trim()
  if (!n || t.length <= n.length + 2 || !t.toLowerCase().startsWith(n.toLowerCase())) return t
  const rest = t.slice(n.length).replace(/^[\s:—–-]+/, '')
  if (!rest || /^[a-z]/i.test(rest) === false) return t
  return rest[0].toUpperCase() + rest.slice(1)
}

/** A row that ends by naming the card's place — "Proctored exam 1 — Testing
    Center" under a card tagged FSU Testing Center — drops the repeat. */
function shortOfPlace(text, place) {
  const t = String(text || '')
  if (!place) return t
  const m = t.match(/^(.*?\S)\s*(?:[—–-]|\bat\b|@)\s*([^—–]+?)\s*$/)
  if (!m) return t
  const tail = m[2].trim().toLowerCase()
  if (tail.length < 4 || !place.toLowerCase().includes(tail)) return t
  return m[1]
}

/** A block's title earns its line only when it says something the card's
    name does not: "Up next" under Reading, "Oven" under Kitchen. "Weather
    to-dos" under Weather, "Financial aid to-dos" under FSU financial aid,
    and any bare "tasks" / "to-dos" / "list" / "notes" say nothing. */
const GENERIC = new Set(['todo', 'todos', 'to-do', 'to-dos', 'task', 'tasks', 'list', 'lists', 'note', 'notes', 'item', 'items', 'thing', 'things'])
function titleEarned(title, spaceName) {
  const t = String(title || '').trim()
  if (!t) return false
  const own = [...words(t.replace(/-/g, ''))].filter((w) => !GENERIC.has(w))
  if (!own.length) return false
  const name = [...words(spaceName)]
  const covered = (w) => name.some((n) => n.startsWith(w.slice(0, 4)) || w.startsWith(n.slice(0, 4)))
  return own.some((w) => !covered(w))
}

// ------------------------------------------------------------ card kinds
// A card has a shape when the page can tell what it is: a course by its
// name, money by its ledger. The engine may say so outright (space.kind);
// otherwise the page reads it off the content. A kind changes what the
// card leads with — three figures over hairlines — and the order of what
// follows; the blocks themselves are untouched.
const COURSE = /^[A-Z]{2,4}\s?\d{3,4}[A-Z]?$/
const TRIP = /\b(trip|travel|vacation|holiday|getaway|weekend in|flight to)\b/i
function kindOf(space) {
  if (space.kind === 'course' || space.kind === 'money' || space.kind === 'trip') return space.kind
  if (COURSE.test(String(space.name || '').trim())) return 'course'
  if (space.blocks.some((b) => b.type === 'ledger')) return 'money'
  if (TRIP.test(String(space.name || '')) || /^travel$/i.test(String(space.area || ''))) return 'trip'
  return ''
}

/** "sep 18" — the short day every figure and row uses. */
const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleString('en', { month: 'short', day: 'numeric' }).toLowerCase()

/** The term a course's dates fall in: "Fall 2026". */
function termOf(space) {
  const dates = space.blocks.filter((b) => b.type === 'reminder' && b.when).map((b) => b.when)
  if (!dates.length) return ''
  const mid = dates.sort()[Math.floor(dates.length / 2)]
  const [y, m] = mid.split('-').map(Number)
  return `${m >= 8 ? 'Fall' : m >= 6 ? 'Summer' : 'Spring'} ${y}`
}

/** Up to three figures a shaped card leads with: numbers over hairlines,
    the facts in the small size. Only what the data actually says. */
function figuresOf(space, kind) {
  const today = localDay()
  const figs = []
  if (kind === 'course') {
    const open = space.blocks.filter((b) => b.type === 'reminder' && !b.done && b.when).sort((a, b) => a.when.localeCompare(b.when))
    const late = open.filter((b) => b.when < today)
    const ahead = open.filter((b) => b.when >= today)
    if (ahead[0]) figs.push({ n: shortDay(ahead[0].when), k: 'next' })
    if (late.length) figs.push({ n: String(late.length), k: 'overdue', od: true })
    else if (ahead.length > 1) figs.push({ n: String(ahead.length), k: 'ahead' })
    const last = ahead.at(-1)
    if (last && ahead.length > 1) figs.push({ n: shortDay(last.when), k: 'last' })
  }
  if (kind === 'money') {
    const ledgers = space.blocks.filter((b) => b.type === 'ledger')
    const all = ledgers.flatMap((b) => b.entries.map((e) => ({ ...e, unit: b.unit || '' })))
    if (all.length) {
      const unit = all[0].unit
      const sum = (list) => list.reduce((n, e) => n + (Number(e.amount) || 0), 0)
      const month = today.slice(0, 7)
      const total = sum(all)
      // a currency figure is named by its ledger; a counted one already
      // carries its unit ("4 mi"), so its label says only when
      figs.push({ n: fmtAmount(total, unit), k: unit === '$' ? (ledgers[0].title ? ledgers[0].title.toLowerCase() : 'total') : 'so far' })
      const thisMonth = sum(all.filter((e) => String(e.at || '').startsWith(month)))
      if (thisMonth && thisMonth !== total) figs.push({ n: fmtAmount(thisMonth, unit), k: 'this month' })
      const last = [...all].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0]
      if (last?.at) figs.push({ n: shortDay(localDay(new Date(last.at))), k: 'last entry' })
      else figs.push({ n: String(all.length), k: all.length === 1 ? 'entry' : 'entries' })
    }
  }
  if (kind === 'trip') {
    // a trip is its dates: when it leaves, how long until, what is left to pack
    const dated = space.blocks.filter((b) => b.type === 'reminder' && b.when).map((b) => b.when).sort()
    const ahead = dated.filter((d) => d >= today)
    const leaves = ahead[0]
    if (leaves) {
      figs.push({ n: shortDay(leaves), k: 'leaves' })
      const days = Math.round((new Date(`${leaves}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000)
      if (days > 0) figs.push({ n: String(days), k: days === 1 ? 'day' : 'days' })
      const back = ahead.at(-1)
      if (back && back !== leaves && days <= 0) figs.push({ n: shortDay(back), k: 'back' })
    }
    const packing = space.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items.filter((i) => !i.done))
    if (packing.length && figs.length) figs.push({ n: String(packing.length), k: 'to pack' })
  }
  return figs.slice(0, 3)
}

function figuresHTML(figs) {
  if (figs.length < 2) return ''
  return `<div class="figs">${figs
    .map((f) => `<div class="fig${f.od ? ' od' : ''}"><b>${esc(f.n)}</b><span>${esc(f.k)}</span></div>`)
    .join('')}</div>`
}

function spaceInner(space, full = false) {
  // A tracker that carries a goal already stands in the band over the
  // cards — the same count, meter and pace, always on screen. Saying it
  // again on the compact card is the page repeating itself, so the card
  // shows everything else and the focus view keeps the full detail.
  // Carriers with their own content (a goal over a ledger, a streak, a
  // list) keep their blocks: those show the receipts, not the goal.
  const shown = full ? space.blocks : space.blocks.filter((b) => !(b.goal && b.type === 'tracker'))
  const kind = kindOf(space)
  // reminders that are open float to the top of the card; a shaped card
  // goes further — its dates in order, its lists, and its prose at the foot
  const blocks = [...shown].sort((a, b) => {
    if (kind) {
      const rank = (x) =>
        kind === 'money' && x.type === 'ledger' ? 0
        : x.type === 'reminder' && !x.done ? 1
        : x.type === 'list' ? 2
        : x.type === 'reminder' ? 3
        : x.type === 'note' ? 4
        : 1
      const d = rank(a) - rank(b)
      if (d) return d
      if (a.type === 'reminder' && b.type === 'reminder') return String(a.when || '9').localeCompare(String(b.when || '9'))
      return 0
    }
    const w = (x) => (x.type === 'reminder' && !x.done ? 0 : 1)
    return w(a) - w(b)
  })
  // the opened card keeps the same lead the compact card has: more room
  // never means a smaller number
  const hero = heroId({ blocks: shown })
  const figures = figuresHTML(figuresOf(space, kind))
  const corner = `<div class="card-tools">
        <button class="card-tool ${archiveReady(space) ? 'ready' : ''}" data-finish="${space.id}" aria-label="${space.finished ? 'Reopen this space' : 'Archive this space'}" title="${space.finished ? 'reopen' : 'archive'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8v12h16V8M3 4h18v4H3zM10 12h4"/></svg>
        </button>
        <button class="card-tool ${space.pinned ? 'on' : ''}" data-pin="${space.id}" aria-label="${space.pinned ? 'Unpin' : 'Pin'}" title="${space.pinned ? 'unpin' : 'pin'}">
          <svg viewBox="0 0 24 24" fill="${space.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 4 4v2h-5v5h-2v-5H6v-2l4-4-1-6Z"/></svg>
        </button>
        ${full ? '<button type="button" class="surface-close" data-close aria-label="Close card">Close</button>' : ''}
      </div>`
  const solo = full ? null : soloOf(space)
  if (solo) {
    const b = solo.block
    const w = b.type === 'reminder' ? whenPhrase(b) : null
    // a thing that is done is not overdue, whatever its date says
    const bits = [
      w ? `<span class="${w.urgent && !b.done ? 'urgent' : ''}">${esc(w.text)}</span>` : '',
      b.repeat || '',
      solo.label ? esc(solo.label) : '',
    ].filter(Boolean)
    const checkable = b.type === 'reminder'
    return `
      ${corner}
      <div class="solo ${checkable ? 'solo-task' : ''}">
        ${checkable ? `<button type="button" class="row solo-check ${b.done ? 'done' : ''}" data-block="${b.id}" role="checkbox" aria-checked="${b.done}" aria-label="${esc(b.text)}">
          <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
        </button>` : ''}
        <span class="solo-text">${linkify(b.text)}</span>
        ${bits.length ? `<span class="solo-sub">${bits.join(' · ')}</span>` : ''}
      </div>`
  }
  // The opened card names its area at the right end of its own title line,
  // a quiet tag — not a line under the title. When it was last touched is
  // the page talking about itself; the receipts hold that.
  const term = kind === 'course' ? termOf(space) : ''
  // a place that two or more of the card's reminders share is the card's
  // place: said once beside the name, not on every row
  const placeCount = new Map()
  for (const b of space.blocks) {
    if (b.type !== 'reminder' || b.done) continue
    const name = b.entities?.find((e) => e.type === 'place')?.name
    if (name) placeCount.set(name, (placeCount.get(name) || 0) + 1)
  }
  const commonPlace = [...placeCount.entries()].find(([, n]) => n >= 2)?.[0] || ''
  const tagWords = full ? [term, commonPlace, space.area] : [term, commonPlace]
  const tag = tagWords.some(Boolean) ? `<span class="space-tag">${esc(tagWords.filter(Boolean).join(' · '))}</span>` : ''
  const besideImage = shown.some(block => block.preview?.kind === 'image')
  const sky = blocks[0]?.type === 'note' ? weatherScene(blocks[0].preview) : ''
  const weatherHeaderId = sky ? blocks[0].id : null
  fold.left = !full && openRowsOf(blocks) > FOLD_AT ? FOLD_TO : Infinity
  fold.hidden = 0
  let rendered = blocks
    .map((original) => {
      // A heading earns its place only when it adds information. Keep stored
      // wording intact; this also covers older cards the agent already wrote.
      const sameTitle = !titleEarned(original.title, space.name)
      const ownPlace = commonPlace && original.type === 'reminder' && original.entities?.some((e) => e.type === 'place' && e.name === commonPlace)
      let b = sameTitle || ownPlace
        ? { ...original, ...(sameTitle ? { title: '' } : {}), ...(ownPlace ? { entities: original.entities.filter((e) => !(e.type === 'place' && e.name === commonPlace)) } : {}) }
        : original
      // rows do not repeat the card's name at their start
      if (b.type === 'reminder') {
        const shown = shortOfPlace(shortOfName(b.text, space.name), commonPlace)
        if (shown !== b.text) b = { ...b, shown }
      } else if (b.type === 'list') {
        const items = b.items.map((i) => { const shown = shortOfName(i.text, space.name); return shown !== i.text ? { ...i, shown } : i })
        if (items.some((i, k) => i !== b.items[k])) b = { ...b, items }
      }
      const isHero = b.id === hero
      const compact = !full && !isHero && COMPACT[b.type]
      const draw = full && FULL[b.type] ? FULL[b.type] : RENDER[b.type]
      // the figures already carry a money card's total; the ledger keeps its
      // lines and loses the big number that would say it twice
      const quietHero = (isHero || full) && b.type === 'ledger' && !!figures
      const body = compact ? COMPACT[b.type](b) : draw ? draw(b, full, isHero && !quietHero, besideImage, weatherHeaderId) : ''
      if (!String(body).trim()) return ''
      return `<div class="block${isHero && !quietHero ? ' hero' : ''}${quietHero ? ' figured' : ''}" data-bid="${b.id}" data-type="${b.type}">${body}</div>`
    })
    .join('')
  if (fold.hidden) rendered += `<div class="fold-more">${fold.hidden} more</div>`
  fold.left = Infinity
  // A completed card is a receipt, not an empty state. Its full view keeps
  // the original checkboxes available to inspect or reopen.
  const completed = shown.flatMap(b => b.type === 'list' ? b.items.filter(i=>i.done) : b.type === 'reminder' && b.done ? [b] : [])
  const emptyText = completed.length === 1 ? `Done · ${completed[0].text}` : completed.length ? `${completed.length} done` : 'Nothing here yet'
  const body = rendered.trim() || (full ? '' : `<div class="done-more">${esc(emptyText)}</div>`)
  return `
    ${corner}
    ${sky}
    <h2 class="space-name">${esc(space.name)}${tag ? ` ${tag}` : ''}</h2>
    ${figures}
    ${body}`
}
export { clockOf, whenPhrase, words, spaceInner, heroId }
