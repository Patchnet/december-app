import { esc, localDay, fmtAmount, page } from './session.js'

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
    ${open.length === 0 ? '<div class="done-more">nothing open</div>' : ''}
    ${
      done.length
        ? `<details class="done-fold"><summary>${done.length} done</summary>${done.map((i) => rowMarkup(b, i)).join('')}</details>`
        : ''
    }`
  },
}

const RENDER = {
  // Live cards show only open work. Done rows stay in storage and in focus.
  list: (b, full) => {
    const open = b.items.filter((i) => !i.done)
    const done = b.items.filter((i) => i.done).sort((a, z) => (z.doneAt || '').localeCompare(a.doneAt || ''))
    if (!full && open.length === 0) return ''
    const shown = [...open, ...(full ? done : [])]
    return `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    ${shown.map((i) => rowMarkup(b, i)).join('')}`
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

  reminder: (b, full) => {
    if (!full && b.done && !b.repeat) return ''
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

function archiveReady(space) {
  return !space.finished && space.role === 'do' && !!space.complete
}

function soloOf(space) {
  if (space.blocks.length !== 1) return null
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
        <button class="card-tool ${archiveReady(space) ? 'ready' : ''}" data-finish="${space.id}" aria-label="${space.finished ? 'Reopen this space' : 'Archive this space'}" title="${space.finished ? 'reopen' : 'archive'}">
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
  const rendered = blocks
    .map((b) => {
      const isHero = b.id === hero
      const compact = !full && !isHero && COMPACT[b.type]
      const draw = full && FULL[b.type] ? FULL[b.type] : RENDER[b.type]
      const body = compact ? COMPACT[b.type](b) : draw ? draw(b, full, isHero) : ''
      if (!String(body).trim()) return ''
      return `<div class="block${isHero ? ' hero' : ''}" data-bid="${b.id}">${body}</div>`
    })
    .join('')
  // Done work leaves the compact card, so a space whose every thing is done
  // (a reopened one, say) would be a name over nothing. Say so, the way a
  // list with no open rows does, rather than drawing an empty card.
  const body = rendered.trim() || (full ? '' : '<div class="done-more">nothing open</div>')
  return `
    ${corner}
    <h2 class="space-name">${esc(space.name)}</h2>
    ${meta ? `<div class="focus-meta">${esc(meta)}</div>` : ''}
    ${body}`
}
export { clockOf, whenPhrase, words, spaceInner, heroId }
