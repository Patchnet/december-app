// The day on a row, opened as a month you can read.
//
// December's own calendar rather than the browser's: the native one arrives in
// the system's typeface at the system's size, in a corner the page did not
// choose, and says nothing the page's own register would say. This one is a
// card — hairlines, serif figures, tone on hover — anchored under the date it
// belongs to.
import { openPop } from './pop.js'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fromISO = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

// Monday-first, and only the weeks the month actually touches: a trailing row
// of nothing but the next month says the same days twice.
export function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const weeks = Math.ceil((lead + days) / 7)
  const start = new Date(year, month, 1 - lead)
  return Array.from({ length: weeks * 7 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    return { date: d, iso: iso(d), inMonth: d.getMonth() === month }
  })
}

/**
 * Open a month over `anchor`. `onPick` receives a YYYY-MM-DD string, or ''
 * when the person clears the day. Returns a close function.
 */
export function openDayPicker(anchor, { value = '', today = new Date(), onPick } = {}) {
  const selected = fromISO(value)
  let cursor = selected ? new Date(selected.getFullYear(), selected.getMonth(), 1)
    : new Date(today.getFullYear(), today.getMonth(), 1)

  const { el, close, place } = openPop(anchor, { className: 'day-picker', label: 'Change the day' })
  const pick = (day) => { close({ instant: true }); onPick?.(day) }

  function draw() {
    const todayISO = iso(today)
    const cells = monthGrid(cursor.getFullYear(), cursor.getMonth()).map(c => {
      const flags = [
        c.inMonth ? '' : 'away',
        c.iso === todayISO ? 'today' : '',
        selected && c.iso === value ? 'chosen' : '',
      ].filter(Boolean).join(' ')
      return `<button type="button" class="dp-day ${flags}" data-day="${c.iso}"${
        selected && c.iso === value ? ' aria-current="date"' : ''
      } aria-label="${c.date.toDateString()}">${c.date.getDate()}</button>`
    }).join('')
    el.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-step" data-step="-1" aria-label="Previous month">‹</button>
        <div class="dp-month" aria-live="polite">${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}</div>
        <button type="button" class="dp-step" data-step="1" aria-label="Next month">›</button>
      </div>
      <div class="dp-week">${WEEKDAYS.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="dp-grid">${cells}</div>
      ${value ? '<button type="button" class="dp-clear">No day</button>' : ''}`
  }

  el.addEventListener('click', (e) => {
    const step = e.target.closest('.dp-step')
    if (step) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + Number(step.dataset.step), 1)
      draw()
      el.querySelector(`[data-step="${step.dataset.step}"]`)?.focus({ preventScroll: true })
      // a month with six weeks is taller than one with five: the popover
      // keeps its anchor rather than growing off the bottom of the window
      return place()
    }
    if (e.target.closest('.dp-clear')) return pick('')
    const day = e.target.closest('.dp-day')
    if (day) pick(day.dataset.day)
  })

  // The calendar behaves as a calendar from the keyboard, including across
  // month boundaries; repainting never strands focus on the document.
  el.addEventListener('keydown', (e) => {
    const day = e.target.closest('.dp-day')
    if (!day) return
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (!(e.key in offsets)) return
    e.preventDefault()
    const next = fromISO(day.dataset.day)
    next.setDate(next.getDate() + offsets[e.key])
    const target = iso(next)
    if (!el.querySelector(`[data-day="${target}"]`)) {
      cursor = new Date(next.getFullYear(), next.getMonth(), 1)
      draw()
      place()
    }
    el.querySelector(`[data-day="${target}"]`)?.focus({ preventScroll: true })
  })

  draw()
  place()
  ;(el.querySelector('.dp-day.chosen') || el.querySelector('.dp-day.today') || el.querySelector('.dp-day'))?.focus({ preventScroll: true })
  return close
}
