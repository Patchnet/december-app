// What December says in the morning.
//
// One notification, once, and only when there is something to say. The rule
// the whole page keeps applies hardest here, because this is the one surface
// the person did not open: December speaks in their words about their things,
// and never reports on itself. Silence is a valid morning.
export const VOICES = ['next', 'shape', 'stage', 'ask']

const clock = (at) => {
  if (!/^\d{1,2}:\d{2}$/.test(String(at || ''))) return ''
  const [h, m] = String(at).split(':').map(Number)
  const hour = h % 12 || 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

/** `day` is { next: {text, at}|null, todayCount, overdue, week }. */
export function morningLine(day, voice = 'ask') {
  const { next, todayCount = 0, overdue = 0, week = 0 } = day || {}
  const at = next ? clock(next.at) : ''

  if (voice === 'ask') {
    // the capture line, moved to the morning; it has something to say on a
    // blank day too, because asking does not depend on there being anything
    return { title: 'Anything to remember?', body: next ? `${next.text}${at ? `, ${at}` : ''}` : 'Today is open.' }
  }

  // every other voice reports, so every other voice is silent with nothing
  // to report: a notification that says "nothing today" is still an
  // interruption that said nothing
  if (!next && !overdue && !todayCount) return null

  if (voice === 'shape') {
    const parts = [
      overdue ? `${overdue} overdue` : '',
      todayCount ? `${todayCount} today` : '',
      week ? `${week} this week` : '',
    ].filter(Boolean)
    return { title: 'Today', body: parts.join(' · ') }
  }

  if (voice === 'stage') {
    const rest = [
      overdue ? `${overdue} overdue` : '',
      todayCount > 1 ? `${todayCount - 1} more today` : '',
    ].filter(Boolean).join(' · ')
    return {
      title: next ? `${at ? `${at}  ` : ''}${next.text}` : 'Today',
      body: rest || (next ? 'Nothing else today.' : ''),
    }
  }

  // 'next' — the one thing, and nothing about how many there are
  if (!next) return null
  return { title: at || 'Today', body: next.text }
}
