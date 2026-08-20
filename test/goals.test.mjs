import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setBlockGoal, goalOf, goalMeasure, uid } from '../lib/blocks.mjs'

let importNumber = 0
async function isolatedCore(dataDir) {
  process.env.DECEMBER_DATA_DIR = dataDir
  return import(`../lib/core.mjs?goals-test=${++importNumber}`)
}

test('a goal is derived from its block, so logging into the block moves the goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goals-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Running')
  const made = await core.createBlock(space.id, { type: 'ledger', title: 'Runs', unit: 'mi', entries: [{ label: 'Monday', amount: 4 }] })

  const set = await core.setGoal({ space: 'Running', target: 200, unit: 'miles' })
  assert.equal(set.blockId, made.blockId)
  assert.equal(set.goal.current, 4)
  assert.equal(set.goal.target, 200)
  assert.equal(set.goal.movedAt, null)

  await core.updateBlock(made.blockId, { entry_label: 'Tuesday', entry_amount: 6 }, 'ledger', 'log_amount')
  const [goal] = core.agentView().goals
  assert.equal(goal.current, 10)
  assert.equal(goal.quietDays, 0)
  assert.equal(goal.space, 'Running')
  assert.equal(goal.blockId, made.blockId)

  // the page sees the same goal, projected onto its block
  const projected = core.project().spaces.find((s) => s.id === space.id).blocks[0].goal
  assert.equal(projected.current, 10)
  assert.equal(projected.by, `${new Date().getFullYear()}-12-31`)
})

test('a tracker has one target: the goal sets it, and 0 lifts the goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goals-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Reading')
  const made = await core.createBlock(space.id, { type: 'tracker', title: '', current: 3, target: 10, unit: 'books' })
  await core.setGoal({ space: space.id, blockId: made.blockId, target: 12 })
  let block = core.project().spaces[0].blocks[0]
  assert.equal(block.target, 12)
  assert.equal(block.goal.current, 3)
  await core.setGoal({ space: 'Reading', target: 0 })
  block = core.project().spaces[0].blocks[0]
  assert.equal(block.goal, undefined)
  assert.equal(core.agentView().goals.length, 0)
})

test('without a blockId the space picks its countable block; notes cannot carry a goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goals-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Spanish')
  await core.createBlock(space.id, { type: 'note', title: '', text: 'verbs' })
  await assert.rejects(core.setGoal({ space: 'Spanish', target: 100 }), /nothing a goal can count/)
  const streak = await core.createBlock(space.id, { type: 'streak', title: 'Practiced' })
  const set = await core.setGoal({ space: 'Spanish', target: 100, unit: 'days' })
  assert.equal(set.blockId, streak.blockId)
  await core.setFinished(space.id, true)
  assert.equal(core.agentView().goals.length, 0, 'a finished space has no live goals')
})

test('a dated goal paces from when it was set and from where the block stood', () => {
  const block = { type: 'tracker', current: 40, target: 100, unit: '' }
  const goal = setBlockGoal(block, { target: 100, by: '2026-10-31' }, '2026-08-01')
  assert.equal(goal.from, '2026-08-01')
  assert.equal(goal.base, 40)
  // halfway through the window, the expected value is halfway from 40 to 100
  const mid = goalOf(block, new Date('2026-09-15T12:00:00'))
  assert.ok(Math.abs(mid.expected - 70) < 1, `expected ~70, got ${mid.expected}`)
  assert.ok(mid.diff < 0)
  // re-setting the target keeps the window; a new horizon opens a new one
  setBlockGoal(block, { target: 120, by: '2026-10-31' }, '2026-09-01')
  assert.equal(block.goal.from, '2026-08-01')
  setBlockGoal(block, { target: 120, by: '2026-11-30' }, '2026-09-01')
  assert.equal(block.goal.from, '2026-09-01')
  assert.equal(block.goal.base, 40)
})

test('a calendar-year goal runs January to December from zero', () => {
  const block = { type: 'list', items: [{ done: true }, { done: false }, { done: true }] }
  const goal = setBlockGoal(block, { target: 24 }, '2026-08-19')
  assert.equal(goal.from, '2026-01-01')
  assert.equal(goal.by, '2026-12-31')
  assert.equal(goal.base, 0)
  assert.equal(goalMeasure(block), 2)
  assert.throws(() => setBlockGoal({ type: 'note', text: '' }, { target: 1 }), /cannot carry a goal/)
})

test('a tracker created with goal: true carries the goal from its first line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goals-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Running')
  await core.createBlock(space.id, { type: 'tracker', title: '', current: 132, target: 200, unit: 'miles', goal: true })
  const [g] = core.agentView().goals
  assert.equal(g.target, 200)
  assert.equal(g.current, 132)
  assert.equal(g.unit, 'miles')
  assert.equal(g.quietDays, 0)
  // a plain tracker is not a goal
  await core.createBlock(space.id, { type: 'tracker', title: 'Shoes', current: 1, target: 3 })
  assert.equal(core.agentView().goals.length, 1)
})

test('the conversion motion: a goal moves carriers without changing where it stands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goals-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Running')
  const tracker = await core.createBlock(space.id, { type: 'tracker', title: 'Miles by December', current: 132, target: 200, unit: 'miles', goal: true })
  const ledger = await core.createBlock(space.id, { type: 'ledger', title: '', unit: 'mi', entries: [{ label: 'Monday', amount: 4 }] })

  const out = await core.moveGoal({ space: 'Running', blockId: tracker.blockId, toBlockId: ledger.blockId })
  assert.equal(out.absorbed, true, 'the mirroring tracker is absorbed')
  assert.equal(out.goal.current, 132, 'standing unchanged: 128 carried + 4 already logged')
  const sp = core.project().spaces[0]
  assert.equal(sp.blocks.length, 1, 'one counter, not two')
  assert.equal(sp.blocks[0].title, 'Miles by December', 'the tracker title passes to the new carrier')

  // progress keeps flowing through the new carrier's own verb
  await core.updateBlock(ledger.blockId, { entry_label: 'Tuesday', entry_amount: 6 }, 'ledger', 'log_amount')
  const [g] = core.agentView().goals
  assert.equal(g.current, 138)
  assert.equal(g.target, 200)

  // a carrier holding the person's words is never absorbed
  const streak = await core.createBlock(space.id, { type: 'streak', title: 'Ran', dates: ['2026-08-01'] })
  await core.moveGoal({ space: 'Running', blockId: ledger.blockId, toBlockId: streak.blockId })
  const after = core.project().spaces[0]
  assert.equal(after.blocks.length, 2, 'the ledger stays: it holds entries')
  assert.equal(after.blocks.find((b) => b.type === 'ledger').goal, undefined)
  // 138 stood; the streak counts 1 day; 137 rides as carried
  assert.equal(after.blocks.find((b) => b.type === 'streak').goal.current, 138)

  await assert.rejects(core.moveGoal({ space: 'Running', blockId: streak.blockId, toBlockId: 'nope' }), /unknown toBlockId/)
})

test('a rejected cross-space goal move has no memory, event, or persistence effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goal-cross-'))
  const core = await isolatedCore(dir)
  await core.createSpace('Running')
  const source = await core.createBlock('Running', { type: 'tracker', title: 'Miles', target: 200, unit: 'mi', goal: true })
  const other = await core.createBlock('Cycling', { type: 'ledger', title: 'Rides', unit: 'mi' })
  const year = new Date().getFullYear()
  const statePath = join(dir, 'state.json')
  const eventsPath = join(dir, `events-${year}.jsonl`)
  const beforeProject = core.project()
  const beforeSource = structuredClone(core.readBlock(source.blockId).block)
  const beforeTarget = structuredClone(core.readBlock(other.blockId).block)
  const beforeState = await readFile(statePath, 'utf8')
  const beforeEvents = await readFile(eventsPath, 'utf8')

  await assert.rejects(
    core.moveGoal({ space: 'Running', blockId: source.blockId, toBlockId: other.blockId }),
    /lives in Cycling/
  )
  assert.deepEqual(core.readBlock(source.blockId).block, beforeSource)
  assert.deepEqual(core.readBlock(other.blockId).block, beforeTarget)
  assert.equal(core.project().updatedAt, beforeProject.updatedAt)
  assert.equal(core.project().canUndo, beforeProject.canUndo)
  assert.equal(await readFile(statePath, 'utf8'), beforeState)
  assert.equal(await readFile(eventsPath, 'utf8'), beforeEvents)
})

test('new ids are cryptographic while legacy short ids remain readable', async () => {
  const ids = Array.from({ length: 512 }, uid)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every((id) => /^[A-Za-z0-9_-]{22}$/.test(id)))

  const dir = await mkdtemp(join(tmpdir(), 'december-legacy-ids-'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [{ id: 'oldcap1', text: 'legacy source', at: '2025-01-02T00:00:00.000Z', status: 'filed' }],
    spaces: [{
      id: 'oldspace1',
      name: 'Legacy',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
      blocks: [{ id: 'oldblock1', type: 'note', title: '', text: 'still here', entities: [] }],
      area: '',
      pinned: false,
      finished: false,
    }],
    yearOf: new Date().getFullYear(),
  }))
  const core = await isolatedCore(dir)
  assert.equal(core.project().spaces[0].id, 'oldspace1')
  assert.equal(core.readBlock('oldblock1').block.text, 'still here')
  const capture = await core.addCapture('new record')
  assert.match(capture.id, /^[A-Za-z0-9_-]{22}$/)
  assert.equal(core.project().sources.oldcap1, 'legacy source')
})

test('goal readings cover zero, met, over, and fractional pace boundaries', () => {
  const block = {
    type: 'tracker',
    current: 0,
    target: 10,
    unit: 'miles',
    goal: {
      target: 10,
      unit: 'miles',
      from: '2026-01-01',
      by: '2026-12-31',
      base: 0,
      setAt: '2026-01-01',
      movedAt: null,
    },
  }
  const afterHorizon = new Date('2027-01-01T12:00:00')

  let reading = goalOf(block, afterHorizon)
  assert.equal(reading.current, 0)
  assert.equal(reading.whole, true)
  assert.equal(reading.gap, 10)
  assert.equal(reading.paceText, '10 behind')
  assert.equal(reading.behind, true)

  block.current = 10
  reading = goalOf(block, afterHorizon)
  assert.equal(reading.met, true)
  assert.equal(reading.pace, 'met')
  assert.equal(reading.paceText, 'done')
  assert.equal(reading.behind, false)

  block.current = 12
  reading = goalOf(block, afterHorizon)
  assert.equal(reading.met, true)
  assert.equal(reading.paceText, 'done')
  assert.equal(reading.behind, false)

  block.current = 9.5
  reading = goalOf(block, afterHorizon)
  assert.equal(reading.diff, -0.5)
  assert.equal(reading.whole, false)
  assert.equal(reading.gap, 0.5)
  assert.equal(reading.paceText, '0.5 behind', 'the existing pace wording is preserved')
  assert.equal(reading.behind, false, 'negative one-half is visually neutral')

  block.current = 9.6
  reading = goalOf(block, afterHorizon)
  assert.equal(reading.diff, -0.4)
  assert.equal(reading.paceText, 'on pace')
  assert.equal(reading.behind, false)

  block.current = 9.4
  reading = goalOf(block, afterHorizon)
  assert.equal(reading.diff, -0.6)
  assert.equal(reading.whole, false)
  assert.equal(reading.behind, true)

  block.current = 9
  reading = goalOf(block, afterHorizon)
  assert.equal(reading.whole, true)
  assert.equal(reading.gap, 1)
})

test('calendar-year and dated goals expose the same derived contract', () => {
  const calendar = { type: 'tracker', current: 25, target: 100, unit: 'miles' }
  setBlockGoal(calendar, { target: 100 }, '2026-08-01')
  const calendarReading = goalOf(calendar, new Date('2026-08-01T12:00:00'))
  assert.equal(calendarReading.from, '2026-01-01')
  assert.equal(calendarReading.by, '2026-12-31')
  assert.equal(typeof calendarReading.paceText, 'string')
  assert.equal(typeof calendarReading.behind, 'boolean')

  const dated = { type: 'tracker', current: 25, target: 100, unit: 'miles' }
  setBlockGoal(dated, { target: 100, by: '2026-10-31' }, '2026-08-01')
  const datedReading = goalOf(dated, new Date('2026-08-01T12:00:00'))
  assert.equal(datedReading.from, '2026-08-01')
  assert.equal(datedReading.by, '2026-10-31')
  assert.equal(datedReading.base, 25)
  assert.equal(typeof datedReading.paceText, 'string')
  assert.equal(typeof datedReading.behind, 'boolean')
})

test('quiet wording begins on day fourteen and movedAt takes precedence', () => {
  const block = {
    type: 'tracker',
    current: 0,
    target: 10,
    unit: '',
    goal: {
      target: 10,
      unit: '',
      from: '2026-01-01',
      by: '2026-12-31',
      base: 0,
      setAt: '2026-08-01',
      movedAt: null,
    },
  }

  let reading = goalOf(block, new Date('2026-08-14T12:00:00'))
  assert.equal(reading.quietDays, 13)
  assert.equal(reading.quietText, '')

  reading = goalOf(block, new Date('2026-08-15T12:00:00'))
  assert.equal(reading.quietDays, 14)
  assert.equal(reading.quietText, 'quiet 14 days')

  block.goal.movedAt = '2026-08-10T12:00:00'
  reading = goalOf(block, new Date('2026-08-15T12:00:00'))
  assert.equal(reading.quietDays, 5)
  assert.equal(reading.quietText, '')
})

test('project derives labels and countedBy without changing durable serialization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goal-projection-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Running')
  const tracker = await core.createBlock(space.id, {
    type: 'tracker', title: 'Year total', current: 1, target: 2, unit: 'runs', goal: true,
  })
  const list = await core.createBlock(space.id, { type: 'list', title: 'Sessions', items: ['First', 'Second'] })
  const ledger = await core.createBlock(space.id, { type: 'ledger', title: 'Long runs', unit: 'miles' })
  await core.setGoal({ space: space.id, blockId: ledger.blockId, target: 100, unit: 'miles' })

  let projected = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(projected.blocks.find((b) => b.id === tracker.blockId).goal.label, 'Running')
  assert.equal(projected.blocks.find((b) => b.id === ledger.blockId).goal.label, 'Long runs')
  assert.equal(projected.blocks.find((b) => b.id === list.blockId).countedBy, tracker.blockId)
  assert.deepEqual(core.agentView().goals.map((g) => g.label), ['Running', 'Long runs'])

  await core.createBlock(space.id, { type: 'list', title: 'Gear', items: ['Shoes'] })
  projected = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(projected.blocks.find((b) => b.id === list.blockId).countedBy, undefined, 'a second list withdraws the stamp')

  const stored = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  const storedSpace = stored.spaces.find((s) => s.id === space.id)
  const storedTracker = storedSpace.blocks.find((b) => b.id === tracker.blockId)
  const storedList = storedSpace.blocks.find((b) => b.id === list.blockId)
  assert.deepEqual(
    Object.keys(storedTracker.goal).sort(),
    ['base', 'by', 'from', 'movedAt', 'setAt', 'target', 'unit'],
    'derived readings do not enter the legacy goal serialization'
  )
  assert.equal(storedList.countedBy, undefined)
})

test('multiple tracker candidates leave a counted list unstamped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-counted-ambiguity-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Rent')
  const list = await core.createBlock(space.id, { type: 'list', title: '', items: ['Jan', 'Feb'] })
  await core.createBlock(space.id, { type: 'tracker', title: 'Payments', current: 0, target: 2, unit: '' })
  let projected = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(typeof projected.blocks.find((b) => b.id === list.blockId).countedBy, 'string')

  await core.createBlock(space.id, { type: 'tracker', title: 'Other', current: 0, target: 2, unit: '' })
  projected = core.project().spaces.find((s) => s.id === space.id)
  assert.equal(projected.blocks.find((b) => b.id === list.blockId).countedBy, undefined)
})
