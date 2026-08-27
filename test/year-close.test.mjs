import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let importNumber = 0
async function isolatedCore(dataDir) {
  process.env.DECEMBER_DATA_DIR = dataDir
  return import(`../lib/core.mjs?year-close=${++importNumber}`)
}

const baseState = (year, spaces = [], retired = []) => ({
  captures: [], pocketActions: [], spaces, lessons: [], about: { markdown: '', updatedAt: null },
  activity: [], ask: null, suggestions: [], surfaced: [], retired, yearOf: year,
  carryover: null, rolloverProvenance: null, updatedAt: `${year}-12-31T23:00:00.000Z`, revision: 7,
})

test('Year Close carries every supported open structure faithfully and only from open spaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-year-close-matrix-'))
  const active = {
    id: 'active', name: 'Home', area: 'Life', role: 'do', createdAt: '2024-01-01T12:00:00.000Z', updatedAt: '2024-12-31T12:00:00.000Z',
    blocks: [
      {
        id: 'list-old', type: 'list', title: 'Repairs', entities: [{ type: 'place', name: 'House' }], watch: { since: '2024-02-01T12:00:00.000Z' },
        items: [
          { id: 'done', text: 'painted', done: true, doneAt: '2024-07-04T12:00:00.000Z', src: 'capture-done' },
          { id: 'open', text: 'fix gate', done: false, src: 'capture-open' },
        ],
      },
      {
        id: 'tracker-old', type: 'tracker', title: 'Books', current: 4, target: 12, unit: 'books', period: '', entities: [{ type: 'thing', name: 'Books' }],
        goal: { target: 12, unit: 'books', from: '2024-01-01', by: '2024-10-31', base: 4, setAt: '2024-02-29', movedAt: '2024-12-01T12:00:00.000Z', carried: 2, note: 'keep metadata' },
      },
      {
        id: 'reminder-old', type: 'reminder', title: 'Household', text: 'change filter', done: false,
        when: '2024-12-31', at: '09:30', repeat: 'monthly', repeatAnchor: '12-31', entities: [{ type: 'thing', name: 'Filter' }],
      },
      {
        id: 'streak-old', type: 'streak', title: 'Stretch', dates: ['2024-12-30'], entities: [{ type: 'thing', name: 'Stretching' }],
      },
    ],
  }
  const finished = {
    id: 'finished', name: 'Closed', finished: true, blocks: [{ id: 'closed-list', type: 'list', title: 'No', items: [{ id: 'x', text: 'do not carry', done: false }] }],
  }
  const retired = {
    id: 'retired', name: 'Retired', blocks: [{ id: 'retired-list', type: 'list', title: 'No', items: [{ id: 'y', text: 'do not carry', done: false }] }],
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(baseState(2024, [active, finished], [retired])))
  const core = await isolatedCore(dir)

  assert.equal(await core.rolloverIfNeeded(new Date('2025-01-01T00:05:00')), 2024)
  const pending = core.project().carryover
  assert.deepEqual(pending.items.map((item) => item.kind), ['list', 'tracker', 'reminder', 'streak'])
  assert.equal(pending.items.some((item) => item.space === 'Closed' || item.space === 'Retired'), false)

  await core.applyCarryover(pending.items.map((item) => item.id))
  const page = core.project()
  assert.equal(page.carryover, null)
  assert.equal(page.spaces.length, 1)
  assert.equal(page.spaces[0].area, 'Life')
  assert.equal(page.spaces[0].role, 'do')

  const [list, tracker, reminder, streak] = page.spaces[0].blocks
  assert.notEqual(list.id, 'list-old')
  assert.deepEqual(list.items.map(({ text, done, src }) => ({ text, done, src })), [{ text: 'fix gate', done: false, src: 'capture-open' }])
  assert.deepEqual(list.entities, [{ type: 'place', name: 'House' }])
  assert.deepEqual(list.watch, { since: '2024-02-01T12:00:00.000Z' })

  assert.deepEqual({ title: tracker.title, current: tracker.current, target: tracker.target, unit: tracker.unit, period: tracker.period }, {
    title: 'Books', current: 0, target: 12, unit: 'books', period: '',
  })
  assert.deepEqual(tracker.entities, [{ type: 'thing', name: 'Books' }])
  const durable = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  const durableGoal = durable.spaces[0].blocks.find((block) => block.type === 'tracker').goal
  assert.deepEqual(durableGoal, {
    target: 12, unit: 'books', from: '2025-01-01', by: '2025-10-31', base: 0,
    setAt: '2025-02-28', movedAt: null, note: 'keep metadata',
  })

  assert.deepEqual({ title: reminder.title, text: reminder.text, when: reminder.when, at: reminder.at, repeat: reminder.repeat, repeatAnchor: reminder.repeatAnchor }, {
    title: 'Household', text: 'change filter', when: '2025-01-31', at: '09:30', repeat: 'monthly', repeatAnchor: '12-31',
  })
  assert.deepEqual(reminder.entities, [{ type: 'thing', name: 'Filter' }])
  assert.deepEqual({ title: streak.title, dates: streak.dates, entities: streak.entities }, {
    title: 'Stretch', dates: [], entities: [{ type: 'thing', name: 'Stretching' }],
  })

  await assert.rejects(core.applyCarryover(pending.items.map((item) => item.id)), /nothing to carry/)
  assert.equal((await readdir(join(dir, 'years'))).some((name) => name.endsWith('.writing')), false)
})

test('Year Close preserves every unfinished list item beyond the ordinary creation cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-year-close-long-list-'))
  const unfinished = Array.from({ length: 35 }, (_, index) => ({
    id: `old-${index + 1}`,
    text: `carry item ${String(index + 1).padStart(2, '0')}`,
    done: false,
    src: `capture-${index + 1}`,
  }))
  const source = baseState(2024, [{
    id: 'long-list-space', name: 'Long list', blocks: [
      { id: 'long-list', type: 'list', title: 'Every item', items: unfinished },
    ],
  }])
  await writeFile(join(dir, 'state.json'), JSON.stringify(source))
  const core = await isolatedCore(dir)

  await core.rolloverIfNeeded(new Date('2025-01-01T00:05:00'))
  const archivePath = join(dir, 'years', '2024.json')
  const archiveBeforeCarryover = await readFile(archivePath, 'utf8')
  const pending = core.project().carryover
  await core.applyCarryover(pending.items.map((item) => item.id))

  const carried = core.project().spaces[0].blocks[0]
  assert.deepEqual(
    carried.items.map(({ text, src }) => ({ text, src })),
    unfinished.map(({ text, src }) => ({ text, src })),
  )
  assert.equal(await readFile(archivePath, 'utf8'), archiveBeforeCarryover)

  const ordinaryItems = Array.from({ length: 35 }, (_, index) => `ordinary item ${index + 1}`)
  const ordinary = await core.createBlock('Ordinary list', { type: 'list', title: 'Capped', items: ordinaryItems })
  assert.deepEqual(core.readBlock(ordinary.blockId).block.items.map((item) => item.text), ordinaryItems.slice(0, 30))
})

test('rollover refuses a non-identical archive without changing either year', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-year-close-conflict-'))
  const live = baseState(2024, [{ id: 'live', name: 'Live year', blocks: [] }])
  const conflict = baseState(2024, [{ id: 'other', name: 'Different archive', blocks: [] }])
  await writeFile(join(dir, 'state.json'), JSON.stringify(live))
  await mkdir(join(dir, 'years'))
  await writeFile(join(dir, 'years', '2024.json'), JSON.stringify(conflict, null, 2))
  const core = await isolatedCore(dir)

  await assert.rejects(core.rolloverIfNeeded(new Date('2025-01-01T12:00:00')), /refusing to replace non-identical 2024 archive/)
  assert.equal(core.project().spaces[0].name, 'Live year')
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'years', '2024.json'), 'utf8')), conflict)
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).yearOf, 2024)
})

test('archived month reads and exports use the immutable archived state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-year-close-archive-read-'))
  const archivedSpace = {
    id: 'history', name: 'History', blocks: [
      { id: 'list', type: 'list', title: 'Milestones', items: [{ id: 'done', text: 'shipped July work', done: true, doneAt: '2024-07-12T12:00:00.000Z' }] },
      { id: 'note', type: 'note', title: 'Record', text: 'archived words' },
    ],
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(baseState(2024, [archivedSpace])))
  const core = await isolatedCore(dir)
  await core.rolloverIfNeeded(new Date('2025-01-01T12:00:00'))

  const month = core.readMonth('2024-07')
  assert.equal(month.archived, true)
  assert.equal(month.spaces[0].lines[0].text, 'shipped July work')
  assert.match(core.exportMarkdown(2024), /^# December 2024/m)
  assert.match(core.exportMarkdown(2024), /archived words/)
  assert.match(core.exportMarkdown(), new RegExp(`^# December ${new Date().getFullYear()}`, 'm'))
  assert.doesNotMatch(core.exportMarkdown(), /archived words/)
})

class FakeClassList {
  values = new Set()
  toggle(name, on) { on ? this.values.add(name) : this.values.delete(name) }
  contains(name) { return this.values.has(name) }
}

class FakeElement {
  constructor(document, attrs = {}) {
    this.ownerDocument = document
    this.attrs = attrs
    this.dataset = {}
    this.children = []
    this.parent = null
    this.isConnected = true
    this.inert = false
    this.classList = new FakeClassList()
  }
  append(child) { child.parent = this; this.children.push(child); return child }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
  focus() { this.ownerDocument.activeElement = this }
  getAttribute(name) { return this.attrs[name] ?? null }
  querySelector(selector) {
    if (selector.startsWith('[data-co-next]')) return this.children.find((child) => child.attrs['data-co-next'] != null || child.attrs['data-co-yes'] != null || child.attrs['data-co-no'] != null || child.attrs['data-co-park'] != null) || null
    return this.querySelectorAll(selector)[0] || null
  }
  querySelectorAll() { return this.children.filter((child) => child.attrs.disabled == null) }
}

class FakeDocument {
  constructor() {
    this.documentElement = { classList: new FakeClassList() }
    this.listeners = new Map()
    this.shell = new FakeElement(this)
    this.nudge = new FakeElement(this)
    this.opener = new FakeElement(this)
    this.focus = new FakeElement(this)
    this.focus.dataset = { co: '' }
    this.activeElement = this.opener
    Object.defineProperty(this.focus, 'innerHTML', {
      get: () => this.focusHtml || '',
      set: (html) => {
        this.focusHtml = html
        if (!html) {
          if (this.dialog) this.dialog.isConnected = false
          this.dialog = null
          return
        }
        const article = /<article[^>]+role="dialog"[^>]*>/.exec(html)?.[0] || ''
        const attr = (name) => new RegExp(`${name}="([^"]+)"`).exec(article)?.[1]
        this.dialog = new FakeElement(this, {
          role: attr('role'), 'aria-modal': attr('aria-modal'),
          'aria-labelledby': attr('aria-labelledby'), 'aria-describedby': attr('aria-describedby'),
        })
        for (const match of html.matchAll(/<button\s+([^>]*)>/g)) {
          const attrs = {}
          for (const data of match[1].matchAll(/(data-[\w-]+)(?:="([^"]*)")?/g)) attrs[data[1]] = data[2] ?? ''
          this.dialog.append(new FakeElement(this, attrs))
        }
      },
    })
    this.nudge.innerHTML = ''
  }
  addEventListener(type, handler) { this.listeners.set(type, handler) }
  querySelector(selector) {
    if (selector === '#focus') return this.focus
    if (selector === '#shell') return this.shell
    if (selector === '#co-nudge') return this.nudge
    if (selector === '.co-card[role="dialog"]' || selector === '.co-card') return this.dialog
    if (selector === '[data-co-yes]') return this.dialog?.children.find((child) => child.attrs['data-co-yes'] != null) || null
    if (selector === '[data-co-no]') return this.dialog?.children.find((child) => child.attrs['data-co-no'] != null) || null
    return null
  }
}

test('Clean Slate dialog names itself, focuses under reduced motion, traps Tab, and restores focus on Escape', async () => {
  const priorDocument = globalThis.document
  const priorWindow = globalThis.window
  const document = new FakeDocument()
  globalThis.document = document
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  try {
    const session = await import('../public/js/session.js')
    const year = await import('../public/js/year.js?year-close-dom')
    session.page.field = new FakeElement(document)
    session.page.state = {
      carryover: { fromYear: 2024, finished: { done: 1, met: 0, moments: 2, highlights: [] }, items: [{ id: 'co0', space: 'Home', kind: 'list', title: 'Repairs', texts: ['gate'] }] },
    }
    session.page.coIndex = 0
    session.page.coParked = false

    year.renderCarryover()
    assert.equal(document.dialog.getAttribute('aria-labelledby'), 'co-title')
    assert.equal(document.dialog.getAttribute('aria-describedby'), 'co-description')
    assert.equal(document.activeElement.attrs['data-co-next'], '')
    assert.equal(document.shell.inert, true)
    assert.equal(document.documentElement.classList.contains('modal-open'), true)

    const controls = document.dialog.querySelectorAll('button')
    controls.at(-1).focus()
    let prevented = false
    year.trapCarryoverFocus({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(document.activeElement, controls[0])
    prevented = false
    year.trapCarryoverFocus({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(document.activeElement, controls.at(-1))

    document.opener.isConnected = true
    year.handleCarryoverKeydown({ key: 'Escape', preventDefault() {} })
    assert.equal(session.page.coParked, true)
    assert.equal(document.shell.inert, false)
    assert.equal(document.documentElement.classList.contains('modal-open'), false)
    assert.equal(document.activeElement, document.opener)

    session.page.state.year = { year: 2026, month: 7, months: Array.from({ length: 12 }, () => ({ events: 0 })) }
    session.page.state.archivedYears = [2024]
    session.page.yearShown = {
      year: 2024,
      months: Array.from({ length: 12 }, (_, index) => ({ events: index === 6 ? 1 : 0, highlights: [] })),
      spaces: [],
    }
    year.buildYear()
    assert.ok(document.focusHtml.includes('data-month="2024-07"'), 'a recorded archived month renders as a button')
    assert.ok(document.focusHtml.includes('href="/api/export/2024.md"'), 'the archived view exposes its own download')
  } finally {
    if (priorDocument === undefined) delete globalThis.document
    else globalThis.document = priorDocument
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
  }
})
