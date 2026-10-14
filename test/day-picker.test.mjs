// December's own month. The grid is the part that can be wrong quietly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthGrid, iso } from '../public/js/day-picker.js'

test('the month begins on a Monday and covers only the weeks it touches', () => {
  // September 2026 begins on a Tuesday and has 30 days: five rows exactly.
  const sep = monthGrid(2026, 8)
  assert.equal(sep.length, 35)
  assert.equal(sep[0].iso, '2026-08-31', 'the Monday before the first')
  assert.equal(sep[0].inMonth, false)
  assert.equal(sep[1].iso, '2026-09-01')
  assert.equal(sep.at(-1).iso, '2026-10-04')
  assert.equal(sep.filter(c => c.inMonth).length, 30)
})

test('a month that starts on a Monday does not carry a leading week of nothing', () => {
  // June 2026 begins on a Monday, 30 days: no lead, five rows.
  const jun = monthGrid(2026, 5)
  assert.equal(jun[0].iso, '2026-06-01')
  assert.equal(jun.length, 35)
})

test('a long month pushed late needs six rows and gets them', () => {
  // August 2026 begins on a Saturday and has 31 days: 6 + 31 = 37 -> 6 rows.
  const aug = monthGrid(2026, 7)
  assert.equal(aug.length, 42)
  assert.equal(aug[0].iso, '2026-07-27')
  assert.equal(aug.filter(c => c.inMonth).length, 31)
})

test('February in a leap year keeps its extra day', () => {
  const feb = monthGrid(2028, 1)
  assert.equal(feb.filter(c => c.inMonth).length, 29)
  assert.ok(feb.some(c => c.iso === '2028-02-29'))
})

test('every cell runs on in order with no gap or repeat', () => {
  for (const [y, m] of [[2026, 0], [2026, 8], [2027, 11], [2028, 1]]) {
    const cells = monthGrid(y, m)
    assert.equal(cells.length % 7, 0)
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1].date
      const next = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1)
      assert.equal(cells[i].iso, iso(next), `${y}-${m} broke at cell ${i}`)
    }
  }
})

test('a day is written the way the server reads it, in local time', () => {
  // Not toISOString: that shifts the day backwards west of Greenwich.
  assert.equal(iso(new Date(2026, 8, 1, 0, 30)), '2026-09-01')
  assert.equal(iso(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
})
