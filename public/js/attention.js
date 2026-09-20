import { $, esc, localDay, page, hooks } from './session.js'
import { clockOf, whenPhrase, words } from './blocks.js'
import { closeFocus, rememberReturn, showIntro } from './layout.js'
import { stageReceipts, stamp, openHistory } from './stage-context.js'
import { createMorningNotifier, isMorning } from './morning-notification.js'

// ------------------------------------------------------ the shape of the day
// The page faces the day in two lines under the writing line: the next
// dated thing, and the counts — overdue, due, this week, the last change —
// each a way into the full sheet. Nothing in the stage is a task to tick;
// the cards are where that happens. The sheet lists everything as rows.

let attentionItems = []

/** A day the way you would say it inside a week: "fri 14". */
function weekdayOf(iso) {
  const dt = new Date(`${iso}T12:00:00`)
  return `${dt.toLocaleString('en', { weekday: 'short' }).toLowerCase()} ${dt.getDate()}`
}

/** Every row in the strip is one line in one grammar: the thing itself on
    the left, and on the right the small facts that place it — which card,
    which day. Overdue is the same dot the cards use, once, and nothing
    else is red. A reminder keeps its tick; the rest keep the tick's
    column so the text lines up. */
function attentionRow(i) {
  const sub = i.sub ? `<span class="today-sub ${i.urgent ? 'overdue' : ''}">${esc(i.sub)}</span>` : ''
  const said = `${esc(i.label)}${i.sub ? `, ${esc(i.sub)}` : ''}`
  if (i.kind === 'ahead') {
    return `<button class="today-row ahead" aria-label="${said}"><span class="tick-slot"></span><span class="row-text">${esc(i.label)}</span>${sub}</button>`
  }
  if (i.kind === 'surfaced') {
    return `<button class="today-row plain" aria-label="${said}${i.why ? `. ${esc(i.why)}` : ''}"${i.why ? ` title="${esc(i.why)}"` : ''}><span class="tick-slot"></span><span class="row-text">${esc(i.label)}</span>${sub}</button>`
  }
  return `<button class="row today-row" data-block="${i.bid}" role="checkbox" aria-checked="false" aria-label="${said}"><span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span><span class="row-text">${esc(i.label)}</span>${sub}</button>`
}
/** A band that holds more than it shows says so under its own name, in
    the label column, where there is room to spare; the count is a real
    control that opens the whole list. */
function attentionBand(label, rows, hidden = 0) {
  if (!rows.length) return ''
  const more = hidden
    ? `<button class="today-more" data-attention-open aria-haspopup="dialog" aria-controls="focus" aria-label="Show all ${attentionItems.length} Today and This week items; ${hidden} more hidden">${hidden} more</button>`
    : ''
  return `<div class="band"><span class="band-label">${label}${more}</span><div class="band-body">${rows
    .map((i) => `<div class="today-item" data-sid="${i.sid || ''}">${attentionRow(i)}</div>`)
    .join('')}</div></div>`
}
function openAttention() {
  if (!attentionItems.length) return
  rememberReturn()
  const now = attentionItems.filter((i) => i.kind !== 'ahead')
  const week = attentionItems.filter((i) => i.kind === 'ahead')
  const wrap = $('#focus')
  wrap.innerHTML = `
    <div class="focus-backdrop" data-close></div>
    <div class="focus-wrap" data-close>
      <article class="focus-card attention-card" role="dialog" aria-modal="true" aria-labelledby="attention-title">
        <div class="attention-head">
          <h2 class="space-name" id="attention-title">Today and this week</h2>
          <button class="btn-quiet attention-close" data-close data-attention-close>Close and return</button>
        </div>
        <div class="attention-list">
          ${attentionBand('today', now)}
          ${attentionBand('this week', week)}
        </div>
      </article>
    </div>`
  document.documentElement.classList.add('modal-open')
  wrap.querySelector('[data-attention-close]')?.focus({ preventScroll: true })
}

// Task-focus gets first say in capture; the rest keep strip navigation.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-attention-open]')) {
    e.stopImmediatePropagation(); openAttention(); return
  }
  const row = e.target.closest('#focus .attention-list .today-row')
  const keyboardCheck = row?.matches('.row[data-block]') && e.detail === 0
  if (!row || e.target.closest('.tick') || keyboardCheck) return
  const sid = row.closest('.today-item')?.dataset.sid
  if (!sid) return
  e.stopImmediatePropagation()
  closeFocus()
  hooks.jumpToSpace(sid)
})

document.addEventListener('keydown', (e) => {
  const card = document.querySelector('.attention-card')
  if (e.key !== 'Tab' || !card) return
  const controls = [...card.querySelectorAll('button:not([disabled])')]
  const [first, last] = [controls[0], controls.at(-1)]
  if (e.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) {
    e.preventDefault(); last?.focus()
  } else if (!e.shiftKey && (document.activeElement === last || !card.contains(document.activeElement))) {
    e.preventDefault(); first?.focus()
  }
})

/** What needs you, in two bands: what is due now, and what is coming.
    The horizon used to stop at tomorrow, so a page holding eight dated
    things could tell you about none of them — everything you had written
    down stayed invisible until the night before, and the only reason
    anything further out ever appeared was that the agent happened to
    guess it was worth surfacing. Dates the page already holds are not a
    matter of judgment. */
/** The short day a card row would print: "sep 4". */
function shortDay(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleString('en', { month: 'short', day: 'numeric' }).toLowerCase()
}
/** The reason the engine gave, cut to its first clause: a row has one
    line, the row gives the rest of it an ellipsis, and the whole
    sentence is there in the card. */
function shortReason(text) {
  return String(text || '').split(/[;.]|\s[—–]\s/)[0].trim()
}
/** The facts that place a row, on its right: the card, unless the text
    already names it, then the day. */
function placeWords(space, label, ...rest) {
  const named = space && !label.toLowerCase().includes(space.toLowerCase()) ? [space] : []
  return [...named, ...rest].filter(Boolean).join(' · ')
}

function renderToday() {
  const box = $('#today')
  const today = localDay()
  const horizon = localDay(new Date(Date.now() + 7 * 86400000))
  // The same reminder filed under two cards is one thing to do, not two:
  // a course's exam also mirrored into the school's card was counting
  // twice and reading as a longer day than it was. Keep the copy whose
  // card the text itself names, else the first.
  const byKey = new Map()
  for (const s of page.state.spaces) {
    for (const b of s.blocks) {
      if (b.type !== 'reminder' || b.done || !b.when || b.when > horizon) continue
      const key = `${b.text.trim().toLowerCase()}|${b.when}`
      const named = b.text.toLowerCase().includes(s.name.toLowerCase())
      const have = byKey.get(key)
      if (have && (have.named || !named)) continue
      byKey.set(key, { s, b, named })
    }
  }
  const now = [] // due today, or already past
  const week = [] // dated, ahead of today, inside the next seven days
  const seen = new Set()
  for (const { s, b } of byKey.values()) {
    const w = whenPhrase(b)
    const base = { bid: b.id, sid: s.id, label: b.text, at: b.at || '', when: `${b.when} ${b.at || '99:99'}` }
    if (b.when <= today) {
      // under a band that already says today, a bare "today" says nothing;
      // past due, the day it was due says more than the word "overdue"
      const late = b.when < today
      const day = late ? shortDay(b.when) : w && w.text !== 'today' ? w.text : ''
      now.push({ ...base, kind: 'reminder', late, sub: placeWords(s.name, b.text, day, b.repeat), urgent: late || !!w?.urgent, whenWord: w?.text || 'today' })
    } else {
      // the day rides where every card row already puts its date — on the
      // right, so the week's text stays in line with today's
      const day = b.at ? `${weekdayOf(b.when)}, ${clockOf(b.at)}` : weekdayOf(b.when)
      week.push({ ...base, kind: 'ahead', sub: placeWords(s.name, b.text, day), whenWord: w?.text || day })
    }
    seen.add(b.text.toLowerCase())
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
    if (seen.has(su.label.toLowerCase())) continue
    if (echoesAsk(su.label)) continue
    // the engine's reason is a sentence; the row is a line. It rides as
    // the row's title and the card says it in full.
    const space = page.state.spaces.find((s) => s.id === su.spaceId)?.name
    items.push({ kind: 'surfaced', sid: su.spaceId, label: su.label, sub: placeWords(space, su.label), why: shortReason(su.reason), whenWord: 'today' })
  }
  // soonest first, so the sheet reads like a morning
  const bySoonest = (a, x) => (a.when || '').localeCompare(x.when || '')
  now.sort(bySoonest)
  week.sort(bySoonest)
  page.attentionCount = now.length + week.length
  const all = [...now, ...week]
  attentionItems = all
  maybeNotify(now)
  const receipts = stageReceipts(page.state)
  const last = receipts[0] ? stamp(receipts[0].at) : ''
  // a page with nothing on it yet shows, where the day would be, three
  // things a person might say — in the serif, each one a way to say it
  const blank = !page.state.spaces.length && !page.state.captures.length && !page.state.carryover && !(page.state.retired || []).length
  const key = blank ? 'first-words' : all.map((i) => i.kind + (i.bid || i.sid) + i.label + i.sub).join() + `|${last}`
  if (box.dataset.key === key) return
  if (blank) {
    box.dataset.key = key
    box.innerHTML = `<div class="first-words">${FIRST_WORDS.map((t) => `<button class="first-word" data-first="${esc(t)}">${esc(t)}</button>`).join('')}</div>`
    return
  }
  // the lines rise in only on the stage's first appearance; a reshuffle
  // later must not replay the entrance
  if (box.dataset.key !== undefined) box.classList.add('norise')
  box.dataset.key = key

  // The next thing: due today with the day still ahead of it, else the
  // soonest of the week, else what the surfacing sense pinned. Overdue is
  // never "next" — it is a count. One line, in the page's serif.
  const dueToday = now.filter((i) => i.kind === 'reminder' && !i.late)
  const surfaced = now.filter((i) => i.kind === 'surfaced')
  const next = dueToday[0] || week[0] || surfaced[0]
  const late = now.filter((i) => i.kind === 'reminder' && i.late).length
  // what the counts say, each a way into the sheet; a count of one thing
  // that is already the next line is not repeated
  const parts = []
  if (late) parts.push(`<button class="shape-part overdue" data-attention-open aria-haspopup="dialog" aria-controls="focus">${late} overdue</button>`)
  // what the surfacing sense pinned counts with today: it is in that band
  const restToday = dueToday.length + surfaced.length - (next && next !== week[0] ? 1 : 0)
  // directly under a line that is today's, "more" needs no day; after the
  // overdue count it keeps it, or it would read as more overdue. Under a
  // line from the week there is no "more": these are all of today.
  const todayWords = next === week[0] ? 'today' : parts.length ? 'more today' : 'more'
  if (restToday) parts.push(`<button class="shape-part" data-attention-open aria-haspopup="dialog" aria-controls="focus" aria-label="${restToday} ${next === week[0] ? '' : 'more '}today">${restToday} ${todayWords}</button>`)
  const restWeek = week.length - (next && next === week[0] ? 1 : 0)
  if (restWeek) parts.push(`<button class="shape-part" data-attention-open aria-haspopup="dialog" aria-controls="focus">${restWeek} ${next === week[0] ? 'more ' : ''}this week</button>`)
  // a quiet day says so, so the line is never only a timestamp
  if (!parts.length && !next && (last || page.state.spaces.length)) parts.push('<span class="shape-part quiet">nothing due this week</span>')
  // the last change is a trace of the page, not a count of the day: it
  // trails whatever the day's last row is, a shade quieter. After counts
  // that is the caption; with nothing to count it is the next thing's own
  // row, so one dated thing is one line and never a line with a timestamp
  // under it. On screen it is a word and a time; read aloud, the whole
  // phrase and where it goes.
  const trace = last ? `<button class="shape-part stamp" data-history-open aria-haspopup="dialog" aria-label="Last changed ${esc(last)}. Recent changes">changed ${esc(last)}</button>` : ''
  const trails = trace && next && !parts.length
  if (trace && !trails) parts.push(trace)
  const was = box.querySelector('.next-what')?.textContent
  const shapeWas = box.querySelector('.shape')?.textContent
  const trailWas = box.querySelector('.today-item > .stamp')?.textContent
  // the dateline already says what day it is, so a bare "today" before the
  // next thing says nothing; a time, tomorrow, or a weekday still leads it.
  // The label read aloud keeps the whole phrase.
  const when = next?.whenWord && next.whenWord !== 'today' ? `<span class="next-when">${esc(next.whenWord)}</span>` : ''
  box.innerHTML =
    (next
      ? `<div class="today-item" data-sid="${next.sid || ''}"><button class="today-row next" aria-label="${esc(next.label)}${next.whenWord ? `, ${esc(next.whenWord)}` : ''}"${next.why ? ` title="${esc(next.why)}"` : ''}>${when}<span class="next-what">${esc(next.label)}</span></button>${trails ? trace : ''}</div>`
      : '') +
    (parts.length ? `<div class="shape">${parts.join('')}</div>` : '')
  // when the next thing becomes another thing — a tick, a filing — the
  // line resolves through a soft blur rather than snapping, the way the
  // working line does; interruptible, and never under reduced motion
  const swap = (el) => {
    el.getAnimations().forEach((a) => a.cancel())
    el.animate([{ opacity: 0, transform: 'translateY(5px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' })
  }
  const moving = was !== undefined && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const line = box.querySelector('.today-row.next')
  if (moving && line && was !== next?.label) swap(line)
  // the counts too: a thing ticked off changes the shape of the day, and
  // the line that says so resolves rather than snaps
  const shape = box.querySelector('.shape')
  if (moving && shape && shapeWas !== undefined && shapeWas !== shape.textContent) swap(shape)
  // and the trace, when it joins the next thing's row or its time moves on
  const trail = box.querySelector('.today-item > .stamp')
  if (moving && trail && trailWas !== trail.textContent) swap(trail)
}

const FIRST_WORDS = [
  'Paid rent this month, $1,450.',
  'Reading 24 books this year, finished number 9.',
  'Dentist Thursday at 3, and pick up the passport photos before.',
]

/** A first sentence, written onto the line the way a hand would, and left
    there with the cursor at its end: yours to send or change. */
async function typeFirst(text) {
  const field = page.field
  if (!field) return
  field.focus()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const put = (v) => {
    field.value = v
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (reduced) { put(text); return }
  put('')
  for (const ch of text) {
    if (document.activeElement !== field) return // they took the pen back
    put(field.value + ch)
    await new Promise((r) => setTimeout(r, 14))
  }
  field.setSelectionRange(field.value.length, field.value.length)
}

// the sheets: every row, from the counts; the writing help, from the line's end
document.addEventListener('click', (e) => {
  const first = e.target.closest('[data-first]')
  if (first) {
    e.stopImmediatePropagation(); typeFirst(first.dataset.first); return
  }
  if (e.target.closest('[data-history-open]')) {
    e.stopImmediatePropagation(); openHistory(stageReceipts(page.state)); return
  }
  if (e.target.closest('.stage-help')) {
    e.stopImmediatePropagation(); showIntro()
  }
})

// --------------------------------------------------------- notifications
// A due date only matters if it reaches you. Quiet, deduped per day.

const morningNotify = createMorningNotifier({
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
  notify: (title, options) => new Notification(title, options),
  onOpen: () => {
    window.focus()
    closeFocus()
    page.field?.focus({ preventScroll: true })
  },
})

function checkMorningNotification() {
  if (!page.state || !('Notification' in window) || Notification.permission !== 'granted') return
  const today = localDay()
  const due = attentionItems.filter((i) => i.kind === 'reminder' && i.when.slice(0, 10) === today)
  // Tomorrow's appointment must not read as something happening today.
  const next = due[0]
  morningNotify({ next: next ? { text: next.label, at: next.at } : null })
}

function maybeNotify(items) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (isMorning(new Date())) {
    checkMorningNotification()
    return
  }
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
export { renderToday, attentionBand, openAttention, checkMorningNotification }
