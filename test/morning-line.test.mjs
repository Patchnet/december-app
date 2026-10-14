// The one line December says unprompted. What it must never do is report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { morningLine, VOICES } from '../public/js/morning-line.js'

const busy = { next: { text: 'Plumber comes', at: '09:00' }, todayCount: 3, overdue: 1, week: 6 }
const blank = { next: null, todayCount: 0, overdue: 0, week: 0 }

test('a morning with nothing in it is silent, except for the one voice that asks', () => {
  for (const voice of ['next', 'shape', 'stage']) {
    assert.equal(morningLine(blank, voice), null, `${voice} should say nothing`)
  }
  // asking does not depend on there being anything to report
  assert.match(morningLine(blank, 'ask').title, /Anything to remember/)
})

test('the line speaks the person\'s own words, never December\'s', () => {
  for (const voice of VOICES) {
    const note = morningLine(busy, voice)
    const said = `${note.title} ${note.body}`
    assert.doesNotMatch(said, /December|task|item|reminder|you have/i,
      `${voice} narrated the system: ${said}`)
  }
})

test('each voice says the thing it promises', () => {
  assert.deepEqual(morningLine(busy, 'next'), { title: '9am', body: 'Plumber comes' })
  assert.deepEqual(morningLine(busy, 'shape'), { title: 'Today', body: '1 overdue · 3 today · 6 this week' })
  assert.deepEqual(morningLine(busy, 'stage'), { title: '9am  Plumber comes', body: '1 overdue · 2 more today' })
  assert.equal(morningLine(busy, 'ask').body, 'Plumber comes, 9am')
})

test('a single thing does not get counted at itself', () => {
  const one = { next: { text: 'Dentist', at: '14:30' }, todayCount: 1, overdue: 0, week: 1 }
  assert.equal(morningLine(one, 'stage').body, 'Nothing else today.', 'never "0 more today"')
  assert.equal(morningLine(one, 'next').title, '2:30pm')
})

test('a thing with no clock time still has a morning line', () => {
  const undated = { next: { text: 'Call the landlord', at: '' }, todayCount: 1, overdue: 0, week: 1 }
  assert.equal(morningLine(undated, 'next').title, 'Today')
  assert.equal(morningLine(undated, 'stage').title, 'Call the landlord')
  assert.equal(morningLine(undated, 'ask').body, 'Call the landlord')
})

test('overdue alone is worth a morning, with nothing dated today', () => {
  const late = { next: null, todayCount: 0, overdue: 2, week: 0 }
  assert.equal(morningLine(late, 'shape').body, '2 overdue')
  assert.equal(morningLine(late, 'next'), null, 'the next-thing voice has no next thing')
})

test('midnight and noon are read the way a person says them', () => {
  const at = (t) => morningLine({ next: { text: 'x', at: t }, todayCount: 1 }, 'next').title
  assert.equal(at('00:00'), '12am')
  assert.equal(at('12:00'), '12pm')
  assert.equal(at('13:05'), '1:05pm')
})
