import { test } from 'node:test'
import assert from 'node:assert/strict'

const priorWindow = globalThis.window
const priorDocument = globalThis.document
globalThis.window = { matchMedia: () => ({ matches: false }) }
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  documentElement: { classList: { add() {}, remove() {} } },
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({ dataset: {} }),
  addEventListener() {},
}
const focus = await import('../public/js/focus-task.js')
if (priorWindow === undefined) delete globalThis.window
else globalThis.window = priorWindow
if (priorDocument === undefined) delete globalThis.document
else globalThis.document = priorDocument

const taskWordsIn = (...ancestors) => {
  const classes = new Set(ancestors)
  const row = {
    closest(selector) {
      return selector.split(',').some((part) => classes.has(part.trim())) ? {} : null
    },
  }
  return {
    row,
    text: {
      isContentEditable: false,
      closest: (selector) => (selector === '.row[data-block]' ? row : null),
    },
  }
}

test('attention-dialog rows cannot enter Task Focus', () => {
  const attention = taskWordsIn('.focus-card', '.attention-card')
  assert.equal(focus.eligibleRow(attention.text), null)
})

test('Task Focus remains available in cards where work happens', () => {
  const card = taskWordsIn('.space')
  assert.equal(focus.eligibleRow(card.text), card.row)

  const focusedCard = taskWordsIn('.focus-card')
  assert.equal(focus.eligibleRow(focusedCard.text), focusedCard.row)
})
