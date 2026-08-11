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

// ---------------------------------------------------------------- blocks

const rowMarkup = (b, i) => `
      <button class="row ${i.done ? 'done no-anim' : ''}" data-block="${b.id}" data-item="${i.id}">
        <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
        <span class="row-text">${esc(i.text)}</span>
      </button>`

const RENDER = {
  // Open items in full; the done pile compresses to its two most recent.
  list: (b) => {
    const open = b.items.filter((i) => !i.done)
    const done = b.items.filter((i) => i.done).sort((a, z) => (z.doneAt || '').localeCompare(a.doneAt || ''))
    const shown = [...open, ...done.slice(0, 2)]
    const more = done.length > 2 ? `<div class="done-more">${done.length - 2} more done</div>` : ''
    return `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    ${shown.map((i) => rowMarkup(b, i)).join('')}${more}`
  },

  tracker: (b) => {
    const pct = Math.min(100, Math.round((b.current / b.target) * 100))
    const full = b.current >= b.target
    // year trackers carry a today marker at the point the year has reached
    const yearPct = Math.round(((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 31536000000) * 100)
    const notch = b.period === 'year' && !full ? `<span class="notch" style="left:${yearPct}%"></span>` : ''
    return `
    <div class="tracker-line">
      <span class="block-title" style="margin:0">${esc(b.title)}</span>
      <span class="tracker-count ${full ? 'full' : ''}"><b>${b.current}</b> of ${b.target}${b.unit ? ` <span class="tracker-unit">${esc(b.unit)}</span>` : ''}</span>
    </div>
    <div class="meter ${full ? 'full' : ''}" data-meter="${b.id}"><span style="width:${pct}%"></span>${notch}</div>`
  },

  ledger: (b) => {
    const month = new Date().toISOString().slice(0, 7)
    const monthSum = b.entries.filter((e) => (e.at || '').startsWith(month)).reduce((n, e) => n + (Number(e.amount) || 0), 0)
    const monthLine =
      monthSum && monthSum !== b.total
        ? `<div class="ledger-month">${new Date().toLocaleString('en', { month: 'short' }).toLowerCase()} ${fmtAmount(monthSum, b.unit)}</div>`
        : ''
    return `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="ledger-total">${fmtAmount(b.total, b.unit)}</div>
    ${monthLine}
    ${b.entries
      .slice(-3)
      .reverse()
      .map((e) => `<div class="ledger-entry"><span>${esc(e.label)}</span><span>${fmtAmount(e.amount, b.unit)}</span></div>`)
      .join('')}`
  },

  streak: (b) => {
    const days = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      const on = b.dates.includes(d)
      const today = i === 0 && !on
      days.push(`<i class="${on ? 'on' : ''}${today ? 'today' : ''}" style="--i:${13 - i}"></i>`)
    }
    return `
    <div class="tracker-line">
      <span class="block-title" style="margin:0">${esc(b.title)}</span>
      <span class="streak-count">${b.dates.length}</span>
    </div>
    <div class="streak-line"><span class="streak-dots">${days.join('')}</span></div>`
  },

  note: (b) => `
    ${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}
    <div class="note-text ${b.text.length > 280 ? 'clamp' : ''}">${esc(b.text)}</div>`,

  reminder: (b) => `
    <button class="row reminder ${b.done ? 'done no-anim' : ''}" data-block="${b.id}">
      <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
      <span class="row-text">${esc(b.text)}</span>
    </button>`,
}

function spaceInner(space) {
  // reminders that are open float to the top of the card
  const blocks = [...space.blocks].sort((a, b) => {
    const w = (x) => (x.type === 'reminder' && !x.done ? 0 : 1)
    return w(a) - w(b)
  })
  return `
    <h2 class="space-name">${esc(space.name)}</h2>
    ${blocks.map((b) => `<div class="block" data-bid="${b.id}">${RENDER[b.type] ? RENDER[b.type](b) : ''}</div>`).join('')}`
}

// ---------------------------------------------------------------- render

function renderYearline() {
  const now = new Date()
  const dec31 = new Date(now.getFullYear(), 11, 31)
  const days = Math.max(0, Math.ceil((dec31 - now) / 86400000))
  const month = now.toLocaleString('en', { month: 'long' }).toLowerCase()
  $('#yearline').textContent = `${month} · ${days} days to december`
}

/** An accent dot arcs from where your sentence was to the space it landed
    in. Slow enough to follow; the page holds still while it flies. */
function travelDot(fromRect, toEl, then) {
  if (reduced || !toEl) return then?.()
  const to = toEl.getBoundingClientRect()
  const dot = document.createElement('div')
  dot.className = 'travel-dot'
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
      then?.()
    })
}

function washCard(el) {
  if (!el) return
  el.classList.remove('washed')
  void el.offsetWidth
  el.classList.add('washed')
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

function renderInbox(targets = new Map()) {
  const box = $('#inbox')
  const failed = !state.settle.running && state.settle.lastError
  const ids = new Set(state.captures.map((c) => c.id))

  // captures that settled: the dot leaves the line, lands on its space,
  // the card washes — and only then does the line fold, so the page holds
  // still for the whole flight.
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
        travelDot(rect, targetEl, () => {
          washCard(targetEl)
          fold()
        })
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
      text.classList.add('reading')
      chip.className = 'inbox-state'
      chip.innerHTML = `<i class="working-dot" aria-label="settling"></i>`
    }
  }
}

function renderActivity() {
  const el = $('#activity')
  const a = state.activity[0]
  if (!a) {
    el.innerHTML = ''
    return
  }
  const extra = state.activity.length > 1 ? ` <span>+${state.activity.length - 1} more</span>` : ''
  el.innerHTML =
    `<b>${esc(a.space)}</b> · ${esc(a.summary)}${extra}` +
    (state.canUndo ? ` · <button class="undo" id="undo-btn">undo</button>` : '')
}

const DORMANT_MS = 30 * 86400000
const awake = new Set() // dormant spaces the user woke this session

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
      el.className = 'space fresh'
      el.style.animationDelay = `${Math.min(i * 45, 270)}ms`
      el.dataset.sid = space.id
      el.innerHTML = spaceInner(space)
      box.appendChild(el)
      spaceEls.set(space.id, { el, updatedAt: space.updatedAt })
      drawMeters(el)
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
        }
      }
      // cards receiving a travel dot wash when the dot lands, not before
      if (!delayWash.has(space.id)) washCard(known.el)
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
        known.el.style.animation = 'none'
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
  const on = state.spaces.length >= 3
  rail.classList.toggle('on', on)
  if (!on) return
  const key = state.spaces.map((s) => s.id + s.name).join()
  if (rail.dataset.key === key) return
  rail.dataset.key = key
  rail.innerHTML = state.spaces
    .map((s) => `<a href="#" data-jump="${s.id}">${esc(s.name)}</a>`)
    .join('')
}

function renderSuggestions() {
  const box = $('#suggest')
  const key = (state.suggestions || []).join('|')
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.innerHTML = (state.suggestions || [])
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
  box.innerHTML = `
    <div class="ask">
      <div class="ask-q">${esc(state.ask.question)}</div>
      <div class="chips">
        ${state.ask.options.map((o, i) => `<button class="chip-btn" data-answer="${esc(o)}" style="--d:${i * 45}ms">${esc(o)}</button>`).join('')}
        <button class="skip" data-dismiss>skip</button>
      </div>
    </div>`
}

function renderHint() {
  const empty = !state.spaces.length && !state.captures.length && !(state.suggestions || []).length
  $('#hint').textContent = empty ? 'Rent, a habit, a goal, a stray thought. Write it and it organizes itself.' : ''
}

function render() {
  renderYearline()
  const targets = travelTargets()
  renderSpaces(new Set(targets.values()))
  renderInbox(targets)
  renderActivity()
  renderSuggestions()
  renderAsk()
  renderHint()
  renderRail()
  celebrateDiffs()
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
  nextPrompt()
  try {
    state = await api('/api/capture', { text })
    render()
    schedulePoll()
  } catch (e) {
    field.value = text
    toast(e.message)
  }
}

const field = $('#capture')

// The page greets you like a person, not a form. A new question each visit
// and after every capture.
const PROMPTS = [
  "What's up?",
  "What's new?",
  "What's on your mind?",
  'What do you need to do today?',
  'What happened today?',
  'What are you tracking?',
  'Anything to remember?',
  'What did you get done?',
]
function nextPrompt() {
  let p
  do {
    p = PROMPTS[Math.floor(Math.random() * PROMPTS.length)]
  } while (p === field.placeholder)
  field.placeholder = p
}
nextPrompt()

field.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitCapture()
  }
})
field.addEventListener('input', () => {
  field.style.height = 'auto'
  field.style.height = `${Math.min(field.scrollHeight, 200)}px`
})

// The page is the input: start typing anywhere and it lands in the capture.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (e.key.length === 1) field.focus()
})

document.addEventListener('click', async (e) => {
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

  // suggestion chip: the sentence files as if typed
  const sug = e.target.closest('[data-suggest]')
  if (sug) {
    sug.classList.add('picked')
    const text = sug.dataset.suggest
    const remaining = (state.suggestions || []).filter((s) => s !== text)
    setTimeout(async () => {
      try {
        state = await api('/api/capture', { text })
        state.suggestions = remaining
        render()
        schedulePoll()
        api('/api/tool', { name: 'december_suggest', arguments: { suggestions: remaining } }).catch(() => {})
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

  // rail: jump to a space
  const jump = e.target.closest('[data-jump]')
  if (jump) {
    e.preventDefault()
    const el = document.querySelector(`.space[data-sid="${jump.dataset.jump}"]`)
    if (el) {
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
      el.classList.remove('washed')
      void el.offsetWidth
      el.classList.add('washed')
    }
    return
  }

  // manual check on a list item or reminder — instant, no model
  const row = e.target.closest('.row[data-block]')
  if (row) {
    const done = !row.classList.contains('done')
    row.classList.remove('no-anim')
    row.classList.toggle('done', done)
    if (done) {
      pop(row.querySelector('.tick'))
      celebrate(row.querySelector('.tick'))
      // finishing the whole list earns the card a wash
      const blockEl = row.closest('[data-bid]')
      if (blockEl && ![...blockEl.querySelectorAll('.row')].some((r) => !r.classList.contains('done'))) {
        setTimeout(() => washCard(row.closest('.space')), 300)
      }
    }
    try {
      state = await api('/api/check', { blockId: row.dataset.block, itemId: row.dataset.item, done })
      // adopt silently; the row is already painted
      const known = spaceEls.get(row.closest('.space')?.dataset.sid)
      if (known) known.updatedAt = state.spaces.find((s) => s.id === row.closest('.space').dataset.sid)?.updatedAt
      prev = state
    } catch (err) {
      toast(err.message)
    }
    return
  }

  if (e.target.closest('#undo-btn')) {
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

async function boot() {
  try {
    state = await api('/api/state')
    render()
    schedulePoll()
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:40px;font-family:monospace">could not load: ${e.message}</pre>`
  }
}

boot()
