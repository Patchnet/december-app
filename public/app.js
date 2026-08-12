// December — client. No framework, no build step.
// You type; text lands instantly. The settle pass runs behind you and the
// page settles: spaces appear, blocks tick, captures fold away. Space
// cards re-render surgically (only when their updatedAt moves), so the
// page never feels like it refreshed.

const $ = (sel) => document.querySelector(sel)
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

/** Replay the small status-swap on an element whose value just changed. */
function bump(el) {
  if (reduced || !el) return
  el.classList.remove('bump')
  void el.offsetWidth
  el.classList.add('bump')
}

// ---------------------------------------------------------------- blocks

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
      <button class="row ${i.done ? 'done no-anim' : ''}" data-block="${b.id}" data-item="${i.id}"${srcTitle(i.src)}>
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
    // year trackers carry a today marker at the point the year has reached
    const yearPct = Math.round(((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 31536000000) * 100)
    const notch = b.period === 'year' && !full ? `<span class="notch" style="left:${yearPct}%"></span>` : ''
    // the hero drops its title: the space name and the number already say it
    const title = hero ? '' : `<span class="block-title" style="margin:0">${esc(b.title)}</span>`
    return `
    <div class="tracker-line">
      ${title}
      <span class="tracker-count ${full ? 'full' : ''}"><b>${b.current}</b> of ${b.target}${b.unit ? ` <span class="tracker-unit">${esc(b.unit)}</span>` : ''}</span>
    </div>
    <div class="meter ${full ? 'full' : ''}" data-meter="${b.id}"><span style="width:${pct}%"></span>${notch}</div>`
  },

  ledger: (b, full, hero) => {
    const month = new Date().toISOString().slice(0, 7)
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
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
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

  reminder: (b) => `
    <button class="row reminder ${b.done ? 'done no-anim' : ''}" data-block="${b.id}">
      <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
      <span class="row-text">${linkify(b.text)}</span>
    </button>`,
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
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
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

function spaceInner(space, full = false) {
  // reminders that are open float to the top of the card
  const blocks = [...space.blocks].sort((a, b) => {
    const w = (x) => (x.type === 'reminder' && !x.done ? 0 : 1)
    return w(a) - w(b)
  })
  const hero = full ? null : heroId(space)
  return `
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
  focusId = null
  yearOpen = false
  $('#focus').innerHTML = ''
  $('#focus').dataset.u = ''
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
    if (failed) {
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

/** Receipts are stubs: one short line; the full story one click away.
    Rebuilt only when the receipt actually changes, so it never re-animates
    on an idle poll. */
function renderActivity() {
  const el = $('#activity')
  const acts = state.activity || []
  const key = acts.length ? `${acts[0].at}|${acts.length}|${state.canUndo}` : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  if (!acts.length) {
    el.innerHTML = ''
    el.classList.remove('open')
    return
  }
  const latest = acts[0]
  const n = acts.length
  const stub =
    n === 1
      ? `<b>${esc(latest.space)}</b> · ${esc(latest.summary.slice(0, 72))}`
      : `<b>${esc(latest.space)}</b> · ${n} recent changes`
  el.classList.remove('faded')
  el.innerHTML =
    `<span class="act-stub ${n > 1 ? 'more' : ''}">${stub}</span>` +
    (state.canUndo ? ` · <button class="undo" id="undo-btn">undo</button>` : '') +
    (n > 1 ? `<div class="act-list">${acts.map((a) => `<div class="act-item"><b>${esc(a.space)}</b> ${esc(a.summary)}</div>`).join('')}</div>` : '')
  // transients leave: the receipt has its moment, then steps back
  clearTimeout(renderActivity._t)
  renderActivity._t = setTimeout(() => el.classList.add('faded'), 45000)
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
  const active = state.spaces.filter((s) => now - new Date(s.updatedAt) < DORMANT_MS || awake.has(s.id))
  const resting = state.spaces.filter((s) => !active.includes(s))

  active.forEach((space, i) => {
    seen.add(space.id)
    const known = spaceEls.get(space.id)
    if (!known) {
      const el = document.createElement('article')
      // a card born from a settling capture arrives as a hollow frame and
      // inks in when the dot lands; anything else materializes whole
      const building = delayWash.has(space.id) && !reduced
      el.className = building ? 'space fresh building' : 'space fresh'
      el.style.animationDelay = `${Math.min(i * 45, 270)}ms`
      el.dataset.sid = space.id
      el.innerHTML = spaceInner(space)
      // once the entrance ends, stop its fill so FLIP transforms can act
      el.addEventListener('animationend', () => el.classList.add('settled'), { once: true })
      box.appendChild(el)
      spaceEls.set(space.id, { el, updatedAt: space.updatedAt })
      if (!building) drawMeters(el)
    } else if (known.updatedAt !== space.updatedAt) {
      const prevSpace = prev?.spaces.find((s) => s.id === space.id)
      known.el.innerHTML = spaceInner(space)
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
      // changed numbers beat; changed meters glide from where they were
      for (const b of space.blocks) {
        const pb = prevSpace?.blocks.find((x) => x.id === b.id)
        if (!pb) continue
        const bel = known.el.querySelector(`[data-bid="${b.id}"]`)
        if (!bel) continue
        if (b.type === 'tracker' && pb.current !== b.current) {
          bump(bel.querySelector('.tracker-count'))
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

  // Keep the grid in liveness order without replaying entrances.
  const order = active.map((s) => s.id)
  const domOrder = [...box.children].map((el) => el.dataset.sid)
  if (order.join() !== domOrder.join()) {
    for (const id of order) {
      const known = spaceEls.get(id)
      if (known) {
        known.el.classList.add('settled')
        box.appendChild(known.el)
      }
    }
  }

  // The year accumulates; the page doesn't. Quiet spaces rest below.
  const rest = $('#resting')
  const key = resting.map((s) => s.id).join()
  if (rest.dataset.key !== key) {
    rest.dataset.key = key
    rest.innerHTML = !resting.length
      ? ''
      : `<div class="rest-head">resting</div>` +
        resting
          .map((s) => {
            const mon = new Date(s.updatedAt).toLocaleString('en', { month: 'long' }).toLowerCase()
            return `<button class="rest-row" data-wake="${s.id}"><span>${esc(s.name)}</span><span class="rest-when">quiet since ${mon}</span></button>`
          })
          .join('')
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
  const on = state.spaces.length >= 6
  rail.classList.toggle('on', on)
  if (!on) return
  const key = state.spaces.map((s) => s.id + s.name).join()
  if (rail.dataset.key === key) return
  rail.dataset.key = key
  rail.innerHTML = state.spaces
    .map((s) => `<a href="#" data-jump="${s.id}">${esc(s.name)}</a>`)
    .join('')
}

let attentionCount = 0

/** The busyness budget: attention beats suggestions; settling beats both. */
function renderSuggestions() {
  const box = $('#suggest')
  const cap = state.captures.length ? 0 : attentionCount >= 3 ? 2 : 3
  const list = (state.suggestions || []).slice(0, cap)
  const key = `${cap}|${list.join('|')}`
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.classList.remove('retired')
  box.innerHTML = list
    .map((s, i) => `<button class="chip-btn" data-suggest="${esc(s)}" style="--d:${i * 45}ms">${esc(s)}</button>`)
    .join('')
  clearTimeout(renderSuggestions._t)
  if (list.length) renderSuggestions._t = setTimeout(() => box.classList.add('retired'), 120000)
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
  box.innerHTML = `
    <div class="ask">
      <div class="ask-q">${esc(state.ask.question)}</div>
      <div class="chips">
        ${state.ask.options.map((o, i) => `<button class="chip-btn" data-answer="${esc(o)}" style="--d:${i * 45}ms">${esc(o)}</button>`).join('')}
        <button class="skip" data-dismiss>skip</button>
      </div>
    </div>`
}

/** The page faces the day: what has become relevant rises to the top —
    due and tomorrow's reminders, evening-open streaks, and whatever the
    surfacing sense pinned, each with its reason. */
function renderToday() {
  const box = $('#today')
  const today = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const evening = new Date().getHours() >= 17
  const items = []
  const seen = new Set()
  for (const s of state.spaces) {
    for (const b of s.blocks) {
      if (b.type === 'reminder' && !b.done && b.when && b.when <= tomorrow) {
        // under a header that already says today, only NOT-today earns a label
        const sub = b.when < today ? 'overdue' : b.when === today ? '' : 'tomorrow'
        items.push({ kind: 'reminder', bid: b.id, sid: s.id, label: b.text, sub })
        seen.add(`${s.id}|${b.text.toLowerCase()}`)
      }
      if (evening && b.type === 'streak' && !b.dates.includes(today)) {
        items.push({ kind: 'streak', sid: s.id, label: b.title, sub: 'still open' })
      }
    }
  }
  for (const su of state.surfaced || []) {
    if (seen.has(`${su.spaceId}|${su.label.toLowerCase()}`)) continue
    items.push({ kind: 'surfaced', sid: su.spaceId, label: su.label, sub: su.reason })
  }
  attentionCount = items.length
  const key = items.map((i) => i.kind + (i.bid || i.sid) + i.label + i.sub).join()
  if (box.dataset.key === key) return
  // rows animate in only on the strip's first appearance; later reshuffles
  // must not replay entrances
  if (box.dataset.key !== undefined) box.classList.add('norise')
  box.dataset.key = key
  // every row shares one left column: tick, or an empty slot the same width
  box.innerHTML = items
    .slice(0, 4)
    .map((i) => {
      const sub = i.sub ? `<span class="today-sub ${i.sub === 'overdue' ? 'overdue' : ''}">${esc(i.sub)}</span>` : ''
      return i.kind === 'reminder'
        ? `<button class="row today-row" data-block="${i.bid}">
            <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
            <span class="row-text">${esc(i.label)}</span>${sub}</button>`
        : `<button class="today-row plain" ${i.sid ? `data-jump="${i.sid}"` : ''}>
            <span class="tick-slot"></span>
            <span class="row-text">${esc(i.label)}</span>${sub}</button>`
    })
    .join('')
}

// ------------------------------------------------------------- year view

let yearOpen = false

function buildYear() {
  const y = state.year
  if (!y) return
  const wrap = $('#focus')
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const rows = names
    .map((name, m) => {
      const data = y.months[m]
      const future = m > y.month
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
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card year-card">
        <h2 class="space-name">${y.year}</h2>
        ${rows}
      </article>
    </div>`
  yearOpen = true
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

async function submitCapture() {
  const field = $('#capture')
  const text = field.value.trim()
  if (!text) return
  field.value = ''
  field.style.height = 'auto'
  enterHint.classList.remove('on')
  $('#shell').classList.remove('composing')
  localStorage.setItem('dec-files', String(Number(localStorage.getItem('dec-files') || 0) + 1))
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
const enterHint = $('#enter-hint')
const hintEligible = () => Number(localStorage.getItem('dec-files') || 0) < 5

field.addEventListener('input', () => {
  field.style.height = 'auto'
  field.style.height = `${Math.min(field.scrollHeight, 200)}px`
  enterHint.classList.toggle('on', !!field.value.trim() && hintEligible())
  $('#shell').classList.toggle('composing', !!field.value.trim())
})

// The page is the input: start typing anywhere and it lands in the capture.
// Space alone still scrolls; with the focus view open, typing lands there.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (e.key.length !== 1) return
  if (e.key === ' ') return
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
    let el = document.querySelector(`.space[data-sid="${jump.dataset.jump}"]`)
    if (!el) {
      // a resting space wakes when something points at it
      awake.add(jump.dataset.jump)
      render()
      el = document.querySelector(`.space[data-sid="${jump.dataset.jump}"]`)
    }
    if (el) {
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
      el.classList.remove('noted')
      void el.offsetWidth
      el.classList.add('noted')
      setTimeout(() => el.classList.remove('noted'), 1000)
    }
    return
  }

  // closing the focus view: backdrop or wrapper, never the card itself
  if (e.target.dataset?.close !== undefined) {
    closeFocus()
    return
  }

  // the receipt stub unfolds its full story
  const stub = e.target.closest('.act-stub.more')
  if (stub) {
    $('#activity').classList.toggle('open')
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focusId) closeFocus()
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

// ----------------------------------------------------- the first-run demo
// Once, on a truly empty page: the page performs its own pitch, then
// hands you the pen. Any key or click skips it.

async function firstRunDemo() {
  if (reduced || localStorage.getItem('dec-demo') || state.spaces.length || state.captures.length) return
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
    schedulePoll()
    firstRunDemo()
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:40px;font-family:monospace">could not load: ${e.message}</pre>`
  }
}

boot()
