// Board mode: the line across the top of a repo's board, which is the
// session's clock. The left end is when the session started and the pen is
// now. A task closed this session notches under the line; a commit crosses
// it; a wait on the person is a gap that ends in a pen-lift flick (still
// open, the pen stays lifted); a file changed outside any card's scope is a
// stray mark above it. While an agent works, the last stretch at the pen
// boils, three drawings on twos. Nothing else on the line moves.
//
// The hand is SVG only, because the app runs offline: a curve fixed by the
// session's start time, a slow wobble, pencil outlines that taper, and
// graphite grain from a filter. Ink is currentColor. It is paint-only: no
// layer is moved or faded; the boil swaps which of three small tip drawings
// is visible.
//
//   drawTimeline(host, { board, spaces, now })
// is called on every paint. It diffs what is drawn and never restarts the
// boil. Only a new width or a new session redraws from nothing; when the
// clock's scale steps out, the marks are redrawn in place.

const NS = 'http://www.w3.org/2000/svg'
const FPS = 12
const MIN = 60000
const TIP = 22 // css px nearest the pen: the only stretch that boils
const STEP = 4 // css px between samples along the line
// the clock's scale, in minutes; it steps out before the pen passes FILL
const SCALES = [30, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720, 960, 1200, 1440]
const FILL = 0.86
const COMPACT = 560 // narrower than this, marks draw a little smaller
const QUIET = 10 * MIN // a task in progress with no word for this long is not being worked (the board's own rule)

// The marks, in css px about the line's point. Under the line: work closed.
// Across it: work kept. Above it: work off the plan. `a` is the pass's ink.
const MARKS = {
  task: [{ c: [[-0.6, 1.8], [0.1, 4.3], [0.9, 7]], w: 1.15 }],
  commit: [
    { c: [[-2.2, -8.6], [-0.2, 0], [2.1, 8.6]], w: 1.75 },
    { c: [[-1.2, -8], [0.6, 0.4], [2.8, 8]], w: 0.95, a: 0.55 },
  ],
  stray: [{ c: [[-5.5, -10.4], [-0.5, -12.8], [5, -15]], w: 1.1 }],
  lift: [{ c: [[-6, 0.3], [-1.6, -0.2], [1.8, -3.4], [3.5, -7.2]], w: 1.2 }],
}
const LINE = { w: 1.05, a: 0.9 } // the main pass
const GHOST = { w: 0.8, dx: 0.5, dy: 0.9, a: 0.4 } // the second, lighter pass

const reducedQ = matchMedia('(prefers-reduced-motion: reduce)')
const states = new WeakMap()
let ids = 0

/* ------------------------------------------------------------- the API */
export function drawTimeline(host, { board, spaces, now } = {}) {
  if (!host) return
  let st = states.get(host)
  const start = Date.parse(board?.session?.startedAt)
  if (!Number.isFinite(start)) {
    if (st) destroy(st)
    else if (host.firstChild) host.replaceChildren()
    return
  }
  if (st && !host.contains(st.root)) { destroy(st); st = null }
  if (!st) { st = create(host); states.set(host, st) }
  const t = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now
  st.input = { board, spaces, now: Number.isFinite(t) ? t : Date.now(), at: Date.now() }
  render(st)
}

/* ---------------------------------------------------------- what to draw */
function rowsOf(spaces) {
  const rows = []
  for (const space of spaces || []) {
    for (const block of space?.blocks || []) {
      for (const item of Array.isArray(block?.items) ? block.items : []) if (item && typeof item === 'object') rows.push(item)
    }
  }
  return rows
}

function model({ board, spaces, now: given, at }, wall = Date.now()) {
  const start = Date.parse(board.session.startedAt)
  // between paints the clock keeps running from the last `now` it was given
  const now = Math.max(start, given + Math.max(0, wall - at))
  const rows = rowsOf(spaces)
  const doing = rows.filter((r) => r.state === 'doing')
  const marks = []
  for (const r of rows) {
    if (!(r.state === 'done' || (!r.state && r.done))) continue
    const t = Date.parse(r.doneAt)
    if (!(t >= start)) continue
    marks.push({ kind: 'task', key: `t:${r.id || r.text}:${r.doneAt}`, t, text: `${clock(t)} · ${r.text || ''}` })
  }
  for (const c of board.commits || []) {
    const t = Date.parse(c?.at)
    if (!Number.isFinite(t) || t < start - MIN) continue
    const sha = String(c.sha || '').slice(0, 7)
    marks.push({ kind: 'commit', key: `c:${c.sha || c.at}`, t, text: [sha, c.subject].filter(Boolean).join(' · ') })
  }
  for (const d of board.drift || []) {
    const t = Date.parse(d?.since)
    if (!Number.isFinite(t) || !d.path) continue
    marks.push({ kind: 'stray', key: `s:${d.path}`, t, text: `${clock(t)} · ${d.path}, outside any card` })
  }
  const waits = (board.waits || [])
    .map((w) => ({ at: Date.parse(w?.at), until: w?.until ? Date.parse(w.until) : null, q: w?.question || '' }))
    .filter((w) => Number.isFinite(w.at) && w.at >= start - MIN && w.at <= now && (w.until === null || Number.isFinite(w.until)))
    .sort((a, b) => a.at - b.at)

  // where the pen is: lifted at an open wait; at now while an agent works;
  // otherwise resting where the last thing happened. A task left in
  // progress keeps the pen down until the board calls it quiet, so the pen
  // stops rather than stepping back; an ended session rests at its end.
  let last = Date.parse(board.session.lastActivityAt) || start
  for (const m of marks) last = Math.max(last, m.t)
  for (const w of waits) last = Math.max(last, w.until ?? w.at)
  const ended = Date.parse(board.session.endedAt) || Infinity
  const live = board.session.live !== false && ended === Infinity
  const rest = Math.min(ended, doing.length && live ? last + QUIET : last)
  const segs = []
  let from = start, open = null
  for (const w of waits) {
    const a = Math.max(w.at, start)
    if (a < from) continue
    segs.push({ a: from, b: a, end: 'lift', wait: w })
    if (w.until === null) { open = w; break }
    from = Math.max(a, Math.min(w.until, now))
  }
  const working = !open && doing.length > 0 && live && now < last + QUIET
  const tipAt = open ? open.at : working ? now : Math.max(from, Math.min(now, rest))
  if (!open) segs.push({ a: from, b: Math.max(from, tipAt), end: 'tip' })
  const end = open ? now : Math.max(from, tipAt)
  for (const m of marks) m.t = Math.min(Math.max(m.t, start), end)

  let scale = SCALES.find((v) => (end - start) / MIN <= v * FILL)
  if (!scale) { scale = SCALES.at(-1); while ((end - start) / MIN > scale * FILL) scale *= 2 }
  const task = doing.slice().sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0))[0]
  return { start, now, end, scale: scale * MIN, marks, waits, segs, open, working, tipAt, task: task?.text || '' }
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

// The line's shape for one session: one long swell and a shallower one
// across the whole width, with a hand's slow wander on top. Fixed by the
// session's start, so it never reshapes between paints; the pen only runs
// further along it.
class Geo {
  constructor(w, h, start, scale) {
    const r = rng(`line:${start}`)
    this.w = w; this.h = h; this.start = start; this.scale = scale
    this.compact = w < COMPACT
    this.k = this.compact ? 0.82 : 1
    this.x0 = 3; this.x1 = w - 6
    this.mid = h * 0.56
    this.amp = Math.min(9, w / 70)
    this.p = [0.25 + (r() - 0.5) * 0.5, 1 + (r() - 0.5) * 1.2, r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283]
  }
  x(t) { return this.x0 + ((t - this.start) / this.scale) * (this.x1 - this.x0) }
  y(x) {
    const u = (x - this.x0) / (this.x1 - this.x0), p = this.p
    return this.mid + this.amp * (0.85 * Math.sin(u * Math.PI * 1.5 + p[0]) + 0.15 * Math.sin(u * Math.PI * 3.4 + p[1])) +
      0.34 * Math.sin(x / 23 + p[2]) + 0.18 * Math.sin(x / 9.7 + p[3])
  }
  // the hand's pressure along the line
  press(x) { return 1 + 0.12 * Math.sin(x / 31 + this.p[4]) + 0.07 * Math.sin(x / 13 + this.p[5]) }
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
// the first f of a stroke, so a mark draws on as the same stroke
function prefix(pts, ws, f) {
  if (f >= 1) return [pts, ws]
  const d = [0]
  for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const want = d.at(-1) * f
  const P = [pts[0]], W = [ws[0]]
  for (let i = 1; i < pts.length; i++) {
    if (d[i] <= want) { P.push(pts[i]); W.push(ws[i]); continue }
    const k = (want - d[i - 1]) / (d[i] - d[i - 1] || 1)
    P.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k])
    W.push(ws[i - 1] + (ws[i] - ws[i - 1]) * k)
    break
  }
  return P.length > 1 ? [P, W] : [[pts[0], pts[0]], [ws[0], ws[0]]]
}

// A stretch of the line from xa to xb: the main pass and the lighter
// second pass under it. `down` tapers the start (the pen set down), `lift`
// the end into a flick, `pen` the end where the pen still is.
function stretch(g, xa, xb, { down = false, lift = false, pen = false, wob = null } = {}) {
  const n = Math.max(1, Math.ceil((xb - xa) / STEP))
  const pts = [], ws = []
  for (let i = 0; i <= n; i++) {
    const x = xa + ((xb - xa) * i) / n
    pts.push([x, g.y(x) + (wob ? wob(x) : 0)])
    let w = LINE.w * g.press(x)
    if (down) w *= 0.45 + 0.55 * ss(0, 8, x - xa)
    if (lift) w *= 0.7 + 0.3 * ss(0, 6, xb - x)
    if (pen) w *= 0.62 + 0.38 * ss(0, 4, xb - x)
    ws.push(w)
  }
  const ghost = pts.map(([x, y]) => [x + GHOST.dx, y + GHOST.dy])
  return [outline(ghost, ws.map((w) => (w * GHOST.w) / LINE.w)), outline(pts, ws)]
}

function markPasses(kind, x, y, k, key) {
  const r = rng(key)
  return MARKS[kind].map((p) => {
    const c = p.c.map(([dx, dy]) => [x + (dx + (r() - 0.5) * 0.5) * k, y + (dy + (r() - 0.5) * 0.5) * k])
    const pts = spline(c, 5)
    const end = kind === 'lift' ? 0.72 : 0.5
    const ws = pts.map((_, i) => {
      const t = i / (pts.length - 1)
      return p.w * (0.5 + 0.5 * ss(0, 0.25, t)) * (1 - end * ss(0.6, 1, t))
    })
    return { pts, ws, a: p.a || 1 }
  })
}

// Graphite: fine noise roughens the edge and takes ink out of the stroke in
// specks, the way a pencil skips across paper; a slower noise along the line
// is the hand pressing harder and lighter. Same seed, same grain. At 1x a
// speck is smaller than a pixel and would only grey the line, so the grain
// there takes out less ink.
function grain(id, seed, w, h, fine) {
  const [sa, sb, qa, qb] = fine ? [2.2, -0.25, 1.6, 0.05] : [1.5, 0.15, 1.2, 0.3]
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="-8" y="-8" width="${w + 16}" height="${h + 16}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="2 1.6" numOctaves="2" seed="${seed}" result="n"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.035 0.25" numOctaves="1" seed="${seed + 3}" result="p"/>` +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="0.4" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 ${sa} 0 ${sb}" result="s"/>` +
    `<feColorMatrix in="p" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${qa} 0 0 0 ${qb}" result="q"/>` +
    '<feComposite in="s" in2="q" operator="in" result="m"/>' +
    '<feComposite in="d" in2="m" operator="in"/></filter>'
}

/* ---------------------------------------------------------------- the DOM */
function el(tag, attrs = {}, ns = null) {
  const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}
const svg = (tag, attrs) => el(tag, attrs, NS)

function create(host) {
  const id = `btl${++ids}`
  const root = el('div', { class: 'board-timeline-in' })
  const ink = svg('svg', { class: 'board-timeline-ink', 'aria-hidden': 'true', focusable: 'false' })
  const defs = svg('defs')
  const body = svg('g', { filter: `url(#${id}-g)` })
  const line = svg('g', { class: 'board-timeline-line' })
  const marks = svg('g', { class: 'board-timeline-marks' })
  const tip = svg('g', { class: 'board-timeline-tip' })
  body.append(line, marks)
  ink.append(defs, body, tip)
  const keys = el('div', { class: 'board-timeline-keys', role: 'list' })
  const read = el('div', { class: 'board-timeline-read', 'aria-hidden': 'true' })
  root.append(ink, keys, read)
  host.replaceChildren(root)
  const st = {
    id, host, root, ink, defs, line, marks, tip, keys, read,
    shapeKey: '', scale: 0, g: null, ready: false, w: 0, glideT: 0,
    segs: [], markMap: new Map(), tipKey: '', tipGs: [], boilT: 0, boilI: 0,
    items: [], keyEls: new Map(), roving: '', saying: '', clockT: 0, frame: 0, touchT: 0, readTop: 0,
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
  clearTimeout(st.clockT)
  clearTimeout(st.glideT)
  clearTimeout(st.touchT)
  cancelAnimationFrame(st.frame)
  for (const rec of st.markMap.values()) rec.timers.forEach(clearTimeout)
  st.ro.disconnect()
  reducedQ.removeEventListener('change', st.onMotion)
  states.delete(st.host)
  st.host.replaceChildren()
}

function render(st) {
  clearTimeout(st.clockT)
  if (!st.input) return
  if (!st.root.isConnected) return stopBoil(st)
  const w = Math.round(st.host.clientWidth)
  st.w = w
  if (w < 60) return stopBoil(st) // not laid out yet; the observer calls back
  const h = Math.round(st.host.clientHeight) || 46
  const m = model(st.input)
  const dpr = (devicePixelRatio || 1) >= 1.5 ? 2 : 1
  const fresh = `${w}|${h}|${dpr}|${m.start}` !== st.shapeKey
  if (fresh) rebuild(st, w, h, dpr, m)
  else if (m.scale !== st.scale) glide(st, m.scale)
  st.scale = m.scale
  draw(st, m, st.ready && !fresh)
  st.ready = true
  if (m.working) {
    // the pen keeps time between paints: one redraw per half pixel it moves
    const ms = m.scale / (st.g.x1 - st.g.x0) / 2
    st.clockT = setTimeout(() => render(st), Math.min(30000, Math.max(1000, ms)))
  }
}

function draw(st, m, animate) {
  const reduced = reducedQ.matches
  drawLine(st, m)
  drawMarks(st, m, animate && !reduced)
  drawTip(st, m, reduced)
  drawKeys(st, m)
  if (m.working && !reduced) startBoil(st)
  else stopBoil(st)
}

// A new width or a new session redraws from nothing, with no motion.
function rebuild(st, w, h, dpr, m) {
  clearTimeout(st.glideT)
  st.shapeKey = `${w}|${h}|${dpr}|${m.start}`
  st.g = new Geo(w, h, m.start, m.scale)
  st.ink.setAttribute('viewBox', `0 0 ${w} ${h}`)
  st.ink.setAttribute('width', w)
  st.ink.setAttribute('height', h)
  const seed = hashOf(`grain:${m.start}`) % 997
  const fine = dpr > 1
  st.defs.innerHTML = grain(`${st.id}-g`, seed, w, h, fine) + [0, 1, 2].map((k) => grain(`${st.id}-t${k}`, seed + 11 + k * 7, w, h, fine)).join('')
  st.line.replaceChildren(); st.segs = []
  for (const rec of st.markMap.values()) rec.timers.forEach(clearTimeout)
  st.marks.replaceChildren(); st.markMap.clear()
  st.tip.replaceChildren(); st.tipGs = []; st.tipKey = ''
  st.keys.setAttribute('aria-label', `Session line from ${clock(m.start)}`)
  // the readout sits on one line under the lowest a mark can hang
  st.readTop = Math.round(st.g.mid + st.g.amp + 9 * st.g.k)
  st.ready = false
  hide(st)
}

// When the pen nears the right edge the clock's scale steps out and every
// mark moves left together. The hand redraws it in four drawings on twos,
// easing out, so the eye can follow what moved; reduced motion just lands.
function glide(st, to) {
  clearTimeout(st.glideT)
  const from = st.g.scale
  if (!st.ready || reducedQ.matches) { st.g.scale = to; return }
  const steps = [0.45, 0.78, 0.94, 1]
  let i = 0
  st.g.scale = from + (to - from) * steps[0]
  const next = () => {
    i++
    st.g.scale = from + (to - from) * steps[i]
    if (st.input && st.root.isConnected) draw(st, model(st.input), true)
    if (i < steps.length - 1) st.glideT = setTimeout(next, 1000 / FPS)
  }
  st.glideT = setTimeout(next, 1000 / FPS)
}

function pair(parent) {
  const g = svg('g')
  const ghost = svg('path', { fill: 'currentColor', 'fill-opacity': GHOST.a })
  const main = svg('path', { fill: 'currentColor', 'fill-opacity': LINE.a })
  g.append(ghost, main)
  parent.append(g)
  return { g, ghost, main }
}

function drawLine(st, m) {
  const g = st.g, want = []
  for (const s of m.segs) {
    const xa = half(g.x(s.a)), xb = half(g.x(s.b))
    const end = s.end === 'tip' ? Math.max(xa, xb - TIP) : xb
    if (end - xa < 1) continue
    want.push({ key: `${xa}|${end}|${s.end}`, xa, xb: end, lift: s.end === 'lift' })
  }
  want.forEach((s, i) => {
    let rec = st.segs[i]
    if (rec && rec.key === s.key) return
    if (!rec) rec = st.segs[i] = pair(st.line)
    const [ghost, main] = stretch(g, s.xa, s.xb, { down: true, lift: s.lift })
    rec.ghost.setAttribute('d', ghost)
    rec.main.setAttribute('d', main)
    rec.key = s.key
  })
  for (const rec of st.segs.splice(want.length)) rec.g.remove()
}

function drawMarks(st, m, animate) {
  const g = st.g, want = new Map()
  for (const mk of m.marks) want.set(mk.key, { ...mk, x: half(g.x(mk.t)) })
  for (const s of m.segs) if (s.end === 'lift') want.set(`w:${s.wait.at}`, { kind: 'lift', key: `w:${s.wait.at}`, x: half(g.x(s.b)) })
  for (const [k, rec] of st.markMap) {
    if (want.has(k)) continue
    rec.timers.forEach(clearTimeout)
    rec.g.remove()
    st.markMap.delete(k)
  }
  for (const mk of want.values()) {
    let rec = st.markMap.get(mk.key)
    const sig = `${mk.kind}|${mk.x}`
    if (rec && rec.sig === sig) continue
    const passes = markPasses(mk.kind, mk.x, g.y(mk.x), g.k, mk.key)
    const isNew = !rec
    if (!rec) {
      rec = { g: svg('g', { class: `board-timeline-${mk.kind}` }), paths: [], timers: [] }
      rec.paths = passes.map((p) => svg('path', { fill: 'currentColor', ...(p.a < 1 ? { 'fill-opacity': p.a } : {}) }))
      rec.g.append(...rec.paths)
      st.marks.append(rec.g)
      st.markMap.set(mk.key, rec)
    }
    rec.sig = sig
    rec.timers.forEach(clearTimeout); rec.timers = []
    const put = (f) => passes.forEach((p, i) => rec.paths[i].setAttribute('d', outline(...prefix(p.pts, p.ws, f))))
    if (isNew && animate) {
      // three drawings on twos, then the mark rests
      const frames = [0.38, 0.72, 1]
      put(frames[0])
      frames.slice(1).forEach((f, i) => rec.timers.push(setTimeout(() => put(f), ((i + 1) * 1000) / FPS)))
    } else put(1)
  }
}

// The stretch nearest the pen, in three drawings that differ only in the
// hand's last wobble and the grain. They meet the body at the same point.
function drawTip(st, m, reduced) {
  const s = m.segs.at(-1)
  if (!s || s.end !== 'tip') {
    if (st.tipGs.length) { st.tip.replaceChildren(); st.tipGs = []; st.tipKey = '' }
    return
  }
  const g = st.g
  const xa = half(g.x(s.a)), xb = Math.max(xa + 1, half(g.x(s.b)))
  // the pen set down after a wait with nothing drawn since: no speck
  if (!m.working && xb - xa < 2) {
    if (st.tipGs.length) { st.tip.replaceChildren(); st.tipGs = []; st.tipKey = '' }
    return
  }
  const j = Math.max(xa, xb - TIP)
  const n = m.working && !reduced ? 3 : 1
  const key = `${j}|${xb}|${n}`
  if (key === st.tipKey) return
  st.tipKey = key
  if (st.tipGs.length !== n) {
    st.tip.replaceChildren()
    st.tipGs = Array.from({ length: n }, (_, k) => {
      const grp = svg('g', { filter: `url(#${st.id}-t${k})` })
      const p = pair(grp)
      st.tip.append(grp)
      return { grp, ...p }
    })
    st.boilI = 0
    st.tipGs.forEach((t, k) => t.grp.setAttribute('visibility', k === 0 ? 'visible' : 'hidden'))
  }
  // the point wanders a little: a hair of wobble and of reach per drawing
  st.tipGs.forEach((t, k) => {
    const wob = k ? (x) => ss(j, xb, x) * 0.65 * Math.sin(x / 4.1 + k * 2.3) : null
    const [ghost, main] = stretch(g, j, xb + [0, 0.8, -0.6][k], { down: j === xa, pen: true, wob })
    t.ghost.setAttribute('d', ghost)
    t.main.setAttribute('d', main)
  })
}

function startBoil(st) {
  if (st.boilT || st.tipGs.length < 2) return
  st.boilT = setInterval(() => {
    if (!st.root.isConnected) return stopBoil(st)
    if (document.hidden || st.tipGs.length < 2) return
    showTip(st, (st.boilI + 1) % st.tipGs.length)
  }, 1000 / FPS)
}
function stopBoil(st) {
  if (st.boilT) { clearInterval(st.boilT); st.boilT = 0 }
  if (st.boilI && st.tipGs.length) showTip(st, 0)
}
function showTip(st, i) {
  st.tipGs[st.boilI]?.grp.setAttribute('visibility', 'hidden')
  st.boilI = i
  st.tipGs[i]?.grp.setAttribute('visibility', 'visible')
}

/* ------------------------------------------------------ reading the line */
function clock(t) {
  const d = new Date(t)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}
function span(a, b) {
  const x = clock(a), y = clock(b)
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`
}

// Everything a pointer or a key can land on, in time order.
function itemsOf(st, m) {
  const g = st.g, items = [{ key: 'start', kind: 'start', t: m.start, x: g.x0, text: `started ${clock(m.start)}` }]
  for (const mk of m.marks) {
    items.push({ key: mk.key, kind: mk.kind, t: mk.t, x: half(g.x(mk.t)), text: mk.text })
  }
  for (const w of m.waits) {
    const seg = m.segs.find((s) => s.wait === w)
    if (!seg) continue
    const x0 = half(g.x(seg.b)), x1 = half(g.x(w.until ?? m.now))
    const text = w.until === null ? `${clock(w.at)} · waiting on you · ${w.q}` : `${span(w.at, w.until)} · waited on you · ${w.q}`
    items.push({ key: `w:${w.at}`, kind: 'wait', t: w.at, x: Math.max(x0, (x0 + x1) / 2), x0, x1: Math.max(x1, x0 + 6), open: w.until === null, text })
  }
  const s = m.segs.at(-1)
  if (s && s.end === 'tip') {
    const text = m.working ? `now · ${m.task}` : `changed ${clock(m.tipAt)}`
    items.push({ key: 'tip', kind: 'tip', t: m.tipAt + 1, x: half(g.x(s.b)), text })
  }
  for (const it of items) it.y = g.y(it.x)
  return items.sort((a, b) => a.t - b.t)
}

function drawKeys(st, m) {
  const items = itemsOf(st, m)
  st.items = items
  const seen = new Set()
  let next = null
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    seen.add(it.key)
    let k = st.keyEls.get(it.key)
    if (!k) {
      k = el('span', { class: 'board-timeline-key', role: 'listitem', tabindex: '-1', 'data-kind': it.kind })
      k.append(el('span', { class: 'sr-only' }))
      st.keys.insertBefore(k, next)
      st.keyEls.set(it.key, k)
    }
    if (k.firstChild.textContent !== it.text) k.firstChild.textContent = it.text
    const left = `${r2(it.x - 9)}px`, top = `${r2(it.y - 11)}px`
    if (k.style.left !== left) k.style.left = left
    if (k.style.top !== top) k.style.top = top
    next = k
  }
  for (const [key, k] of st.keyEls) {
    if (seen.has(key)) continue
    k.remove()
    st.keyEls.delete(key)
  }
  if (!seen.has(st.roving)) rove(st, items.at(-1)?.key || '')
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

// The mark nearest the pointer, within a small reach. A wait answers for its
// whole gap and for the flick that starts it; one still open is what needs
// the person, so it wins a near tie.
function point(st, e) {
  const x = e.clientX - st.root.getBoundingClientRect().left
  let best = null
  for (const it of st.items) {
    let d, reach = 8
    if (it.kind === 'wait') {
      d = x >= it.x0 && x <= it.x1 ? 0 : Math.abs(x - it.x0)
      if (it.open) d -= 4
    } else {
      d = Math.abs(it.x - x)
      reach = it.kind === 'tip' ? 14 : it.kind === 'start' ? 10 : 8
    }
    if (d <= reach && (!best || d <= best.d)) best = { it, d }
  }
  if (best) say(st, best.it)
  else if (!st.keys.contains(document.activeElement)) hide(st)
}

function say(st, it) {
  if (st.saying === it.key) return
  st.saying = it.key
  const r = st.read
  r.textContent = it.text
  r.style.left = '0px'
  const w = r.offsetWidth
  r.style.left = `${r2(Math.max(0, Math.min(st.w - w, it.x - w / 2)))}px`
  r.style.top = `${st.readTop}px`
  r.classList.add('on')
}

function hide(st) {
  st.saying = ''
  st.read.classList.remove('on')
}
