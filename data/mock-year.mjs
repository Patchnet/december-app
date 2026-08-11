// Generates a synthetic ten-months-in state so "December in November" can be
// seen, not imagined. Run: node data/mock-year.mjs  (server stopped)
import { writeFileSync } from 'node:fs'

const d = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()
const day = (daysAgo) => d(daysAgo).slice(0, 10)
let n = 0
const id = () => 'mk' + n++
const streak = (count, span) => {
  const out = []
  for (let i = 0; i < span && out.length < count; i++) if (Math.random() < count / span) out.push(day(i))
  return out
}

const state = {
  captures: [],
  lessons: ['groceries go under Food, not Housing', 'reading counts audiobooks'],
  ask: null,
  suggestions: ["mark today's run", 'log september rent', 'finished book 10'],
  activity: [{ at: d(0), captureId: 'x1', space: 'Running', summary: "logged this morning's 4 miles, 132 of 200" }],
  previous: null,
  updatedAt: d(0),
  spaces: [
    { id: id(), name: 'Running', createdAt: d(280), updatedAt: d(0), blocks: [
      { id: id(), type: 'tracker', title: 'Miles by December', current: 132, target: 200, unit: 'miles', period: 'year' },
      { id: id(), type: 'streak', title: 'Ran today', dates: streak(84, 220) },
    ]},
    { id: id(), name: 'Housing expenses', createdAt: d(300), updatedAt: d(1), blocks: [
      { id: id(), type: 'reminder', title: '', text: 'Schedule the furnace inspection', done: false },
      { id: id(), type: 'tracker', title: 'Rent payments this year', current: 8, target: 12, unit: 'payments', period: 'year' },
      { id: id(), type: 'ledger', title: 'Costs', unit: '$', entries: [
        ['March rent', 2300, 160], ['April rent', 2300, 130], ['May rent', 2300, 99], ['June rent', 2300, 68],
        ['Water heater repair', 480, 55], ['July rent', 2300, 38], ['August rent', 2300, 8], ['Renters insurance', 210, 5],
      ].map(([l, a, ago]) => ({ id: id(), label: l, amount: a, at: d(ago) })) },
    ]},
    { id: id(), name: 'Reading', createdAt: d(290), updatedAt: d(2), blocks: [
      { id: id(), type: 'tracker', title: 'Books this year', current: 9, target: 12, unit: 'books', period: 'year' },
      { id: id(), type: 'list', title: 'Up next', items: [
        { id: id(), text: 'The Making of the Atomic Bomb', done: false },
        { id: id(), text: 'Piranesi', done: false },
        ...['Project Hail Mary', 'The Idea Factory', 'Snow Crash', 'Working', 'The Design of Everyday Things',
          'Endurance', 'The Soul of a New Machine', 'Thinking in Systems', 'Amusing Ourselves to Death',
        ].map((t, i) => ({ id: id(), text: t, done: true, doneAt: d(20 + i * 25) })),
      ]},
    ]},
    { id: id(), name: 'Side project', createdAt: d(200), updatedAt: d(4), blocks: [
      { id: id(), type: 'list', title: 'Ship list', items: [
        { id: id(), text: 'Write the landing page', done: false },
        { id: id(), text: 'Set up payments', done: false },
        { id: id(), text: 'Invite five beta users', done: false },
        ...Array.from({ length: 11 }, (_, i) => ({ id: id(), text: `Milestone ${i + 1} shipped`, done: true, doneAt: d(10 + i * 15) })),
      ]},
      { id: id(), type: 'note', title: 'Where this is going', text: 'The core idea keeps holding up: one page, plain text in, structure out. What changed since spring is the emphasis on the year as the frame. People do not want another inbox, they want to look up in November and see that the year added up to something. Pricing thought from July: free single page, paid for sync and a shared household page. The demo that lands best is still the rent tracker appearing from one typed sentence. Next milestone is getting ten real weekly users and watching where their pages grow.' },
    ]},
    { id: id(), name: 'Health', createdAt: d(250), updatedAt: d(7), blocks: [
      { id: id(), type: 'streak', title: 'Stretched', dates: streak(41, 120) },
      { id: id(), type: 'tracker', title: 'Dentist and checkups', current: 3, target: 4, unit: 'visits', period: 'year' },
    ]},
    { id: id(), name: 'Food', createdAt: d(180), updatedAt: d(11), blocks: [
      { id: id(), type: 'ledger', title: 'Groceries', unit: '$', entries: Array.from({ length: 14 }, (_, i) => ({
        id: id(), label: `Week of ${day(7 * i + 4).slice(5)}`, amount: 120 + Math.round(Math.random() * 90), at: d(7 * i + 4),
      })) },
    ]},
    { id: id(), name: 'Spanish', createdAt: d(230), updatedAt: d(24), blocks: [
      { id: id(), type: 'tracker', title: 'Lessons', current: 61, target: 100, unit: 'lessons', period: 'year' },
    ]},
    { id: id(), name: 'Trips', createdAt: d(220), updatedAt: d(64), blocks: [
      { id: id(), type: 'list', title: 'Baja trip', items: [
        { id: id(), text: 'Book the ferry', done: true, doneAt: d(70) },
        { id: id(), text: 'Reserve campsites', done: true, doneAt: d(66) },
      ]},
      { id: id(), type: 'note', title: '', text: 'June trip notes: the coast road south of Ensenada is worth the extra day.' },
    ]},
    { id: id(), name: 'Car', createdAt: d(320), updatedAt: d(96), blocks: [
      { id: id(), type: 'ledger', title: 'Maintenance', unit: '$', entries: [
        { id: id(), label: 'Brakes', amount: 640, at: d(120) },
        { id: id(), label: 'Oil + filters', amount: 110, at: d(98) },
      ]},
    ]},
    { id: id(), name: 'Gift ideas', createdAt: d(260), updatedAt: d(130), blocks: [
      { id: id(), type: 'list', title: '', items: [
        { id: id(), text: 'Record player for M', done: false },
        { id: id(), text: 'Field notes subscription', done: false },
      ]},
    ]},
  ],
}

writeFileSync(new URL('./state.json', import.meta.url), JSON.stringify(state, null, 1))
console.log('mock year-state written:', state.spaces.length, 'spaces')
