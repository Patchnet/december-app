import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
