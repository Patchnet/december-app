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

function paceWords(g) {
  if (g.met) return 'done'
  const whole = Number.isInteger(g.current) && Number.isInteger(g.target)
  const gap = whole ? Math.round(Math.abs(g.diff)) : Math.abs(g.diff)
  if (gap < 0.5) return 'on pace'
  const n = g.unit === '$' ? fmtAmount(gap, '$') : gap
  return `${n} ${g.diff > 0 ? 'ahead' : 'behind'}`
}

function renderGoals() {
  const band = $('#goals')
  if (!band) return
  const goals = liveGoals(page.state)
  band.hidden = goals.length === 0
  if (!goals.length) {
    band.innerHTML = ''
    return
  }
  const before = new Map(liveGoals(page.prev).map((x) => [x.block.id, x.goal]))
  band.innerHTML = goals
    .map(({ space, block, goal: g }) => {
      const stale = g.movedAt ? Math.floor((Date.now() - new Date(g.movedAt)) / 86400000) : null
      const quiet = stale != null && stale >= 14 && !g.met ? ` · quiet ${stale} days` : ''
      // the space's name stands for its heartbeat; any other block says its own
      const label = block.id === heroId(space) || !block.title ? space.name : block.title
      const cls = g.met ? 'met' : g.diff < -0.5 ? 'behind' : ''
      return `<a href="#" class="goal ${cls}" data-goal="${block.id}" data-jump="${space.id}" aria-label="${esc(label)}: ${esc(fmtAmount(g.current, g.unit))} of ${esc(fmtAmount(g.target, g.unit))}, ${esc(paceWords(g))}">
        <span class="goal-name">${esc(label)}</span>
        <span class="goal-count"><b>${esc(g.unit === '$' ? fmtAmount(g.current, '$') : fmtAmount(g.current, ''))}</b><small>of ${esc(fmtAmount(g.target, g.unit))}</small></span>
        <span class="goal-pace">${esc(paceWords(g))}${esc(quiet)}</span>
      </a>`
    })
    .join('')
  // a goal that just moved says so where it moved; one that just landed is a moment
  for (const { block, goal: g } of goals) {
    const was = before.get(block.id)
    if (!was || was.current === g.current) continue
    const el = band.querySelector(`[data-goal="${block.id}"] .goal-count`)
    if (!el) continue
    bump(el)
    const d = Math.round((g.current - was.current) * 10) / 10
    markChange(el, `${d > 0 ? '+' : ''}${g.unit === '$' ? fmtAmount(d, '$') : d}`)
    if (!was.met && g.met) {
      pop(el)
      celebrate(el)
    }
  }
}

export { renderGoals, liveGoals }
