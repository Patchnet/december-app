// Block table behavior — the six types' make/update contracts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeBlock, updateBlock, projectBlock, verbPatch } from '../lib/blocks.mjs'

test('list: make caps items and update checks by id', () => {
  const b = makeBlock({ type: 'list', items: ['milk', 'eggs'], source: 'cap1' })
  assert.equal(b.type, 'list')
  assert.equal(b.items.length, 2)
  assert.equal(b.items[0].src, 'cap1')
  assert.equal(b.items[0].done, false)

  updateBlock(b, { check_item_ids: [b.items[0].id] })
  assert.equal(b.items[0].done, true)
  assert.ok(b.items[0].doneAt)

  updateBlock(b, { uncheck_item_ids: [b.items[0].id] })
  assert.equal(b.items[0].done, false)

  updateBlock(b, { add_items: ['bread'] })
  assert.equal(b.items.length, 3)
})

test('tracker: clamps and moves by delta', () => {
  const b = makeBlock({ type: 'tracker', current: 3, target: 300, unit: 'miles', period: 'year' })
  assert.equal(b.current, 3)
  assert.equal(b.target, 300)
  assert.equal(b.period, 'year')

  updateBlock(b, { delta: 5 })
  assert.equal(b.current, 8)
  updateBlock(b, { delta: -100 })
  assert.equal(b.current, 0) // never negative
  updateBlock(b, { set_target: 0 })
  assert.equal(b.target, 300) // target stays >= 1 and keeps prior on invalid
})

test('unknown block type returns null', () => {
  assert.equal(makeBlock({ type: 'pie-chart' }), null)
})

test('verbPatch translates every block verb', () => {
  const cases = [
    ['december_add_or_check', { blockId: 'b1', add: ['milk'], check: ['i1'], uncheck: ['i2'], source: 'c1' }, 'list', { add_items: ['milk'], check_item_ids: ['i1'], uncheck_item_ids: ['i2'], source: 'c1' }],
    ['december_move_tracker', { blockId: 'b2', delta: 2, current: 5, target: 12, period: 'year', source: 'c2' }, 'tracker', { delta: 2, set_current: 5, set_target: 12, set_period: 'year', source: 'c2' }],
    ['december_log_amount', { blockId: 'b3', label: 'rent', amount: 2300, source: 'c3' }, 'ledger', { entry_label: 'rent', entry_amount: 2300, source: 'c3' }],
    ['december_mark_day', { blockId: 'b4', date: '2026-08-12', source: 'c4' }, 'streak', { mark_date: '2026-08-12', source: 'c4' }],
    ['december_write_note', { blockId: 'b5', text: 'hello', mode: 'append', source: 'c5' }, 'note', { note_text: 'hello', note_mode: 'append', source: 'c5' }],
    ['december_set_reminder', { blockId: 'b6', done: false, when: '2026-09-01', at: '09:30', repeat: 'monthly', source: 'c6' }, 'reminder', { reminder_done: false, reminder_when: '2026-09-01', reminder_at: '09:30', reminder_repeat: 'monthly', source: 'c6' }],
  ]
  for (const [name, args, type, patch] of cases) {
    assert.deepEqual(verbPatch(name, args), { blockId: args.blockId, type, patch })
  }
})

test('entities validate, normalize, update, and project on old blocks', () => {
  const b = makeBlock({
    type: 'reminder',
    text: 'Meet Ana at Union Square',
    entities: [{ type: 'person', name: '  Ana  ' }, { type: 'place', name: 'Union Square' }],
  })
  assert.deepEqual(b.entities, [{ type: 'person', name: 'Ana' }, { type: 'place', name: 'Union Square' }])

  updateBlock(b, { entities: [{ type: 'org', name: 'OpenAI' }] })
  assert.deepEqual(b.entities, [{ type: 'org', name: 'OpenAI' }])
  assert.throws(() => updateBlock(b, { reminder_when: '2026-09-01', entities: [{ type: 'planet', name: 'Mars' }] }), /unknown entity type/)
  assert.equal(b.when, '') // validation happens before any other patch field

  assert.throws(() => makeBlock({ type: 'note', entities: 'Ana' }), /must be an array/)
  assert.throws(() => makeBlock({ type: 'note', entities: Array.from({ length: 9 }, (_, i) => ({ type: 'thing', name: `Thing ${i}` })) }), /at most 8/)
  assert.throws(() => makeBlock({ type: 'note', entities: [{ type: 'thing', name: 'x'.repeat(61) }] }), /1-60/)
  assert.deepEqual(projectBlock({ id: 'old', type: 'note', title: '', text: 'legacy' }).entities, [])
})

test('reminder rhythms retain and reset their calendar anchor', () => {
  const reminder = makeBlock({ type: 'reminder', text: 'pay rent', when: '2026-01-31', repeat: 'monthly' })
  assert.equal(reminder.repeatAnchor, '01-31')

  updateBlock(reminder, { reminder_done: true })
  assert.equal(reminder.repeatAnchor, '01-31')

  updateBlock(reminder, { reminder_when: '2026-04-30' })
  assert.equal(reminder.repeatAnchor, '04-30')

  updateBlock(reminder, { reminder_repeat: '' })
  assert.equal(Object.hasOwn(reminder, 'repeatAnchor'), false)
})
