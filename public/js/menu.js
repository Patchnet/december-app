// A short list of things you can pick, opened over the value it would change.
//
// The native <select> arrives in the system's typeface at the system's size,
// with a chevron December did not draw — the same reason the month replaced
// the native calendar. This is that popover with rows instead of days.
import { openPop } from './pop.js'

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * @param anchor   the value the menu belongs to
 * @param items    [{ value, label, note?, group? }] — group starts a run
 * @param value    which one is chosen now
 * @param onPick   called with the chosen value
 */
export function openMenu(anchor, { items = [], value = '', label = 'Choose', onPick } = {}) {
  const { el, close, place } = openPop(anchor, { className: 'menu', label })
  el.setAttribute('role', 'menu')

  let group = null
  el.innerHTML = items.map((item) => {
    const head = item.group && item.group !== group
      ? `<div class="menu-group">${esc(item.group)}</div>` : ''
    group = item.group || group
    const chosen = item.value === value
    return `${head}<button type="button" class="menu-item${chosen ? ' chosen' : ''}" data-value="${esc(item.value)}"${
      ` role="menuitemradio" aria-checked="${chosen}"`}>
      <span class="menu-label">${esc(item.label)}</span>
      ${item.note ? `<span class="menu-note">${esc(item.note)}</span>` : ''}
    </button>`
  }).join('')

  el.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item')
    if (!item) return
    close({ instant: true })
    onPick?.(item.dataset.value)
  })

  // the list is walkable without the mouse; the popover itself handles Escape
  el.addEventListener('keydown', (e) => {
    const all = [...el.querySelectorAll('.menu-item')]
    const i = all.indexOf(document.activeElement)
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      all[e.key === 'Home' ? 0 : all.length - 1]?.focus()
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const match = [...all.slice(i + 1), ...all.slice(0, i + 1)].find(item => item.querySelector('.menu-label').textContent.toLowerCase().startsWith(e.key.toLowerCase()))
      if (match) { e.preventDefault(); match.focus() }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1
      all[(next + all.length) % all.length]?.focus()
    }
  })

  place()
  ;(el.querySelector('.menu-item.chosen') || el.querySelector('.menu-item'))?.focus({ preventScroll: true })
  return close
}
