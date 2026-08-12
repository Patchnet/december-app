// A page at scale: what December looks like eight months into a year that
// was actually used. mock-year.mjs sketches nine spaces; this one exists to
// press on the things that only bend under weight — a rail that has to
// group, columns that have to balance, a finished pile that keeps growing,
// a heatmap with a real year in it, a ledger long enough to need months,
// and every month of the year holding something so the year and month
// views have anything to say.
//
// Run with the server stopped:  node data/mock-scale.mjs
import { writeFileSync } from 'node:fs'

const now = new Date()
const YEAR = now.getFullYear()
const JAN1 = new Date(YEAR, 0, 1)
// how many days of history are still inside this calendar year: anything
// older falls out of the year summary and would seed months that never show
const SPAN = Math.floor((now - JAN1) / 86400000)

const d = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()
const day = (daysAgo) => d(daysAgo).slice(0, 10)
const ahead = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const money = (lo, hi) => Math.round(lo + Math.random() * (hi - lo))

let n = 0
const id = () => `sc${n++}`

/** Days marked across a span, clipped to this year. */
const streak = (count, span) => {
  const out = []
  const reach = Math.min(span, SPAN)
  for (let i = 0; i < reach && out.length < count; i++) {
    if (Math.random() < count / reach) out.push(day(i))
  }
  return out
}

/** Entries spread evenly back through the year, newest first. */
const spread = (count, label, lo, hi, step = Math.floor(SPAN / count)) =>
  Array.from({ length: count }, (_, i) => ({
    id: id(),
    label: label(i, day(i * step + 2)),
    amount: money(lo, hi),
    at: d(i * step + 2),
  }))

const list = (items) => ({ id: id(), type: 'list', title: '', items })
const item = (text, doneAgo) =>
  doneAgo == null
    ? { id: id(), text, done: false }
    : { id: id(), text, done: true, doneAt: d(doneAgo) }

const space = (name, area, agoTouched, blocks, extra = {}) => ({
  id: id(),
  name,
  area,
  createdAt: d(Math.min(SPAN, agoTouched + 60)),
  updatedAt: d(agoTouched),
  pinned: false,
  finished: false,
  blocks,
  ...extra,
})

// ------------------------------------------------------------- the page

const spaces = [
  // --- Money -------------------------------------------------------------
  space('Rent', 'Money', 1, [
    { id: id(), type: 'tracker', title: 'Payments made', current: 8, target: 12, unit: 'payments' },
    { id: id(), type: 'ledger', title: 'Paid', unit: '$', entries: spread(8, (i) => `${['August','July','June','May','April','March','February','January'][i]} rent`, 2300, 2300, 30) },
  ], { pinned: true }),

  space('Groceries', 'Money', 0, [
    { id: id(), type: 'ledger', title: 'Weekly shop', unit: '$', entries: spread(30, (i, dd) => `week of ${dd.slice(5)}`, 88, 210, 7) },
  ]),

  space('Car', 'Money', 9, [
    { id: id(), type: 'ledger', title: 'Running costs', unit: '$', entries: [
      { id: id(), label: 'brake pads', amount: 297, at: d(2) },
      { id: id(), label: 'registration', amount: 212, at: d(53) },
      { id: id(), label: 'new tires', amount: 642, at: d(102) },
      { id: id(), label: 'oil change', amount: 89, at: d(151) },
    ] },
    { id: id(), type: 'reminder', title: '', text: 'Renew the registration', done: false, when: ahead(46), at: '', repeat: 'yearly' },
  ]),

  space('Taxes', 'Money', 41, [
    list([item('Send the CPA last year’s returns', 44), item('Set aside Q3 estimate', 41), item('Ask about the home office deduction')]),
    { id: id(), type: 'note', title: '', text: 'CPA says quarterly estimates are fine at 25% of net. Revisit in November once the second half of the year is clearer.' },
  ]),

  // --- Health ------------------------------------------------------------
  space('Running', 'Health', 0, [
    { id: id(), type: 'tracker', title: 'Miles by December', current: 412, target: 600, unit: 'miles', period: 'year' },
    { id: id(), type: 'streak', title: 'Ran today', dates: streak(118, SPAN) },
  ], { pinned: true }),

  space('Stretching', 'Health', 2, [
    { id: id(), type: 'streak', title: 'Stretched before bed', dates: streak(64, 150) },
  ]),

  space('Dentist', 'Health', 5, [
    { id: id(), type: 'reminder', title: '', text: 'Cleaning and check-up', done: false, when: ahead(8), at: '09:30', repeat: '' },
  ]),

  space('Doctor', 'Health', 34, [
    { id: id(), type: 'tracker', title: 'Check-ups this year', current: 2, target: 4, unit: 'visits' },
    { id: id(), type: 'reminder', title: '', text: 'Book the annual physical', done: false, when: ahead(23) },
  ]),

  space('Sleep', 'Health', 12, [
    { id: id(), type: 'streak', title: 'In bed before midnight', dates: streak(52, 120) },
    { id: id(), type: 'note', title: '', text: 'The pattern is obvious now: the nights that go badly are the ones with a screen after eleven.' },
  ]),

  // --- Work --------------------------------------------------------------
  space('Product', 'Work', 0, [
    list([
      item('Ship the month view'),
      item('Write the changelog'),
      item('Fix the attention strip clipping'),
      ...Array.from({ length: 26 }, (_, i) => item(`Milestone ${26 - i} shipped`, 4 + i * 7)),
    ]),
    { id: id(), type: 'note', title: 'Where this is going', text: 'The core idea keeps holding up: one page, plain text in, structure out. What changed since spring is the emphasis on the year as the frame. People do not want another inbox — they want to look up in November and see that the year added up to something. Pricing thought from July: free single page, paid for sync and a shared household page. The demo that lands best is still the rent tracker appearing from one typed sentence. Next milestone is ten real weekly users, then watching where their pages actually grow rather than where we guessed they would.' },
  ], { pinned: true }),

  space('Pitches', 'Work', 1, [
    list([
      item('Trucking company — Thursday'),
      item('Investment meeting — Thursday'),
      item('Logistics group', 12),
      item('Two regional carriers', 33),
    ]),
    { id: id(), type: 'reminder', title: '', text: 'Send the deck before the trucking pitch', done: false, when: ahead(4), at: '17:00' },
  ]),

  space('Hiring', 'Work', 6, [
    list([item('Write the role'), item('Post it'), item('First five screens', 8), item('Decide on the take-home', 15)]),
  ]),

  space('Metrics', 'Work', 3, [
    { id: id(), type: 'tracker', title: 'Reports sent', current: 8, target: 12, unit: 'reports' },
    { id: id(), type: 'ledger', title: 'ARR', unit: '$', entries: spread(8, (i, dd) => `month ending ${dd.slice(5)}`, 4000, 22000, 30) },
  ]),

  space('Invoices', 'Work', 17, [
    { id: id(), type: 'ledger', title: 'Sent', unit: '$', entries: spread(11, (i, dd) => `invoice ${String(1041 - i)}`, 900, 4200, 18) },
  ]),

  // --- Home --------------------------------------------------------------
  space('Move to Tallahassee', 'Home', 0, [
    list([
      item('Get quotes from three movers'),
      item('Give notice on the lease'),
      item('Change the address everywhere'),
      item('Sort out the storage unit'),
      item('Book the truck', 3),
      item('Decide the date', 9),
    ]),
    { id: id(), type: 'reminder', title: '', text: 'Moving day', done: false, when: ahead(5) },
  ]),

  space('Cookie', 'Home', 0, [
    { id: id(), type: 'streak', title: 'Walked', dates: streak(96, 140) },
    list([item('Buy food from Petco'), item('Book the groomer', 6)]),
  ]),

  space('Plants', 'Home', 8, [
    { id: id(), type: 'reminder', title: '', text: 'Water the fiddle leaf', done: false, when: ahead(2), at: '', repeat: 'weekly' },
  ]),

  space('Repairs', 'Home', 21, [
    list([item('Fix the closet door'), item('Reseal the shower', 24), item('Replace the porch light', 38)]),
    { id: id(), type: 'ledger', title: 'Spent', unit: '$', entries: [
      { id: id(), label: 'plumber', amount: 340, at: d(24) },
      { id: id(), label: 'hardware run', amount: 68, at: d(38) },
    ] },
  ]),

  space('Kitchen', 'Home', 63, [
    { id: id(), type: 'note', title: '', text: 'The pan that actually gets used is the twelve inch carbon steel. Everything else is decoration.' },
  ]),

  // --- Learning ----------------------------------------------------------
  space('Reading', 'Learning', 4, [
    { id: id(), type: 'tracker', title: 'Books this year', current: 14, target: 24, unit: 'books', period: 'year' },
    list([
      item('The Making of the Atomic Bomb'),
      item('Piranesi'),
      ...['Project Hail Mary','The Idea Factory','Snow Crash','Working','The Design of Everyday Things','Endurance','The Soul of a New Machine','Thinking in Systems','Amusing Ourselves to Death','Seeing Like a State','The Right Stuff','A Canticle for Leibowitz'].map((t, i) => item(t, 6 + i * 16)),
    ]),
  ]),

  space('Spanish', 'Learning', 7, [
    { id: id(), type: 'tracker', title: 'Lessons', current: 148, target: 250, unit: 'lessons', period: 'year' },
    { id: id(), type: 'streak', title: 'Practiced', dates: streak(140, SPAN) },
  ]),

  space('Guitar', 'Learning', 15, [
    { id: id(), type: 'tracker', title: 'Practice sessions', current: 46, target: 100, unit: 'sessions', period: 'year' },
  ]),

  space('Courses', 'Learning', 55, [
    list([item('Finish the systems course', 58), item('Start the writing one')]),
  ]),

  // --- People ------------------------------------------------------------
  space('Parents', 'People', 2, [
    { id: id(), type: 'streak', title: 'Called', dates: streak(31, 120) },
    { id: id(), type: 'reminder', title: '', text: 'Breakfast on Saturday', done: false, when: ahead(7), at: '09:00' },
  ]),

  space('Gift ideas', 'People', 26, [
    list([item('Record player'), item('Field notes subscription'), item('The good olive oil'), item('Climbing shoes')]),
  ]),

  space('Birthdays', 'People', 48, [
    { id: id(), type: 'reminder', title: '', text: 'Card in the post', done: false, when: ahead(19), at: '', repeat: 'yearly' },
  ]),

  // --- Play --------------------------------------------------------------
  space('Trips', 'Play', 19, [
    list([item('Book the ferry', 22), item('Reserve campsites', 26), item('Sort the rental car')]),
    { id: id(), type: 'note', title: '', text: 'The coast road south of Ensenada is worth the extra day. Next time go midweek.' },
  ]),

  space('Photos', 'Play', 37, [
    { id: id(), type: 'tracker', title: 'Rolls developed', current: 7, target: 12, unit: 'rolls' },
  ]),

  space('Garden', 'Play', 74, [
    { id: id(), type: 'note', title: '', text: 'Tomatoes went in too late this year. Start them indoors in February.' },
  ]),

  // --- resting: untouched long enough to step below the grid --------------
  space('Old apartment', 'Home', 96, [
    { id: id(), type: 'ledger', title: 'Deposit', unit: '$', entries: [{ id: id(), label: 'returned', amount: 1800, at: d(96) }] },
  ]),
  space('Winter coat', 'Home', 118, [
    list([item('Get it re-waterproofed', 118)]),
  ]),

  // --- finished: the pile that only ever grows ---------------------------
  ...[
    ['Dry cleaning', 'Home', 3], ['Passport renewal', 'Home', 11], ['Tax return', 'Money', 29],
    ['Insurance switch', 'Money', 44], ['Conference talk', 'Work', 51], ['Bike tune-up', 'Play', 66],
    ['Spring clean', 'Home', 78], ['Eye test', 'Health', 89], ['Website move', 'Work', 104],
    ['Storage unit', 'Home', 131],
  ].map(([name, area, ago]) =>
    space(name, area, ago, [list([item('done', ago)])], { finished: true, finishedAt: d(ago) })
  ),
]

// filed captures give the year its own words, month by month
const captures = Array.from({ length: 26 }, (_, i) => {
  const ago = Math.min(SPAN - 1, 3 + i * 8)
  const sp = pick(spaces.filter((s) => !s.finished))
  return {
    id: id(),
    text: pick([
      'paid the rent', 'ran four miles before work', 'called mum back',
      'groceries came to 140', 'booked the movers for the 17th',
      'finished the book on the plane', 'dentist moved to the 20th',
    ]),
    at: d(ago),
    status: 'filed',
    spaceId: sp.id,
    summary: pick([
      'logged the August rent, 8 of 12',
      'added four miles, 412 of 600',
      'marked the call, 31 days',
      'logged the weekly shop',
      'moving day set for the 17th',
    ]),
  }
})

const live = spaces.filter((s) => !s.finished)
const state = {
  captures,
  spaces,
  lessons: [
    'groceries go under Money, not Home',
    'reading counts audiobooks',
    'never surface anything about the car before a Monday',
  ],
  activity: captures.slice(0, 6).map((c) => ({
    at: c.at,
    captureId: c.id,
    space: spaces.find((s) => s.id === c.spaceId)?.name || 'Running',
    summary: c.summary,
  })),
  ask: null,
  suggestions: [],
  surfaced: [
    { label: 'send the deck before the trucking pitch', reason: 'pitch is in 4 days', spaceId: live.find((s) => s.name === 'Pitches')?.id || null, until: ahead(4), at: d(0) },
    { label: 'get quotes from three movers', reason: 'moving day in 5 days', spaceId: live.find((s) => s.name === 'Move to Tallahassee')?.id || null, until: ahead(5), at: d(0) },
    { label: 'book the annual physical', reason: 'has been open since spring', spaceId: live.find((s) => s.name === 'Doctor')?.id || null, until: ahead(20), at: d(0) },
  ],
  retired: [
    space('Old side project', 'Work', 140, [{ id: id(), type: 'note', title: '', text: 'Parked in March. Worth another look one day.' }]),
  ],
  yearOf: YEAR,
  carryover: null,
  previous: null,
  updatedAt: d(0),
}

writeFileSync(new URL('./state.json', import.meta.url), JSON.stringify(state, null, 1))

const blocks = spaces.flatMap((s) => s.blocks)
console.log(`mock scale state written for ${YEAR}`)
console.log(`  spaces      ${spaces.length}  (${live.length} live, ${spaces.length - live.length} finished, 1 retired)`)
console.log(`  areas       ${[...new Set(live.map((s) => s.area))].join(', ')}`)
console.log(`  blocks      ${blocks.length}`)
console.log(`  list items  ${blocks.filter((b) => b.type === 'list').reduce((n2, b) => n2 + b.items.length, 0)}`)
console.log(`  ledger rows ${blocks.filter((b) => b.type === 'ledger').reduce((n2, b) => n2 + b.entries.length, 0)}`)
console.log(`  streak days ${blocks.filter((b) => b.type === 'streak').reduce((n2, b) => n2 + b.dates.length, 0)}`)
console.log(`  captures    ${captures.length} filed`)
