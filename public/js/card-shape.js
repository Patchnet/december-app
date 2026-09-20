// Animate the frame, never scale its text. A newer server update takes over
// from the currently visible height; an old completion cannot undo it.
const shapes = new Map()
const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
export function restHeight(el) { return shapes.get(el)?.targetHeight ?? el.offsetHeight }
export function finishCardShape(el) { shapes.get(el)?.() }

export function finishCardShapes() {
  for (const finish of [...shapes.values()]) finish()
}

export function animateCardShape(el, from, { enter = false } = {}) {
  const old = shapes.get(el)
  const previous = old?.motion
  const saved = previous?.saved || { height: el.style.height, paddingTop: el.style.paddingTop, paddingBottom: el.style.paddingBottom, marginBottom: el.style.marginBottom, opacity: el.style.opacity }
  // Measure natural content synchronously, then restore the visible state
  // before the browser paints. New targets preserve velocity, not a new ease.
  const current = previous ? { ...previous.values } : null
  const velocity = previous ? { ...previous.velocity } : {}
  old?.()
  const style = getComputedStyle(el)
  const target = { height: el.offsetHeight, paddingTop: parseFloat(style.paddingTop), paddingBottom: parseFloat(style.paddingBottom), marginBottom: parseFloat(style.marginBottom), opacity: parseFloat(style.opacity) }
  if (preference.matches || document.hidden || !el.isConnected || !from) return
  if (!previous && !enter && Math.abs(target.height - from) < 1) return
  const values = current || { ...target, height: from }
  if (enter && !previous) Object.assign(values, { paddingTop: 2, paddingBottom: 2, marginBottom: 0, opacity: 0 })
  const keys = Object.keys(target)
  for (const key of keys) velocity[key] ??= 0
  const state = { values, velocity, saved, frame: 0, last: performance.now() }
  const apply = () => {
    for (const key of keys) el.style[key] = key === 'opacity' ? String(Math.max(0, Math.min(1, values[key]))) : `${Math.max(0, values[key])}px`
  }
  const finish = () => {
    if (shapes.get(el) !== finish) return
    shapes.delete(el)
    cancelAnimationFrame(state.frame)
    Object.assign(el.style, saved)
  }
  finish.targetHeight = target.height
  finish.motion = state
  shapes.set(el, finish)
  apply()
  function tick(now) {
    if (shapes.get(el) !== finish) return
    if (!el.isConnected || preference.matches || document.hidden) { finish(); return }
    const dt = Math.min(.05, Math.max(0, (now - state.last) / 1000))
    state.last = now
    // Analytic critically damped spring: no oscillation or frame-rate-dependent
    // integration. Keeps position and velocity continuous across target changes.
    const omega = 23, decay = Math.exp(-omega * dt)
    let settled = true
    for (const key of keys) {
      const delta = values[key] - target[key]
      const c = velocity[key] + omega * delta
      values[key] = target[key] + (delta + c * dt) * decay
      velocity[key] = (velocity[key] - omega * c * dt) * decay
      const epsilon = key === 'opacity' ? .002 : .12
      if (Math.abs(values[key] - target[key]) > epsilon || Math.abs(velocity[key]) > epsilon * 15) settled = false
    }
    apply()
    if (settled) finish()
    else state.frame = requestAnimationFrame(tick)
  }
  state.frame = requestAnimationFrame(tick)
}

// A completing row owns real layout inside its card for a moment. It joins
// this registry so placeCards reads its resting height, the finishers above
// can end it, and a newer frame animation takes over from the visible height.
export function claimCardShape(el, release, targetHeight) {
  shapes.get(el)?.()
  const finish = () => {
    if (shapes.get(el) !== finish) return
    shapes.delete(el)
    release()
  }
  finish.targetHeight = targetHeight
  shapes.set(el, finish)
  return finish
}

preference.addEventListener('change', () => { if (preference.matches) finishCardShapes() })
document.addEventListener('visibilitychange', () => { if (document.hidden) finishCardShapes() })
let resizeFrame = null
window.addEventListener('resize', () => {
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    for (const el of [...shapes.keys()]) animateCardShape(el, el.getBoundingClientRect().height)
  })
})
