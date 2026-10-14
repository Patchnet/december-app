import { reduced, page } from './session.js'
import { circleNumber } from './ink-feedback.js'

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

// The class is `popping`, never `pop`: `.pop` is the popover's chrome (pop.js),
// and an element wearing it took on a popover's padding, position and opacity.
function pop(el) {
  if (reduced || !el) return
  el.classList.remove('popping')
  void el.offsetWidth
  el.classList.add('popping')
  clearTimeout(el._popT)
  el._popT = setTimeout(() => el.classList.remove('popping'), 600)
}

/** Say what a number did, right where it happened, then let it go. */
function markChange(el, label) {
  if (reduced || !el || !label) return
  el.querySelector('.delta')?.remove()
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
  if (el.matches('.tracker-count, .goal-count, .ledger-total')) circleNumber(el)
}

/** The filing moment: a mote of light leaves your sentence and dissolves
    into the space it landed in. A bright core and a soft halo — blurred
    while it is moving fast, sharp as it arrives. The page holds still
    while it flies. */
const inViewport = (r) => r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth

function travelDot(fromRect, toEl, then, hue) {
  if (reduced || document.hidden || !toEl?.isConnected) return then?.()
  const to = toEl.getBoundingClientRect()
  // a flight nobody can see is just latency: skip when either end is offscreen
  if (!inViewport(fromRect) || !inViewport(to)) return then?.()

  const x0 = fromRect.left
  const y0 = fromRect.top + fromRect.height / 2
  const dx = to.left + 22 - x0
  const dy = to.top + 22 - y0

  // Sample a continuous cubic arc: the old four-point path changed
  // direction at each keyframe, which read as little jolts in flight.
  const duration = Math.round(Math.min(440, 280 + Math.hypot(dx, dy) * .16))
  const arc = (blur) => Array.from({ length: 49 }, (_, i) => {
    const t = i / 48, u = 1 - t
    const x = 3*u*u*t*dx*.22 + 3*u*t*t*dx*.78 + t*t*t*dx
    const y = 3*u*u*t*(-24) + 3*u*t*t*(dy-24) + t*t*t*dy
    const swell = Math.sin(Math.PI*t)
    return { transform: `translate(${x}px, ${y}px) scale(${.45 + swell*.65})`,
      opacity: Math.min(1, swell*3), filter: `blur(${blur*(.5+swell)}px)`, offset: t }
  })

  const parts = [
    { cls: 'mote-halo', blur: 7, delay: 0 },
    { cls: 'mote-core', blur: 1.2, delay: 0 },
  ]

  let lead = null
  const flights = []
  for (const p of parts) {
    const el = document.createElement('div')
    el.className = `mote ${p.cls}`
    if (hue) el.style.setProperty('--mote', hue)
    el.style.left = `${x0}px`
    el.style.top = `${y0}px`
    document.body.appendChild(el)
    // the settle curve, not expo: tokens.css says it itself — expo "whips
    // out of the gate and reads as a snap". Filing should leave the sentence
    // gently and arrive gently; the blur already carries the speed.
    const anim = el.animate(arc(p.blur), {
      duration,
      delay: p.delay,
      easing: 'cubic-bezier(.4, 0, .2, 1)',
      fill: 'forwards',
    })
    flights.push({ el, anim })
    anim.addEventListener('finish', () => el.remove())
    if (p.cls === 'mote-core') lead = anim
  }

  let completed = false
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  const finish = () => {
    if (completed) return
    completed = true
    clearTimeout(fallback)
    document.removeEventListener('visibilitychange', interrupt)
    preference.removeEventListener('change', interrupt)
    for (const { el, anim } of flights) { anim.cancel(); el.remove() }
    // a card answers with its own swipe; only a goal, which has none, blooms
    if (toEl.classList?.contains('goal') && !document.hidden && !preference.matches) bloom(x0 + dx, y0 + dy)
    then?.()
  }
  const interrupt = () => { if (document.hidden || preference.matches) finish() }
  // A cancelled animation or a backgrounded tab must never strand soft ink.
  const fallback = setTimeout(finish, duration + 250)
  document.addEventListener('visibilitychange', interrupt)
  preference.addEventListener('change', interrupt)
  lead.addEventListener('finish', finish)
  lead.addEventListener('cancel', finish)
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
  el._washT = setTimeout(() => el.classList.remove('washed'), 1200)
}

// A layout move owns only its own animation. Reflow interrupts it from the
// current visual position, and an old finish cannot reset a newer move.
const layoutMoves=new Map()
function finishLayoutMoves() {
  for(const animation of layoutMoves.values())animation.cancel()
  layoutMoves.clear()
}
const layoutPreference=window.matchMedia('(prefers-reduced-motion: reduce)')
layoutPreference.addEventListener?.('change',()=>{if(layoutPreference.matches)finishLayoutMoves()})
globalThis.document?.addEventListener('visibilitychange',()=>{if(document.hidden)finishLayoutMoves()})

/** FLIP: preserve where things are now, then glide to their new layout. */
let layoutDepth = 0
function withFlip(fn, prior = null) {
  // Action handlers can render through another FLIP boundary. One outer
  // transaction must own the measurements, or the two transforms compound.
  if (layoutDepth) return fn()
  if(reduced || document.hidden){finishLayoutMoves();return fn()}
  const before=prior || new Map()
  if (!prior) for(const el of document.querySelectorAll('#spaces .space, #rail, #resting'))before.set(el,el.getBoundingClientRect())
  const rowsBefore=new Map()
  if (!prior) for(const row of document.querySelectorAll('#spaces .row[data-item]'))rowsBefore.set(`${row.dataset.block}/${row.dataset.item}`,row.getBoundingClientRect())
  // Measure the displayed position before releasing interrupted transforms.
  finishLayoutMoves()
  let result
  layoutDepth++
  try { result=fn() } finally { layoutDepth-- }
  const moves=[],parentMoves=new Map()
  for(const [el,a] of before) {
    if(!el.isConnected || el.classList.contains('leaving') || (el.classList.contains('fresh') && !el.classList.contains('settled')))continue
    const b=el.getBoundingClientRect(),dx=a.left-b.left,dy=a.top-b.top
    if(Math.abs(dx)>1 || Math.abs(dy)>1){moves.push({el,dx,dy,top:b.top});parentMoves.set(el,{dx,dy})}
  }
  for(const row of document.querySelectorAll('#spaces .row[data-item]')) {
    const a=rowsBefore.get(`${row.dataset.block}/${row.dataset.item}`)
    if(!a)continue
    const b=row.getBoundingClientRect(),parent=parentMoves.get(row.closest('.space'))
    // A row travels with its card already. Animate only its internal move.
    const dx=a.left-b.left-(parent?.dx || 0),dy=a.top-b.top-(parent?.dy || 0)
    if(Math.abs(dx)>1 || Math.abs(dy)>1)moves.push({el:row,dx,dy,top:b.top})
  }
  moves.sort((a,b)=>a.top-b.top).forEach((move)=>{
    if(!move.el.animate)return
    const animation=move.el.animate([
      {transform:`translate(${move.dx}px, ${move.dy}px)`},{transform:'translate(0, 0)'},
    ],{duration:Math.round(Math.min(300,180+Math.hypot(move.dx,move.dy)*.2)),easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'})
    layoutMoves.set(move.el,animation)
    animation.onfinish=()=>{
      if(layoutMoves.get(move.el)!==animation)return
      layoutMoves.delete(move.el);animation.cancel()
    }
  })
  return result
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
