import { page } from './session.js'
import { animateCardShape } from './card-shape.js'
import { growPlaceholder, stopPlaceholder } from './placeholder-growth.js'

// ------------------------------------------------------------ expecting
// The moment you press Enter, the page guesses where your words will land
// and makes room in an existing destination. New territory waits for
// actual structured content before a card is introduced. Existing-card
// row hints disappear when actual sourced content arrives.

const STOP = new Set(['a', 'an', 'the', 'my', 'your', 'with', 'from', 'for', 'to', 'at', 'on', 'in', 'of', 'and', 'is', 'was', 'about', 'this', 'that', 'it'])
const words = (t) => [...new Set(String(t).toLowerCase().match(/[a-z0-9']+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) || [])]
const stem = (w) => w.slice(0, 4)
const TTL = 4 * 60 * 1000

/** Which live card the words most likely belong to: the card being viewed
    when they were written, else the card whose name the words carry. A
    guess needs at least one shared word; otherwise the words are new. */
export function guessSpace(text, hint) {
  const live = (page.state?.spaces || []).filter((s) => !s.finished)
  if (hint) {
    const named = live.find((s) => s.name === hint || s.id === hint)
    if (named) return named.id
  }
  const mine = words(text).map(stem)
  let best = null, score = 0
  for (const s of live) {
    const theirs = words(s.name).map(stem)
    const hit = theirs.filter((w) => mine.includes(w)).length
    if (hit > score || (hit === score && hit && new Date(s.updatedAt) > new Date(live.find((x) => x.id === best)?.updatedAt || 0))) {
      best = s.id
      score = hit
    }
  }
  return score ? best : null
}

/** A capture's sentences or lines, each a row in the making. */
const partsOf = (text) => String(text).split(/\n|(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean)

/** Each sentence is guessed on its own: one capture can be a row for the
    Apartment and the first lines of a Lisbon card. A sentence that names
    no card follows the one before it — people write about one thing in a
    row — and a first sentence that names none is new territory. */
export function expect(text, hint) {
  page.expecting ||= []
  const key = String(text).trim()
  if (!key || page.expecting.some((e) => e.key === key)) return
  const bySid = new Map()
  let last = null
  for (const part of partsOf(key)) {
    const sid = guessSpace(part, hint) ?? last
    last = sid
    bySid.set(sid, (bySid.get(sid) || 0) + Math.max(part.split(/[,;\n]/).length, Math.ceil(part.length / 64)))
  }
  for (const [sid, lines] of bySid) page.expecting.push({ key, sid, lines: Math.min(6, lines), at: Date.now() })
  renderExpecting()
}

/** Still in flight: in the outbox, or in the inbox. Once it is neither, the
    engine has filed it and the room it held is the real thing's now. */
function inFlight(key) {
  const queued = (page.queuedTexts || []).some((t) => String(t).trim() === key)
  const inbox = (page.state?.captures || []).some((c) => String(c.text).trim() === key)
  return queued || inbox
}

// Match real sourced content to the existing-card row hints it replaces.
function matchingExpectations(space) {
  const entries = page.expecting || []
  const sources = new Set((space.blocks || []).flatMap(b => [b.src, ...(b.items || []).map(item => item.src)]).filter(Boolean))
  for (const event of page.state.activity || []) if (event.space === space.name && event.captureId) sources.add(event.captureId)
  const captures = [...(page.state.captures || []), ...(page.prev?.captures || [])]
  const keys = new Set(captures.filter(c => sources.has(c.id)).map(c => c.text.trim()))
  for (const id of sources) if (page.state.sources?.[id]) keys.add(page.state.sources[id].trim())
  return entries.filter(e => keys.has(e.key))
}

export function materializeExpectation(space) {
  const matches = matchingExpectations(space)
  for (const e of matches) if (e.sid === space.id) e.materialized = true
}

export function renderExpecting() {
  const now = Date.now()
  page.expecting = (page.expecting || []).filter(e => now - e.at < TTL && inFlight(e.key))
  const wanted = new Map()
  for (const e of page.expecting) if (e.sid && !e.materialized) wanted.set(e.sid, (wanted.get(e.sid) || 0) + e.lines)
  for (const [sid, { el }] of page.spaceEls) {
    const n = Math.min(6, wanted.get(sid) || 0)
    let ghost = el.querySelector(':scope > .ghost-rows')
    if (!n && ghost) {
      const from = el.getBoundingClientRect().height
      stopPlaceholder(ghost.firstElementChild)
      ghost.remove()
      animateCardShape(el, from)
    } else if (n && Number(ghost?.dataset.n) !== n) {
      const from = el.getBoundingClientRect().height
      if (!ghost) {
        ghost = document.createElement('div')
        ghost.className = 'ghost-rows grown'
        ghost.setAttribute('aria-hidden', 'true')
        ghost.innerHTML = '<div></div>'
        el.append(ghost)
      }
      ghost.dataset.n = n
      growPlaceholder(ghost.firstElementChild, el, n)
      animateCardShape(el, from)
    }
    el.classList.toggle('expecting', n > 0)
  }

  // New territory has no speculative card. Its real content creates the frame.
}
