import { $, esc, localDay, reduced, fmtAmount, page, hooks } from './session.js'
import { clockOf, whenPhrase, words, spaceInner } from './blocks.js'
import { markChange, markEdited, bump, travelDot, washCard, withFlip, drawMeters } from './motion.js'

// ------------------------------------------------------------ focus view


function buildFocus() {
  const wrap = $('#focus')
  const space = page.focusId && page.state.spaces.find((s) => s.id === page.focusId)
  if (!space) {
    page.focusId = null
    wrap.innerHTML = ''
    return
  }
  // a re-render (the agent touched this space) must never eat a draft
  // mid-sentence, drop the caret, or jump the scroll
  const oldField = wrap.querySelector('.focus-capture')
  const draft = oldField?.value || ''
  const hadFocus = document.activeElement === oldField
  const caret = oldField?.selectionStart ?? draft.length
  const scrollTop = wrap.querySelector('.focus-card')?.scrollTop || 0

  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" data-sid="${space.id}">
        ${spaceInner(space, true)}
        <textarea class="capture focus-capture" rows="1" placeholder="Add to ${esc(space.name)}…" spellcheck="false"></textarea>
      </article>
    </div>`
  wrap.dataset.u = space.updatedAt
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
  document.documentElement.classList.add('modal-open')
}

function closeFocus() {
  document.documentElement.classList.remove('modal-open')
  $('#focus').dataset.confirm = ''
  page.focusId = null
  page.yearOpen = false
  page.yearShown = null
  $('#focus').innerHTML = ''
  $('#focus').dataset.u = ''
  $('#focus').dataset.help = ''
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

function travelTargets() {
  const targets = new Map()
  const ids = new Set(page.state.captures.map((c) => c.id))
  for (const a of page.state.activity) {
    if (!page.pending.has(a.captureId) || ids.has(a.captureId)) continue
    const space = page.state.spaces.find((s) => s.name === a.space)
    if (space) targets.set(a.captureId, space.id)
  }
  return targets
}

/** Spaces that appeared while something is still settling. The agent
    creates a space BEFORE it files the capture, so without this the card
    materializes whole on one poll and the mote arrives on the next — the
    card beating its own animation. Held cards stay a hollow frame until
    the mote lands on them. */
function heldSpaces() {
  if (!page.state.captures.length || !page.prev) return []
  const before = new Set(page.prev.spaces.map((s) => s.id))
  return page.state.spaces.filter((s) => !before.has(s.id)).map((s) => s.id)
}

/** Pinning does not change a space's content, so its updatedAt does not
    move and the card's markup is never rebuilt. The tools have to be synced
    on their own or an unpinned card keeps a solid pin forever. */
function syncTools(el, space) {
  if (!el) return
  el.classList.toggle('pinned', !!space.pinned)
  const pin = el.querySelector('[data-pin]')
  if (pin) {
    pin.classList.toggle('on', !!space.pinned)
    pin.setAttribute('aria-label', space.pinned ? 'Unpin' : 'Pin')
    pin.setAttribute('title', space.pinned ? 'unpin' : 'pin')
    pin.querySelector('svg')?.setAttribute('fill', space.pinned ? 'currentColor' : 'none')
  }
  el.querySelector('[data-finish]')?.classList.toggle('ready', !!space.complete)
}

// The building moment: a card under construction is a hollow dashed frame
// with its content still forming; when the mote lands, it inks in.
function unbuild(el) {
  if (!el?.classList.contains('building')) return
  el.classList.remove('building')
  el.classList.add('forming')
  setTimeout(() => el.classList.remove('forming'), 700)
  drawMeters(el)
}

/** Nothing left settling: release any frame still waiting on a mote that
    is never coming (a failed pass, a capture filed to nothing). */
function releaseHeld(targets) {
  if (page.state.captures.length) return
  const landing = new Set(targets.values())
  for (const el of document.querySelectorAll('.space.building')) {
    if (!landing.has(el.dataset.sid)) unbuild(el)
  }
}

/** While the agent works the stage says one word, not your own sentence.
    The words you just wrote were echoed back for the whole pass — thirty
    to sixty seconds of reading what you already knew — and everything then
    resolved in about a second. The one line stays put while each settled
    capture flies out of it into its card, so the filing motion still reads
    as your sentence travelling somewhere. */
function renderInbox(targets = new Map()) {
  const box = $('#inbox')
  const failed = !page.state.settle.running && page.state.settle.lastError
  const captureOnly = page.state.settle.captureOnly
  const ids = new Set(page.state.captures.map((c) => c.id))

  // anything that left the inbox since the last pass flies to its card;
  // a batch launches as a stream, not a swarm
  const origin = box.querySelector('.working')?.getBoundingClientRect()
  let launch = 0
  for (const cid of [...page.pending]) {
    if (ids.has(cid)) continue
    page.pending.delete(cid)
    const targetEl = page.spaceEls.get(targets.get(cid))?.el
    if (!targetEl || !origin) continue
    page.flying++
    setTimeout(() => {
      travelDot(origin, targetEl, () => {
        unbuild(targetEl)
        washCard(targetEl)
        page.flying = Math.max(0, page.flying - 1)
        hooks.renderStage() // the stage was holding open for this
      })
    }, launch++ * 160)
  }
  for (const c of page.state.captures) page.pending.add(c.id)

  const word = captureOnly ? 'saved · capture only' : failed ? "couldn't settle" : 'working'
  const kind = captureOnly ? 'capture-only' : failed ? 'failed' : ''
  // the queue: what you said, greyed, in order, until it lands on a card
  const queue = [...page.queuedTexts, ...page.state.captures.map((c) => c.text)]
  const show = queue.length > 0 || page.pending.size > 0 || page.state.settle.running || page.flying > 0
  const key = show ? `${kind}|${word}|${queue.join('¦')}` : ''
  if (box.dataset.key === key) return
  box.dataset.key = key
  const dots = kind === '' ? '<span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : ''
  box.innerHTML = show
    ? queue.map((t) => `<div class="queue-row">${esc(t)}</div>`).join('') +
      `<div class="working ${kind}"><span class="working-word">${esc(word)}</span>${dots}${
        failed ? '<button class="retry">retry</button>' : ''
      }</div>`
    : ''
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
        <h2 class="space-name" id="co-title">Close out ${esc(space.name)}?</h2>
        <p class="co-read">${
          open.length
            ? `<b>${open.length}</b> thing${open.length === 1 ? '' : 's'} still unfinished.`
            : 'Nothing here is unfinished.'
        } You can reopen it anytime.</p>
        <div class="confirm-list">${open.slice(0, 6).map((t) => `<div class="confirm-item">${esc(t)}</div>`).join('')}${open.length > 6 ? `<div class="confirm-item more">and ${open.length - 6} more</div>` : ''}</div>
        <div class="co-actions">
          <button class="btn-solid" data-confirm-finish="${space.id}">Close it out</button>
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

const colCount = () => (innerWidth <= 720 ? 1 : 2)

function ensureColumns(box) {
  const want = colCount()
  if (box.children.length === want && box.firstElementChild?.classList.contains('col')) return
  const cards = [...box.querySelectorAll('.space')]
  box.innerHTML = ''
  for (let i = 0; i < want; i++) {
    const col = document.createElement('div')
    col.className = 'col'
    box.appendChild(col)
  }
  for (const c of cards) box.firstElementChild.appendChild(c)
}

/** Place cards in order, each into the currently shortest column. Cards
    already in the right place are left alone entirely. */
function placeCards(box, ordered) {
  const cols = [...box.querySelectorAll('.col')]
  if (!cols.length) return
  const heights = cols.map(() => 0)
  const want = cols.map(() => [])
  const STICK = 140 // px of imbalance a card tolerates to stay put
  for (const el of ordered) {
    let target = 0
    for (let i = 1; i < cols.length; i++) if (heights[i] < heights[target]) target = i
    // a card that already lives somewhere stays there unless the shortest
    // column is genuinely shorter: re-balancing on every small height change
    // is what makes the page churn
    const cur = cols.indexOf(el.parentElement)
    if (cur !== -1 && heights[cur] <= heights[target] + STICK) target = cur
    want[target].push(el)
    heights[target] += el.offsetHeight + 14
  }
  // touch the DOM only where it actually differs: re-appending a node
  // restarts its animations, so a needless move replays the sheen
  cols.forEach((col, i) => {
    const have = [...col.children]
    const need = want[i]
    if (have.length === need.length && have.every((el, n) => el === need[n])) return
    for (const el of need) col.appendChild(el)
  })
}

/** A card that changed content grows or shrinks into its new size. */
function animateHeight(el, from) {
  if (reduced) return
  const to = el.offsetHeight
  if (from === to || !from) return
  el.style.height = `${from}px`
  el.style.overflow = 'hidden'
  void el.offsetHeight
  el.style.transition = 'height var(--m-struct) var(--ease-expo)'
  el.style.height = `${to}px`
  const done = () => {
    el.style.height = ''
    el.style.overflow = ''
    el.style.transition = ''
    el.removeEventListener('transitionend', done)
  }
  el.addEventListener('transitionend', done)
  setTimeout(done, 500)
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

function renderSpaces(delayWash = new Set()) {
  const box = $('#spaces')
  const seen = new Set()
  const now = Date.now()
  const live = page.state.spaces.filter((s) => !s.finished)
  const finished = page.state.spaces.filter((s) => s.finished)
  const active = live.filter((s) => now - new Date(s.updatedAt) < DORMANT_MS || page.awake.has(s.id))
  const resting = live.filter((s) => !active.includes(s))

  ensureColumns(box)
  active.forEach((space, i) => {
    seen.add(space.id)
    // whatever branch runs below, the tools reflect the space afterwards
    queueMicrotask(() => syncTools(page.spaceEls.get(space.id)?.el, space))
    const known = page.spaceEls.get(space.id)
    if (!known) {
      const el = document.createElement('article')
      // a card born from a settling capture arrives as a hollow frame and
      // inks in when the dot lands; anything else materializes whole
      const building = delayWash.has(space.id) && !reduced
      el.className = building ? 'space fresh building' : 'space fresh'
      el.tabIndex = 0
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', `${space.name}, open`)
      // on the first paint the cards follow the header in, a beat apart and
      // for longer; afterwards a new card arrives on its own immediately
      el.style.animationDelay = page.booting
        ? `${260 + Math.min(i * 55, 660)}ms`
        : `${Math.min(i * 45, 270)}ms`
      el.dataset.sid = space.id
      el.innerHTML = spaceInner(space)
      el.classList.toggle('pinned', !!space.pinned)
      // once the entrance ends, stop its fill so FLIP transforms can act
      el.addEventListener('animationend', () => el.classList.add('settled'), { once: true })
      ;(box.querySelector('.col') || box).appendChild(el)
      page.spaceEls.set(space.id, { el, updatedAt: space.updatedAt })
      if (!building) drawMeters(el)
    } else if (known.updatedAt !== space.updatedAt) {
      const prevSpace = page.prev?.spaces.find((s) => s.id === space.id)
      const heightBefore = known.el.offsetHeight
      known.el.innerHTML = spaceInner(space)
      animateHeight(known.el, heightBefore)
      known.el.classList.toggle('pinned', !!space.pinned)
      known.el.style.animationDelay = '0ms'
      known.el.classList.remove('fresh')
      // blocks the agent just added rise in individually
      const before = new Set((prevSpace?.blocks || []).map((b) => b.id))
      let n = 0
      for (const bel of known.el.querySelectorAll('[data-bid]')) {
        if (!before.has(bel.dataset.bid)) {
          bel.classList.add('arrive')
          bel.style.setProperty('--d', `${Math.min(n++, 4) * 45}ms`)
        }
      }
      // reworded text is not a flicker: it says it changed
      const prevText = new Map()
      for (const pb of prevSpace?.blocks || []) {
        if (pb.type === 'list') for (const i of pb.items) prevText.set(i.id, i.text)
        if (pb.type === 'note' || pb.type === 'reminder') prevText.set(pb.id, pb.text)
      }
      for (const b of space.blocks) {
        const bel0 = known.el.querySelector(`[data-bid="${b.id}"]`)
        if (!bel0) continue
        if (b.type === 'list') {
          for (const i of b.items) {
            if (prevText.has(i.id) && prevText.get(i.id) !== i.text) {
              markEdited(bel0.querySelector(`[data-item="${i.id}"] .row-text`))
            }
          }
        } else if ((b.type === 'note' || b.type === 'reminder') && prevText.has(b.id) && prevText.get(b.id) !== b.text) {
          markEdited(bel0.querySelector('.note-text, .row-text'))
        }
      }
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
          markChange(bel.querySelector('.ledger-total'), `+${fmtAmount((b.total ?? 0) - (pb.total ?? 0), b.unit)}`)
          bel.querySelector('.ledger-entry')?.classList.add('entry-in')
        }
        if (b.type === 'streak' && b.dates.length > (pb.dates?.length ?? 0)) {
          const dots = bel.querySelectorAll('.streak-dots i.on')
          dots[dots.length - 1]?.classList.add('just-marked')
        }
      }
      // cards receiving a travel dot wash when the dot lands, not before;
      // quiet re-sorts (the person's own hand) get no sheen at all
      if (!delayWash.has(space.id) && !known.quiet) washCard(known.el)
      known.quiet = false
      known.updatedAt = space.updatedAt
    }
  })
  for (const [id, { el }] of page.spaceEls) {
    if (!seen.has(id)) {
      el.remove()
      page.spaceEls.delete(id)
    }
  }

  // ordering is a placement decision, made once, for all columns
  placeCards(box, active.map((s) => page.spaceEls.get(s.id)?.el).filter(Boolean))

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
          `<button class="rest-grp ${page.restOpen === name ? 'on' : ''}" data-grp="${name}" aria-expanded="${page.restOpen === name}">${name} <span class="rest-n">${v.length}</span></button>`
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

/** A rotation should become the new layout immediately, not after the next
    ten-second state poll. Only rebuild the column shells when the breakpoint
    actually changes; CSS handles all fluid resizing within a layout. */
function resizeLayout() {
  clearTimeout(resizeLayout._t)
  resizeLayout._t = setTimeout(() => {
    if (!page.state) return
    const box = $('#spaces')
    if (box.children.length !== colCount()) withFlip(() => renderSpaces())

    if ($('#capture')?.value) hooks.fitCapture()
  }, 120)
}
window.addEventListener('resize', resizeLayout)

function renderRail() {
  const rail = $('#rail')
  const on = page.state.spaces.filter((s) => !s.finished).length >= 6
  rail.classList.toggle('on', on)
  if (!on) return
  const key = page.state.spaces.map((s) => s.id + s.name + s.finished).join()
  if (rail.dataset.key === key) return
  rail.dataset.key = key
  // A flat list of pointers, nothing more. Areas still exist on the cards;
  // the rail's one job is taking your eye to a card.
  const live = page.state.spaces.filter((s) => !s.finished)
  rail.innerHTML = live.map((s) => `<a href="#" data-jump="${s.id}">${esc(s.name)}</a>`).join('')
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
        setTimeout(() => (box.innerHTML = ''), 240)
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
    <div class="ask">
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

/** The page faces the day: what has become relevant rises to the top —
    due and tomorrow's reminders, evening-open streaks, and whatever the
    surfacing sense pinned, each with its reason. */
/** A day the way you would say it inside a week: "fri 14". */
function weekdayOf(iso) {
  const dt = new Date(`${iso}T12:00:00`)
  return `${dt.toLocaleString('en', { weekday: 'short' }).toLowerCase()} ${dt.getDate()}`
}

/** What needs you, in two bands: what is due now, and what is coming.
    The horizon used to stop at tomorrow, so a page holding eight dated
    things could tell you about none of them — everything you had written
    down stayed invisible until the night before, and the only reason
    anything further out ever appeared was that the agent happened to
    guess it was worth surfacing. Dates the page already holds are not a
    matter of judgment. */
function renderToday() {
  const box = $('#today')
  const today = localDay()
  const horizon = localDay(new Date(Date.now() + 7 * 86400000))
  const now = [] // due today, or already past
  const week = [] // dated, ahead of today, inside the next seven days
  const seen = new Set()
  for (const s of page.state.spaces) {
    for (const b of s.blocks) {
      if (b.type !== 'reminder' || b.done || !b.when || b.when > horizon) continue
      const w = whenPhrase(b)
      const base = { bid: b.id, sid: s.id, label: b.text, when: `${b.when} ${b.at || '99:99'}` }
      if (b.when <= today) {
        // under a band that already says today, a bare "today" says nothing
        now.push({ ...base, kind: 'reminder', sub: w && w.text !== 'today' ? w.text : '', urgent: !!w?.urgent })
      } else {
        // the day rides where every card row already puts its date — on the
        // right. Putting it in a left column of its own knocked the week's
        // text out of line with today's, which reads as two lists rather
        // than two bands of one.
        week.push({ ...base, kind: 'ahead', sub: b.at ? `${weekdayOf(b.when)}, ${clockOf(b.at)}` : weekdayOf(b.when) })
      }
      seen.add(`${s.id}|${b.text.toLowerCase()}`)
    }
  }
  const items = now
  // the page must not say the same thing twice: an open ask already puts
  // this question on screen, so surfacing it again reads as a flicker where
  // one replaces the other
  const askWords = page.state.ask ? words(page.state.ask.question) : null
  const echoesAsk = (label) => {
    if (!askWords || !askWords.size) return false
    const mine = words(label)
    if (!mine.size) return false
    let hit = 0
    for (const w of mine) if (askWords.has(w)) hit++
    return hit / mine.size >= 0.5
  }
  for (const su of page.state.surfaced || []) {
    if (seen.has(`${su.spaceId}|${su.label.toLowerCase()}`)) continue
    if (echoesAsk(su.label)) continue
    items.push({ kind: 'surfaced', sid: su.spaceId, label: su.label, sub: su.reason })
  }
  // soonest first, so each band reads like a morning
  const bySoonest = (a, x) => (a.when || '').localeCompare(x.when || '')
  now.sort(bySoonest)
  week.sort(bySoonest)
  page.attentionCount = now.length + week.length
  maybeNotify(now)
  const all = [...now, ...week]
  const key = all.map((i) => i.kind + (i.bid || i.sid) + i.label + i.sub).join()
  if (box.dataset.key === key) return
  // rows animate in only on the strip's first appearance; later reshuffles
  // must not replay entrances
  if (box.dataset.key !== undefined) box.classList.add('norise')
  box.dataset.key = key

  // Today is where you act: it keeps the tick. The week ahead is a look
  // forward, so a row there carries its day instead and opens the card.
  const rowFor = (i) => {
    const sub = i.sub ? `<span class="today-sub ${i.urgent ? 'overdue' : ''}">${esc(i.sub)}</span>` : ''
    if (i.kind === 'ahead') {
      return `<button class="today-row ahead" aria-label="${esc(i.label)}, ${esc(i.sub)}">
          <span class="tick-slot"></span>
          <span class="row-text">${esc(i.label)}</span>${sub}</button>`
    }
    if (i.kind === 'surfaced') {
      return `<button class="today-row plain">
          <span class="tick-slot"></span>
          <span class="row-text">${esc(i.label)}</span>${sub}</button>`
    }
    return `<button class="row today-row" data-block="${i.bid}" role="checkbox" aria-checked="false" aria-label="${esc(i.label)}${i.sub ? `, ${esc(i.sub)}` : ''}">
        <span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>
        <span class="row-text">${esc(i.label)}</span>${sub}</button>`
  }
  // The overflow count rides on the right of the last row rather than
  // taking a line to itself. A line of its own cost 24px in a region that
  // has none spare, and pushed everything else down for six characters.
  const band = (label, rows, tail) =>
    rows.length
      ? `<div class="band"><span class="band-label">${label}</span><div class="band-body">${rows
          .map(
            (i, n) =>
              `<div class="today-item" data-sid="${i.sid || ''}">${rowFor(i)}${
                tail && n === rows.length - 1 ? `<span class="today-more">${tail}</span>` : ''
              }</div>`
          )
          .join('')}</div></div>`
      : ''

  // How much fits is a question about pixels, and pixels are something the
  // page can measure. Three times now this was a hand-picked number that
  // was right until a font or a margin moved and then quietly clipped the
  // last line. Paint what there is, then drop from the end until it truly
  // fits, counting whatever came off. The stage cannot scroll, so nothing
  // may be left hanging past its edge.
  const paint = (nCount, wCount) => {
    const a = now.slice(0, nCount)
    const b = week.slice(0, wCount)
    const left = now.length - a.length + (week.length - b.length)
    const tail = left > 0 ? `+${left} more` : ''
    box.innerHTML =
      band('today', a, b.length ? '' : tail) + band('this week', b, tail)
  }
  const floor = () => document.querySelector('.moment')?.getBoundingClientRect().bottom ?? 0
  const overflows = () => {
    const edge = floor()
    if (!edge) return false // nothing laid out yet; nothing to measure against
    return [...box.children].some((el) => el.getBoundingClientRect().bottom > edge + 1)
  }

  let nCount = now.length
  let wCount = week.length
  paint(nCount, wCount)
  while (overflows() && nCount + wCount > 0) {
    if (wCount) wCount--
    else nCount--
    paint(nCount, wCount)
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
/** The reference, reachable from the gear whenever you want it — rather
    than thrown at a brand new page once and then gone forever. The old
    footer promised "? for this", which was never wired: the writing line
    holds the caret from the moment the page opens, so a bare ? has nowhere
    to land. It lists the keys that actually work now. */
function showIntro() {
  const wrap = $('#focus')
  wrap.dataset.help = '1'
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card" role="dialog" aria-modal="true" aria-label="What December can do">
        <h2 class="space-name">What you can say</h2>
        ${CAN_DO.map(([k, v]) => `<div class="can-row"><div class="can-k">${esc(k)}</div><div class="can-v">${esc(v)}</div></div>`).join('')}
        <div class="can-keys">/ to find · ⌘Z to undo · esc to close</div>
      </article>
    </div>`
}

// --------------------------------------------------------- notifications
// A due date only matters if it reaches you. Quiet, deduped per day.

function maybeNotify(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const today = localDay()
  let seen
  try {
    seen = JSON.parse(localStorage.getItem('dec-notified') || '{}')
  } catch {
    seen = {}
  }
  if (seen.date !== today) seen = { date: today, keys: [] }
  for (const i of items) {
    const key = `${i.label}|${i.sub}`
    if (seen.keys.includes(key)) continue
    seen.keys.push(key)
    try {
      new Notification('December', { body: i.sub ? `${i.label} · ${i.sub}` : i.label, silent: true, tag: key })
    } catch {}
  }
  localStorage.setItem('dec-notified', JSON.stringify(seen))
}
export { buildFocus, closeFocus, renderYearline, travelTargets, heldSpaces, renderInbox, renderActivity, askToFinish, resortCard, renderSpaces, renderResting, resizeLayout, renderRail, renderSuggestions, renderAsk, renderToday, showIntro, releaseHeld }
