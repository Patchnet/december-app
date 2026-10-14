import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMorningNotifier } from '../public/js/morning-notification.js'

const at = (day, hour = 9) => new Date(2026, 8, day, hour)
function harness(values = new Map()) {
  const sent = []
  let opened = 0, closed = 0, fail = false
  const options = {
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    notify: (title, options) => {
      if (fail) throw new Error('Notifications unavailable')
      const note = { title, ...options, close: () => closed++ }
      sent.push(note)
      return note
    },
    onOpen: () => opened++,
  }
  return { options, sent, values, check: createMorningNotifier(options),
    set fail(value) { fail = value }, get opened() { return opened }, get closed() { return closed } }
}

test('a quiet morning asks once, including across reloads; the next day can ask again', () => {
  const h = harness()
  assert.equal(h.check({}, at(19)), true)
  assert.equal(h.sent[0].title, 'Anything to remember?')
  assert.equal(h.sent[0].body, 'Today is open.')
  assert.equal(h.check({}, at(19, 11)), false)
  assert.equal(createMorningNotifier(h.options)({}, at(19, 10)), false)
  assert.equal(h.check({}, at(20)), true)
  assert.equal(h.sent.length, 2)
})

test('night and afternoon do not deliver missed mornings', () => {
  const h = harness()
  for (const hour of [0, 7, 12, 18, 23]) assert.equal(h.check({}, at(19, hour)), false)
  assert.equal(h.sent.length, 0)
  assert.equal(h.check({}, at(20, 8)), true)
})

test('the notification uses the selected voice and clicking closes it and opens capture', () => {
  const h = harness()
  h.check({ next: { text: 'Dentist', at: '10:30' } }, at(19))
  assert.equal(h.sent[0].title, 'Anything to remember?')
  assert.equal(h.sent[0].body, 'Dentist, 10:30am')
  assert.equal(h.sent[0].silent, true)
  h.sent[0].onclick()
  assert.equal(h.opened, 1)
  assert.equal(h.closed, 1)
})

test('failed delivery can retry, but a failed storage write cannot spam this window', () => {
  const h = harness()
  h.fail = true
  assert.equal(h.check({}, at(19)), false)
  assert.equal(h.values.size, 0)
  h.fail = false
  h.options.storage.setItem = () => { throw new Error('Storage full') }
  assert.equal(h.check({}, at(19)), true)
  assert.equal(h.check({}, at(19)), false)
  assert.equal(h.sent.length, 1)
})

test('unreadable storage does not send an undeduplicated notification', () => {
  const h = harness()
  h.options.storage.getItem = () => { throw new Error('Storage blocked') }
  assert.equal(h.check({}, at(19)), false)
  assert.equal(h.sent.length, 0)
})
