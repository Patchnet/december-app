// A completion the agent confirmed gets the same moment a hand's check gets:
// the brush tick, the strike, then the row settles to its new place. It plays
// once. The card is held for the moment exactly as a manual check holds it, and
// the manual check's own bookkeeping lets it go, so the two can never both
// settle a card or play the same row twice.
import { commitTick, clearCommitTick } from './commit-tick.js'
import { drawCompletion, clearInk } from './ink-feedback.js'
import { holdCard } from './completion-motion.js'
import { hooks } from './session.js'

// the brush tick draws for 583ms and the row rests a breath under it
const MOMENT = 620
const preference = window.matchMedia('(prefers-reduced-motion: reduce)')

/** What went false → true between what a card last showed and what is true
    now. A row that is new, or was already done, is not a completion. */
export function newlyDone(before, after) {
  const out = []
  if (!before || !after) return out
  const old = new Map((before.blocks || []).map((b) => [b.id, b]))
  for (const b of after.blocks || []) {
    const pb = old.get(b.id)
    if (!pb || pb.type !== b.type) continue
    if (b.type === 'reminder' && !pb.done && b.done) out.push({ block: b.id, item: '', key: `${b.id}/` })
    if (b.type !== 'list') continue
    const items = new Map((pb.items || []).map((i) => [i.id, i]))
    for (const i of b.items || []) {
      if (i.done && items.has(i.id) && !items.get(i.id).done) out.push({ block: b.id, item: i.id, key: `${b.id}/${i.id}` })
    }
  }
  return out
}

/** The same row may be on the grid card, the opened card and the day's line. */
function twins({ block, item }) {
  const at = `[data-block="${CSS.escape(block)}"]${item ? `[data-item="${CSS.escape(item)}"]` : ''}`
  return [...document.querySelectorAll(`.row${at}, .solo${at}`)].filter((row) => item || !row.dataset.item)
}

/**
 * Play the moment for `ticked` rows of card `sid`. Answers true when the card
 * is now held: the caller must leave it alone, and its settlement adopts the
 * latest confirmed state once. Answers false when there is nothing to play
 * (reduced motion, a hidden tab, rows nobody can see, a check already owned by
 * the hand): the caller reconciles the card quietly, as any other edit.
 */
export function playConfirmed(sid, ticked) {
  const moment = hooks.completionMoment
  if (!moment || !ticked.length || preference.matches || document.hidden) return false
  const playing = []
  for (const t of ticked) {
    const rows = twins(t).filter((row) => !row.classList.contains('done'))
    if (!rows.some((row) => row.getClientRects().length) || !moment.claim(t.key)) continue
    // one hold per row, as a hand's checks count: the last to let go settles
    holdCard(sid)
    for (const row of rows) {
      clearInk(row.querySelector('.row-text'))
      clearCommitTick(row)
      row.classList.remove('no-anim')
      row.classList.add('done')
      row.setAttribute('aria-checked', 'true')
      commitTick(row)
      drawCompletion(row)
    }
    playing.push(t)
  }
  if (!playing.length) return false
  setTimeout(() => {
    // the ink is dry; what settles is the plain checked row
    for (const t of playing) for (const row of twins(t)) { clearInk(row.querySelector('.row-text')); clearCommitTick(row) }
    // every hold is let go, whatever one settlement does
    for (const t of playing) { try { moment.leave(sid, t.key, true) } catch (err) { console.error(err) } }
  }, MOMENT)
  return true
}
