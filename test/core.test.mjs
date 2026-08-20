import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalDataDir = process.env.DECEMBER_DATA_DIR
let importNumber = 0

async function isolatedCore(dataDir) {
  process.env.DECEMBER_DATA_DIR = dataDir
  return import(`../lib/core.mjs?core-test=${++importNumber}`)
}

test('pin and finish persist, and finishing clears the pin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-core-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Launch')

  await core.setPinned(space.id, true)
  assert.equal(core.project().spaces.find((item) => item.id === space.id).pinned, true)

  await core.setFinished(space.id, true)
  const finished = core.project().spaces.find((item) => item.id === space.id)
  assert.equal(finished.finished, true)
  assert.equal(finished.pinned, false)
})

test('events append and stream back with block entities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-events-'))
  const core = await isolatedCore(dir)
  const year = new Date().getFullYear()
  const space = await core.createSpace('People')
  const made = await core.createBlock(space.id, {
    type: 'reminder',
    title: '',
    text: 'Meet Ana at Union Square',
    source: 'capture-1',
    entities: [{ type: 'person', name: 'Ana' }, { type: 'place', name: 'Union Square' }],
  })
  await core.updateBlock(made.blockId, { reminder_when: '2026-09-01', source: 'capture-1' }, 'reminder', 'set_reminder')

  const events = await core.readEvents(year)
  assert.deepEqual(events.map((event) => event.kind), ['create_space', 'create_block', 'set_reminder'])
  assert.equal(events.every((event) => typeof event.at === 'string'), true)
  assert.deepEqual(events[1].entities, [{ type: 'person', name: 'Ana' }, { type: 'place', name: 'Union Square' }])
  assert.deepEqual(events[2].entities, events[1].entities)
  assert.equal(events[2].src, 'capture-1')
})

test('rollover uses the injected clock and starts the new year event file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rollover-'))
  const legacy = {
    captures: [{ id: 'c1', text: 'old note', at: '2024-06-01T12:00:00.000Z', status: 'filed', summary: 'kept note' }],
    spaces: [], lessons: ['keep it short'], activity: [], ask: null, suggestions: [], surfaced: [], retired: [],
    yearOf: 2024, carryover: null, previous: null, updatedAt: '2024-12-31T23:00:00.000Z',
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy))
  const oldEvent = '{"at":"2024-06-01T12:00:00.000Z","kind":"capture"}\n'
  await writeFile(join(dir, 'events-2024.jsonl'), oldEvent)
  const core = await isolatedCore(dir)

  assert.equal(await core.rolloverIfNeeded(new Date('2025-01-01T12:00:00.000Z')), 2024)
  const archived = JSON.parse(await readFile(join(dir, 'years', '2024.json'), 'utf8'))
  assert.equal(archived.captures[0].text, 'old note')
  assert.equal(await readFile(join(dir, 'events-2024.jsonl'), 'utf8'), oldEvent)
  assert.deepEqual((await core.readEvents(2025)).map((event) => event.kind), ['rollover'])
  const fresh = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(fresh.yearOf, 2025)
  assert.deepEqual(fresh.lessons, ['keep it short'])
})

test('calendar rhythms retain the original day across clamps, leap years, and forward jumps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rhythm-'))
  const core = await isolatedCore(dir)

  assert.equal(core.nextWhen('2026-01-31', 'monthly', '2026-01-31', '01-31'), '2026-02-28')
  assert.equal(core.nextWhen('2026-02-28', 'monthly', '2026-02-28', '01-31'), '2026-03-31')
  assert.equal(core.nextWhen('2024-02-29', 'yearly', '2024-02-29', '02-29'), '2025-02-28')
  assert.equal(core.nextWhen('2025-02-28', 'yearly', '2027-03-01', '02-29'), '2028-02-29')
  assert.equal(core.nextWhen('2026-01-05', 'weekly', '2026-02-01', '01-05'), '2026-02-02')
  assert.equal(core.nextWhen('2026-03-02', 'weekly', '2026-03-09', '03-02'), '2026-03-16')
})

test('legacy monthly reminders persist their inferred anchor across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rhythm-restart-'))
  const nextYear = new Date().getFullYear() + 1
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [],
    spaces: [{
      id: 'legacy-space', name: 'Bills', createdAt: `${nextYear - 1}-01-01T12:00:00.000Z`, updatedAt: `${nextYear - 1}-01-01T12:00:00.000Z`,
      blocks: [{ id: 'legacy-reminder', type: 'reminder', title: '', text: 'Pay rent', done: false, when: `${nextYear}-01-31`, at: '', repeat: 'monthly' }],
    }],
    lessons: [], activity: [], retired: [], yearOf: new Date().getFullYear(),
  }))
  let core = await isolatedCore(dir)
  await core.check('legacy-reminder', null, true)
  let saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  const februaryEnd = new Date(nextYear, 2, 0).getDate()
  assert.equal(saved.spaces[0].blocks[0].when, `${nextYear}-02-${februaryEnd}`)
  assert.equal(saved.spaces[0].blocks[0].repeatAnchor, '01-31')

  core = await isolatedCore(dir)
  await core.check('legacy-reminder', null, true)
  saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.spaces[0].blocks[0].when, `${nextYear}-03-31`)
  assert.equal(saved.spaces[0].blocks[0].repeatAnchor, '01-31')
})

test('local day projection follows the executing timezone at date boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-timezone-'))
  const moduleUrl = new URL('../lib/core.mjs', import.meta.url).href
  const script = `import { localDay } from ${JSON.stringify(moduleUrl)}; process.stdout.write(localDay(new Date('2026-01-01T00:30:00.000Z')))`
  const inZone = (tz) => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz, DECEMBER_DATA_DIR: dir },
  })
  const east = inZone('Pacific/Kiritimati')
  const west = inZone('Pacific/Honolulu')
  assert.equal(east.status, 0, east.stderr)
  assert.equal(west.status, 0, west.stderr)
  assert.equal(east.stdout, '2026-01-01')
  assert.equal(west.stdout, '2025-12-31')
})

test('invalid recurrence dates are rejected without changing durable state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rhythm-invalid-'))
  const initial = {
    captures: [],
    spaces: [{
      id: 's1', name: 'Bad date', createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z',
      blocks: [{ id: 'b1', type: 'reminder', title: '', text: 'Impossible', done: false, when: '2026-02-30', at: '', repeat: 'monthly' }],
    }],
    lessons: [], activity: [], retired: [], yearOf: 2026,
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(initial))
  const core = await isolatedCore(dir)
  assert.throws(() => core.nextWhen('2026-02-30', 'monthly', '2026-02-01'), /invalid reminder date/)
  await assert.rejects(core.check('b1', null, true), /invalid reminder date/)
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.spaces[0].blocks[0].when, '2026-02-30')
})

test('a multi-year clock jump must hold before rollover and recovers after restart by provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rollover-provenance-'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [],
    spaces: [{
      id: 's1', name: 'Journal', createdAt: '2024-01-01T12:00:00.000Z', updatedAt: '2024-12-31T12:00:00.000Z',
      blocks: [{ id: 'b1', type: 'note', title: 'Year note', text: 'Keep this writing' }],
    }],
    lessons: ['keep it short'],
    about: { markdown: '# Person\n\nProfile text', updatedAt: '2024-12-31T12:00:00.000Z' },
    activity: [], retired: [], yearOf: 2024,
  }))
  let core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date('2027-01-01T12:00:00.000Z')), null)
  assert.equal(await core.rolloverIfNeeded(new Date('2027-01-01T12:04:59.000Z')), null)
  assert.equal(await core.rolloverIfNeeded(new Date('2027-01-01T12:05:00.000Z')), 2024)
  let fresh = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(fresh.rolloverProvenance, {
    fromYear: 2024, toYear: 2027, at: '2027-01-01T12:05:00.000Z', mutated: false,
  })

  core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date('2024-07-01T12:00:00.000Z')), 2024)
  const restored = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(restored.yearOf, 2024)
  assert.equal(restored.spaces[0].blocks[0].text, 'Keep this writing')
  assert.deepEqual(restored.lessons, ['keep it short'])
  assert.match(restored.about.markdown, /Profile text/)
})

test('rollover recovery never replaces a page mutated after rollover, including after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rollover-mutated-'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [], spaces: [], lessons: ['old lesson'],
    about: { markdown: '# Old profile', updatedAt: '2024-12-31T12:00:00.000Z' },
    activity: [], retired: [], yearOf: 2024,
  }))
  let core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date('2025-01-01T12:00:00.000Z')), 2024)
  await core.writeAbout('# New profile\n\nValid writing', 'set')
  await core.addLesson('new lesson')
  const notes = await core.createSpace('New notes')
  await core.createBlock(notes.id, { type: 'note', title: '', text: 'do not overwrite' })

  core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date('2024-06-01T12:00:00.000Z')), null)
  const kept = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(kept.yearOf, 2025)
  assert.equal(kept.rolloverProvenance.mutated, true)
  assert.match(kept.about.markdown, /Valid writing/)
  assert.ok(kept.lessons.includes('new lesson'))
  assert.equal(kept.spaces[0].blocks[0].text, 'do not overwrite')
})

test('an archive alone is not rollover provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rollover-no-provenance-'))
  const core2024 = await isolatedCore(dir)
  await core2024.createSpace('Archive source')
  await core2024.rolloverIfNeeded(new Date(`${new Date().getFullYear() + 1}-01-01T12:00:00.000Z`))
  const current = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  current.rolloverProvenance = null
  current.about = { markdown: '# Current page', updatedAt: new Date().toISOString() }
  await writeFile(join(dir, 'state.json'), JSON.stringify(current))

  const core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date(`${new Date().getFullYear()}-06-01T12:00:00.000Z`)), null)
  assert.equal(core.project().about.name, 'Current page')
})

test('the capture cap removes only oldest inbox entries when legacy ids collide', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-capture-cap-'))
  const year = new Date().getFullYear()
  const captures = [
    { id: 'duplicate-id', text: 'first filed receipt', at: `${year}-01-01T12:00:00.000Z`, status: 'filed', summary: 'first' },
    { id: 'duplicate-id', text: 'second filed receipt', at: `${year}-01-02T12:00:00.000Z`, status: 'filed', summary: 'second' },
    ...Array.from({ length: 200 }, (_, i) => ({
      id: i === 0 ? 'duplicate-id' : `inbox-${i}`,
      text: `inbox ${i}`,
      at: `${year}-01-03T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
      status: 'inbox',
    })),
  ]
  await writeFile(join(dir, 'state.json'), JSON.stringify({ captures, spaces: [], lessons: [], activity: [], retired: [], yearOf: year }))
  const core = await isolatedCore(dir)
  await core.addCapture('one more inbox item')

  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).captures
  assert.equal(saved.filter((capture) => capture.status === 'inbox').length, 200)
  assert.equal(saved.filter((capture) => capture.status === 'filed').length, 2)
  assert.deepEqual(saved.filter((capture) => capture.status === 'filed').map((capture) => capture.text), [
    'first filed receipt', 'second filed receipt',
  ])
  assert.equal(saved.some((capture) => capture.text === 'inbox 0'), false)
  assert.equal(core.project().sources['duplicate-id'], 'second filed receipt')
})

test('retired spaces remain in current and archived history but never schedule or carry work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-retired-history-'))
  const core = await isolatedCore(dir)
  const year = new Date().getFullYear()
  const month = new Date().toISOString().slice(0, 7)
  const future = `${year}-12-30`
  const space = await core.createSpace('Retired project')
  await core.createBlock(space.id, { type: 'ledger', title: 'Costs', unit: '$', entries: [{ label: 'materials', amount: 40 }] })
  const list = await core.createBlock(space.id, { type: 'list', title: 'Tasks', items: ['done task'] })
  const item = core.readBlock(list.blockId).block.items[0]
  await core.check(list.blockId, item.id, true)
  await core.createBlock(space.id, { type: 'reminder', text: 'active work', when: future })
  await core.retireSpace(space.id)

  const currentMonth = core.readMonth(month)
  const detail = currentMonth.spaces.find((entry) => entry.name === 'Retired project')
  assert.equal(detail.retired, true)
  assert.ok(detail.lines.some((line) => line.text === 'materials'))
  assert.equal(detail.lines.some((line) => line.ahead), false)
  assert.equal(core.project().year.months.reduce((sum, entry) => sum + entry.scheduled, 0), 0)
  const currentCounts = core.project().year.months.map((entry) => entry.events)

  assert.equal(await core.rolloverIfNeeded(new Date(`${year + 1}-01-01T12:00:00.000Z`)), year)
  const fresh = core.project()
  assert.equal(fresh.carryover.items.some((entry) => entry.space === 'Retired project'), false)
  assert.ok(fresh.carryover.finished.done >= 1)

  const archived = core.readYear(year)
  assert.equal(archived.spaces.find((entry) => entry.name === 'Retired project')?.retired, true)
  assert.deepEqual(archived.months.map((entry) => entry.events), currentCounts)
})

test('pre-entities and pre-events state loads without data loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-compat-'))
  const year = new Date().getFullYear()
  const legacy = {
    captures: [{ id: 'c1', text: 'legacy capture', at: `${year}-01-02T12:00:00.000Z`, status: 'inbox' }],
    spaces: [{
      id: 's1', name: 'Legacy', createdAt: `${year}-01-01T12:00:00.000Z`, updatedAt: `${year}-01-01T12:00:00.000Z`,
      blocks: [{ id: 'b1', type: 'note', title: 'Old note', text: 'still here' }],
    }],
    lessons: [], activity: [], yearOf: year,
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy))
  const core = await isolatedCore(dir)

  const page = core.project()
  assert.equal(page.captures[0].text, 'legacy capture')
  assert.equal(page.spaces[0].blocks[0].text, 'still here')
  assert.deepEqual(page.spaces[0].blocks[0].entities, [])
  assert.deepEqual(core.agentView().spaces[0].blocks[0].entities, [])
  assert.deepEqual(await core.readEvents(year), [])
})

test('inline edits cover block titles and ledger labels with manual undo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-edits-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Money')
  const made = await core.createBlock(space.id, { type: 'ledger', title: 'Costs', entries: [{ label: 'Rent', amount: 10 }] })
  const entryId = core.readBlock(made.blockId).block.entries[0].id

  await core.editText({ blockId: made.blockId, field: 'title', text: 'Home costs' })
  await core.editText({ blockId: made.blockId, itemId: entryId, field: 'ledger_label', text: 'August rent' })
  let block = core.readBlock(made.blockId).block
  assert.equal(block.title, 'Home costs')
  assert.equal(block.entries[0].label, 'August rent')

  await core.undoManual()
  block = core.readBlock(made.blockId).block
  assert.equal(block.title, 'Home costs')
  assert.equal(block.entries[0].label, 'Rent')
})

test('space role defaults from block types: note or ledger is keep, else do', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-role-'))
  const core = await isolatedCore(dir)
  const errands = await core.createSpace('Errands')
  await core.createBlock(errands.id, { type: 'list', title: '', items: ['milk'] })
  assert.equal(core.project().spaces.find((s) => s.id === errands.id).role, 'do')

  const family = await core.createSpace('Family')
  await core.createBlock(family.id, { type: 'note', title: '', text: 'Lincoln Elementary' })
  await core.createBlock(family.id, { type: 'list', title: '', items: ['pack lunch'] })
  assert.equal(core.project().spaces.find((s) => s.id === family.id).role, 'keep')

  const money = await core.createSpace('Money')
  await core.createBlock(money.id, { type: 'ledger', title: 'Rent', entries: [{ label: 'June', amount: 10 }] })
  assert.equal(core.project().spaces.find((s) => s.id === money.id).role, 'keep')
})

test('checking the last open item archives a do-only space and keeps items', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-archive-do-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Errands')
  const made = await core.createBlock(space.id, { type: 'list', title: '', items: ['milk', 'eggs'] })
  const items = core.readBlock(made.blockId).block.items

  await core.check(made.blockId, items[0].id, true)
  let page = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(page.finished, false)
  assert.equal(page.blocks[0].items.filter((i) => i.done).length, 1)

  await core.check(made.blockId, items[1].id, true)
  page = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(page.finished, true)
  assert.equal(page.blocks[0].items.every((i) => i.done), true)
  assert.equal(page.blocks[0].items.length, 2)
})

test('a keep space stays on the page after its nested list is complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-keep-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('School')
  await core.createBlock(space.id, { type: 'note', title: '', text: 'Maya · Lincoln Elementary' })
  const made = await core.createBlock(space.id, { type: 'list', title: '', items: ['pack lunch'] })
  const item = core.readBlock(made.blockId).block.items[0]
  await core.check(made.blockId, item.id, true)
  const page = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(page.role, 'keep')
  assert.equal(page.complete, true)
  assert.equal(page.finished, false)
})

test('checking a repeating reminder does not archive the space', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-repeat-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Pills')
  const made = await core.createBlock(space.id, {
    type: 'reminder',
    title: '',
    text: 'Take vitamins',
    when: '2026-08-18',
    repeat: 'daily',
  })
  await core.check(made.blockId, undefined, true)
  const page = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(page.finished, false)
  assert.equal(page.blocks[0].done, false)
  assert.ok(page.blocks[0].when > '2026-08-18')
})

test('marking a repeating reminder done through updateBlock does not archive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-repeat-agent-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Pills')
  const made = await core.createBlock(space.id, {
    type: 'reminder',
    title: '',
    text: 'Take vitamins',
    when: '2026-08-18',
    repeat: 'daily',
  })
  await core.updateBlock(made.blockId, { reminder_done: true }, 'reminder', 'set_reminder')
  const page = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(page.blocks[0].done, true)
  assert.equal(page.complete, false)
  assert.equal(page.finished, false)
})

test('undoing a check does not revert a later About Me edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-about-undo-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Errands')
  const made = await core.createBlock(space.id, { type: 'list', title: '', items: ['milk'] })
  const item = core.readBlock(made.blockId).block.items[0]
  await core.check(made.blockId, item.id, true)
  await core.writeAbout('# Luis', 'set')
  await core.undoManual()
  assert.match(core.project().about.markdown, /# Luis/)
})

test('About Me name, initial, set, append, and undo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-about-'))
  const core = await isolatedCore(dir)
  assert.equal(core.aboutName(''), '')
  assert.equal(core.aboutInitial(''), 'D')
  assert.equal(core.aboutName('# Luis\n\nLives in Brooklyn'), 'Luis')
  assert.equal(core.aboutInitial('# Luis\n\nLives in Brooklyn'), 'L')
  assert.equal(core.aboutInitial('# 佐藤'), '佐')
  assert.equal(core.aboutName('Maya goes to Lincoln'), 'Maya goes to Lincoln')
  assert.deepEqual(core.project().about, { markdown: '', name: '', initial: 'D', updatedAt: null })

  const set = await core.writeAbout('# Luis\n\nLives in Brooklyn', 'set', { manual: true })
  assert.equal(set.name, 'Luis')
  assert.equal(set.initial, 'L')
  assert.match(set.markdown, /Brooklyn/)
  assert.equal(core.agentView().about.name, 'Luis')

  const appended = await core.writeAbout("Maya's school is Lincoln", 'append', { manual: true })
  assert.match(appended.markdown, /# Luis/)
  assert.match(appended.markdown, /Maya's school is Lincoln/)

  await core.undoManual()
  assert.equal(core.project().about.markdown.includes('Maya'), false)
  assert.match(core.project().about.markdown, /# Luis/)
})

test('About Me survives year rollover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-about-year-'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [],
    spaces: [],
    lessons: ['keep it short'],
    about: { markdown: '# Luis\n', updatedAt: '2024-12-31T23:00:00.000Z' },
    activity: [],
    ask: null,
    suggestions: [],
    surfaced: [],
    retired: [],
    yearOf: 2024,
    carryover: null,
    previous: null,
    updatedAt: '2024-12-31T23:00:00.000Z',
  }))
  const core = await isolatedCore(dir)
  await core.rolloverIfNeeded(new Date('2025-01-01T12:00:00.000Z'))
  const fresh = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(fresh.yearOf, 2025)
  assert.equal(fresh.about.markdown, '# Luis\n')
  assert.equal(core.project().about.initial, 'L')
})

test.after(() => {
  if (originalDataDir == null) delete process.env.DECEMBER_DATA_DIR
  else process.env.DECEMBER_DATA_DIR = originalDataDir
})

test('an undated reminder that was done shows up in the month it was done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-month-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Housing')
  const made = await core.createBlock(space.id, { type: 'reminder', title: '', text: 'Schedule the furnace inspection' })
  await core.check(made.blockId, null, true)
  const ym = new Date().toISOString().slice(0, 7)
  const month = core.readMonth(ym)
  const housing = month.spaces.find((s) => s.name === 'Housing')
  assert.ok(housing, 'the space appears in the month')
  assert.ok(housing.lines.some((l) => l.text === 'Schedule the furnace inspection'))
  // unchecking forgets the day again
  await core.check(made.blockId, null, false)
  assert.equal(core.readMonth(ym).spaces.find((s) => s.name === 'Housing'), undefined)
})

test('a month faces forward: scheduled reminders and goal horizons appear in it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-ahead-'))
  const core = await isolatedCore(dir)
  const y = new Date().getFullYear()
  const space = await core.createSpace('Trips')
  await core.createBlock(space.id, { type: 'reminder', title: '', text: 'Flight to Denver', when: `${y}-11-14`, at: '09:30' })
  const run = await core.createSpace('Running')
  await core.createBlock(run.id, { type: 'tracker', title: '', current: 10, target: 100, unit: 'miles', goal: true, by: `${y}-11-30` })

  const nov = core.readMonth(`${y}-11`)
  assert.equal(nov.ahead, 2)
  const trips = nov.spaces.find((s) => s.name === 'Trips')
  assert.ok(trips.lines.some((l) => l.ahead && l.text === 'Flight to Denver' && l.at === '09:30'))
  assert.match(trips.headline, /1 due/)
  assert.ok(nov.spaces.find((s) => s.name === 'Running')?.lines.some((l) => l.goal && /goal: 100 miles/.test(l.text)))

  // the year counts them for the month rows
  const months = core.project().year.months
  assert.equal(months[10].scheduled, 2)
  // a done reminder stops being scheduled
  const st = core.agentView().spaces.find((s) => s.name === 'Trips')
  await core.check(st.blocks[0].id, null, true)
  assert.equal(core.project().year.months[10].scheduled, 1)
})
