// Block table behavior — the six types' make/update contracts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeBlock, updateBlock } from '../lib/blocks.mjs'

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
