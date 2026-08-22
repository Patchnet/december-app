import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goalOf } from '../lib/blocks.mjs'

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
    yearOf: 2024, carryover: null, previous: null, updatedAt: '2024-12-31T23:00:00.000Z', revision: 41,
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
  assert.equal(fresh.revision, 42)
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

test('tomorrow urgency uses the local calendar across a 25-hour DST day', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-dst-'))
  const moduleUrl = new URL('../lib/core.mjs', import.meta.url).href
  const script = `import { urgencyOf } from ${JSON.stringify(moduleUrl)}; const space = { blocks: [{ type: 'reminder', done: false, when: '2026-11-02' }] }; process.stdout.write(String(urgencyOf(space, new Date('2026-11-01T04:30:00.000Z'))))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York', DECEMBER_DATA_DIR: dir },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '20')
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
  assert.ok(restored.revision > fresh.revision, 'recovery keeps the write revision monotonic')
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

test('batch capture protects a rolled-over page from clock recovery after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-rollover-batch-'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [], spaces: [], lessons: [], activity: [], retired: [], yearOf: 2024,
  }))
  let core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date('2025-01-01T12:00:00.000Z')), 2024)
  await core.addCaptureBatch(['paid rent', 'ran three miles'])

  core = await isolatedCore(dir)
  assert.equal(await core.rolloverIfNeeded(new Date('2024-06-01T12:00:00.000Z')), null)
  const kept = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(kept.yearOf, 2025)
  assert.equal(kept.rolloverProvenance.mutated, true)
  assert.deepEqual(kept.captures.map((capture) => capture.text), ['paid rent', 'ran three miles'])
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

test('batch capture deduplicates in order, persists once, and caps only the inbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-batch-'))
  const year = new Date().getFullYear()
  const captures = [
    { id: 'filed-1', text: 'first receipt', at: `${year}-01-01T12:00:00.000Z`, status: 'filed' },
    { id: 'filed-2', text: 'second receipt', at: `${year}-01-02T12:00:00.000Z`, status: 'filed' },
    ...Array.from({ length: 199 }, (_, index) => ({
      id: `inbox-${index}`, text: `existing ${index}`, at: `${year}-02-01T12:00:00.000Z`, status: 'inbox',
    })),
  ]
  await writeFile(join(dir, 'state.json'), JSON.stringify({ captures, spaces: [], lessons: [], activity: [], retired: [], yearOf: year }))
  const core = await isolatedCore(dir)
  let persists = 0
  core.observePersists(() => { persists++ })

  const kept = await core.addCaptureBatch(['paid rent', 'ran three miles', 'paid rent'])
  assert.deepEqual(kept.map((capture) => capture.text), ['paid rent', 'ran three miles'])
  assert.equal(persists, 1)

  const raw = await readFile(join(dir, 'state.json'), 'utf8')
  const saved = JSON.parse(raw)
  assert.equal(raw.includes('\n'), false, 'the live state stays compact')
  assert.equal(saved.revision, 1)
  assert.equal(saved.captures.filter((capture) => capture.status === 'inbox').length, 200)
  assert.deepEqual(saved.captures.filter((capture) => capture.status === 'filed').map((capture) => capture.text), [
    'first receipt', 'second receipt',
  ])
  const events = (await core.readEvents(year)).filter((event) => event.kind === 'capture')
  assert.deepEqual(events.map((event) => event.summary), ['paid rent', 'ran three miles'])
})

test('durable revisions and poll freshness cross same-state time boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-freshness-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Tomorrow')
  await core.createBlock(space.id, { type: 'reminder', text: 'prepare', when: '2026-01-02' })
  const revision = core.project().revision

  const afternoon = core.stateFingerprint(new Date(2026, 0, 1, 16, 59))
  const evening = core.stateFingerprint(new Date(2026, 0, 1, 17, 0))
  const priorMonth = core.stateFingerprint(new Date(2025, 11, 31, 23, 59))
  assert.notEqual(afternoon, evening, 'the tomorrow urgency threshold changes at 5pm')
  assert.notEqual(priorMonth, afternoon, 'local day and month boundaries change freshness')
  assert.equal(core.project().revision, revision, 'time-only freshness does not mutate durable state')

  await core.addCapture('first same-clock candidate')
  const firstRevision = core.project().revision
  await core.addCapture('second same-clock candidate')
  assert.equal(core.project().revision, firstRevision + 1, 'every durable write has a distinct monotonic revision')
})

test('poll freshness follows same-day goal pace wording and styling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goal-pace-freshness-'))
  const block = {
    id: 'pace-goal', type: 'tracker', title: '', current: 0, target: 2000, unit: '',
    goal: { target: 2000, unit: '', from: '2026-08-20', by: '2026-08-20', base: 0, setAt: null, movedAt: null },
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [], lessons: [], activity: [], retired: [], yearOf: 2026, revision: 7,
    spaces: [{ id: 'pace-space', name: 'Pace', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', blocks: [block] }],
  }))
  const core = await isolatedCore(dir)
  const onPace = new Date(2026, 7, 20, 0, 0, 17)
  const boundary = new Date(2026, 7, 20, 0, 0, 22)
  const behind = new Date(2026, 7, 20, 0, 0, 26)
  assert.equal(goalOf(block, onPace).paceText, 'on pace')
  assert.equal(goalOf(block, boundary).paceText, '1 behind')
  assert.equal(goalOf(block, boundary).behind, false, 'the exact -0.5 boundary stays visually neutral')
  assert.equal(goalOf(block, behind).behind, true)
  assert.notEqual(core.stateFingerprint(onPace), core.stateFingerprint(boundary))
  assert.notEqual(core.stateFingerprint(boundary), core.stateFingerprint(behind))
  assert.equal(core.project().revision, 7)
})

test('poll freshness follows same-day goal quiet wording', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goal-quiet-freshness-'))
  const block = {
    id: 'quiet-goal', type: 'tracker', title: '', current: 0, target: 1, unit: '',
    goal: { target: 1, unit: '', from: '2026-01-01', by: '2026-12-31', base: 0, setAt: '2026-08-06', movedAt: null },
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [], lessons: [], activity: [], retired: [], yearOf: 2026, revision: 8,
    spaces: [{ id: 'quiet-space', name: 'Quiet', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', blocks: [block] }],
  }))
  const core = await isolatedCore(dir)
  const before = new Date(2026, 7, 20, 11, 59)
  const after = new Date(2026, 7, 20, 12, 0)
  assert.equal(goalOf(block, before).quietText, '')
  assert.equal(goalOf(block, after).quietText, 'quiet 14 days')
  assert.notEqual(core.stateFingerprint(before), core.stateFingerprint(after))
  assert.equal(core.project().revision, 8)
})

test('poll freshness follows the same-day goal tick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-goal-tick-freshness-'))
  const block = {
    id: 'tick-goal', type: 'tracker', title: '', current: 0, target: 1, unit: '',
    goal: { target: 1, unit: '', from: '2026-01-01', by: '2026-12-31', base: 0, setAt: null, movedAt: null },
  }
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [], lessons: [], activity: [], retired: [], yearOf: 2026, revision: 9,
    spaces: [{ id: 'tick-space', name: 'Tick', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', blocks: [block] }],
  }))
  const core = await isolatedCore(dir)
  const morning = new Date(2026, 7, 20, 1, 0)
  const afternoon = new Date(2026, 7, 20, 13, 0)
  const morningGoal = goalOf(block, morning)
  const afternoonGoal = goalOf(block, afternoon)
  assert.equal(morningGoal.paceText, afternoonGoal.paceText)
  assert.equal(morningGoal.quietText, afternoonGoal.quietText)
  assert.notEqual(Math.round(morningGoal.through * 1000), Math.round(afternoonGoal.through * 1000))
  assert.notEqual(core.stateFingerprint(morning), core.stateFingerprint(afternoon))
  assert.equal(core.project().revision, 9)
})

test('agent undo is in-memory, clears legacy snapshots, and expires on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-agent-undo-'))
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    captures: [], spaces: [], lessons: [], activity: [], retired: [], yearOf: new Date().getFullYear(),
    previous: JSON.stringify({ spaces: [{ id: 'stale' }], captures: [], lessons: [] }),
    previousAt: new Date().toISOString(),
  }))
  let core = await isolatedCore(dir)
  assert.equal(core.project().canUndo, false, 'a legacy on-disk snapshot is not offered after restart')
  await core.createSpace('First session')
  assert.equal(core.project().canUndo, true)
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal('previous' in saved, false)
  assert.equal('previousAt' in saved, false)

  core = await isolatedCore(dir)
  assert.equal(core.project().canUndo, false)
  await assert.rejects(core.undo(), /nothing recent to undo/)
  await core.createSpace('Second session')
  await core.undo()
  assert.deepEqual(core.project().spaces.map((space) => space.name), ['First session'])
})

test('latest-work queue coalesces overlap and contains retryable failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-work-queue-'))
  const core = await isolatedCore(dir)
  const calls = []
  let releaseFirst
  let firstStarted
  const started = new Promise((resolveStarted) => { firstStarted = resolveStarted })
  const gate = new Promise((resolveGate) => { releaseFirst = resolveGate })
  const queue = core.createLatestWorkQueue(async (value, revision) => {
    calls.push([value, revision])
    if (revision === 1) {
      firstStarted()
      await gate
    }
  }, { delayMs: 0 })

  queue.schedule('first', 1)
  await started
  queue.schedule('middle', 2)
  queue.schedule('latest', 3)
  releaseFirst()
  await queue.drain()
  assert.deepEqual(calls, [['first', 1], ['latest', 3]])
  assert.deepEqual(queue.status(), { pendingRevision: null, inFlightRevision: null, lastError: null })
  queue.schedule('stale', 2)
  await queue.drain()
  assert.deepEqual(calls, [['first', 1], ['latest', 3]], 'a completed newer revision still rejects stale work')

  let fail = true
  const errors = []
  const retry = core.createLatestWorkQueue(async () => {
    if (fail) throw new Error('relay unavailable')
  }, { delayMs: 0, onError: (error) => errors.push(error.message) })
  retry.schedule('page', 9)
  const failed = await retry.drain()
  assert.equal(failed.pendingRevision, 9)
  assert.equal(failed.inFlightRevision, null)
  assert.equal(failed.lastError, 'relay unavailable')
  assert.deepEqual(errors, ['relay unavailable'])
  fail = false
  retry.schedule('page', 9)
  assert.deepEqual(await retry.drain(), { pendingRevision: null, inFlightRevision: null, lastError: null })
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

// ----------------------------------------------------------- focus spans

test('a focus span writes one event and one line of history, and touches nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-focus-'))
  const core = await isolatedCore(dir)
  const year = new Date().getFullYear()
  const space = await core.createSpace('Kitchen')
  const list = await core.createBlock(space.id, {
    type: 'list',
    title: 'Splashback',
    items: ['cut the tiles', 'grout'],
    entities: [{ type: 'place', name: 'Kitchen' }],
  })
  const itemId = core.readBlock(list.blockId).block.items[0].id
  const before = core.agentView().spaces.find((s) => s.id === space.id)

  const out = await core.recordFocus({ blockId: list.blockId, itemId, ms: 45 * 60 * 1000 })
  assert.equal(out.summary, '45m focused on: cut the tiles')
  assert.equal(out.itemId, itemId)
  assert.equal(out.duration, 45 * 60 * 1000)

  const focusEvents = (await core.readEvents(year)).filter((e) => e.kind === 'focus')
  assert.equal(focusEvents.length, 1, 'exactly one focus event per span')
  assert.equal(focusEvents[0].blockId, list.blockId)
  assert.equal(focusEvents[0].itemId, itemId)
  assert.equal(focusEvents[0].spaceId, space.id)
  assert.equal(focusEvents[0].duration, 45 * 60 * 1000)
  assert.deepEqual(focusEvents[0].entities, [{ type: 'place', name: 'Kitchen' }])

  const activity = core.project().activity
  assert.equal(activity.filter((a) => a.summary.includes('focused on')).length, 1)
  assert.equal(activity[0].space, 'Kitchen')
  assert.equal(activity[0].summary, '45m focused on: cut the tiles')

  // sitting with something is not editing it
  const after = core.agentView().spaces.find((s) => s.id === space.id)
  assert.equal(after.updatedAt, before.updatedAt)
  assert.deepEqual(after.blocks, before.blocks)
})

test('a reminder is focused whole, and its own entities ride along', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-focus-reminder-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('People')
  const made = await core.createBlock(space.id, {
    type: 'reminder',
    title: '',
    text: 'Call the landlord',
    entities: [{ type: 'person', name: 'Ana' }],
  })

  const out = await core.recordFocus({ blockId: made.blockId, ms: 20 * 60 * 1000 })
  assert.equal(out.summary, '20m focused on: Call the landlord')
  assert.equal(out.itemId, '')
  const event = (await core.readEvents(new Date().getFullYear())).at(-1)
  assert.equal(event.kind, 'focus')
  assert.equal(Object.hasOwn(event, 'itemId'), false, 'a reminder span carries no itemId')
  assert.deepEqual(event.entities, [{ type: 'person', name: 'Ana' }])

  await assert.rejects(
    core.recordFocus({ blockId: made.blockId, itemId: 'nope', ms: 60000 }),
    /no items/
  )
})

test('only a list item or a reminder can be focused, and only with real identifiers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-focus-eligible-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Running')
  const tracker = await core.createBlock(space.id, { type: 'tracker', title: 'Miles', current: 3, target: 100, unit: 'miles' })
  const note = await core.createBlock(space.id, { type: 'note', title: 'Shoes', text: 'the blue ones' })
  const list = await core.createBlock(space.id, { type: 'list', title: 'Kit', items: ['wash the socks'] })

  await assert.rejects(core.recordFocus({ blockId: tracker.blockId, ms: 60000 }), /not a tracker/)
  await assert.rejects(core.recordFocus({ blockId: note.blockId, ms: 60000 }), /not a note/)
  await assert.rejects(core.recordFocus({ blockId: 'nothing', ms: 60000 }), /unknown blockId/)
  await assert.rejects(core.recordFocus({ blockId: list.blockId, ms: 60000 }), /name the itemId/)
  await assert.rejects(core.recordFocus({ blockId: list.blockId, itemId: 'ghost', ms: 60000 }), /unknown itemId/)
  assert.equal((await core.readEvents(new Date().getFullYear())).some((e) => e.kind === 'focus'), false)
})

test('a focus span has to be a sitting: below the floor and above the ceiling are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-focus-bounds-'))
  const core = await isolatedCore(dir)
  const space = await core.createSpace('Desk')
  const made = await core.createBlock(space.id, { type: 'reminder', title: '', text: 'Write the letter' })

  await assert.rejects(core.recordFocus({ blockId: made.blockId, ms: core.FOCUS_MIN_MS - 1 }), /too short/)
  await assert.rejects(core.recordFocus({ blockId: made.blockId, ms: core.FOCUS_MAX_MS + 1 }), /too long/)
  await assert.rejects(core.recordFocus({ blockId: made.blockId, ms: -5000 }), /too short/)
  await assert.rejects(core.recordFocus({ blockId: made.blockId, ms: 'a while' }), /needs a duration/)
  await assert.rejects(core.recordFocus({ blockId: made.blockId }), /needs a duration/)
  assert.equal(core.project().activity.length, 0)

  // the edges themselves are sittings
  await core.recordFocus({ blockId: made.blockId, ms: core.FOCUS_MIN_MS })
  await core.recordFocus({ blockId: made.blockId, ms: core.FOCUS_MAX_MS })
  assert.deepEqual(core.project().activity.map((a) => a.summary), [
    '8h focused on: Write the letter',
    '20s focused on: Write the letter',
  ])
})

test('a span says how long it took the way a person would', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'december-focus-words-'))
  const core = await isolatedCore(dir)
  assert.equal(core.focusPhrase(40000), '40s')
  assert.equal(core.focusPhrase(45 * 60000), '45m')
  assert.equal(core.focusPhrase(59.6 * 60000), '1h')
  assert.equal(core.focusPhrase(80 * 60000), '1h 20m')
  assert.equal(core.focusPhrase(120 * 60000), '2h')
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
