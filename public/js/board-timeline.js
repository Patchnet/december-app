// Board mode: the plan line, under a repo's board name. The whole line is
// the plan: every task on the board's open cards, one equal stretch each,
// ending at its count ("3 of 10"). It is drawn firm through the tasks
// already closed, in the order they closed, so it builds as the work lands;
// each closed task ends in a tick under the line, light while its proof is
// unchecked. What is left is a faint track with a small notch per task, so
// what remains can be counted at a glance. The marker stands where progress
// has landed: while an agent works, the pen just past it boils, three
// drawings on twos; while the board waits on the person, the marker is red.
// Pointing or arrowing along the line names the task in each stretch.
//
// The hand is SVG only, because the app runs offline: a level line with a
// hand's slight wander and pressure and, on screens dense enough to show it
// (2x and up), graphite grain from a filter. Below that the stroke stays
// clean, since grain finer than a pixel only breaks a line into scratches.
// Ink is currentColor. Paint-only: nothing is moved or faded.
//
//   drawTimeline(host, { board, spaces, ask, now })
// is called on every paint and diffs what is drawn.

const NS = 'http://www.w3.org/2000/svg'
const FPS = 12
const MIN = 60000
const STEP = 4 // css px between samples along the line
const QUIET = 10 * MIN // a task in progress with no word for this long is not being worked (the board's own rule)
const PEN = 14 // css px: how far past the marker the working pen reaches, at most

// strokes, in css px about the line's point: ticks hang under it, the
// marker stands on it, the end post closes it
const MARKS = {
  tick: { c: [[0.2, 1.6], [0.05, 5.5], [-0.1, 9.5]], w: 1.5 },
  notch: { c: [[0, 1.4], [0, 3.2], [0, 4.6]], w: 1.1 },
  post: { c: [[0, -5], [0, 0], [0, 5]], w: 1.2 },
  marker: { c: [[0.15, 4.5], [0, -3], [-0.1, -11]], w: 2.1 },
}
const INK = { line: 0.92, track: 0.2, tick: 0.92, held: 0.34, notch: 0.3, post: 0.38, marker: 1 }
const LINE_W = 1.6
const TRACK_W = 1

const reducedQ = matchMedia('(prefers-reduced-motion: reduce)')
const states = new WeakMap()
let ids = 0

/* ------------------------------------------------------------- the API */
export function drawTimeline(host, { board, spaces, ask = false, now } = {}) {
  if (!host) return
  let st = states.get(host)
  const m = model({ board, spaces, ask, now: Number.isFinite(now) ? now : Date.now() })
  if (!m.slots.length) {
    if (st) destroy(st)
    else if (host.firstChild) host.replaceChildren()
    return
  }
  if (st && !host.contains(st.root)) { destroy(st); st = null }
  if (!st) { st = create(host); states.set(host, st) }
  st.m = m
  render(st)
}

/* ---------------------------------------------------------- what to draw */
const stateOf = (i) => i.state || (i.done ? 'done' : 'queued')

function model({ board, spaces, ask, now }) {
  const rows = []
  for (const space of spaces || []) {
    if (!space || space.finished) continue
    for (const block of space.blocks || []) {
      if (block?.type !== 'list') continue
      for (const item of Array.isArray(block.items) ? block.items : []) {
        if (item && typeof item === 'object' && stateOf(item) !== 'cancelled') rows.push(item)
      }
    }
  }
  const t = (i) => Date.parse(i.doneAt) || 0
  const done = rows.filter((i) => stateOf(i) === 'done').sort((a, b) => t(a) - t(b))
  const doing = rows.filter((i) => stateOf(i) === 'doing')
  const rest = rows.filter((i) => !['done', 'doing'].includes(stateOf(i)))
  const slots = [...done, ...doing, ...rest].map((i) => ({
    key: String(i.id || i.text),
    state: stateOf(i),
    held: stateOf(i) === 'done' && !(i.proof?.ok),
    text: String(i.text || ''),
    reason: String(i.reason || ''),
    doneAt: i.doneAt || '',
  }))
  const s = board?.session
  const last = Date.parse(s?.lastActivityAt) || 0
  const waiting = !!ask || rows.some((i) => stateOf(i) === 'waiting')
  const working = !waiting && doing.length > 0 && !!s && s.live !== false && now - last < QUIET
  return { slots, done: done.length, waiting, working }
}

/* --------------------------------------------------------------- the hand */
function hashOf(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
function rng(seed) {
  let a = hashOf(String(seed))
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ss = (a, b, t) => { const k = Math.min(1, Math.max(0, (t - a) / (b - a))); return k * k * (3 - 2 * k) }
const r2 = (n) => Math.round(n * 100) / 100
const half = (n) => Math.round(n * 2) / 2

// The line's shape: level, with a hand's slight wander and pressure. Fixed
// by the board's repo, so it never reshapes between paints.
class Geo {
  constructor(w, h, n, room, seed) {
    const r = rng(`plan:${seed}`)
    this.w = w; this.h = h; this.n = n
    this.k = w < 560 ? 0.85 : 1
    this.x0 = 1; this.x1 = Math.max(this.x0 + 40, w - room)
    this.sw = (this.x1 - this.x0) / n
    this.mid = Math.round(h * 0.5) + 0.5
    this.p = [r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283]
  }
  at(i) { return this.x0 + i * this.sw } // the boundary before slot i
  y(x) { return this.mid + 0.26 * Math.sin(x / 23 + this.p[0]) + 0.12 * Math.sin(x / 9.7 + this.p[1]) }
  press(x) { return 1 + 0.1 * Math.sin(x / 31 + this.p[2]) + 0.06 * Math.sin(x / 13 + this.p[3]) }
}

// A stroke as a filled outline, so it can swell and taper like a pencil.
function outline(pts, ws) {
  const n = pts.length
  if (n < 2) return ''
  const L = [], R = []
  for (let i = 0; i < n; i++) {
    const a = pts[i ? i - 1 : 0], b = pts[i < n - 1 ? i + 1 : n - 1]
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1
    const nx = -dy / len, ny = dx / len, h = ws[i] / 2
    L.push(`${r2(pts[i][0] + nx * h)},${r2(pts[i][1] + ny * h)}`)
    R.push(`${r2(pts[i][0] - nx * h)},${r2(pts[i][1] - ny * h)}`)
  }
  return `M${L.join('L')}L${R.reverse().join('L')}Z`
}
function spline(c, per = 5) {
  const out = []
  for (let i = 0; i < c.length - 1; i++) {
    const p0 = c[i - 1] || c[i], p1 = c[i], p2 = c[i + 1], p3 = c[i + 2] || c[i + 1]
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t
      const at = (j) => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t3)
      out.push([at(0), at(1)])
    }
  }
  out.push(c.at(-1))
  return out
}

// A stretch of the line from xa to xb. `down` tapers the start (the pen set
// down), `pen` the end where the pen still is.
function stretch(g, xa, xb, w, { down = false, pen = false, wob = null } = {}) {
  const n = Math.max(1, Math.ceil((xb - xa) / STEP))
  const pts = [], ws = []
  for (let i = 0; i <= n; i++) {
    const x = xa + ((xb - xa) * i) / n
    pts.push([x, g.y(x) + (wob ? wob(x) : 0)])
    let v = w * g.press(x)
    if (down) v *= 0.5 + 0.5 * ss(0, 8, x - xa)
    if (pen) v *= 0.6 + 0.4 * ss(0, 5, xb - x)
    ws.push(v)
  }
  return outline(pts, ws)
}

// A mark at x: a pencil stroke, full at once and eased at its end.
function mark(kind, g, x, key) {
  const r = rng(key), p = MARKS[kind], y = g.y(x)
  const c = p.c.map(([dx, dy]) => [x + (dx + (r() - 0.5) * 0.3) * g.k, y + dy * g.k])
  const pts = spline(c, 4)
  const ws = pts.map((_, i) => { const t = i / (pts.length - 1); return p.w * (0.78 + 0.22 * ss(0, 0.2, t)) * (1 - 0.35 * ss(0.65, 1, t)) })
  return outline(pts, ws)
}

// Graphite, on dense screens only: fine noise takes ink out of the stroke in
// specks, the way a pencil skips across paper, and a slower noise along the
// line is the hand pressing harder and lighter. Same seed, same grain.
function grain(id, seed, w, h) {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="-8" y="-12" width="${w + 16}" height="${h + 24}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="2 1.6" numOctaves="2" seed="${seed}" result="n"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.035 0.25" numOctaves="1" seed="${seed + 3}" result="p"/>` +
    '<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 2.2 0 0.15" result="s"/>' +
    '<feColorMatrix in="p" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 0.35" result="q"/>' +
    '<feComposite in="s" in2="q" operator="in" result="m"/>' +
    '<feComposite in="SourceGraphic" in2="m" operator="in"/></filter>'
}

/* ---------------------------------------------------------------- the DOM */
function el(tag, attrs = {}, ns = null) {
  const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}
const svg = (tag, attrs) => el(tag, attrs, NS)
const path = (parent, a, cls = '') => { const p = svg('path', { fill: 'currentColor', 'fill-opacity': a, ...(cls ? { class: cls } : {}) }); parent.append(p); return p }

function create(host) {
  const id = `bpl${++ids}`
  const root = el('div', { class: 'board-timeline-in' })
  const ink = svg('svg', { class: 'board-timeline-ink', 'aria-hidden': 'true', focusable: 'false' })
  const defs = svg('defs')
  const body = svg('g')
  const track = path(body, INK.track)
  const notches = path(body, INK.notch)
  const post = path(body, INK.post)
  const line = path(body, INK.line)
  const ticks = path(body, INK.tick)
  const held = path(body, INK.held)
  const marker = path(body, INK.marker, 'board-timeline-marker')
  const tip = svg('g', { class: 'board-timeline-tip' })
  ink.append(defs, body, tip)
  const count = el('span', { class: 'board-timeline-count' })
  const keys = el('div', { class: 'board-timeline-keys', role: 'list' })
  const read = el('div', { class: 'board-timeline-read', 'aria-hidden': 'true' })
  root.append(ink, count, keys, read)
  host.replaceChildren(root)
  const st = {
    id, host, root, ink, defs, body, track, notches, post, line, ticks, held, marker, tip, count, keys, read,
    shapeKey: '', g: null, w: 0, fine: false, shown: -1, drawT: 0, frame: 0, touchT: 0, boilT: 0, boilI: 0,
    tipKey: '', tipPaths: [], items: [], keyEls: new Map(), roving: '', saying: '', m: null,
  }
  root.addEventListener('pointermove', (e) => point(st, e))
  root.addEventListener('pointerdown', (e) => point(st, e))
  root.addEventListener('pointerleave', (e) => {
    clearTimeout(st.touchT)
    if (keys.contains(document.activeElement)) return
    // a tap has no hover to end it: the readout stays long enough to read
    if (e.pointerType === 'touch') st.touchT = setTimeout(() => hide(st), 2400)
    else hide(st)
  })
  keys.addEventListener('focusin', (e) => {
    const it = st.items.find((i) => st.keyEls.get(i.key) === e.target)
    if (it) { rove(st, it.key); say(st, it) }
  })
  keys.addEventListener('focusout', (e) => { if (!keys.contains(e.relatedTarget)) hide(st) })
  keys.addEventListener('keydown', (e) => key(st, e))
  st.ro = new ResizeObserver(() => {
    if (Math.round(host.clientWidth) === st.w) return
    cancelAnimationFrame(st.frame)
    st.frame = requestAnimationFrame(() => render(st))
  })
  st.ro.observe(host)
  st.onMotion = () => render(st)
  reducedQ.addEventListener('change', st.onMotion)
  return st
}

function destroy(st) {
  stopBoil(st)
  clearTimeout(st.drawT)
  clearTimeout(st.touchT)
  cancelAnimationFrame(st.frame)
  st.ro.disconnect()
  reducedQ.removeEventListener('change', st.onMotion)
  states.delete(st.host)
  st.host.replaceChildren()
}

function render(st) {
  const m = st.m
  if (!m || !st.root.isConnected) return stopBoil(st)
  const w = Math.round(st.host.clientWidth)
  st.w = w
  if (w < 60) return stopBoil(st) // not laid out yet; the observer calls back
  const h = Math.round(st.host.clientHeight) || 28
  const n = m.slots.length
  // the count first: the line ends where its words begin
  const all = m.done === n
  const words = `<b>${m.done}</b> of ${n}`
  if (st.count.innerHTML !== words) st.count.innerHTML = words
  st.count.classList.toggle('all', all)
  st.count.setAttribute('aria-label', `${m.done} of ${n} tasks done`)
  const room = Math.ceil(st.count.offsetWidth) + 14
  const fine = (devicePixelRatio || 1) >= 1.75
  const shape = `${w}|${h}|${n}|${room}|${fine}`
  const fresh = shape !== st.shapeKey
  if (fresh) {
    st.shapeKey = shape
    st.fine = fine
    st.g = new Geo(w, h, n, room, st.host.dataset.seed || 'board')
    st.ink.setAttribute('viewBox', `0 0 ${w} ${h}`)
    st.ink.setAttribute('width', w)
    st.ink.setAttribute('height', h)
    const seed = hashOf(`grain:${st.host.dataset.seed || 'board'}`) % 997
    st.defs.innerHTML = fine ? grain(`${st.id}-g`, seed, w, h) + [0, 1, 2].map((k) => grain(`${st.id}-t${k}`, seed + 11 + k * 7, w, h)).join('') : ''
    if (fine) st.body.setAttribute('filter', `url(#${st.id}-g)`)
    else st.body.removeAttribute('filter')
    st.tip.replaceChildren(); st.tipPaths = []; st.tipKey = ''
    st.keys.setAttribute('aria-label', 'The plan, task by task')
    hide(st)
  }
  // a task just closed: the pen draws its stretch, three drawings on twos
  const from = st.shown < 0 || fresh ? m.done : Math.min(st.shown, m.done)
  clearTimeout(st.drawT)
  if (from < m.done && !reducedQ.matches) {
    const steps = [0.38, 0.72, 1]
    let i = 0
    const next = () => {
      paintBody(st, m, from + (m.done - from) * steps[i])
      if (++i < steps.length) st.drawT = setTimeout(next, 1000 / FPS)
      else finish(st, m)
    }
    next()
  } else {
    paintBody(st, m, m.done)
    finish(st, m)
  }
  st.shown = m.done
  st.marker.classList.toggle('needs', m.waiting)
}

function finish(st, m) {
  drawTip(st, m)
  drawKeys(st, m)
  if (m.working && !reducedQ.matches && st.tipPaths.length > 1) startBoil(st)
  else stopBoil(st)
}

// Everything but the working pen, with progress standing at `at` tasks.
function paintBody(st, m, at) {
  const g = st.g, n = m.slots.length
  const X = half(g.at(at))
  st.line.setAttribute('d', X - g.x0 >= 1 ? stretch(g, g.x0, X, LINE_W, { down: true }) : '')
  st.track.setAttribute('d', g.x1 - X >= 1 ? stretch(g, X, g.x1, TRACK_W) : '')
  // a closed task's tick at its stretch's end; the marker stands on the last
  let ticks = '', held = ''
  if (g.sw >= 4) {
    for (let i = 0; i < Math.floor(at) - 1; i++) {
      const d = mark('tick', g, half(g.at(i + 1)), `t:${m.slots[i].key}`)
      if (m.slots[i].held) held += d
      else ticks += d
    }
  }
  st.ticks.setAttribute('d', ticks)
  st.held.setAttribute('d', held)
  // what is left: a notch between tasks, and the post that ends the plan
  let notches = ''
  if (g.sw >= 6) for (let i = Math.ceil(at) + 1; i < n; i++) notches += mark('notch', g, half(g.at(i)), `n:${i}`)
  st.notches.setAttribute('d', notches)
  st.post.setAttribute('d', at < n ? mark('post', g, g.x1, 'post') : '')
  st.marker.setAttribute('d', mark('marker', g, X, 'marker'))
}

// The working pen: just past the marker, into the task in hand, in three
// drawings that differ only in the hand's last wobble and the grain.
function drawTip(st, m) {
  const g = st.g
  if (!m.working) {
    if (st.tipPaths.length) { st.tip.replaceChildren(); st.tipPaths = []; st.tipKey = '' }
    return
  }
  const xa = half(g.at(m.done)) + 1.5
  const xb = Math.min(g.x1, xa + Math.max(6, Math.min(PEN, g.sw * 0.6)))
  const n = reducedQ.matches ? 1 : 3
  const key = `${xa}|${xb}|${n}`
  if (key === st.tipKey) return
  st.tipKey = key
  st.tip.replaceChildren()
  st.tipPaths = Array.from({ length: n }, (_, k) => {
    const grp = svg('g', st.fine ? { filter: `url(#${st.id}-t${k})` } : {})
    const p = path(grp, INK.line)
    const wob = k ? (x) => ss(xa, xb, x) * 0.6 * Math.sin(x / 4.1 + k * 2.3) : null
    p.setAttribute('d', stretch(g, xa, xb + [0, 0.8, -0.6][k], LINE_W, { pen: true, wob }))
    grp.setAttribute('visibility', k === 0 ? 'visible' : 'hidden')
    st.tip.append(grp)
    return grp
  })
  st.boilI = 0
}

function startBoil(st) {
  if (st.boilT) return
  st.boilT = setInterval(() => {
    if (!st.root.isConnected) return stopBoil(st)
    if (document.hidden || st.tipPaths.length < 2) return
    showTip(st, (st.boilI + 1) % st.tipPaths.length)
  }, 1000 / FPS)
}
function stopBoil(st) {
  if (st.boilT) { clearInterval(st.boilT); st.boilT = 0 }
  if (st.boilI && st.tipPaths.length) showTip(st, 0)
}
function showTip(st, i) {
  st.tipPaths[st.boilI]?.setAttribute('visibility', 'hidden')
  st.boilI = i
  st.tipPaths[i]?.setAttribute('visibility', 'visible')
}

/* ------------------------------------------------------ reading the line */
function clock(t) {
  const d = new Date(t)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

// One stop per task, in the line's order, each saying what its stretch is.
function sayOf(s, waiting) {
  if (s.state === 'done') return `${s.doneAt ? `closed ${clock(Date.parse(s.doneAt))}` : 'closed'} · ${s.text}${s.held ? ' · proof unchecked' : ''}`
  if (s.state === 'doing') return `${waiting ? 'paused' : 'in hand'} · ${s.text}`
  if (s.state === 'waiting') return `needs you · ${s.text}`
  if (s.state === 'blocked') return `blocked · ${s.text}${s.reason ? ` · ${s.reason}` : ''}`
  return `planned · ${s.text}`
}

function drawKeys(st, m) {
  const g = st.g
  const items = m.slots.map((s, i) => ({ key: s.key, i, x: r2(g.at(i) + g.sw / 2), text: sayOf(s, m.waiting) }))
  st.items = items
  const seen = new Set()
  let next = null
  for (let j = items.length - 1; j >= 0; j--) {
    const it = items[j]
    seen.add(it.key)
    let k = st.keyEls.get(it.key)
    if (!k) {
      k = el('span', { class: 'board-timeline-key', role: 'listitem', tabindex: '-1' })
      k.append(el('span', { class: 'sr-only' }))
      st.keys.insertBefore(k, next)
      st.keyEls.set(it.key, k)
    } else if (k.nextSibling !== next) st.keys.insertBefore(k, next)
    if (k.firstChild.textContent !== it.text) k.firstChild.textContent = it.text
    const width = Math.max(6, Math.min(18, g.sw))
    const left = `${r2(it.x - width / 2)}px`, top = `${r2(g.mid - 11)}px`
    if (k.style.left !== left) { k.style.left = left; k.style.width = `${width}px` }
    if (k.style.top !== top) k.style.top = top
    next = k
  }
  for (const [key, k] of st.keyEls) {
    if (seen.has(key)) continue
    k.remove()
    st.keyEls.delete(key)
  }
  // the roving stop starts where progress stands
  if (!seen.has(st.roving)) rove(st, items[Math.min(m.done, items.length - 1)]?.key || '')
  if (st.saying) {
    const it = items.find((i) => i.key === st.saying)
    if (it) { st.saying = ''; say(st, it) } else hide(st)
  }
}

function rove(st, key) {
  st.roving = key
  for (const [k, e] of st.keyEls) e.tabIndex = k === key ? 0 : -1
}

function key(st, e) {
  const i = st.items.findIndex((it) => st.keyEls.get(it.key) === e.target)
  if (i < 0) return
  const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: st.items.length - 1 }[e.key]
  if (to === undefined) return
  e.preventDefault()
  const it = st.items[Math.max(0, Math.min(st.items.length - 1, to))]
  rove(st, it.key)
  st.keyEls.get(it.key)?.focus()
}

// The task whose stretch is under the pointer.
function point(st, e) {
  const g = st.g
  if (!g) return
  const x = e.clientX - st.root.getBoundingClientRect().left
  if (x < g.x0 - 6 || x > g.x1 + 6) {
    if (!st.keys.contains(document.activeElement)) hide(st)
    return
  }
  const i = Math.max(0, Math.min(st.items.length - 1, Math.floor((x - g.x0) / g.sw)))
  if (st.items[i]) say(st, st.items[i])
}

function say(st, it) {
  if (st.saying === it.key) return
  st.saying = it.key
  const r = st.read
  r.textContent = it.text
  r.style.left = '0px'
  const w = r.offsetWidth
  r.style.left = `${r2(Math.max(0, Math.min(st.w - w, it.x - w / 2)))}px`
  r.style.top = `${Math.round(st.g.mid + 11 * st.g.k)}px`
  r.classList.add('on')
}

function hide(st) {
  st.saying = ''
  st.read.classList.remove('on')
}
