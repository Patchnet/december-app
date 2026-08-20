import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setBlockGoal, goalOf, goalMeasure } from '../lib/blocks.mjs'

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
  await core.createBlock(space.id, { type: 'tracker', title: 'Miles by December', current: 132, target: 200, unit: 'miles', goal: true })
  const ledger = await core.createBlock(space.id, { type: 'ledger', title: '', unit: 'mi', entries: [{ label: 'Monday', amount: 4 }] })

  const out = await core.moveGoal({ space: 'Running', toBlockId: ledger.blockId })
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
  await core.moveGoal({ space: 'Running', toBlockId: streak.blockId })
  const after = core.project().spaces[0]
  assert.equal(after.blocks.length, 2, 'the ledger stays: it holds entries')
  assert.equal(after.blocks.find((b) => b.type === 'ledger').goal, undefined)
  // 138 stood; the streak counts 1 day; 137 rides as carried
  assert.equal(after.blocks.find((b) => b.type === 'streak').goal.current, 138)

  await assert.rejects(core.moveGoal({ space: 'Running', toBlockId: 'nope' }), /unknown toBlockId/)
})

test('a goal never moves to a block in another space', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goal-cross-'))
  const core = await isolatedCore(dir)
  await core.createSpace('Running')
  await core.createBlock('Running', { type: 'tracker', title: 'Miles', target: 200, unit: 'mi', goal: true })
  const other = await core.createBlock('Cycling', { type: 'ledger', title: 'Rides', unit: 'mi' })
  await assert.rejects(
    core.moveGoal({ space: 'Running', toBlockId: other.blockId }),
    /lives in Cycling/
  )
  // nothing changed: Running still carries its goal, Cycling has none
  const goals = core.agentView().goals
  assert.equal(goals.length, 1)
  assert.equal(goals[0].space, 'Running')
})
