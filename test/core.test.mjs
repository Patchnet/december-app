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

test.after(() => {
  if (originalDataDir == null) delete process.env.DECEMBER_DATA_DIR
  else process.env.DECEMBER_DATA_DIR = originalDataDir
})
