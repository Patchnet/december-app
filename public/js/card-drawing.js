// Original p5.brush artwork, fitted to live card geometry. Decoration only:
// asset loading and animation never delay readiness or persistence.
import { syncCardWriting, finishCardWriting } from './card-writing.js'
import { paintCard } from './card-paint.js'
const live = new WeakMap()
const PAD = 24
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const frames = []
let loading
function load() {
  return loading ??= Promise.all(Array.from({ length: 9 }, (_, n) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { frames[n] = img; resolve(img) }
    img.onerror = reject
    img.src = new URL(`../brush/card-form/f${String(n + 5).padStart(3, '0')}.png`, import.meta.url).href
  })))
}
// Warm the small local plates ahead of the first capture. Keep the normal
// dashed border if assets fail; the agent never waits on the decoration.
load().catch(() => {})
function paint(el, state, index = 0) {
  if (!state.canvas.isConnected || !frames[index]) return
  const w = el.clientWidth, h = el.clientHeight
  if (!w || !h) return
  const d = Math.min(devicePixelRatio || 1, 2)
  const canvas = state.canvas
  const width = Math.ceil((w + PAD * 2) * d), height = Math.ceil((h + PAD * 2) * d)
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(d, 0, 0, d, 0, 0)
  ctx.clearRect(0, 0, w + PAD * 2, h + PAD * 2)
  ctx.save(); ctx.translate(PAD, PAD)
  paintCard(ctx, frames, index, w, h)
  ctx.restore()
}
export function drawCard(el) {
  syncCardWriting(el)
  if (!el || live.has(el) || reduced()) return
  const canvas = document.createElement('canvas')
  canvas.className = 'card-drawing painted-card-frame'
  canvas.setAttribute('aria-hidden', 'true')
  const state = { canvas, watch: null, animation: null, index: 0, raf: 0 }
  live.set(el, state)
  load().then(() => {
    if (live.get(el) !== state || !el.isConnected || !el.classList.contains('building')) return
    el.append(canvas)
    el.classList.add('drawing')
    state.watch = new ResizeObserver(() => paint(el, state, state.index))
    state.watch.observe(el)
    paint(el, state)
    state.animation = canvas.animate([{ opacity: .15 }, { opacity: 1 }], {
      duration: reduced() ? 0 : 560, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'backwards',
    })
  }).catch(() => {})
}
export function eraseCard(el) {
  finishCardWriting(el)
  const state = el && live.get(el)
  if (!state) return
  live.delete(el)
  state.animation?.cancel()
  const cleanup = () => {
    cancelAnimationFrame(state.raf)
    state.watch?.disconnect()
    state.canvas.remove()
    if (!live.has(el)) el.classList.remove('drawing')
  }
  if (!state.canvas.isConnected || !el.isConnected || reduced()) { cleanup(); return }
  const start = performance.now()
  function tick(now) {
    if (!el.isConnected || live.has(el)) { cleanup(); return }
    const p = reduced() ? 1 : Math.min(1, (now - start) / 740)
    state.index = Math.min(frames.length - 1, Math.floor(p * frames.length))
    paint(el, state, state.index)
    state.canvas.style.opacity = String(1 - Math.max(0, (p - .75) / .25))
    if (p < 1) state.raf = requestAnimationFrame(tick)
    else cleanup()
  }
  state.raf = requestAnimationFrame(tick)
}
