// Task focus — one thing, alone on the screen, quietly timed.
//
// There is no start button, no session name, no category, no goal, and
// nothing that ticks its way to the server. You click the words of a list
// item or a reminder, the rest of the page falls away, and a small clock
// counts up. Escape or a click away ends it. December hears one number,
// once, after the sitting is over.
//
// The span machine below is deliberately free of the DOM: the one rule that
// matters — a span is written once, or not at all — should be readable, and
// testable, without a browser around it.

import { esc, api, page, hooks, toast } from './session.js'

// The same bounds lib/core.mjs enforces. Below the floor a click was only
// passing through; above the ceiling a window was left open overnight.
// Neither is a sitting, so neither is written.
export const FOCUS_MIN_MS = 20 * 1000
export const FOCUS_MAX_MS = 8 * 3600 * 1000
// A double-click on those same words means "fix the wording", and inline
// editing was here first. The spotlight waits long enough to find out.
export const OPEN_DELAY_MS = 300

// The sheet for this surface is pulled in here rather than through
// styles.css so the whole feature — behaviour and appearance — is one
// file's business. Nothing it styles exists until a spotlight opens, so
// arriving a beat after the page cannot flash anything.
if (!document.querySelector('link[data-focus-css]')) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/css/focus.css'
  link.dataset.focusCss = '1'
  document.head.appendChild(link)
}

// ------------------------------------------------------------- the span

const clock = () => (typeof performance?.now === 'function' ? performance.now() : Date.now())

/** How long it took, the way a person says it: 40s, 45m, 1h 20m. Mirrors
    focusPhrase in lib/core.mjs, which writes the same words into history. */
export function focusPhrase(ms) {
  const seconds = Math.round(Math.max(0, Number(ms) || 0) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** The running clock, which is a different thing from the phrase: it moves
    every second and must never round. */
export function elapsedClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export const openSpan = (task, at) => ({ ...task, at, closed: false })

/** End a span and say what, if anything, December should be told. A span
    that has already been closed yields nothing: Escape and a click away can
    arrive together, and two receipts for one sitting is a lie. */
export function closeSpan(span, at) {
  if (!span || span.closed) return { write: null, reason: 'already-closed', ms: 0 }
  span.closed = true
  const ms = Math.round(at - span.at)
  if (!Number.isFinite(ms) || ms < FOCUS_MIN_MS) return { write: null, reason: 'too-short', ms }
  if (ms > FOCUS_MAX_MS) return { write: null, reason: 'too-long', ms }
  return {
    write: { blockId: span.blockId, ...(span.itemId ? { itemId: span.itemId } : {}), ms },
    reason: 'recorded',
    ms,
  }
}

/** What a row is, if it is a task at all. Only list items and reminders
    render as rows, so the markup already carries the rule; a done thing is
    not waiting for anyone, and a tracker, ledger, streak or note is a
    reading, not something you sit down to. */
export function taskOf(row) {
  const blockId = row?.dataset?.block || ''
  if (!blockId) return null
  if (row.classList?.contains('done')) return null
  // the words only: a reminder row also carries its due phrase and any place
  // chip, and none of that is the task
  const label = String(row.querySelector?.('.row-text')?.textContent ?? row.textContent ?? '').trim()
  if (!label) return null
  return { blockId, itemId: row.dataset.item || '', label }
}

// ------------------------------------------------------------ the page

let span = null
let host = null
let ticker = null
let openTimer = null
let returnTo = null

const spaceNameOf = (blockId) =>
  (page.state?.spaces || []).find((s) => s.blocks?.some((b) => b.id === blockId))?.name || ''

export const focusIsOpen = () => !!span

/** A card row is eligible; the attention strip, the year, the demo and the
    onboarding ghosts are not — those are places you look, not places you
    work. */
function eligibleRow(text) {
  if (!text || text.isContentEditable) return null
  const row = text.closest('.row[data-block]')
  if (!row) return null
  if (!row.closest('.space, .focus-card')) return null
  if (row.closest('#today, .year-card, .demo-card, .ghost')) return null
  return row
}

/** A stricter gate for the pointer alone: a link in the words is a link, and
    dragging across them to copy is reading, not sitting down. */
function eligibleClick(target) {
  if (target?.closest?.('a.card-link')) return null
  if (window.getSelection?.()?.toString()) return null
  return eligibleRow(target?.closest?.('.row-text'))
}

function build(task) {
  const spaceName = spaceNameOf(task.blockId)
  host = document.createElement('div')
  host.id = 'task-focus'
  host.className = 'task-focus'
  host.innerHTML = `
    <div class="task-focus-backdrop" data-task-close></div>
    <div class="task-focus-wrap" data-task-close>
      <section class="task-focus-card" role="dialog" aria-modal="true" aria-labelledby="task-focus-label" tabindex="-1">
        ${spaceName ? `<p class="task-focus-space">${esc(spaceName)}</p>` : ''}
        <div class="row task-focus-task" data-block="${esc(task.blockId)}"${task.itemId ? ` data-item="${esc(task.itemId)}"` : ''}>
          <span class="row-text" id="task-focus-label">${esc(task.label)}</span>
        </div>
        <p class="task-focus-clock" aria-hidden="true"><span class="task-focus-elapsed">0:00</span></p>
        <p class="sr-only">Focused on this one thing. Press Escape, or click away, when you are done.</p>
        <p class="task-focus-hint" aria-hidden="true">esc, or click away, when you're done</p>
      </section>
    </div>`
  document.body.appendChild(host)
  document.documentElement.classList.add('task-focusing')
  background(true)
}

/** Everything that is not this one thing steps out of the way — for the
    pointer, the keyboard, and anything reading the page aloud. The space
    focus overlay is one of those things: it is still there when you come
    back, it just is not part of the sitting. */
function background(away) {
  for (const id of ['shell', 'focus']) {
    const el = document.getElementById(id)
    if (!el) continue
    if (away) {
      el.inert = true
      el.setAttribute('aria-hidden', 'true')
    } else {
      el.inert = false
      el.removeAttribute('aria-hidden')
    }
  }
}

/** The clock, and only the clock. Nothing here reaches the server: a sitting
    that wrote every second would be a stream of noise, and a page that
    crashed halfway would leave a span nobody finished. */
function paint() {
  if (!span || !host) return
  const el = host.querySelector('.task-focus-elapsed')
  if (el) el.textContent = elapsedClock(clock() - span.at)
}

function enter(row) {
  if (span) return
  const task = taskOf(row)
  if (!task) return
  returnTo = document.activeElement
  span = openSpan(task, clock())
  build(task)
  paint()
  ticker = setInterval(paint, 1000)
  host.querySelector('.task-focus-card')?.focus({ preventScroll: true })
}

/** Put the page back exactly as it was. The space focus overlay keeps its
    own scroll lock, so only this surface's lock comes off. */
function teardown() {
  clearInterval(ticker)
  ticker = null
  host?.remove()
  host = null
  document.documentElement.classList.remove('task-focusing')
  // the page comes back before the caret does, or it lands somewhere inert
  background(false)
  if (returnTo?.isConnected && typeof returnTo.focus === 'function') returnTo.focus({ preventScroll: true })
  returnTo = null
}

/** The one write. No prompt, no question, no confirmation — the sitting
    happened, and the page says so afterwards. */
async function exit() {
  if (!span) return
  const verdict = closeSpan(span, clock())
  span = null
  teardown()
  if (!verdict.write) {
    if (verdict.reason === 'too-long') toast('that one ran too long to log')
    return
  }
  try {
    await api('/api/tool', { name: 'december_focus', arguments: verdict.write })
    toast(`${focusPhrase(verdict.ms)} focused`)
    const next = await api('/api/state')
    if (Array.isArray(next?.spaces) && Array.isArray(next?.captures)) {
      page.state = next
      hooks.render()
    }
  } catch (err) {
    toast(err.message)
  }
}

export { exit as endTaskFocus }

// Capture phase, so this settles what a click means before the row's own
// handler checks the item off and before Escape closes the card behind.
document.addEventListener(
  'click',
  (e) => {
    // Any click at all settles a spotlight that was only pending: whatever
    // you reached for next is what you meant.
    clearTimeout(openTimer)
    if (span) {
      e.stopPropagation()
      if (!e.target?.closest?.('.task-focus-card')) exit()
      return
    }
    const row = eligibleClick(e.target)
    if (!row) return
    // The tick, and every quiet inch of the row beside the words, still
    // checks the thing off. Only the words themselves open it.
    e.stopPropagation()
    e.preventDefault()
    if (e.detail > 1) return // a double-click is a rewording; leave it to the editor
    openTimer = setTimeout(() => enter(row), OPEN_DELAY_MS)
  },
  true
)

document.addEventListener(
  'keydown',
  (e) => {
    if (!span) {
      if (e.key === 'Escape') clearTimeout(openTimer)
      // The row itself is the checkbox, so Enter and Space are already spoken
      // for. A row you have tabbed to opens with f — the only way in that
      // does not need a pointer.
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement
        // the row itself has to be the thing you are standing on, or a bare
        // f typed at the page would spotlight whatever came first in the DOM
        if (!el?.matches?.('.row[data-block]')) return
        const row = eligibleRow(el.querySelector('.row-text'))
        if (!row) return
        e.preventDefault()
        e.stopPropagation()
        clearTimeout(openTimer)
        enter(row)
      }
      return
    }
    // Rewording inside the spotlight owns the keyboard while it lasts.
    if (host?.querySelector('[contenteditable="true"]')) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      exit()
      return
    }
    if (e.key === 'Tab') e.preventDefault() // one thing on screen, nowhere else to be
  },
  true
)
