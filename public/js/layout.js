import { updateRail } from './rail-motion.js'
import { openFocusMotion, leaveFocusMotion, focusVisualRect, focusIsMoving, backdropVisual } from './focus-motion.js'
import { animateCardShape, restHeight } from './card-shape.js'
import { settleRows, cardHeld } from './completion-motion.js'
import { newlyDone, playConfirmed } from './confirmed-completion.js'
import { syncCardWriting } from './card-writing.js'
import { updateCardContent } from './card-dom.js'
import { highlightCardChanges, showAddedItem } from './card-changes.js'
import { $, esc, reduced, fmtAmount, page, hooks } from './session.js'
import { spaceInner } from './blocks.js'
import { markChange, bump, travelDot, washCard, withFlip, drawMeters } from './motion.js'
import { goalOnly } from './goals.js'
import { renderPendingStage } from './pending-stage.js'
import { pendingView, filingPlan, runDestinations, passComplete } from './work-feedback.js'
import { drawCard, eraseCard } from './card-drawing.js'
import { syncTools, mountSurface } from './card-surface.js'
import { invalidateYearRequest } from './year-navigation.js'

// ------------------------------------------------------------ focus view

let attentionReturn = null
/** A surface that opens over the page remembers what had focus, so
    closing it puts the caret back where it was. */
function rememberReturn(el = document.activeElement) {
  attentionReturn = el
}
function buildFocus() {
  const wrap = $('#focus')
  const space = page.focusId && page.state.spaces.find((s) => s.id === page.focusId)
  queueMicrotask(() => watchCurrent.mark?.())
  if (!space) {
    page.focusId = null
    wrap.innerHTML = ''
    return
  }
  const origin = page.spaceEls.get(space.id)?.el?.getBoundingClientRect()
  const existing=wrap.querySelector('.focus-card')
  if(existing?.dataset.sid===space.id && !wrap.dataset.confirm) {
    const height = existing.getBoundingClientRect().height
    const flight = focusIsMoving(existing) && focusVisualRect(existing)
    updateCardContent(existing,spaceInner(space,true))
    if (flight) openFocusMotion(existing, flight)
    else animateCardShape(existing, height)
    wrap.dataset.u=space.updatedAt
    wrap.dataset.preview=space.previewKey || ''
    syncTools(existing,space)
    existing.setAttribute('aria-label',space.name)
    existing.querySelector('.focus-capture')?.setAttribute('aria-label',`Add or change something in ${space.name}`)
    return
  }
  // a re-render (the agent touched this space) must never eat a draft
  // mid-sentence, drop the caret, or jump the scroll
  const oldField = wrap.querySelector('.focus-capture')
  const draft = oldField?.value || ''
  const hadFocus = document.activeElement === oldField
  const caret = oldField?.selectionStart ?? draft.length
  const scrollTop = wrap.querySelector('.focus-card')?.scrollTop || 0
  // a surface already up hands its backdrop over, so replacing it in place
  // never flashes the page back into focus
  const backdropFrom = backdropVisual(wrap.querySelector('.focus-backdrop'))

  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" data-sid="${space.id}">
        ${spaceInner(space, true)}
        <textarea class="capture focus-capture" rows="1" aria-label="Add or change something in ${esc(space.name)}" placeholder="Add or change something…" spellcheck="false"></textarea>
      </article>
    </div>`
  wrap.dataset.u = space.updatedAt
  wrap.dataset.preview = space.previewKey || ''
  const fieldEl = wrap.querySelector('.focus-capture')
  if (fieldEl) {
    fieldEl.value = draft
    // the add-to field sits at the foot of the card: focusing it normally
    // scrolls it into view, which opened every long card at its bottom
    if (hadFocus || !draft) fieldEl.focus({ preventScroll: true })
    if (draft) fieldEl.setSelectionRange(caret, caret)
  }
  const card = wrap.querySelector('.focus-card')
  // a card opens at its top; only a re-render keeps where you were
  card?.scrollTo({ top: scrollTop, behavior: 'auto' })
  mountSurface(card)
  openFocusMotion(card, origin, backdropFrom)
}

function openStageCard(id) {
  if (!page.state.spaces.some(space => space.id === id && !space.finished)) return
  attentionReturn = document.activeElement
  page.focusId = id
  buildFocus()
}

// Closing releases interaction immediately. The inert visual returns home
// independently, so Escape is responsive without making the card disappear.
function closeFocus({ instant = false } = {}) {
  const from = focusVisualRect($('#focus .focus-card'))
  // read while it is still where it was painted: moving it into the ghost
  // drops a fade in progress, and the exit must start from what was shown
  const backdropFrom = backdropVisual($('#focus .focus-backdrop'))
  const destinationEl = page.focusId && page.spaceEls.get(page.focusId)?.el
  invalidateYearRequest()
  $('#focus').removeAttribute('aria-busy')
  const returnTo = attentionReturn || (page.focusId && page.spaceEls.get(page.focusId)?.el) || (page.yearOpen ? $('#dateline') : null)
  attentionReturn = null
  document.documentElement.classList.remove('modal-open')
  $('#focus').dataset.confirm = ''
  page.focusId = null
  page.yearOpen = false
  page.yearShown = null
  watchCurrent.mark?.()
  // the surface leaves the way it came, faster: a copy of it fades and
  // settles back while the real one is already gone, so nothing under the
  // hand waits on an exit
  const leaving = $('#focus').firstElementChild ? [...$('#focus').children] : []
  if (leaving.length && !reduced && !instant) {
    const ghost = document.createElement('div')
    ghost.className = 'focus-leaving'
    ghost.inert = true
    ghost.setAttribute('aria-hidden', 'true')
    for (const el of leaving) ghost.append(el)
    document.body.append(ghost)
    leaveFocusMotion(ghost, from, destinationEl?.getBoundingClientRect(), { backdropFrom })
  }
  $('#focus').innerHTML = ''
  $('#focus').dataset.u = ''
  $('#focus').dataset.help = ''
  if (returnTo) {
    const target = returnTo.isConnected ? returnTo : document.querySelector('[data-attention-open]') || page.field
    target?.focus?.({ preventScroll: true })
  }
}

// ---------------------------------------------------------------- render

/** The date, and how far the year still has to go. The page is named for
    where it is heading and never said so on the page itself — the count
    only existed inside the year view, on the December row. */
function renderYearline() {
  const now = new Date()
  const days = (to) => Math.ceil((to - now) / 86400000)
  const plural = (n) => `${n} day${n === 1 ? '' : 's'}`
  const til =
    now.getMonth() === 11
      ? (() => {
          const left = days(new Date(now.getFullYear() + 1, 0, 1))
          return left <= 1 ? 'last day' : `${plural(left)} left`
        })()
      : `${plural(days(new Date(now.getFullYear(), 11, 1)))} to December`
  const el = $('#dateline')
  const date = `${now.toLocaleString('en', { month: 'long' })} ${now.getDate()}`
  const key = `${date}|${til}`
  // only rebuilt when the day or the count actually turns, so the greeting
  // below fires once on load and not on every ten-second poll
  if (el.dataset.key === key) return
  const first = !el.dataset.key
  el.dataset.key = key
  el.innerHTML = `${esc(date)}<span class="til">${esc(til)}</span>`
  if (first) {
    // it says how far the year has to go once, when you arrive, and then
    // gets out of the way — it is there to be glanced at, not read
    const t = el.querySelector('.til')
    t.classList.add('greet')
    t.addEventListener('animationend', () => t.classList.remove('greet'), { once: true })
  }
}

// One agent pass is one run. It gathers the cards it is changing as the polls
// come in, and only when the pass completes does each card get its one dot.
// Saving never waits on any of this: the run reads state, it owns none.
let run = null
const landing = new Map() // sid → the element a dot is on its way to
const released = [] // destinations of a finished run that resolve without a flight

const heldNow = () => new Set([...(run?.dests || []), ...landing.keys()])

/** What the page has not shown of a space yet. A new space only counts once
    there is a previous state to be new against. */
function unshown(space) {
  const known = page.spaceEls.get(space.id)
  // resting and goal-only spaces have no card either, and are not new
  if (!known) return page.prev && !page.prev.spaces.some((s) => s.id === space.id) ? 'new' : false
  return known.updatedAt !== space.updatedAt || known.previewKey !== space.previewKey ? 'edit' : false
}

/** Every render adds what this poll proves about the run; replayed polls add
    nothing. Returns the cards whose new content waits for a landing: a new
    card stays a hollow frame, an existing card keeps its old content usable. */
function collectRun() {
  const inbox = page.state.captures.map((c) => c.id)
  if (!run && inbox.length) run = { captures: new Set(), dests: new Set(), revealed: new Set(), ran: false }
  if (run) {
    for (const id of inbox) run.captures.add(id)
    run.ran ||= !!page.state.settle.running
    for (const sid of runDestinations(page.state, run.captures, unshown)) run.dests.add(sid)
  }
  return heldNow()
}

// The building moment: a card under construction is a hollow hand-drawn frame
// with provisional ink; the dot landing and blue swipe solidify that ink.
function unbuild(el) {
  if (!el?.classList.contains('building')) return
  el.classList.remove('building')
  el.classList.add('forming')
  eraseCard(el)
  setTimeout(() => el.classList.remove('forming'), 950)
  drawMeters(el)
}

/** A landing, or a release with no flight: the frame resolves and the content
    that was held is adopted once, with its usual arrival and sheen. */
function resolveCards(sids, landed = false) {
  const cards = []
  for (const sid of sids) {
    const el = landing.get(sid) || page.spaceEls.get(sid)?.el
    landing.delete(sid)
    if (el) el._filing = false
    // a later run that wanted the same card sees it resolve now, and has
    // nothing left to land on unless the agent changes the card again
    if (run?.dests.delete(sid)) run.revealed.add(sid)
    if (el?.classList.contains('goal')) { if (landed) bump(el.querySelector('.goal-count')) }
    else if (el) cards.push(el)
  }
  // the swipe solidifies a frame that was being built: a new card, never an edit
  const built = cards.filter((el) => el.classList.contains('building'))
  for (const el of cards) unbuild(el)
  if (page.state) withFlip(() => renderSpaces(heldNow()))
  if (landed) for (const el of built) if (el.isConnected && !el.classList.contains('washed')) washCard(el)
}

/** After every render: finish what needs no flight, and release any frame
    nothing is coming for (a failed pass, a capture filed to nothing). */
function releaseHeld() {
  if (released.length) resolveCards(released.splice(0))
  const held = heldNow()
  for (const el of document.querySelectorAll('.space.building')) {
    if (!held.has(el.dataset.sid) && !el._filing) unbuild(el)
  }
}

/** The pass is complete: one flight per destination card, a stream and not a
    swarm. A card that cannot be seen, already showed its change, or belongs to
    a failed pass resolves where it is. */
function landRun(box) {
  const done = run
  run = null
  const failed = !page.state.settle.running && !!page.state.settle.lastError
  const origin = box.querySelector('.working')?.getBoundingClientRect()
  const sidOf = new Map()
  for (const sid of done.dests) {
    if (landing.has(sid)) continue
    const el = page.spaceEls.get(sid)?.el || document.querySelector(`#goals [data-goal-open="${sid}"]`)
    if (el) sidOf.set(el, sid)
  }
  const canMove = !failed && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const visible = rect => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
  // A dot flies to a card that is new to the page (its frame is still being
  // built) or to a goal's row. A card already here resolves without a flight:
  // its edit or completion is acknowledged in its own ink when it is released.
  const lands = el => el.classList.contains('building') || el.classList.contains('goal')
  const plan = filingPlan([...sidOf.keys()], el => canMove && lands(el) && !done.revealed.has(sidOf.get(el)) && visible(origin) && visible(el.getBoundingClientRect()))
  for (const {target, delay} of plan) {
    const sid = sidOf.get(target)
    if (delay === null) { released.push(sid); continue }
    landing.set(sid, target)
    target._filing = true
    page.flying++
    setTimeout(() => {
      let arrived = false
      travelDot(origin, target, () => {
        if (arrived) return
        arrived = true
        page.flying = Math.max(0, page.flying - 1)
        resolveCards([sid], true)
        // Update both the label and pane once the last visual acknowledgement lands.
        renderInbox()
        releaseHeld()
        hooks.render()
      })
    }, delay)
  }
}

/** Keep the existing thought stack, with truthful delivery/work status.
    Filing acknowledges a bounded set of visible saved destinations. */
function renderInbox() {
  const box = $('#inbox')
  if (run && passComplete(page.state, run.ran)) landRun(box)
  const view = pendingView(page.state, page.queuedCaptures, page.flying, page.retainingCaptures)
  renderPendingStage(box, view)
}

/** The card's own sheen already said what happened. All the top keeps is
    a small mark that undo is available, and only for a moment. */
function renderActivity() {
  const el = $('#activity')
  const acts = page.state.activity || []
  const key = acts.length ? `${acts[0].at}|${page.state.canUndo}` : ''
  if (el.dataset.key === key) return
  el.dataset.key = key
  if (!acts.length || !page.state.canUndo) {
    el.innerHTML = ''
    return
  }
  el.classList.remove('faded')
  el.innerHTML =
    `<span class="sr-only">${esc(acts[0].space)}: ${esc(acts[0].summary)}</span>` +
    `<button class="undo" id="undo-btn" title="${esc(acts[0].space)} · ${esc(acts[0].summary)}">undo</button>`
  clearTimeout(renderActivity._t)
  renderActivity._t = setTimeout(() => el.classList.add('faded'), 8000)
}

/** Closing something out is always a question, and an honest one: it
    names what will be left unfinished. */
function askToFinish(space) {
  const open = openThings(space)
  const wrap = $('#focus')
  wrap.dataset.confirm = space.id
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card co-card" role="dialog" aria-modal="true" aria-labelledby="co-title">
        <h2 class="space-name" id="co-title">Archive ${esc(space.name)}?</h2>
        <p class="co-read">${
          open.length
            ? `<b>${open.length}</b> thing${open.length === 1 ? '' : 's'} still unfinished.`
            : 'Nothing here is unfinished.'
        } You can reopen it anytime.</p>
        <div class="confirm-list">${open.slice(0, 6).map((t) => `<div class="confirm-item">${esc(t)}</div>`).join('')}${open.length > 6 ? `<div class="confirm-item more">and ${open.length - 6} more</div>` : ''}</div>
        <div class="co-actions">
          <button class="btn-solid" data-confirm-finish="${space.id}">Archive</button>
          <button class="btn-quiet" data-close>Keep it open</button>
        </div>
      </article>
    </div>`
}

/** The actual things still waiting, in the person's own words. */
function openThings(space) {
  const out = []
  for (const b of space?.blocks || []) {
    if (b.type === 'list') for (const i of b.items) if (!i.done) out.push(i.text)
    if (b.type === 'reminder' && !b.done) out.push(b.text)
    if (b.type === 'tracker' && b.current < b.target) out.push(`${b.title || 'goal'}: ${b.current} of ${b.target}`)
  }
  return out
}

// ---------------------------------------------------------- the layout
// CSS multi-column rebalances the whole flow whenever any card changes
// height, so cards leap between columns and nothing can be animated. We
// own the columns instead: a card is assigned one and keeps it, so growth
// only ever pushes what is directly below it.

// three columns once the window can hold three readable cards; two on a
// laptop, one on a phone. The shell widens with it (tokens.css).
const colCount = () => (innerWidth <= 720 ? 1 : innerWidth < 1100 ? 2 : 3)
// never more columns than there are cards: a page with one card is one
// column, centered, not a card in the left third of an empty grid
const wantColumns = (cards) => Math.max(1, Math.min(colCount(), cards))

function moveCard(parent, el, before = null) {
  if (parent.moveBefore && el.isConnected) parent.moveBefore(el, before)
  else {
    const focus = el.contains(document.activeElement) ? document.activeElement : null
    parent.insertBefore(el, before)
    focus?.focus({preventScroll:true})
  }
}
function ensureColumns(box, count = box.querySelectorAll('.space').length) {
  const want = wantColumns(count)
  const old = [...box.querySelectorAll(':scope > .col')]
  if (old.length === want) return
  const cards = [...box.querySelectorAll('.space')]
  for (const el of cards) {
    el._columnHomes ||= {}
    el._columnHomes[old.length] = old.indexOf(el.parentElement)
    el.dataset.needsColumn = '1'
  }
  while (box.children.length < want) {
    const col = document.createElement('div')
    col.className = 'col'
    box.appendChild(col)
  }
  while (box.children.length > want) {
    const last = box.lastElementChild
    for (const el of [...last.children]) moveCard(box.firstElementChild, el)
    last.remove()
  }
}

/** Place cards in order, each into the currently shortest column. Cards
    already in the right place are left alone entirely. */
function placeCards(box, ordered) {
  const cols = [...box.querySelectorAll('.col')]
  if (!cols.length) return
  const heights = cols.map(() => 0)
  const want = cols.map(() => [])
  for (const el of ordered) {
    let target = 0
    for (let i = 1; i < cols.length; i++) if (heights[i] < heights[target]) target = i
    // Content growth is not a request to move a card across the page.
    // Only new cards or a changed column count need a new assignment.
    const cur = cols.indexOf(el.parentElement)
    if (cur !== -1 && !el.dataset.needsColumn) target = cur
    else if (el._columnHomes?.[cols.length] >= 0 && el._columnHomes[cols.length] < cols.length) target = el._columnHomes[cols.length]
    el._columnHomes ||= {}
    el._columnHomes[cols.length] = target
    delete el.dataset.needsColumn
    want[target].push(el)
    heights[target] += restHeight(el) + 14
  }
  // touch the DOM only where it actually differs: re-appending a node
  // restarts its animations, so a needless move replays the sheen
  cols.forEach((col, i) => {
    const have = [...col.children]
    const need = want[i]
    if (have.length === need.length && have.every((el, n) => el === need[n])) return
    need.forEach((el, n) => { if (col.children[n] !== el) moveCard(col, el, col.children[n] || null) })
  })
}

const DORMANT_MS = 30 * 86400000

/** Quietly re-render one card (done items resort to the tail) with a FLIP
    glide and no agent-touch sheen: this was the person's own hand. */
function resortCard(sid) {
  const known = page.spaceEls.get(sid)
  if (!known) return
  known.updatedAt = ''
  known.quiet = true
  withFlip(() => renderSpaces())
}

/** The end of a completion. Both renderings of the card adopt the latest
    confirmed state in one real-layout move: no FLIP to compound with it and
    no sheen, because this was the person's own hand. An opened card still in
    flight keeps its one owner and only retargets. */
function settleCard(sid, keys) {
  const space = page.state.spaces.find((s) => s.id === sid)
  if (!space) {
    hooks.render()
    return Promise.resolve()
  }
  const runs = []
  const known = page.spaceEls.get(sid)
  if (known) {
    runs.push(settleRows(known.el, keys, () => updateCardContent(known.el, spaceInner(space))))
    syncTools(known.el, space)
    known.el.classList.toggle('pinned', !!space.pinned)
    known.quiet = false
    known.updatedAt = space.updatedAt
    known.previewKey = space.previewKey
    known.shown = space
    // the hand's own settlement showed whatever the agent had written by now
    if (run && page.state.settle.running) run.revealed.add(sid)
  }
  const wrap = $('#focus')
  const opened = wrap.querySelector('.focus-card')
  if (page.focusId === sid && opened?.dataset.sid === sid && !wrap.dataset.confirm) {
    if (focusIsMoving(opened)) {
      const flight = focusVisualRect(opened)
      updateCardContent(opened, spaceInner(space, true))
      openFocusMotion(opened, flight)
    } else runs.push(settleRows(opened, keys, () => updateCardContent(opened, spaceInner(space, true))))
    wrap.dataset.u = space.updatedAt
    wrap.dataset.preview = space.previewKey || ''
    syncTools(opened, space)
  }
  return Promise.all(runs)
}

function renderSpaces(delayWash = new Set()) {
  const box = $('#spaces')
  const seen = new Set()
  const now = Date.now()
  // a space that is nothing but its goal is already on the page, in the
  // band over the cards — a card for it would say the same thing twice
  const live = page.state.spaces.filter((s) => !s.finished && !goalOnly(s) && !(delayWash.has(s.id) && !s.blocks.length))
  const finished = page.state.spaces.filter((s) => s.finished)
  const active = live.filter((s) => now - new Date(s.updatedAt) < DORMANT_MS || page.awake.has(s.id))
  const resting = live.filter((s) => !active.includes(s))

  const arriving = []
  ensureColumns(box, active.length)
  active.forEach((space, i) => {
    seen.add(space.id)
    // whatever branch runs below, the tools reflect the space afterwards
    queueMicrotask(() => syncTools(page.spaceEls.get(space.id)?.el, space))
    const known = page.spaceEls.get(space.id)
    if (!known) {
      const el = document.createElement('article')
      // Actual structured content determines the frame and destination.
      // It grows in place, then the landing resolves its provisional ink.
      const building = delayWash.has(space.id) && !reduced
      el.className = building ? 'space settled building' : 'space fresh'
      el.tabIndex = 0
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', `${space.name}, open`)
      // on the first paint the cards follow the header in, a beat apart and
      // for longer; afterwards a new card arrives on its own immediately
      el.style.animationDelay = page.booting
        ? `${260 + Math.min(i * 55, 660)}ms`
        : '0ms'
      el.dataset.sid = space.id
      el.dataset.needsColumn = '1'
      el.innerHTML = spaceInner(space)
      el.classList.toggle('pinned', !!space.pinned)
      // once the entrance ends, stop its fill so FLIP transforms can act
      const finishArrival = (event) => {
        if (event.target !== el) return
        el.classList.add('settled')
        el.removeEventListener('animationend', finishArrival)
      }
      el.addEventListener('animationend', finishArrival)
      if (!el.isConnected) (box.querySelector('.col') || box).appendChild(el)
      if (building) { arriving.push(el); drawCard(el) }
      page.spaceEls.set(space.id, { el, updatedAt: space.updatedAt, previewKey: space.previewKey, shown: space })
      layoutObserver.observe(el)
      if (!building) drawMeters(el)
    // A card inside a completion's moment is left alone: a poll that adopted
    // the check early would pull the row out from under the hand. Its
    // settlement reconciles it, from whatever is true by then.
    } else if (!cardHeld(space.id) && (known.updatedAt !== space.updatedAt || known.previewKey !== space.previewKey)) {
      // A run destination keeps the content it has, fully usable, until the
      // pass releases it. A frame still building grows with its provisional ink, and
      // the person's own re-sort is never held.
      const building = known.el.classList.contains('building')
      if (delayWash.has(space.id) && !building && !known.quiet) return
      if (run && !building && page.state.settle.running) run.revealed.add(space.id)
      // Hold confirmed completions until their shared check-and-collapse settles.
      if (!building && !known.quiet && playConfirmed(space.id, newlyDone(known.shown, space))) return
      // diff against what this card last showed: a held card skipped polls
      const prevSpace = known.shown || page.prev?.spaces.find((s) => s.id === space.id)
      const heightBefore = known.el.getBoundingClientRect().height
      updateCardContent(known.el, spaceInner(space))
      syncCardWriting(known.el)
      animateCardShape(known.el, heightBefore)
      known.el.classList.toggle('pinned', !!space.pinned)
      known.el.style.animationDelay = '0ms'
      known.el.classList.remove('fresh')
      // New ink fades in where it already sits; the growing frame is the only
      // thing that moves. A frame still being built resolves at its landing.
      if (!known.el.classList.contains('building')) {
        const before = new Set((prevSpace?.blocks || []).map((b) => b.id))
        for (const bel of known.el.querySelectorAll('[data-bid]')) {
          if (!before.has(bel.dataset.bid)) bel.classList.add('arrive')
        }
        if (!known.quiet) {
          // a row inside a new block arrives with its block, not a second time
          const priorItems = new Set((prevSpace?.blocks || []).flatMap(b => (b.items || []).map(item => `${b.id}/${item.id}`)))
          for (const row of known.el.querySelectorAll('.row[data-item]')) {
            if (before.has(row.dataset.block) && !priorItems.has(`${row.dataset.block}/${row.dataset.item}`)) showAddedItem(row)
          }
        }
      }
      // While a capture is being filed, the landing is the one confirmation:
      // the dot arrives, the swipe runs once. Other edits keep their own tint.
      const landingOwns = known.el._filing || delayWash.has(space.id)
      if (!landingOwns) highlightCardChanges(known.el, prevSpace, space)
      // changed numbers beat; changed meters glide from where they were
      for (const b of space.blocks) {
        const pb = prevSpace?.blocks.find((x) => x.id === b.id)
        if (!pb) continue
        const bel = known.el.querySelector(`[data-bid="${b.id}"]`)
        if (!bel) continue
        if (b.type === 'tracker' && pb.current !== b.current) {
          bump(bel.querySelector('.tracker-count'))
          markChange(bel.querySelector('.tracker-count'), `${b.current > pb.current ? '+' : ''}${b.current - pb.current}`)
          const span = bel.querySelector('.meter span')
          if (span && !reduced) {
            const target = span.style.width
            span.style.transition = 'none'
            span.style.width = `${Math.min(100, Math.round((pb.current / pb.target) * 100))}%`
            void span.offsetWidth
            span.style.transition = ''
            requestAnimationFrame(() => (span.style.width = target))
          }
        }
        if (b.type === 'ledger' && (pb.total ?? 0) !== (b.total ?? 0)) {
          bump(bel.querySelector('.ledger-total'))
          const delta = (b.total ?? 0) - (pb.total ?? 0)
          markChange(bel.querySelector('.ledger-total'), `${delta < 0 ? '−' : '+'}${fmtAmount(Math.abs(delta), b.unit)}`)
          if (!known.el.classList.contains('building')) bel.querySelector('.ledger-entry')?.classList.add('entry-in')
        }
        if (b.type === 'streak' && b.dates.length > (pb.dates?.length ?? 0)) {
          const dots = bel.querySelectorAll('.streak-dots i.on')
          dots[dots.length - 1]?.classList.add('just-marked')
        }
      }
      // no sheen here: the swipe belongs to a new card's landing alone. An
      // edit to a card already on the page is said by its changed ink.
      known.quiet = false
      known.updatedAt = space.updatedAt
      known.previewKey = space.previewKey
      known.shown = space
    }
  })
  for (const [id, { el }] of page.spaceEls) {
    if (!seen.has(id) && !cardHeld(id)) {
      layoutObserver.unobserve(el)
      eraseCard(el)
      el.remove()
      page.spaceEls.delete(id)
    }
  }

  // ordering is a placement decision, made once, for all columns
  placeCards(box, active.map((s) => page.spaceEls.get(s.id)?.el).filter(Boolean))
  for (const el of arriving) animateCardShape(el, 8, { enter: true })

  renderResting(finished, resting)
}

// ------------------------------------------------- the foot of the page
// Everything you are done with used to sit here as one full-width row per
// space, at the same weight as live work: twenty rows and 809px on a page
// of 3587, printing "done in june" three times because the month was a
// grouping signal rendered once per row. It only ever grew. It is a count
// now, and opening one gives the month grouping the rows were spelling out.


const GROUPS = {
  finished: { verb: 'data-reopen', dateOf: (s) => s.finishedAt || s.updatedAt },
  resting: { verb: 'data-wake', dateOf: (s) => s.updatedAt },
  retired: { verb: 'data-restore', dateOf: () => '' },
}

/** Newest month first, each month naming its spaces once. */
function byMonth(list, dateOf) {
  const out = new Map()
  for (const s of [...list].sort((a, b) => String(dateOf(b)).localeCompare(String(dateOf(a))))) {
    const at = dateOf(s)
    const label = at ? new Date(at).toLocaleString('en', { month: 'long' }).toLowerCase() : ''
    if (!out.has(label)) out.set(label, [])
    out.get(label).push(s)
  }
  return [...out.entries()]
}

function renderResting(finished, resting) {
  const rest = $('#resting')
  const sets = { finished, resting, retired: page.state.retired || [] }
  if (!sets[page.restOpen]?.length) page.restOpen = '' // the group emptied under us
  const counts = Object.entries(sets).filter(([, v]) => v.length)
  if (!counts.length) {
    rest.innerHTML = ''
    return
  }
  // The shell is built once and kept. Replacing the whole section on every
  // render would hand the panel its content and its open state in the same
  // frame, and a transition with no starting state does not run — it snaps.
  if (!rest.querySelector('.rest-open')) {
    rest.innerHTML = '<div class="rest-fold"></div><div class="rest-open"><div></div></div>'
  }
  const fold = rest.querySelector('.rest-fold')
  const panel = rest.querySelector('.rest-open')
  const inner = panel.firstElementChild

  const lineKey = counts.map(([k, v]) => `${k}${v.length}`).join('|') + `|${page.restOpen}`
  if (fold.dataset.key !== lineKey) {
    fold.dataset.key = lineKey
    fold.innerHTML = counts
      .map(
        ([name, v]) =>
          `<button class="rest-grp ${page.restOpen === name ? 'on' : ''}" data-grp="${name}" aria-expanded="${page.restOpen === name}">${name === 'finished' ? 'archive' : name} <span class="rest-n">${v.length}</span></button>`
      )
      .join('')
  }

  const contentKey = page.restOpen ? page.restOpen + sets[page.restOpen].map((s) => s.id).join() : ''
  if (panel.dataset.key === contentKey) return
  panel.dataset.key = contentKey
  if (!page.restOpen) {
    // let it close before it empties, so it collapses rather than vanishes
    panel.classList.remove('on')
    setTimeout(() => {
      if (!panel.dataset.key) inner.innerHTML = ''
    }, 420)
    return
  }
  const { verb, dateOf } = GROUPS[page.restOpen]
  inner.innerHTML = byMonth(sets[page.restOpen], dateOf)
    .map(
      ([month, list]) => `
      <div class="rest-month">
        <span class="rest-mlabel">${esc(month)}</span>
        <span class="rest-names">${list
          .map((s) => `<button class="rest-name" ${verb}="${s.id}">${esc(s.name)}</button>`)
          .join('')}</span>
      </div>`
    )
    .join('')
  // a frame between the content arriving and the row opening, so there is a
  // height to grow from
  requestAnimationFrame(() => panel.classList.add('on'))
}

// Keep the last layout in document coordinates. A resize event arrives
// after CSS has reflowed, so measuring only then has already lost the origin.
const resizePositions = new Map()
function rememberLayoutPositions() {
  for (const [el] of resizePositions) if (!el.isConnected) resizePositions.delete(el)
  for (const el of document.querySelectorAll('#spaces .space')) {
    const r = el.getBoundingClientRect()
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
    resizePositions.set(el, {left:r.left + scrollX - matrix.m41, top:r.top + scrollY - matrix.m42, width:r.width, height:r.height})
  }
}
const layoutObserver = new ResizeObserver(rememberLayoutPositions)
queueMicrotask(() => { const box = $('#spaces'); if (box) layoutObserver.observe(box) })

function resizeLayout() {
  if (resizeLayout._frame) return
  resizeLayout._frame = requestAnimationFrame(() => {
    resizeLayout._frame = null
    if (!page.state) return
    const prior = new Map()
    for (const [el, r] of resizePositions) {
      if (!el.isConnected) continue
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform)
      prior.set(el, {...r, left:r.left-scrollX+matrix.m41, top:r.top-scrollY+matrix.m42})
    }
    const box = $('#spaces')
    withFlip(() => {
      if (box.children.length !== wantColumns(box.querySelectorAll('.space').length)) renderSpaces()
    }, prior)
    rememberLayoutPositions()
    if ($('#capture')?.value) hooks.fitCapture()
  })
}
window.addEventListener('resize', resizeLayout)

function renderRail() {
  const rail = $('#rail')
  const on = page.state.spaces.filter((s) => !s.finished && !goalOnly(s)).length >= 6
  rail.classList.toggle('on', on)
  if (!on) return
  const key = page.state.spaces.map((s) => s.id + s.name + s.finished + (s.area || '')).join()
  if (rail.dataset.key !== key) {
    rail.dataset.key = key
    updateRail(rail, page.state.spaces.filter(s => !s.finished && !goalOnly(s)))
  }
  watchCurrent()
}

// the card you are beside is the one the rail marks, and it follows you
// down the page; while a card is open, that card
let currentWatch
const railSeen = new Map()
const railObserved = new Set()
function watchCurrent() {
  const rail = $('#rail')
  if (!rail.classList.contains('on') || !('IntersectionObserver' in window)) return
  const seen = railSeen
  const mark = () => {
    const open = page.focusId
    let best = open
    if (!best) {
      let top = Infinity
      for (const [sid, r] of seen) if (r < top) { top = r; best = sid }
    }
    for (const a of rail.querySelectorAll('a')) {
      const current = a.dataset.jump === best
      a.classList.toggle('current', current)
      if (current) a.setAttribute('aria-current', 'location')
      else a.removeAttribute('aria-current')
    }
  }
  if (!currentWatch) currentWatch = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const sid = en.target.dataset.sid
      if (en.isIntersecting) seen.set(sid, Math.abs(en.boundingClientRect.top - 80))
      else seen.delete(sid)
    }
    mark()
  }, { rootMargin: '-72px 0px -40% 0px', threshold: [0, .25] })
  for (const el of [...railObserved]) if (!el.isConnected) { currentWatch.unobserve(el); railObserved.delete(el); seen.delete(el.dataset.sid) }
  for (const el of $('#spaces').querySelectorAll('.space[data-sid]')) if (!railObserved.has(el)) { railObserved.add(el); currentWatch.observe(el) }
  mark()
  watchCurrent.mark = mark
}


/** Suggestions are an answer to a question you only ask with an empty,
    focused field. At rest they do not exist. */
function renderSuggestions() {
  const box = $('#suggest')
  // ask the DOM, never a flag: any render self-corrects. Autofocus on load
  // does not count as asking; you have to reach for the field yourself.
  const show = page.reachedFor && document.activeElement === page.field && !page.field.value.trim() && !page.state.captures.length
  const list = show ? (page.state.suggestions || []).slice(0, page.attentionCount >= 3 ? 2 : 3) : []
  const key = `${show}|${list.join('|')}`
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.classList.remove('retired')
  box.innerHTML = list
    .map((s, i) => `<button class="chip-btn chip-in" data-suggest="${esc(s)}" style="--d:${i * 70}ms">${esc(s)}</button>`)
    .join('')
}

/** The question already says what shape the answer takes, so the field can
    show it: "type it" tells nobody anything. */
function askHint(q) {
  const t = String(q).toLowerCase()
  if (t.includes('what time') || t.includes('which time')) return 'like 7pm'
  if (t.includes('how much') || t.includes('how many')) return 'like 20'
  if (t.includes('what day') || t.includes('which day') || t.startsWith('when')) return 'like friday'
  if (t.includes('how long')) return 'like 45 min'
  if (t.includes('where')) return 'type it'
  return 'type it'
}

function renderAsk() {
  const box = $('#ask')
  if (!page.state.ask) {
    if (box.dataset.aid) {
      box.dataset.aid = ''
      const card = box.querySelector('.ask')
      if (card) {
        card.classList.add('out')
        setTimeout(() => { if (card.parentElement === box && !box.dataset.aid) card.remove() }, 240)
      }
    }
    return
  }
  if (box.dataset.aid === page.state.ask.id) return
  box.dataset.aid = page.state.ask.id
  const opts = page.state.ask.options || []
  // The guesses are guesses. Every question keeps a way to answer it in your
  // own words — offering three wrong options and no way past them is worse
  // than asking nothing at all.
  box.innerHTML = `
    <div class="ask" data-ask-id="${esc(page.state.ask.id)}">
      <div class="ask-q">${esc(page.state.ask.question)}</div>
      ${
        opts.length
          ? `<div class="chips">${opts
              .map((o, i) => `<button class="chip-btn" data-answer="${esc(o)}" style="--d:${i * 45}ms">${esc(o)}</button>`)
              .join('')}</div>`
          : ''
      }
      <div class="ask-reply" style="--d:${opts.length ? opts.length * 45 + 40 : 60}ms">
        <input class="ask-input" placeholder="${opts.length ? 'or say it your way' : askHint(page.state.ask.question)}"
          autocomplete="off" spellcheck="false" aria-label="Your answer" />
        <button class="skip" data-dismiss>skip</button>
      </div>
    </div>`
  // The caret lands in the answer, which says "this is for you" better than
  // any label could — but never while you are mid-sentence somewhere else.
  const busy = document.activeElement === page.field || page.field.value.trim()
  if (!busy && !reduced) {
    setTimeout(() => box.querySelector('.ask-input')?.focus({ preventScroll: true }), 260)
  }
}

// what you can say, once, when you want it
const CAN_DO = [
  ['just write it', 'paid rent 2300 · ran 3 miles · call the landlord thursday'],
  ['ask for a shape', "I'd like a progress bar for rent this year"],
  ['ask a question', 'how much have I spent on the car?'],
  ['correct it', 'groceries go under Food, not Housing — it remembers'],
  ['dump everything', 'paste many lines at once; each finds its own home'],
  ['talk to one space', 'open a card and write inside it'],
]
/** The reference, reachable from Settings whenever you want it — rather
    than thrown at a brand new page once and then gone forever. The old
    footer promised "? for this", which was never wired: the writing line
    holds the caret from the moment the page opens, so a bare ? has nowhere
    to land. It lists the keys that actually work now. */
function showIntro() {
  attentionReturn = document.activeElement
  const wrap = $('#focus')
  wrap.dataset.help = '1'
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" role="dialog" aria-modal="true" aria-label="What December can do">
        <div class="surface-heading"><h2 class="space-name">What you can say</h2><button class="surface-close" data-close aria-label="Close writing help">Close</button></div>
        ${CAN_DO.map(([k, v]) => `<div class="can-row"><div class="can-k">${esc(k)}</div><div class="can-v">${esc(v)}</div></div>`).join('')}
        <div class="can-keys">/ to find · ⌘Z to undo · esc to close</div>
      </article>
    </div>`
  mountSurface(wrap.querySelector('.focus-card'), true)
}

export { rememberReturn, openStageCard, buildFocus, closeFocus, renderYearline, collectRun, renderInbox, renderActivity, askToFinish, resortCard, settleCard, renderSpaces, renderResting, resizeLayout, renderRail, renderSuggestions, renderAsk, showIntro, releaseHeld }
