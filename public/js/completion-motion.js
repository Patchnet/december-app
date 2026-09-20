// A completion is one moment with one owner. While a check is acknowledged
// under the hand its card is held and nothing reconciles it. When the last
// check on the card lets go, the truthful DOM lands once, and the old and new
// slots trade their height in real layout on one clock: the row, the frame
// and the cards below move together because layout moved, never a transform.
import { animateCardShape, claimCardShape, finishCardShape } from './card-shape.js'

const preference = window.matchMedia('(prefers-reduced-motion: reduce)')

// Counted, not a Set: several rows of one card can be mid-moment at once, and
// the card stays held until the last of them is done.
const holds = new Map()
export function holdCard(sid) { if (sid) holds.set(sid, (holds.get(sid) || 0) + 1) }
/** Let go once; answers how many checks still own the card. */
export function releaseCard(sid) {
  const left = (holds.get(sid) || 0) - 1
  if (left > 0) holds.set(sid, left)
  else holds.delete(sid)
  return Math.max(0, left)
}
export const cardHeld = (sid) => holds.has(sid)
export const completionPending = () => holds.size > 0

// Everything a completion can add to a card's flow or take out of it: the
// row, its block, the done pile, a fold's count, the card's empty line.
const UNITS = '.row[data-block], [data-bid], details.list-preview, details.done-fold, .fold-more, .done-more, .figs'
const SHUT = { height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px' }
// Past this, the two layouts are not one card with a row moved; see below.
const MAX_SEAM = 64

/** Rendered, which a row folded away in a closed pile is not. */
function shown(el, card) {
  if (!el.isConnected || el === card || !card.contains(el)) return false
  for (let fold = el.parentElement.closest('details'); fold && card.contains(fold); fold = fold.parentElement.closest('details')) {
    if (!fold.open) return false
  }
  return el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0
}

/** The height of what the card holds, even when the opened card scrolls. */
function flowHeight(card) {
  const box = card.getBoundingClientRect().height - (card.offsetHeight - card.clientHeight)
  return card.scrollHeight > card.clientHeight + 1 ? card.scrollHeight : box
}

function openFrame(el) {
  const style = getComputedStyle(el)
  return {
    height: `${el.getBoundingClientRect().height}px`,
    minHeight: style.minHeight.endsWith('px') ? style.minHeight : '0px',
    paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
    marginTop: style.marginTop, marginBottom: style.marginBottom,
    borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth,
  }
}

/** A copy that only occupies space: no identity for a selector, a label or a
    twin lookup to find, and none of the live row's unfinished ink. */
function quiet(ghost) {
  ghost.inert = true
  ghost.setAttribute('aria-hidden', 'true')
  for (const el of [ghost, ...ghost.querySelectorAll('*')]) {
    for (const { name } of [...el.attributes]) {
      if (name === 'id' || name === 'for' || name === 'name' || (name.startsWith('data-') && name !== 'data-type')) el.removeAttribute(name)
    }
    el.classList.remove('commit-playing', 'ink-host', 'ink-strike-active', 'popping')
    if (el.classList.contains('row')) el.classList.add('no-anim')
  }
  for (const el of ghost.querySelectorAll('.ink-feedback, .commit-tick-live, .delta')) el.remove()
  // Its own class leads: card-dom adopts an unkeyed node by its first class,
  // and a reconcile that lands mid-collapse must drop the ghost, not reuse it.
  ghost.className = `slot-leaving ${ghost.className}`
}

/**
 * Commit `mutate` to `card`, then close every slot it emptied and open every
 * slot it filled. `keys` name the rows that were checked (`block/item`, or
 * `block/` for a reminder): those are the only things that travel; anything
 * else that appears or disappears is a consequence, and is handled the same.
 * Resolves when the card is at rest.
 */
export function settleRows(card, keys, mutate) {
  finishCardShape(card)
  const movers = new Set(keys)
  const isMover = (el) => !!el.dataset && (el.dataset.bid ? movers.has(`${el.dataset.bid}/`) : !!el.dataset.block && movers.has(`${el.dataset.block}/${el.dataset.item || ''}`))
  const still = preference.matches || document.hidden || !card.isConnected || !card.getClientRects().length

  // What is on the card now, copied before anything changes: after the commit
  // a row may be reworded, folded into a closed pile, or gone.
  const units = still ? [] : [...card.querySelectorAll(UNITS)]
  const copies = still ? [] : [...card.cloneNode(true).querySelectorAll(UNITS)]
  const kids = new Map()
  const before = units.map((el, i) => {
    if (!kids.has(el.parentElement)) kids.set(el.parentElement, [...el.parentElement.children])
    return { el, copy: copies[i], parent: el.parentElement, shown: shown(el, card) }
  })
  const fromBox = card.getBoundingClientRect().height
  const from = still ? 0 : flowHeight(card)

  // A checked row that leaves takes the keyboard's place with it. Hand the
  // place to the row that was next, or to the card, rather than to nothing.
  const active = document.activeElement
  const focusedRow = card.contains(active) && active.matches?.('.row[data-block]') ? active : null
  const rowsBefore = focusedRow ? [...card.querySelectorAll('.row[data-block]')].filter((el) => shown(el, card)) : []

  mutate()

  if (focusedRow && !shown(focusedRow, card)) {
    const at = rowsBefore.indexOf(focusedRow)
    const near = [...rowsBefore.slice(at + 1), ...rowsBefore.slice(0, Math.max(0, at)).reverse()]
    const next = near.find((el) => el !== focusedRow && !isMover(el) && shown(el, card)) || (card.tabIndex >= 0 ? card : null)
    next?.focus({ preventScroll: true })
  }
  if (still || !card.isConnected) return Promise.resolve()

  // The truthful layout, measured before any ghost stands in it.
  const to = flowHeight(card)
  const rest = card.offsetHeight
  const was = new Map(before.map((u) => [u.el, u]))

  // A checked row travels when it changes parent, or changes place among the
  // siblings that stayed. Rows that only shift because of it do not travel.
  const travelled = new Map()
  const moved = (u) => {
    if (!u || !isMover(u.el)) return false
    if (travelled.has(u)) return travelled.get(u)
    let answer = u.el.parentElement !== u.parent
    if (!answer) {
      const old = kids.get(u.parent), stayed = new Set(old.filter((el) => el.parentElement === u.parent && !isMover(el)))
      const rank = (list) => { let n = 0; for (const el of list) { if (el === u.el) break; if (stayed.has(el)) n++ } return n }
      answer = rank(old) !== rank([...u.parent.children])
    }
    travelled.set(u, answer)
    return answer
  }

  const left = before.filter((u) => u.shown && (!shown(u.el, card) || moved(u)))
  const leftSet = new Set(left)
  const entered = [...card.querySelectorAll(UNITS)].filter((el) => shown(el, card) && (!was.get(el)?.shown || moved(was.get(el))))
  // only the outermost of each: a block that left carries its rows with it
  const leaving = left.filter((u) => !left.some((o) => o !== u && o.copy.contains(u.copy)))
  const entering = entered.filter((el) => !entered.some((o) => o !== el && o.contains(el)))

  const ghosts = []
  let orphaned = false
  for (const u of leaving) {
    if (!card.contains(u.parent) || (u.parent !== card && !shown(u.parent, card))) { orphaned = true; break }
    const old = kids.get(u.parent), at = old.indexOf(u.el)
    const stayed = (el) => el.parentElement === u.parent && !moved(was.get(el))
    const next = old.slice(at + 1).find(stayed), prev = old.slice(0, at).reverse().find(stayed)
    // Whatever stayed on the card somewhere else is already there for real;
    // the ghost must not show it a second time. What travels inside the real
    // element (a reminder's row inside its block) belongs in the ghost too.
    for (const v of before) if (v !== u && v.shown && !leftSet.has(v) && u.copy.contains(v.copy) && !u.el.contains(v.el)) v.copy.remove()
    quiet(u.copy)
    if (next) u.parent.insertBefore(u.copy, next)
    else if (prev) prev.after(u.copy)
    else u.parent.prepend(u.copy)
    ghosts.push(u.copy)
  }

  // Frames come from the natural boxes. Then both ends are measured with the
  // slots really shut: a ghost changes which block is first or last, and the
  // rules that hang on that (a hairline, a last margin) would otherwise snap
  // at the first or the final frame. The difference rides on one margin.
  const ghostOpen = ghosts.map(openFrame), enterOpen = entering.map(openFrame)
  const measureShut = (list, against) => {
    for (const el of list) el.classList.add('slot-shut')
    const off = flowHeight(card) - against
    for (const el of list) el.classList.remove('slot-shut')
    return off
  }
  const endSeam = orphaned ? 0 : measureShut(ghosts, to)
  const startSeam = orphaned ? 0 : measureShut(entering, from)

  // Not one card with a row moved (a solo card becoming a titled one, a slot
  // whose place no longer exists): the frame alone carries the change.
  if (orphaned || (!ghosts.length && !entering.length) || Math.abs(startSeam) > MAX_SEAM || Math.abs(endSeam) > MAX_SEAM) {
    for (const ghost of ghosts) ghost.remove()
    animateCardShape(card, fromBox)
    return Promise.resolve()
  }

  const ghostShut = ghosts.map(() => ({ ...SHUT })), enterShut = entering.map(() => ({ ...SHUT }))
  const seam = (frame, off) => { if (Math.abs(off) > .5) frame.marginTop = `${parseFloat(frame.marginTop) - off}px` }
  if (ghosts.length) seam(ghostShut[0], endSeam)
  seam(entering.length ? enterShut[0] : ghostOpen[0], startSeam)

  const travel = Math.max(...[...ghostOpen, ...enterOpen].map((frame) => parseFloat(frame.height)))
  const duration = Math.round(Math.min(340, 210 + travel * .4))
  const timing = { duration, easing: 'cubic-bezier(.32, .08, .2, 1)', fill: 'both' }
  // Ink lets go before its slot is thin, and arrives once there is room for it.
  const runs = [
    ...ghosts.map((ghost, i) => ghost.animate([{ ...ghostOpen[i], opacity: 1, offset: 0 }, { opacity: 0, offset: .6 }, { ...ghostShut[i], opacity: 0, offset: 1 }], timing)),
    ...entering.map((el, i) => {
      el.classList.add('slot-entering')
      return el.animate([{ ...enterShut[i], opacity: 0, offset: 0 }, { opacity: 0, offset: .3 }, { ...enterOpen[i], opacity: 1, offset: 1 }], timing)
    }),
  ]

  let timer = null
  return new Promise((resolve) => {
    const finish = claimCardShape(card, () => {
      clearTimeout(timer)
      for (const run of runs) run.cancel()
      for (const ghost of ghosts) ghost.remove()
      for (const el of entering) el.classList.remove('slot-entering')
      resolve()
    }, rest)
    runs[0].addEventListener('finish', finish, { once: true })
    runs[0].addEventListener('cancel', finish, { once: true })
    // a throttled or dropped animation event must never strand a ghost
    timer = setTimeout(finish, duration + 150)
  })
}
