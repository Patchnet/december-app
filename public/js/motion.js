import { $, reduced, page } from './session.js'

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
  if (!page.prev) return
  const prevBlocks = new Map()
  for (const s of page.prev.spaces) for (const b of s.blocks) prevBlocks.set(b.id, b)
  for (const s of page.state.spaces) {
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
export { celebrate, pop, markChange, markEdited, bump, travelDot, bloom, washCard, withFlip, drawMeters, celebrateSpace, celebrateDiffs }
