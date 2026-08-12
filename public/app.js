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
const spaceEls = new Map() // id -> {el, updatedAt}
let pollTimer = null

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
    const clock = due.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(':00', '')
    if (mins < -5) return { text: `${clock}, passed`, urgent: true }
    if (mins <= 1) return { text: 'now', urgent: true }
    if (mins < 60) return { text: `in ${mins} min`, urgent: true }
    if (mins < 180) return { text: `in ${Math.round(mins / 60)} hours`, urgent: true }
    return { text: clock, urgent: false }
  }
  if (b.when === tomorrow) return { text: b.at ? `tomorrow ${b.at}` : 'tomorrow', urgent: false }
  return {
    text: new Date(`${b.when}T12:00:00`).toLocaleString('en', { month: 'short', day: 'numeric' }).toLowerCase(),
    urgent: false,
  }
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
    // the hero drops its title: the space name and the number already say it
    const title = hero ? '' : `<span class="block-title" style="margin:0">${esc(b.title)}</span>`
    return `
    <div class="tracker-line">
      ${title}
      <span class="tracker-count ${full ? 'full' : ''}"><b>${b.current}</b> of ${b.target}${b.unit ? ` <span class="tracker-unit">${esc(b.unit)}</span>` : ''}</span>
    </div>
    <div class="meter ${full ? 'full' : ''}" data-meter="${b.id}"><span style="width:${pct}%"></span></div>`
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
      .map((e) => `<div class="ledger-entry"${srcTitle(e.src)}><span>${linkify(e.label)}</span><span>${fmtAmount(e.amount, b.unit)}</span></div>`)
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
    return `
    <div class="tracker-line">
      ${hero ? '' : `<span class="block-title" style="margin:0">${esc(b.title)}</span>`}
      <span class="streak-count">${b.dates.length}</span>
    </div>
    <div class="streak-line"><span class="streak-dots">${days.join('')}</span></div>`
  },

  note: (b, full) => `
    ${b.title && !/^notes?$/i.test(b.title.trim()) ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="note-text ${!full && b.text.length > 280 ? 'clamp' : ''}">${linkify(b.text)}</div>`,

  reminder: (b) => {
    const w = whenPhrase(b)
    const when = w
      ? `<span class="when-sub ${w.urgent ? 'urgent' : ''}">${esc(w.text)}${b.repeat ? ` · ${b.repeat}` : ''}</span>`
      : b.repeat
        ? `<span class="when-sub">${b.repeat}</span>`
        : ''
    return `
    <button class="row reminder ${b.done ? 'done no-anim' : ''}" data-block="${b.id}"
      role="checkbox" aria-checked="${b.done}" aria-label="${esc(b.text)}">
      <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
      <span class="row-text">${linkify(b.text)}</span>${when}
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

function spaceInner(space, full = false) {
  // reminders that are open float to the top of the card
  const blocks = [...space.blocks].sort((a, b) => {
    const w = (x) => (x.type === 'reminder' && !x.done ? 0 : 1)
    return w(a) - w(b)
  })
  const hero = full ? null : heroId(space)
  const corner = full
    ? ''
    : `<div class="card-tools">
        <button class="card-tool ${space.complete ? 'ready' : ''}" data-finish="${space.id}" aria-label="Close this space out" title="close out">
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
  return `
    ${corner}
    <h2 class="space-name">${esc(space.name)}</h2>
    ${blocks
      .map((b) => {
        const isHero = b.id === hero
        const compact = !full && !isHero && COMPACT[b.type]
        const body = compact ? COMPACT[b.type](b) : RENDER[b.type] ? RENDER[b.type](b, full, isHero) : ''
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
        <div class="space-verbs">
          <button class="co-link" data-finish="${space.id}">${space.finished ? 'reopen it' : 'close it out'}</button>
          <button class="retire-link" data-retire="${space.id}">retire this space</button>
        </div>
      </article>
    </div>`
  wrap.dataset.u = space.updatedAt
  const fieldEl = wrap.querySelector('.focus-capture')
  if (fieldEl) {
    fieldEl.value = draft
    if (hadFocus || !draft) fieldEl.focus()
    if (draft) fieldEl.setSelectionRange(caret, caret)
  }
  const card = wrap.querySelector('.focus-card')
  if (card && scrollTop) card.scrollTop = scrollTop
}

function closeFocus() {
  $('#focus').dataset.confirm = ''
  focusId = null
  yearOpen = false
  yearShown = null
  $('#focus').innerHTML = ''
  $('#focus').dataset.u = ''
  $('#focus').dataset.help = ''
}

// ---------------------------------------------------------------- render

function renderYearline() {
  const now = new Date()
  $('#dateline').textContent = `${now.toLocaleString('en', { month: 'long' })} ${now.getDate()}`
}

/** An accent dot arcs from where your sentence was to the space it landed
    in. Slow enough to follow; the page holds still while it flies. */
const inViewport = (r) => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth

function travelDot(fromRect, toEl, then, hue) {
  if (reduced || !toEl) return then?.()
  const to = toEl.getBoundingClientRect()
  // a flight nobody can see is just latency: skip when either end is offscreen
  if (!inViewport(fromRect) || !inViewport(to)) return then?.()
  const dot = document.createElement('div')
  dot.className = 'travel-dot'
  if (hue) dot.style.background = hue
  dot.style.left = `${fromRect.left}px`
  dot.style.top = `${fromRect.top + fromRect.height / 2}px`
  document.body.appendChild(dot)
  const dx = to.left + 22 - fromRect.left
  const dy = to.top + 22 - (fromRect.top + fromRect.height / 2)
  dot
    .animate(
      [
        { transform: 'translate(0, 0) scale(0.7)', opacity: 0, offset: 0 },
        { transform: `translate(${dx * 0.18}px, ${dy * 0.18 - 22}px) scale(1.25)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.6 - 26}px) scale(1.15)`, opacity: 1, offset: 0.65 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 1, offset: 1 },
      ],
      { duration: 900, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
    )
    .addEventListener('finish', () => {
      dot.remove()
      bloom(fromRect.left + dx, fromRect.top + fromRect.height / 2 + dy)
      then?.()
    })
}

/** A soft ring where the dot lands. */
function bloom(x, y) {
  if (reduced) return
  const layer = document.createElement('div')
  layer.className = 'spark'
  layer.style.left = `${x}px`
  layer.style.top = `${y}px`
  const ring = document.createElement('span')
  ring.className = 'ring'
  layer.appendChild(ring)
  document.body.appendChild(layer)
  setTimeout(() => layer.remove(), 600)
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
  for (const el of document.querySelectorAll('#spaces .space')) before.set(el, el.getBoundingClientRect())
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
  for (const [el, dx, dy] of moves) {
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
  }
  void document.body.offsetHeight
  for (const [el] of moves) {
    el.style.transition = 'transform var(--m-struct) var(--ease-expo)'
    el.style.transform = ''
  }
  setTimeout(() => {
    for (const [el] of moves) el.style.transition = ''
  }, 420)
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
  const inDom = new Set(
    [...document.querySelectorAll('.inbox-row:not(.out)')].map((r) => r.dataset.cid)
  )
  for (const a of state.activity) {
    if (!inDom.has(a.captureId) || ids.has(a.captureId)) continue
    const space = state.spaces.find((s) => s.name === a.space)
    if (space) targets.set(a.captureId, space.id)
  }
  return targets
}

// The building moment: a card under construction is a hollow dashed frame
// with its content still forming; when the dot lands, it inks in.
function unbuild(el) {
  if (!el?.classList.contains('building')) return
  el.classList.remove('building')
  drawMeters(el)
}

function renderInbox(targets = new Map()) {
  const box = $('#inbox')
  const failed = !state.settle.running && state.settle.lastError
  const captureOnly = state.settle.captureOnly
  const ids = new Set(state.captures.map((c) => c.id))

  // captures that settled: the dot leaves the line, lands on its space,
  // the card washes — and only then does the line fold, so the page holds
  // still for the whole flight. A batch launches as a stream, not a swarm.
  let launch = 0
  for (const row of box.querySelectorAll('.inbox-row')) {
    if (!ids.has(row.dataset.cid) && !row.classList.contains('done-wait')) {
      row.classList.add('done-wait')
      const text = row.querySelector('.inbox-text')
      text.classList.remove('reading')
      row.querySelector('.inbox-state').innerHTML = ''
      const rect = text.getBoundingClientRect()
      const targetId = targets.get(row.dataset.cid)
      const targetEl = targetId ? spaceEls.get(targetId)?.el : null
      const fold = () => {
        row.classList.add('out')
        setTimeout(() => row.remove(), 420)
      }
      if (targetEl) {
        setTimeout(() => {
          travelDot(rect, targetEl, () => {
            unbuild(targetEl)
            washCard(targetEl)
            fold()
          })
        }, launch++ * 160)
      } else {
        fold()
      }
    }
  }
  // add rows for new captures; the words themselves carry the working state
  for (const c of state.captures) {
    let row = box.querySelector(`.inbox-row[data-cid="${c.id}"]`)
    if (!row) {
      row = document.createElement('div')
      row.className = 'inbox-row'
      row.dataset.cid = c.id
      row.innerHTML = `<div><span class="inbox-text">${esc(c.text)}</span><span class="inbox-state"></span></div>`
      box.appendChild(row)
    }
    const text = row.querySelector('.inbox-text')
    const chip = row.querySelector('.inbox-state')
    if (captureOnly) {
      text.classList.remove('reading')
      chip.className = 'inbox-state capture-only'
      chip.textContent = 'saved · capture only'
    } else if (failed) {
      text.classList.remove('reading')
      chip.className = 'inbox-state failed'
      chip.innerHTML = `<i class="warn-dot"></i><button class="retry">retry</button>`
    } else {
      // the words carrying the light ARE the status; nothing else needed
      text.classList.add('reading')
      chip.className = 'inbox-state'
      chip.innerHTML = ''
    }
  }
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
      <article class="focus-card co-card" role="dialog" aria-modal="true" aria-label="Close out this space">
        <h2 class="space-name">Close out ${esc(space.name)}?</h2>
        <p class="co-read">${open.length} thing${open.length === 1 ? '' : 's'} still unfinished. Closing keeps everything as it is and moves the space down to finished; you can reopen it anytime.</p>
        <div class="confirm-list">${open.slice(0, 6).map((t) => `<div class="confirm-item">${esc(t)}</div>`).join('')}${open.length > 6 ? `<div class="confirm-item more">and ${open.length - 6} more</div>` : ''}</div>
        <div class="chips" style="margin-top:16px">
          <button class="chip-btn" data-confirm-finish="${space.id}">close it out anyway</button>
          <button class="co-link" data-close>keep it open</button>
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

/** How many things in a space are still waiting on you. */
function countOpen(space) {
  let n = 0
  for (const b of space?.blocks || []) {
    if (b.type === 'list') n += b.items.filter((i) => !i.done).length
    if (b.type === 'reminder' && !b.done) n++
    if (b.type === 'tracker' && b.current < b.target) n++
  }
  return n
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
  for (const el of ordered) {
    let target = 0
    for (let i = 1; i < cols.length; i++) if (heights[i] < heights[target]) target = i
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
      el.style.animationDelay = `${Math.min(i * 45, 270)}ms`
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

  // The year accumulates; the page doesn't. Quiet spaces rest below.
  const rest = $('#resting')
  const retired = state.retired || []
  const key = resting.map((s) => s.id).join() + '|' + retired.map((s) => s.id).join() + '|' + finished.map((s) => s.id).join()
  if (rest.dataset.key !== key) {
    rest.dataset.key = key
    const restRows = !resting.length
      ? ''
      : `<div class="rest-head">resting</div>` +
        resting
          .map((s) => {
            const mon = new Date(s.updatedAt).toLocaleString('en', { month: 'long' }).toLowerCase()
            return `<button class="rest-row" data-wake="${s.id}"><span>${esc(s.name)}</span><span class="rest-when">quiet since ${mon}</span></button>`
          })
          .join('')
    const finishedRows = !finished.length
      ? ''
      : `<div class="rest-head">finished</div>` +
        finished
          .map((s) => {
            const mon = s.finishedAt ? new Date(s.finishedAt).toLocaleString('en', { month: 'long' }).toLowerCase() : ''
            return `<button class="rest-row" data-reopen="${s.id}"><span>${esc(s.name)}</span><span class="rest-when">${mon ? `done in ${mon}` : 'done'}</span></button>`
          })
          .join('')
    const retiredRows = !retired.length
      ? ''
      : `<div class="rest-head">retired</div>` +
        retired
          .map((s) => `<button class="rest-row" data-restore="${s.id}"><span>${esc(s.name)}</span><span class="rest-when">restore</span></button>`)
          .join('')
    rest.innerHTML = finishedRows + restRows + retiredRows
  }
}

/** Trackers that just reached their target get the full §1.12 moment. */
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
  const key = state.spaces.map((s) => s.id + s.name + s.area + s.finished).join()
  if (rail.dataset.key === key) return
  rail.dataset.key = key
  const live = state.spaces.filter((s) => !s.finished)
  const byArea = new Map()
  for (const s of live) {
    const a = s.area || 'other'
    if (!byArea.has(a)) byArea.set(a, [])
    byArea.get(a).push(s)
  }
  // group only once the page has enough spaces to need it
  const grouped = live.length >= 8 && byArea.size > 1 && [...byArea.keys()].some((k) => k !== 'other')
  rail.innerHTML = grouped
    ? [...byArea.entries()]
        .map(
          ([area, list]) =>
            `<div class="rail-area">${esc(area)}</div>` +
            list.map((s) => `<a href="#" data-jump="${s.id}">${esc(s.name)}</a>`).join('')
        )
        .join('')
    : live.map((s) => `<a href="#" data-jump="${s.id}">${esc(s.name)}</a>`).join('')
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
    .map((s, i) => `<button class="chip-btn" data-suggest="${esc(s)}" style="--d:${i * 45}ms">${esc(s)}</button>`)
    .join('')
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
  box.innerHTML = `
    <div class="ask">
      <div class="ask-q">${esc(state.ask.question)}</div>
      <div class="chips">
        ${opts.map((o, i) => `<button class="chip-btn" data-answer="${esc(o)}" style="--d:${i * 45}ms">${esc(o)}</button>`).join('')}
        ${opts.length ? '' : '<input class="ask-input" placeholder="type it" autocomplete="off" spellcheck="false" aria-label="Your answer" />'}
        <button class="skip" data-dismiss>skip</button>
      </div>
    </div>`
}

/** The page faces the day: what has become relevant rises to the top —
    due and tomorrow's reminders, evening-open streaks, and whatever the
    surfacing sense pinned, each with its reason. */
function renderToday() {
  const box = $('#today')
  const today = localDay()
  const tomorrow = localDay(new Date(Date.now() + 86400000))
  const items = []
  const seen = new Set()
  // the strip carries ONLY things with a clock on them: act or it lapses
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type === 'reminder' && !b.done && b.when && b.when <= tomorrow) {
        const w = whenPhrase(b)
        // under a header that already says today, a bare "today" says nothing
        const sub = w && w.text !== 'today' ? w.text : ''
        items.push({ kind: 'reminder', bid: b.id, sid: s.id, label: b.text, sub, urgent: !!w?.urgent, when: `${b.when} ${b.at || '99:99'}` })
        seen.add(`${s.id}|${b.text.toLowerCase()}`)
      }
    }
  }
  for (const su of state.surfaced || []) {
    if (seen.has(`${su.spaceId}|${su.label.toLowerCase()}`)) continue
    items.push({ kind: 'surfaced', sid: su.spaceId, label: su.label, sub: su.reason })
  }
  // soonest first, so the strip reads like a morning
  items.sort((a, x) => (a.when || '').localeCompare(x.when || ''))
  attentionCount = items.length
  maybeNotify(items.filter((i) => i.kind === 'reminder' || i.kind === 'surfaced'))
  const key = items.map((i) => i.kind + (i.bid || i.sid) + i.label + i.sub).join()
  if (box.dataset.key === key) return
  // rows animate in only on the strip's first appearance; later reshuffles
  // must not replay entrances
  if (box.dataset.key !== undefined) box.classList.add('norise')
  box.dataset.key = key
  // every row shares one left column, and every row opens into a moment:
  // answer it right here — done, not yet, or say what happened
  const shown = items.slice(0, 3)
  const rest = items.length - shown.length
  box.innerHTML = shown
    .map((i) => {
      const sub = i.sub ? `<span class="today-sub ${i.urgent ? 'overdue' : ''}">${esc(i.sub)}</span>` : ''
      const spaceName = state.spaces.find((s) => s.id === i.sid)?.name || ''
      const input = `<input class="act-input" data-sid="${i.sid || ''}" placeholder="or say what happened…" />`
      const openChip = i.sid ? `<button class="chip-btn" data-jump="${i.sid}">open</button>` : ''
      const moment =
        i.kind === 'reminder'
          ? `<button class="chip-btn" data-act-done="${i.bid}">done</button>
             <button class="chip-btn" data-act-later="${i.bid}">not yet</button>
             ${openChip}${input}`
          : `<button class="chip-btn" data-act-handled="${esc(i.label)}">handled</button>
             ${openChip}${input}`
      const row =
        i.kind === 'reminder'
          ? `<button class="row today-row" data-block="${i.bid}" role="checkbox" aria-checked="false" aria-label="${esc(i.label)}${i.sub ? `, ${esc(i.sub)}` : ''}">
              <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
              <span class="row-text">${esc(i.label)}</span>${sub}</button>`
          : `<button class="today-row plain">
              <span class="tick-slot"></span>
              <span class="row-text">${esc(i.label)}</span>${sub}</button>`
      return `<div class="today-item">${row}<div class="act-moment" hidden>${moment}</div></div>`
    })
    .join('') + (rest > 0 ? `<div class="today-more">+${rest} more</div>` : '')
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
  const rows = names
    .map((name, m) => {
      const data = y.months[m]
      const future = !yearShown && m > state.year.month
      const dots = Array.from({ length: Math.min(data.events, 28) }, () => '<i></i>').join('')
      const hl = data.highlights.map((h) => `<div class="ym-hl">${esc(h)}</div>`).join('')
      return `
      <div class="ym ${future ? 'future' : ''} ${m === y.month ? 'now' : ''}">
        <div class="ym-name">${name}</div>
        <div class="ym-body">
          ${data.events ? `<div class="ym-dots">${dots}</div>` : future ? '' : '<div class="ym-quiet">quiet</div>'}
          ${hl}
          ${m === 11 && future ? `<div class="ym-quiet">in ${Math.ceil((new Date(y.year, 11, 1) - Date.now()) / 86400000)} days</div>` : ''}
        </div>
      </div>`
    })
    .join('')
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
        ${rows}
        ${held}
        ${past ? '' : `<a class="retire-link" href="/api/export.md" download>download the year</a>`}
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

function renderHint() {
  const empty = !state.spaces.length && !state.captures.length && !(state.suggestions || []).length
  $('#hint').textContent = empty ? 'Rent, a habit, a goal, a stray thought. Write it and it organizes itself.' : ''
}

function render() {
  renderYearline()
  $('#shell').classList.toggle('settling', state.captures.length > 0)
  const targets = travelTargets()
  withFlip(() => {
    renderSpaces(new Set(targets.values()))
    renderInbox(targets)
  })
  renderActivity()
  renderToday()
  renderCarryover()
  renderCarryoverNudge()
  renderSuggestions()
  renderAsk()
  renderHint()
  renderRail()
  celebrateDiffs()
  // keep an open focus view current with what the agent changes
  if (focusId) {
    const space = state.spaces.find((s) => s.id === focusId)
    if (!space) closeFocus()
    else if ($('#focus').dataset.u !== space.updatedAt) buildFocus()
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

async function submitCapture() {
  const field = $('#capture')
  const text = field.value.trim()
  if (!text) return
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
  try {
    state = await api('/api/capture', { text })
    render()
    schedulePoll()
  } catch (e) {
    field.value = text
    $('#shell').classList.add('composing') // the draft is back; keep the page quiet
    toast(e.message)
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

// the action moment's input: what happened, in your words, scoped
document.addEventListener('keydown', async (e) => {
  const ai = e.target.closest?.('.act-input')
  if (!ai || e.key !== 'Enter') return
  e.preventDefault()
  const text = ai.value.trim()
  if (!text) return
  const hint = state.spaces.find((s) => s.id === ai.dataset.sid)?.name
  ai.value = ''
  ai.closest('.act-moment').hidden = true
  try {
    state = await api('/api/capture', { text, hint })
    render()
    schedulePoll()
    toast(hint ? `settling into ${hint}` : 'settling')
  } catch (err) {
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
/** Shown once, to a brand new empty page, and never again. */
function showIntro() {
  const wrap = $('#focus')
  wrap.dataset.help = '1'
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" role="dialog" aria-modal="true" aria-label="What December can do">
        <h2 class="space-name">What you can say</h2>
        ${CAN_DO.map(([k, v]) => `<div class="can-row"><div class="can-k">${esc(k)}</div><div class="can-v">${esc(v)}</div></div>`).join('')}
        <div class="can-keys">? for this · / to find · ⌘Z to undo · esc to close</div>
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

field.addEventListener('input', () => {
  field.style.height = 'auto'
  field.style.height = `${Math.min(field.scrollHeight, Math.round(innerHeight * 0.4))}px`
  enterHint.classList.toggle('on', !!field.value.trim() && hintEligible())
  $('#shell').classList.toggle('composing', !!field.value.trim())
  renderSuggestions()
  // a dump is an object, not a floating wall: contain it past two lines
  // on a phone the field is fixed to the bottom edge: the page must always
  // be able to scroll clear of whatever height it grows to
  document.documentElement.style.setProperty('--capture-h', `${field.offsetHeight}px`)
  const cwrap = field.closest('.cwrap')
  const big = field.scrollHeight > 64
  cwrap.classList.toggle('big', big)
  if (big) {
    const n = field.value.split('\n').filter((l) => l.trim()).length
    cwrap.dataset.hint = n > 1 ? `${n} lines · enter files each one` : ''
  } else {
    cwrap.dataset.hint = ''
  }
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

  if (e.target.closest('[data-answer-close]')) {
    $('#answer').innerHTML = ''
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
    if (!sp?.finished && el && !reduced) celebrate(el.querySelector('.space-name'))
    try {
      const out = await api('/api/finish', { spaceId: finBtn.dataset.finish, finished: !sp?.finished })
      state = out.state
      if (out.finished) {
        const leaving = spaceEls.get(finBtn.dataset.finish)?.el
        spaceEls.delete(finBtn.dataset.finish)
        closeFocus()
        if (leaving && !reduced) {
          // it settles downward and out; the grid closes the gap behind it
          leaving.style.height = `${leaving.offsetHeight}px`
          void leaving.offsetHeight
          leaving.classList.add('leaving')
          setTimeout(() => {
            leaving.remove()
            withFlip(() => render())
          }, 420)
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

  // retire a space (one gentle confirm), restore a retired one
  const ret = e.target.closest('[data-retire]')
  if (ret) {
    if (!ret.dataset.armed) {
      ret.dataset.armed = '1'
      ret.textContent = 'retire? this hides the space; it stays restorable below the grid'
      setTimeout(() => {
        ret.dataset.armed = ''
        ret.textContent = 'retire this space'
      }, 4000)
      return
    }
    try {
      const out = await api('/api/retire', { spaceId: ret.dataset.retire })
      state = out.state
      spaceEls.get(ret.dataset.retire)?.el.remove()
      spaceEls.delete(ret.dataset.retire)
      closeFocus()
      render()
      toast(`${out.name} retired`)
    } catch (err) {
      toast(err.message)
    }
    return
  }
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

  const yj = e.target.closest('.year-jump')
  if (yj) {
    const yy = Number(yj.dataset.year)
    if (yy === state.year.year) {
      yearShown = null
      buildYear()
    } else openPastYear(yy)
    return
  }

  // the receipt stub unfolds its full story
  const stub = e.target.closest('.act-stub.more')
  if (stub) {
    $('#activity').classList.toggle('open')
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

  // an attention row's body opens its action moment (the tick still checks)
  const tRow = e.target.closest('#today .today-row')
  if (tRow && !e.target.closest('.tick')) {
    const moment = tRow.parentElement.querySelector('.act-moment')
    const wasHidden = moment.hidden
    for (const m of document.querySelectorAll('.act-moment')) m.hidden = true
    moment.hidden = !wasHidden
    return
  }

  // moment: done — same joy as the tick
  const actDone = e.target.closest('[data-act-done]')
  if (actDone) {
    const row = document.querySelector(`#today .row[data-block="${actDone.dataset.actDone}"]`)
    row?.querySelector('.tick')?.click()
    actDone.closest('.act-moment').hidden = true
    return
  }

  // moment: not yet — the clock rolls to tomorrow
  const actLater = e.target.closest('[data-act-later]')
  if (actLater) {
    const tomorrow = localDay(new Date(Date.now() + 86400000))
    try {
      await api('/api/tool', { name: 'december_update_block', arguments: { blockId: actLater.dataset.actLater, reminder_when: tomorrow } })
      state = await api('/api/state')
      render()
      toast('tomorrow, then')
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // moment: handled — the surfaced item stands down
  const actHandled = e.target.closest('[data-act-handled]')
  if (actHandled) {
    const label = actHandled.dataset.actHandled
    const remaining = (state.surfaced || []).filter((s) => s.label !== label)
    try {
      await api('/api/tool', {
        name: 'december_surface',
        arguments: { items: remaining.map((s) => ({ label: s.label, reason: s.reason, space: state.spaces.find((x) => x.id === s.spaceId)?.name || s.label, until: s.until || undefined })) },
      })
      state.surfaced = remaining
      render()
      toast('handled')
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // manual check on a list item or reminder — instant, no model.
  // One click, one request: taps during the round trip are ignored.
  const row = e.target.closest('.row[data-block]')
  if (row) {
    if (row.dataset.busy) return
    row.dataset.busy = '1'
    setTimeout(() => delete row.dataset.busy, 600)
    const done = !row.classList.contains('done')
    // the same row may exist in the grid card and the focus card: keep both true
    const twins = document.querySelectorAll(
      `.row[data-block="${row.dataset.block}"]${row.dataset.item ? `[data-item="${row.dataset.item}"]` : ''}`
    )
    for (const twin of twins) {
      twin.classList.remove('no-anim')
      twin.classList.toggle('done', done)
      twin.setAttribute('aria-checked', String(done))
    }
    if (done) {
      pop(row.querySelector('.tick'))
      celebrate(row.querySelector('.tick'))
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
    if (isListItem && sid) {
      const sp = state.spaces.find((s) => s.id === sid)
      const trackers = sp ? sp.blocks.filter((b) => b.type === 'tracker') : []
      if (trackers.length === 1) {
        const t = trackers[0]
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
      // adopt silently; the row is already painted
      const known = sid && spaceEls.get(sid)
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
  if (e.key === 'Escape' && focusId && !document.querySelector('[contenteditable="true"]')) closeFocus()
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
  const el = e.target.closest('.row-text, .note-text, .space-name')
  if (!el || el.closest('.year-card, .demo-card, .ghost, #today')) return
  if (el.isContentEditable) return
  const row = el.closest('.row[data-block]')
  const card = el.closest('.space, .focus-card')
  const payload = el.classList.contains('space-name')
    ? { spaceId: card?.dataset.sid }
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

function jumpToSpace(sid) {
  let el = document.querySelector(`.space[data-sid="${sid}"]`)
  if (!el) {
    // a resting space wakes when something points at it
    awake.add(sid)
    render()
    el = document.querySelector(`.space[data-sid="${sid}"]`)
  }
  if (el) {
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    el.classList.remove('noted')
    void el.offsetWidth
    el.classList.add('noted')
    setTimeout(() => el.classList.remove('noted'), 1000)
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
        .map((h) => `<button class="search-hit" data-shit="${h.sid}"><span class="sh-label">${esc(h.label.slice(0, 44))}</span>${h.space ? `<span class="sh-space">${esc(h.space)}</span>` : ''}</button>`)
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
      jumpToSpace(first.dataset.shit)
      searchEl.value = ''
      closeSearch()
      searchEl.blur()
    }
  }
})

document.addEventListener('click', (e) => {
  const hit = e.target.closest('.search-hit')
  if (hit) {
    jumpToSpace(hit.dataset.shit)
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
let currentSettings = null

function renderSettings(s) {
  currentSettings = s
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
  renderOnboarding(s)
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
  settingsPop.hidden = !open
  $('#gear-toggle').setAttribute('aria-expanded', String(open))
  if (open) {
    try {
      renderSettings(await api('/api/settings'))
    } catch (e) {
      toast(e.message)
    }
  }
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

document.addEventListener('mousedown', (e) => {
  if (!settingsPop.hidden && !e.target.closest('#settings-pop, #gear-toggle')) {
    settingsPop.hidden = true
    $('#gear-toggle').setAttribute('aria-expanded', 'false')
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

$('#theme-toggle').addEventListener('click', () => {
  const root = document.documentElement
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
  root.classList.add('theming')
  root.dataset.theme = next
  localStorage.setItem('dec-theme', next)
  setTimeout(() => root.classList.remove('theming'), 320)
})

// ------------------------------------------------------------------ boot

$('#dateline').addEventListener('click', () => (yearOpen ? closeFocus() : buildYear()))

const launchParams = new URLSearchParams(location.search)
const shouldOnboard = launchParams.has('firstrun') || (launchParams.has('desktop') && !localStorage.getItem('dec-onboarding'))
const onboarding = $('#onboarding')

function renderOnboarding(s) {
  if (onboarding.hidden) return
  const engines = [
    ['claude', 'Claude Code', 'Run claude once and finish its sign-in flow. Then restart December to detect it.'],
    ['codex', 'Codex', 'Run codex login once and finish its sign-in flow. Then restart December to detect it.'],
  ]
  $('#onboarding-engines').innerHTML = engines.map(([key, label, guidance]) => `
    <button class="onboarding-engine ${s.engine === key ? 'selected' : ''}" data-onboard-engine="${key}" ${s.engines[key] ? '' : 'disabled'}>
      <span><b>${label}</b><small>${s.engines[key] ? 'ready on this machine' : 'not detected'}</small></span>
      <span>${s.engines[key] ? (s.engine === key ? 'selected' : 'use this') : 'connect first'}</span>
    </button>
    ${s.engines[key] ? '' : `<p class="onboarding-guidance">${guidance}</p>`}
  `).join('')
  const any = Object.values(s.engines).some(Boolean)
  $('#onboarding-note').textContent = any
    ? 'You can start writing now. December will organize new captures behind you.'
    : 'No local AI was found yet. December still saves everything in capture-only mode; connect a CLI whenever you are ready.'
}

$('#onboarding-engines').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-onboard-engine]')
  if (button) await saveSettings({ engine: button.dataset.onboardEngine })
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
  if (shouldOnboard || reduced || localStorage.getItem('dec-demo') || state.spaces.length || state.captures.length || state.carryover) return
  let alive = true
  const stop = () => {
    alive = false
    localStorage.setItem('dec-demo', '1')
    field.value = ''
    document.querySelector('.demo-card')?.remove()
  }
  window.addEventListener('keydown', stop, { once: true })
  window.addEventListener('mousedown', stop, { once: true })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const line = 'paid rent this month, $2300'
  await wait(1200)
  for (const ch of line) {
    if (!alive) return
    field.value += ch
    await wait(55)
  }
  await wait(700)
  if (!alive) return
  field.value = ''
  const card = document.createElement('article')
  card.className = 'space demo-card'
  card.innerHTML = `
    <h2 class="space-name">Housing</h2>
    <div class="block hero">
      <div class="block-title">Rent</div>
      <div class="ledger-total">$2,300</div>
      <div class="ledger-entry"><span>This month's rent</span><span>$2,300</span></div>
    </div>`
  $('#spaces').prepend(card)
  await wait(2600)
  if (!alive) return
  card.classList.add('ghost-out')
  await wait(320)
  card.remove()
  localStorage.setItem('dec-demo', '1')
  toast('now you')
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
    }
    if (launchParams.has('capture')) $('#capture').focus()
    schedulePoll()
    // a brand new page gets told what it can do, once, ever
    if (!state.spaces.length && !state.captures.length && !state.carryover && !localStorage.getItem('dec-intro')) {
      localStorage.setItem('dec-intro', '1')
      setTimeout(showIntro, 600)
    } else {
      firstRunDemo()
    }
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:40px;font-family:monospace">could not load: ${e.message}</pre>`
  }
}

boot()
