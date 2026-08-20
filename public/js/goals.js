import { $, esc, fmtAmount, page } from './session.js'
import { heroId } from './blocks.js'
import { markChange, bump, pop, celebrate } from './motion.js'

/** The goals band: what you said you would reach this year, as the numbers
    themselves. No bars — the card has the bar. Each goal is the count set in
    the serif the page keeps for the day and the big ledger totals, the name
    above it, and one quiet line under it saying whether the year is ahead of
    you. It wraps, so six goals are a row and twelve are two; there is no cap.
    It is not there at all until there is a goal. */
function liveGoals(state) {
  const out = []
  for (const s of state?.spaces || []) {
    if (s.finished) continue
    for (const b of s.blocks) if (b.goal) out.push({ space: s, block: b, goal: b.goal })
  }
  // stable: in the order they were set, not the order the cards last moved
  return out.sort((a, b) => (a.goal.setAt || '').localeCompare(b.goal.setAt || '') || a.block.id.localeCompare(b.block.id))
}

/** The pace, worded for the page. The verdict and the gap come from the
    server's goalOf — one derivation for band, year card, and engine — and
    only the $-dressing happens here. */
function paceWords(g) {
  if (g.met) return 'done'
  if (g.paceWord === 'on') return 'on pace'
  const n = g.unit === '$' ? fmtAmount(g.gap, '$') : g.gap
  return `${n} ${g.paceWord}`
}

/** What a goal row is called: the space's name stands for its heartbeat;
    any other block says its own title. One rule for the band and the year. */
function goalLabel(space, block) {
  return block.id === heroId(space) || !block.title ? space.name : block.title
}

/** A space that is nothing but its goal lives in the band, not the grid:
    a card saying exactly what the row above it says is the same thing
    twice. The moment it gains anything else, the card comes back. */
function goalOnly(space) {
  return space.blocks.length === 1 && !!space.blocks[0].goal
}

function renderGoals() {
  const band = $('#goals')
  if (!band) return
  const goals = liveGoals(page.state)
  band.hidden = goals.length === 0
  // The band is out of the flow: it says how much of the stage's fixed
  // height it needs, and the attention strip's own measuring does the rest.
  const claim = () => $('#stage')?.style.setProperty('--goals-h', goals.length ? `${band.offsetHeight + 10}px` : '0px')
  if (!goals.length) {
    band.innerHTML = ''
    claim()
    return
  }
  const before = new Map(liveGoals(page.prev).map((x) => [x.block.id, x.goal]))
  band.innerHTML = goals
    .map(({ space, block, goal: g }) => {
      const quiet = g.quietDays != null && g.quietDays >= 14 && !g.met ? ` · quiet ${g.quietDays} days` : ''
      const label = goalLabel(space, block)
      const cls = g.met ? 'met' : g.paceWord === 'behind' ? 'behind' : ''
      const pct = Math.min(100, Math.max(0, (g.current / g.target) * 100))
      // the tick is where the year stands today; fill past it reads as
      // ahead, short of it as behind, before any words. Met goals rest.
      const tick = g.met ? '' : `<i style="left:${Math.round(g.through * 1000) / 10}%"></i>`
      return `<a href="#" class="goal ${cls}" data-goal="${block.id}" data-goal-open="${space.id}" aria-label="${esc(label)}: ${esc(fmtAmount(g.current, g.unit))} of ${esc(fmtAmount(g.target, g.unit))}, ${esc(paceWords(g))}">
        <span class="goal-name">${esc(label)}</span>
        <span class="goal-count"><b>${esc(g.unit === '$' ? fmtAmount(g.current, '$') : fmtAmount(g.current, ''))}</b><small>of ${esc(fmtAmount(g.target, g.unit))}</small></span>
        <span class="goal-meter"><b style="width:${Math.round(pct * 10) / 10}%"></b>${tick}</span>
        <span class="goal-pace">${esc(paceWords(g))}${esc(quiet)}</span>
      </a>`
    })
    .join('')
  claim()
  // a goal that just moved says so where it moved; one that just landed is a moment
  for (const { block, goal: g } of goals) {
    const was = before.get(block.id)
    if (!was || was.current === g.current) continue
    const el = band.querySelector(`[data-goal="${block.id}"] .goal-count`)
    if (!el) continue
    // the fill glides from where it was, the way a card's meter does
    const span = band.querySelector(`[data-goal="${block.id}"] .goal-meter b`)
    if (span) {
      const target = span.style.width
      span.style.transition = 'none'
      span.style.width = `${Math.min(100, Math.max(0, (was.current / (was.target || g.target)) * 100))}%`
      void span.offsetWidth
      span.style.transition = ''
      requestAnimationFrame(() => (span.style.width = target))
    }
    bump(el)
    const d = Math.round((g.current - was.current) * 10) / 10
    markChange(el, `${d > 0 ? '+' : ''}${g.unit === '$' ? fmtAmount(d, '$') : d}`)
    if (!was.met && g.met) {
      pop(el)
      celebrate(el)
    }
  }
}

export { renderGoals, liveGoals, goalOnly, paceWords, goalLabel }
