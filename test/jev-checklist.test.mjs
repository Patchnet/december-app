import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseChecklist, checklistGate } from '../lib/jev-checklist.mjs'
import { tryJevCapture, fixtureDecision, fastCaptureDelay } from '../lib/jev.mjs'
import { checklistCases, existingNames } from './fixtures/jev-checklists.mjs'

const text = checklistCases[0].text
const config = { mode: 'fast', ready: true, fixture: false, key: 'test-only' }
function harness() {
  const view = { spaces: [], captures: [{ id: 'c', text }], lessons: [], ask: null }
  const full = { spaces: [], retired: [] }, writes = []
  let revision = 0
  return { view, full, writes, config, request: fixtureDecision,
    change: () => revision++,
    core: { agentView: () => view, project: () => full, stateRevision: () => revision },
    callTool: async (name, args) => { writes.push({ name, args }); return { spaceId: 'garden', blockId: 'checklist' } },
  }
}

test('authored capture set preserves exact checklist names/items and defers ambiguous inputs', () => {
  for (const c of checklistCases) {
    const parsed = parseChecklist(c.text, existingNames)
    if (c.expected === 'defer') assert.equal(parsed, null, c.text)
    else assert.deepEqual(parsed, { action: 'create', name: c.name, items: c.items }, c.text)
  }
})

test('new checklists work on an empty page, skip debounce, and use one create mutation plus filing', async () => {
  const h = harness()
  assert.equal(fastCaptureDelay(h.view, config), 0)
  const result = await tryJevCapture(h)
  assert.equal(result.outcome, 'created')
  assert.equal(result.operationId, 'jev-create-v1')
  assert.deepEqual(h.writes.map(w => w.name), ['december_create_block', 'december_file_capture'])
  assert.deepEqual(h.writes[0].args, { space: 'Garden', type: 'list', title: 'Garden',
    items: checklistCases[0].items, source: 'c', operationId: 'jev-create-v1' })
  assert.equal(h.writes[1].args.space, 'garden')
  const shadow = harness()
  assert.equal((await tryJevCapture({ ...shadow, config: { ...config, mode: 'shadow' } })).outcome, 'would-create')
  assert.equal(shadow.writes.length, 0)
})

test('closed subjects, retired subjects, and existing block names are not recreated', async () => {
  for (const mutate of [
    h => h.full.spaces.push({ name: 'garden', finished: true }),
    h => h.full.retired.push({ name: 'Garden' }),
    h => h.full.spaces.push({ name: 'Home', blocks: [{ title: 'Garden' }] }),
  ]) {
    const h = harness(); mutate(h)
    h.request = () => { throw new Error('must not call provider') }
    assert.equal((await tryJevCapture(h)).reason, 'outside-fast-path')
    assert.equal(h.writes.length, 0)
  }
})

test('creation rejects disagreement, low confidence, malformed answers, and concurrent edits', async () => {
  for (const mutate of [
    r => { r.data.answers.action.confidence = .94 },
    r => { r.data.answers.action.choice = 'defer' },
    r => { r.data.answers.action.probabilities = { create: .2, defer: .8 } },
    r => { r.data.answers.action.choice = 'invented' },
    r => { r.data.model = 'other' },
  ]) {
    const h = harness()
    h.request = async request => { const result = await fixtureDecision(request); mutate(result); return result }
    assert.equal((await tryJevCapture(h)).outcome, 'fallback')
    assert.equal(h.writes.length, 0)
  }
  const h = harness()
  h.request = async request => { h.change(); return fixtureDecision(request) }
  assert.equal((await tryJevCapture(h)).reason, 'page-changed')
  assert.equal(h.writes.length, 0)
  assert.equal(checklistGate('Make a Garden checklist: herbs', [], {}).action, 'defer')
})

test('real creation receipts survive restart, prevent duplicates, support partial recovery and undo', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'december-jev-create-'))
  const old = process.env.DECEMBER_DATA_DIR
  process.env.DECEMBER_DATA_DIR = dir
  t.after(async () => {
    if (old === undefined) delete process.env.DECEMBER_DATA_DIR
    else process.env.DECEMBER_DATA_DIR = old
    await rm(dir, { recursive: true, force: true })
  })
  const core = await import('../lib/core.mjs')
  const { callTool } = await import('../lib/tools.mjs')
  await core.addCapture(text)
  const capture = core.agentView().captures[0]
  core.beginAgentRun()
  let createArgs
  // A failed filing preserves the exact created block and its receipt.
  await assert.rejects(tryJevCapture({ core, config, request: fixtureDecision, callTool: async (name, args) => {
    if (name === 'december_file_capture') throw new Error('filing interrupted')
    createArgs = args
    return callTool(name, args)
  } }), /filing interrupted/)
  assert.equal(core.agentView().spaces.length, 1)
  assert.equal(core.agentView().captures[0].appliedOperations.length, 1)
  assert.equal((await tryJevCapture({ core, callTool, config, request: fixtureDecision })).reason, 'context-needs-organizer')
  const receipt = await callTool('december_create_block', createArgs)
  assert.equal(core.agentView().spaces[0].blocks.length, 1)
  await callTool('december_file_capture', { captureId: capture.id, space: receipt.spaceId,
    summary: 'Created Garden checklist', source: capture.id, operationId: 'jev-file-v1' })
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.operations.filter(o => o.source === capture.id).length, 2)
  assert.deepEqual(saved.spaces[0].blocks[0].items.map(i => i.text), checklistCases[0].items)
  const restarted = await import('../lib/core.mjs?checklist-restart')
  assert.equal(restarted.hasInbox(), false)
  assert.equal(restarted.agentView().spaces[0].blocks.length, 1)
  await core.undo()
  assert.equal(core.agentView().spaces.length, 0)
  assert.equal(core.hasInbox(), true)
  assert.equal(core.agentOperationStatus(capture.id, 'jev-create-v1'), 'undone')
  assert.equal((await tryJevCapture({ core, callTool, config, request: fixtureDecision })).reason, 'context-needs-organizer')
})
