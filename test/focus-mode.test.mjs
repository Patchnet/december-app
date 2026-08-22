// Task focus — the spotlight, the span, and the one write at the end of it.
//
// The page has no DOM in here, so the parts that can be reasoned about
// without a browser (the span machine, eligibility, the words a duration
// takes) are exercised for real, and the glue that can only exist in a
// browser is held to its source the way the Pocket surface is.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

// every lib import below lands in a page of its own
process.env.DECEMBER_DATA_DIR = mkdtempSync(join(tmpdir(), 'december-focus-mode-'))

const focusTask = read('public/js/focus-task.js')
const focusCss = read('public/css/focus.css')
const actions = read('public/js/actions.js')

// The module wires itself to the document as it loads, so it needs just
// enough of a page to be imported at all. Nothing below calls into the glue.
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

const row = (props = {}) => ({
  dataset: { block: 'b1', ...props.dataset },
  classList: { contains: (name) => (props.classes || []).includes(name) },
  querySelector: () => (props.text === null ? null : { textContent: props.text ?? 'tile the splashback' }),
})

// ------------------------------------------------------------ eligibility

test('only an open list item or reminder is something to sit down to', () => {
  const item = focus.taskOf(row({ dataset: { item: 'i1' } }))
  assert.deepEqual(item, { blockId: 'b1', itemId: 'i1', label: 'tile the splashback' })

  // a reminder is the whole block, so it carries no item id
  assert.deepEqual(focus.taskOf(row({ text: 'Call the landlord' })), {
    blockId: 'b1',
    itemId: '',
    label: 'Call the landlord',
  })

  assert.equal(focus.taskOf(row({ classes: ['done'] })), null, 'a done thing is not waiting for you')
  assert.equal(focus.taskOf(row({ dataset: { block: '' } })), null, 'nothing without a block is a task')
  assert.equal(focus.taskOf(row({ text: '   ' })), null, 'a row with no words is not a task')
  assert.equal(focus.taskOf(null), null)
  assert.equal(focus.taskOf({}), null)
})

test('the label is the words of the task, not the due phrase beside them', () => {
  const reminder = {
    dataset: { block: 'b9' },
    classList: { contains: () => false },
    querySelector: () => ({ textContent: 'Call the landlord' }),
    textContent: 'Call the landlordUnion Squaretomorrow',
  }
  assert.equal(focus.taskOf(reminder).label, 'Call the landlord')
})

// -------------------------------------------------------------- the span

test('a span is written once, or not at all', () => {
  const span = focus.openSpan({ blockId: 'b1', itemId: 'i1' }, 1000)
  const first = focus.closeSpan(span, 1000 + 45 * 60000)
  assert.deepEqual(first.write, { blockId: 'b1', itemId: 'i1', ms: 45 * 60000 })
  assert.equal(first.reason, 'recorded')

  // Escape and a click away can land together; the second one says nothing
  const second = focus.closeSpan(span, 1000 + 46 * 60000)
  assert.equal(second.write, null)
  assert.equal(second.reason, 'already-closed')
  assert.equal(focus.closeSpan(null, 5).write, null)
})

test('a span carries the identifiers December needs and nothing else', () => {
  const listSpan = focus.closeSpan(focus.openSpan({ blockId: 'b1', itemId: 'i7', label: 'grout' }, 0), 60000)
  assert.deepEqual(Object.keys(listSpan.write).sort(), ['blockId', 'itemId', 'ms'])

  const reminderSpan = focus.closeSpan(focus.openSpan({ blockId: 'b2', itemId: '', label: 'call' }, 0), 60000)
  assert.deepEqual(reminderSpan.write, { blockId: 'b2', ms: 60000 })
  assert.equal(Object.hasOwn(reminderSpan.write, 'itemId'), false, 'a reminder span carries no item id')
})

test('a click passing through and a window left open overnight are not sittings', () => {
  const short = focus.closeSpan(focus.openSpan({ blockId: 'b1' }, 0), focus.FOCUS_MIN_MS - 1)
  assert.equal(short.write, null)
  assert.equal(short.reason, 'too-short')

  const long = focus.closeSpan(focus.openSpan({ blockId: 'b1' }, 0), focus.FOCUS_MAX_MS + 1)
  assert.equal(long.write, null)
  assert.equal(long.reason, 'too-long')

  // the edges themselves are sittings
  assert.ok(focus.closeSpan(focus.openSpan({ blockId: 'b1' }, 0), focus.FOCUS_MIN_MS).write)
  assert.ok(focus.closeSpan(focus.openSpan({ blockId: 'b1' }, 0), focus.FOCUS_MAX_MS).write)
})

test('the running clock counts, and the receipt rounds', () => {
  assert.equal(focus.elapsedClock(0), '0:00')
  assert.equal(focus.elapsedClock(9500), '0:09')
  assert.equal(focus.elapsedClock(65 * 1000), '1:05')
  assert.equal(focus.elapsedClock(3725 * 1000), '1:02:05')
  assert.equal(focus.elapsedClock(-5), '0:00')

  assert.equal(focus.focusPhrase(40000), '40s')
  assert.equal(focus.focusPhrase(45 * 60000), '45m')
  assert.equal(focus.focusPhrase(80 * 60000), '1h 20m')
})

test('the page and the page writer agree on what a sitting is', async () => {
  const core = await import('../lib/core.mjs')
  assert.equal(focus.FOCUS_MIN_MS, core.FOCUS_MIN_MS)
  assert.equal(focus.FOCUS_MAX_MS, core.FOCUS_MAX_MS)
  for (const ms of [20000, 59000, 60000, 45 * 60000, 80 * 60000, 8 * 3600000]) {
    assert.equal(focus.focusPhrase(ms), core.focusPhrase(ms), `${ms} reads the same in both places`)
  }
})

// ------------------------------------------------------------- the write

test('december_focus is on the tool surface and reaches the core', async () => {
  const { TOOLS, callTool } = await import('../lib/tools.mjs')
  const tool = TOOLS.find((t) => t.name === 'december_focus')
  assert.ok(tool, 'the page writes its span through the same seam every assistant uses')
  assert.deepEqual(tool.inputSchema.required, ['blockId', 'ms'])
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['blockId', 'itemId', 'ms'])
  assert.match(tool.description, /Never invent a span/)
  assert.match(tool.description, /nothing to start and nothing to stop/)

  const core = await import('../lib/core.mjs')
  const space = await core.createSpace('Studio')
  const made = await core.createBlock(space.id, { type: 'reminder', title: '', text: 'Mix the track' })
  const out = await callTool('december_focus', { blockId: made.blockId, ms: 30 * 60000 })
  assert.equal(out.summary, '30m focused on: Mix the track')
  assert.equal(core.project().activity[0].summary, '30m focused on: Mix the track')
  await assert.rejects(callTool('december_focus', { blockId: made.blockId, ms: 10 }), /too short/)
})

test('a settle pass cannot invent a sitting', async () => {
  const { ALLOWED } = await import('../lib/settle.mjs')
  assert.ok(
    !ALLOWED.split(',').includes('mcp__december__december_focus'),
    'only the person sitting there knows a sitting happened'
  )
})

// -------------------------------------------------------------- the page

test('the spotlight settles a click before anything below can check the row', () => {
  assert.match(focusTask, /document\.addEventListener\(\r?\n\s+'click',[\s\S]*?\r?\n\s+true\r?\n\)/)
  assert.match(focusTask, /document\.addEventListener\(\r?\n\s+'keydown',[\s\S]*?\r?\n\s+true\r?\n\)/)
  // a double-click on the same words is a rewording, and editing was here first
  assert.match(focusTask, /if \(e\.detail > 1\) return/)
  assert.match(focusTask, /openTimer = setTimeout\(\(\) => enter\(row\), OPEN_DELAY_MS\)/)
  assert.match(actions, /import '\.\/focus-task\.js'/, 'the page loads task focus')
  assert.match(actions, /api\('\/api\/check'/, 'checking a row is untouched')
  assert.match(actions, /document\.addEventListener\('dblclick'/, 'inline editing is untouched')
})

test('escape and a click away both end it, and only the words open it', () => {
  assert.match(focusTask, /if \(!e\.target\?\.closest\?\.\('\.task-focus-card'\)\) exit\(\)/)
  assert.match(focusTask, /if \(e\.key === 'Escape'\) \{\r?\n\s+e\.stopPropagation\(\)\r?\n\s+e\.preventDefault\(\)\r?\n\s+exit\(\)/)
  assert.match(focusTask, /const row = eligibleClick\(e\.target\)/)
  // the strip, the year, the demo and the onboarding ghosts are places you
  // look, not places you work
  assert.match(focusTask, /row\.closest\('#today, \.year-card, \.demo-card, \.ghost'\)/)
  assert.match(focusTask, /row\.closest\('\.space, \.focus-card'\)/)
  // a link in the words is still a link, and selecting them is still reading
  assert.match(focusTask, /target\?\.closest\?\.\('a\.card-link'\)/)
  assert.match(focusTask, /window\.getSelection\?\.\(\)\?\.toString\(\)/)
  assert.match(focusTask, /if \(!text \|\| text\.isContentEditable\) return null/)
})

test('the timer is the browser\'s alone and the write happens once, on exit', () => {
  const paint = focusTask.match(/function paint\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(paint, 'paint is present')
  assert.doesNotMatch(paint, /api\(|fetch\(|XMLHttpRequest|sendBeacon/, 'nothing ticks its way to the server')

  const writes = focusTask.match(/api\('\/api\/tool'/g) || []
  assert.equal(writes.length, 1, 'exactly one place writes a span')
  assert.match(focusTask, /name: 'december_focus'/)
  assert.match(
    focusTask,
    /async function exit\(\) \{\r?\n\s+if \(!span\) return\r?\n\s+const verdict = closeSpan\(span, clock\(\)\)\r?\n\s+span = null/,
    'the span is closed and let go before anything is awaited'
  )
  assert.doesNotMatch(focusTask, /\b(?:confirm|prompt)\(/, 'exiting asks nothing')
})

test('the spotlight is a dialog, restores what it took, and leaves the card overlay alone', () => {
  const markup = focusTask.match(/host\.innerHTML = `[\s\S]*?`\r?\n/)?.[0]
  assert.ok(markup, 'the spotlight markup is present')
  assert.match(markup, /role="dialog"/)
  assert.match(markup, /aria-modal="true"/)
  assert.match(markup, /aria-labelledby="task-focus-label"/)
  assert.match(markup, /tabindex="-1"/)
  assert.match(markup, /id="task-focus-label"/)
  assert.match(markup, /class="sr-only"/, 'the spotlight says aloud how to leave it')
  assert.match(markup, /class="task-focus-clock" aria-hidden="true"/, 'a clock must not be read out every second')
  assert.doesNotMatch(markup, /<button/, 'there is no start button and nothing to press')

  assert.match(focusTask, /\.focus\(\{ preventScroll: true \}\)/)
  assert.match(focusTask, /returnTo\?\.isConnected/, 'the caret goes back where it came from')
  assert.match(focusTask, /el\.inert = true/, 'the rest of the page steps out of the way')
  assert.match(focusTask, /el\.removeAttribute\('aria-hidden'\)/)
  assert.match(focusTask, /if \(e\.key === 'Tab'\) e\.preventDefault\(\)/)
  // a row you tabbed to has a way in that needs no pointer
  assert.match(focusTask, /e\.key === 'f' && !e\.metaKey && !e\.ctrlKey && !e\.altKey/)
  assert.match(focusTask, /if \(!el\?\.matches\?\.\('\.row\[data-block\]'\)\) return/, 'f only acts on the row you are standing on')
  // the space focus overlay owns its own scroll lock and its own closing
  assert.doesNotMatch(focusTask, /closeFocus|modal-open/)
})

test('the focus sheet is loaded by the surface it belongs to and overrides nothing else', () => {
  assert.match(focusTask, /link\.href = '\/css\/focus\.css'/)
  assert.match(focusCss, /:root\.task-focusing/)
  assert.doesNotMatch(focusCss, /(^|\s)\.focus-(card|backdrop|wrap)\s*[,{]/m, 'the card overlay keeps its own look')
  assert.doesNotMatch(focusCss, /modal-open/)
})
