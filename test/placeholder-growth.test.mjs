import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function harness() {
  const timers = new Map(), frames = []
  let next = 0
  const preference = { matches: false }, document = { hidden: false, createElement: () => ({ style: { setProperty() {} } }) }
  const source = readFileSync(new URL('../public/js/placeholder-growth.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export function', 'function')
  const api = runInNewContext(source + ';({growPlaceholder,stopPlaceholder})', {
    document, window: { matchMedia: () => preference },
    setTimeout: cb => { timers.set(++next, cb); return next }, clearTimeout: id => timers.delete(id),
    animateCardShape: (card, from, options) => frames.push({ from, to: card.getBoundingClientRect().height, options }),
  })
  const host = { isConnected: true, rows: [], querySelectorAll() { return this.rows }, append(row) { this.rows.push(row) } }
  const card = { isConnected: true, getBoundingClientRect: () => ({ height: 60 + host.rows.length * 24 }) }
  const tick = () => { const [id, cb] = timers.entries().next().value; timers.delete(id); cb() }
  return { ...api, host, card, timers, frames, preference, document, tick }
}

test('placeholder begins as a small frame and gains real layout height one row at a time', () => {
  const h = harness()
  h.growPlaceholder(h.host, h.card, 3, { enter: true })
  assert.equal(h.host.rows.length, 0)
  assert.equal(h.frames[0].from, 8)
  h.tick()
  assert.equal(h.host.rows.length, 1)
  h.tick()
  assert.equal(h.host.rows.length, 2)
  h.tick()
  assert.equal(h.host.rows.length, 3)
  assert.deepEqual(h.frames.map(f => f.to), [60, 84, 108, 132])
  assert.equal(h.timers.size, 0, 'no invented progress after the estimated shape is reached')
})

test('real content adoption stops an old placeholder from adding rows to the final card', () => {
  const h = harness()
  h.growPlaceholder(h.host, h.card, 4, { enter: true })
  const stale = [...h.timers.values()][0]
  h.stopPlaceholder(h.host)
  stale()
  assert.equal(h.host.rows.length, 0)
  assert.equal(h.timers.size, 0)
})

test('repeated renders update the same growth instead of restarting the frame', () => {
  const h = harness()
  h.growPlaceholder(h.host, h.card, 2, { enter: true })
  h.tick()
  h.growPlaceholder(h.host, h.card, 4)
  while (h.timers.size) h.tick()
  assert.equal(h.host.rows.length, 4)
  assert.equal(h.frames.filter(f => f.options?.enter).length, 1)
})

test('hidden and reduced-motion views populate without timers; disconnected cards stop', () => {
  for (const mode of ['hidden', 'reduced']) {
    const h = harness()
    if (mode === 'hidden') h.document.hidden = true
    else h.preference.matches = true
    h.growPlaceholder(h.host, h.card, 3, { enter: true })
    assert.equal(h.host.rows.length, 3)
    assert.equal(h.timers.size, 0)
  }
  const h = harness()
  h.growPlaceholder(h.host, h.card, 3, { enter: true })
  h.host.isConnected = false
  h.tick()
  assert.equal(h.host.rows.length, 0)
  assert.equal(h.timers.size, 0)
})
