import { animateCardShape } from './card-shape.js'

// These are anonymous layout hints, never invented model output or progress.
// Each capture owns a small growing frame; real data takes it over immediately.
const growing = new WeakMap()
const widths = [62, 48, 71, 40, 57, 66]

export function stopPlaceholder(host) {
  const state = growing.get(host)
  if (!state) return
  clearTimeout(state.timer)
  growing.delete(host)
}

export function growPlaceholder(host, card, count, { enter = false } = {}) {
  const current = growing.get(host)
  if (current) { current.target = count; return }
  const state = { target: count, rows: host.querySelectorAll('.ghost-line').length, timer: null }
  growing.set(host, state)
  const quiet = () => document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const append = () => {
    const row = document.createElement('span')
    row.className = 'ghost-line'
    row.style.setProperty('--w', `${widths[state.rows % widths.length]}%`)
    host.append(row)
    state.rows++
  }
  const step = () => {
    if (growing.get(host) !== state) return
    if (!host.isConnected || !card.isConnected) { stopPlaceholder(host); return }
    const from = card.getBoundingClientRect().height
    if (quiet()) while (state.rows < state.target) append()
    else if (state.rows < state.target) append()
    animateCardShape(card, from)
    if (state.rows < state.target) state.timer = setTimeout(step, 180)
    else growing.delete(host)
  }
  if (quiet()) { step(); return }
  if (enter) animateCardShape(card, 8, { enter: true })
  state.timer = setTimeout(step, enter ? 150 : 90)
}
