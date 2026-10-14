// A small thing that opens over the page, anchored to the thing it belongs to.
//
// December has one popover idiom, not one per feature: the same card chrome,
// the same rung of the ladder, the same ways of going away (a press elsewhere,
// Escape, or an answer). The month on a row and the menu in Settings are both
// this; only what they draw inside differs.
const prefersReduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// Only one at a time: a second popover over the first has nothing to say.
let openNow = null

/**
 * @param anchor  the element it belongs to; it opens under or over it
 * @param className  the popover's own class, for what it draws inside
 * @param label  what it is, for anyone who cannot see it
 * @param onClose  called once, whichever way it goes away
 * @returns {{el: HTMLElement, close: function, place: function}}
 */
export function openPop(anchor, { className = '', label = '', onClose } = {}) {
  openNow?.({ instant: true })

  const el = document.createElement('div')
  el.className = `pop ${className}`.trim()
  el.setAttribute('role', 'dialog')
  if (label) el.setAttribute('aria-label', label)

  let closed = false
  const close = ({ instant = false } = {}) => {
    if (closed) return
    closed = true
    if (openNow === close) openNow = null
    document.removeEventListener('mousedown', away, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', place)
    window.removeEventListener('scroll', place, true)
    if (el.contains(document.activeElement) && anchor.isConnected) anchor.focus({ preventScroll: true })
    onClose?.()
    // a keyboard close is an answer, not a gesture: it does not play
    if (instant || prefersReduced()) return el.remove()
    el.classList.add('leaving')
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    setTimeout(() => el.remove(), 300)
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close({ instant: true }) }
    if (e.key === 'Tab') close({ instant: true })
  }
  const away = (e) => { if (!el.contains(e.target)) close() }

  // anchored to the thing it belongs to, and kept on screen: it opens below
  // unless below would run off the bottom and there is room above
  function place() {
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth || 240
    const h = el.offsetHeight || 260
    const gap = 8
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))
    const below = r.bottom + gap
    const above = below + h > window.innerHeight - 8 && r.top > window.innerHeight / 2
    const top = Math.max(8, Math.min(above ? r.top - gap - h : below, window.innerHeight - h - 8))
    el.style.transformOrigin = above ? 'bottom center' : 'top center'
    el.dataset.side = above ? 'above' : 'below'
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
  }

  el.addEventListener('click', (e) => e.stopPropagation())
  document.body.append(el)
  openNow = close
  // the caller draws into el, then calls place(); opening happens on the frame
  // after, so the arrival has somewhere to arrive from
  queueMicrotask(() => {
    if (closed) return
    place()
    // one frame later, so the arrival has somewhere to arrive from. A hidden
    // tab never paints a frame, so a timer says the same thing for the window
    // that is opened, switched away from, and come back to; adding the class
    // twice costs nothing.
    const arrive = () => { if (!closed) el.classList.add('open') }
    requestAnimationFrame(arrive)
    setTimeout(arrive, 32)
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
  })

  return { el, close, place }
}
