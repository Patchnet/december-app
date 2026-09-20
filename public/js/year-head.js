// The top of the year: the number, what it holds, and how far through it is.
//
// Kept apart from the rest of the year so the same renderer can be looked at
// in every register it might wear, side by side, instead of described.
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const CHROMES = ['now', 'quiet', 'figures', 'bare']

function ringHTML(through) {
  const pct = Math.round(through * 100)
  return `<div class="yr-progress" role="img" aria-label="${pct} percent of the year elapsed"><svg viewBox="0 0 80 80" aria-hidden="true"><circle class="yr-ring-track" cx="40" cy="40" r="34"/><circle class="yr-ring-fill" cx="40" cy="40" r="34" pathLength="100" style="stroke-dasharray:${pct} 100"/></svg><span>${pct}<small>%</small></span></div>`
}

function stripHTML({ weeks, sweeks = [], thisWeek, past, caret = '' }) {
  if (!weeks) return ''
  const peak = Math.max(1, ...weeks)
  const cells = weeks.map((c, i) => {
    const sched = sweeks[i] || 0
    const mark = i === thisWeek && !past ? caret : ''
    const nowCls = i === thisWeek && !past ? ' wnow' : ''
    if (c) return `<i class="w on${nowCls}" style="--h:${Math.max(18, Math.round((c / peak) * 100))}%">${mark}</i>`
    if (sched && i >= thisWeek) return `<i class="w sched${nowCls}">${mark}</i>`
    return `<i class="w${nowCls}">${mark}</i>`
  }).join('')
  return `<div class="yr-weeks" aria-hidden="true">${cells}</div>`
}

/**
 * @param y  { year, moments, tail, through, weeks, sweeks, thisWeek, past }
 *           `tail` is the second half of the summary line, already worded.
 * @param chrome  which register the head wears:
 *   now      the ring and the week strip, as built
 *   quiet    the strip alone — the ring repeats what the line already says
 *   figures  no drawing at all: the year's facts as figures over hairlines
 *   bare     the number and its line, nothing else
 */
export function yearHead(y, { chrome = 'now', caret = '', rhythm = false } = {}) {
  const moments = `<span><b>${y.moments}</b> recorded moment${y.moments === 1 ? '' : 's'}</span>`
  const line = `<div class="yr-summary">${moments}<span>${esc(y.tail)}</span></div>`
  const pct = Math.round((y.through ?? 0) * 100)

  if (chrome === 'figures') {
    // the card register, applied to the year: a number in the serif with the
    // word for it underneath, over a hairline. No arc, no bars.
    const figs = [
      [y.moments, `recorded moment${y.moments === 1 ? '' : 's'}`],
      [`${pct}%`, 'of the year gone'],
      [y.weeks ? y.weeks.filter(Boolean).length : 0, 'weeks with something in them'],
    ]
    return `<div class="year-title-row"><div><h2 class="space-name">${y.year}</h2>
      <div class="yr-summary"><span>${esc(y.tail)}</span></div></div></div>
      <div class="figs yr-figs">${figs.map(([n, label]) =>
    `<div class="fig"><b>${esc(String(n))}</b><span>${esc(label)}</span></div>`).join('')}</div>${rhythm && y.weeks ? `<div class="year-rhythm"><div class="year-rhythm-label"><span>Week by week</span><span>${y.past ? 'Full year' : `Week ${y.thisWeek + 1}`}</span></div>${stripHTML({...y,caret})}</div>` : ''}`
  }

  if (chrome === 'bare') {
    return `<div class="year-title-row"><div><h2 class="space-name">${y.year}</h2>${line}</div></div>`
  }

  const ring = chrome === 'now' ? ringHTML(y.through ?? 0) : ''
  const strip = stripHTML({ ...y, caret })
  return `<div class="year-title-row"><div><h2 class="space-name">${y.year}</h2>${line}</div>${ring}</div>
    ${strip ? `<div class="year-rhythm"><div class="year-rhythm-label"><span>The rhythm of your year</span><span>Week by week</span></div>${strip}</div>` : ''}`
}
